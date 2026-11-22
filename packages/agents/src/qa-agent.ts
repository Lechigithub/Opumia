/**
 * Final QA as an agent that watches the film like a viewer (build list B10). The measured QA (motion-engine/qa.ts:
 * loudness, black and frozen frames, captions, provenance, facts, number parity, the vision judge on stills) runs
 * first. Then this agent watches the FINISHED file from start to end in stretches — frames from the mp4 and the
 * mastered sound — with the narration of each stretch beside it, and notes what a viewer would notice: a picture
 * that contradicts the line, a jump or glitch, a frozen or black moment, text that cannot be read, sound that drops
 * out or swamps the voice, an ending that stops instead of landing. Each note names the moment, the shot, how bad it
 * is and who owns it. Its verdict can only make the film's verdict stricter, never looser.
 *
 *  skill    packages/agents/skills/qa.md
 *  tools    qa_report, watch, note_issue, verdict, note_lesson
 *  memory   <memoryDir>/<channel>.md, owner-notes.md (data/agents/qa/)
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { readMemory } from "./lessons.js";
import { agentLoop, cached, MODELS, plain, type AgentTool } from "./llm.js";

export interface ViewerIssue { atS: number; shotId: string | null; what: string; severity: number; owner: "sourcing" | "scene designer" | "editor" | "sound designer" | "colourist" | "voice" | "writer" | "render"; fix: "replace_broll" | "redesign" | "recut" | "resound" | "regrade" | "rerecord" | "rewrite" | "rerender" | "none" }
export interface ViewerVerdict { verdict: "pass" | "review" | "fail"; summary: string; issues: ViewerIssue[]; watchedShare: number; agent: { turns: number; calls: Record<string, number>; usd: number } }

export interface QaAgentOptions {
  channel: string;
  title: string;
  durationS: number;
  /** The measured QA's checks as text. */
  qaText: string;
  shots: Array<{ id: string; startS: number; endS: number }>;
  /** Narration words with times. */
  words: Array<{ word: string; startS: number }>;
  watch: (fromS: number, toS: number) => Promise<{ strip: string; text: string }>;
  memoryDir?: string;
  log?: (s: string) => void;
}

const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
const OWNERS = ["sourcing", "scene designer", "editor", "sound designer", "colourist", "voice", "writer", "render"] as const;
const FIXES = ["replace_broll", "redesign", "recut", "resound", "regrade", "rerecord", "rewrite", "rerender", "none"] as const;

export async function qaAgent(o: QaAgentOptions): Promise<ViewerVerdict> {
  const log = o.log ?? (() => {});
  const issues: ViewerIssue[] = [];
  const seen = new Array<boolean>(Math.ceil(o.durationS)).fill(false);
  let decided: { verdict: ViewerVerdict["verdict"]; summary: string } | null = null, noteSaved = false;
  const watchedShare = () => seen.filter(Boolean).length / Math.max(1, seen.length);
  const shotAt = (t: number) => o.shots.find((s) => t >= s.startS && t < s.endS)?.id ?? null;
  const said = (a: number, b: number) => o.words.filter((w) => w.startS >= a && w.startS < b).map((w) => w.word).join(" ");
  const tools: AgentTool[] = [
    {
      name: "qa_report",
      description: "The measured QA checks of the finished film (loudness, black/frozen frames, captions, provenance, facts, number parity, the stills judge).",
      schema: z.object({}),
      run: (async () => o.qaText) as AgentTool["run"],
    },
    {
      name: "watch",
      description: "Watch a stretch of the finished film (up to 15 s): eight frames from the file, its mastered sound, the cuts in it, the shots it covers and the narration spoken over it. Watch the whole film, start to end.",
      schema: z.object({ fromS: z.number(), toS: z.number() }),
      run: (async (i: { fromS: number; toS: number }) => {
        const from = Math.max(0, i.fromS), to = Math.min(o.durationS, Math.min(i.toS, from + 15));
        const w = await o.watch(from, to).catch((e: Error) => ({ strip: "", text: `could not read the film: ${e.message.slice(0, 200)}` }));
        if (w.strip) for (let s = Math.floor(from); s < Math.ceil(to); s++) seen[s] = true;
        const shots = o.shots.filter((s) => s.endS > from && s.startS < to).map((s) => `${s.id} ${s.startS.toFixed(1)}–${s.endS.toFixed(1)}`).join(", ");
        const t = `${w.text}\nshots: ${shots}\nnarration: "${said(from, to)}"\nwatched so far: ${Math.round(watchedShare() * 100)} % of the film`;
        return w.strip ? [{ type: "text" as const, text: t }, await img(w.strip)] : t;
      }) as AgentTool["run"],
    },
    {
      name: "note_issue",
      description: "Note something a viewer would notice: the moment, what is wrong, how bad (1 = a purist would notice, 5 = most viewers notice, 8+ = it breaks the film), who owns it and the fix.",
      schema: z.object({ atS: z.number(), what: z.string(), severity: z.number().int().min(1).max(10), owner: z.enum(OWNERS), fix: z.enum(FIXES) }),
      run: (async (i: Omit<ViewerIssue, "shotId">) => {
        issues.push({ ...i, shotId: shotAt(i.atS) });
        return `noted (${issues.length}) at ${i.atS.toFixed(1)} s, shot ${shotAt(i.atS) ?? "?"}`;
      }) as AgentTool["run"],
    },
    {
      name: "verdict",
      description: "Give the verdict once you have watched at least 90 % of the film: pass (a viewer of the channel would not notice anything wrong), review (noticeable problems a person should look at), fail (something breaks the film). Refused before that.",
      schema: z.object({ verdict: z.enum(["pass", "review", "fail"]), summary: z.string() }),
      run: (async (i: { verdict: ViewerVerdict["verdict"]; summary: string }) => {
        if (watchedShare() < 0.9) return `refused: you have watched ${Math.round(watchedShare() * 100)} % of the film — watch the rest first (unwatched seconds: ${seen.map((x, k) => (x ? -1 : k)).filter((k) => k >= 0).slice(0, 20).join(", ")}…)`;
        const worst = Math.max(0, ...issues.map((x) => x.severity));
        if (i.verdict === "pass" && worst >= 5) return `refused: you noted a severity-${worst} issue — that is not a pass`;
        decided = i;
        return "Recorded. If this film taught you something about watching films, call note_lesson once; then stop.";
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's QA.",
      schema: z.object({ lesson: z.string() }),
      run: (async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LESSON (${o.title.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      }) as AgentTool["run"],
    },
  ];
  const skill = await readFile(new URL("../skills/qa.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const system = [cached(skill), plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}The film is ${o.durationS.toFixed(1)} s long.`)];
  log(`  viewer QA: watching "${o.title.slice(0, 60)}" (${o.durationS.toFixed(0)} s, ${MODELS.sonnet})…`);
  let grace = 1;
  const turns = Math.min(60, 12 + Math.ceil(o.durationS / 15) * 2);
  const run = await agentLoop({ stage: "qa.agent", model: MODELS.sonnet, system, user: `Watch "${o.title}" from start to end like a viewer of the channel, note what a viewer would notice, then give the verdict. Start with qa_report, then watch from 0 s.`, tools, effort: "medium", maxTurns: turns, maxTokens: 16000, done: () => decided !== null && (noteSaved || grace-- <= 0), nudge: "No verdict yet. Keep watching where you have not, note issues, then give the verdict.", log });
  const d = (decided as { verdict: ViewerVerdict["verdict"]; summary: string } | null) ?? { verdict: "review" as const, summary: `the viewer QA did not finish (${Math.round(watchedShare() * 100)} % watched)` };
  const out: ViewerVerdict = { verdict: d.verdict, summary: d.summary, issues, watchedShare: Math.round(watchedShare() * 100) / 100, agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.title.slice(0, 60)}": ${out.verdict}; ${issues.length} issue(s) (worst ${Math.max(0, ...issues.map((x) => x.severity))}); ${d.summary.slice(0, 200).replace(/\s+/g, " ")}\n`);
  }
  log(`  viewer QA: ${out.verdict.toUpperCase()} — ${issues.length} issue(s), watched ${Math.round(out.watchedShare * 100)} %, ${run.turns} turns, $${out.agent.usd}`);
  return out;
}
