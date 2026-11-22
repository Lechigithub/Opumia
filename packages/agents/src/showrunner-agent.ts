/**
 * The showrunner (build list A1, A2): owns the whole film after it is planned (scenes, edit and sound done, before the
 * preflight gate). It holds the film's central idea, reads every stage's report and the whole-film score, watches the
 * stretches that matter with their sound, and sends work back to the agent that owns each problem — scene designer,
 * editor, sound designer, or (once, the costly loop) the writer. Then it approves or names what is still wrong.
 *
 *  skill    packages/agents/skills/showrunner.md
 *  tools    film_report, watch, redesign_shots, re_edit, redo_sound, rewrite_lines, approve, note_lesson
 *  memory   <memoryDir>/<channel>.md, owner-notes.md
 * The work itself is done by callbacks the pipeline provides (the same stage functions it runs), so every send-back
 * is a real re-run of that agent, measured again.
 */
import { readMemory } from "./lessons.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelId } from "@opumia/contracts";
import * as z from "zod/v4";
import { agentLoop, cached, MODELS, plain, type AgentTool } from "./llm.js";

export interface ShowrunnerDecision {
  approved: boolean;
  summary: string;
  rounds: Array<{ to: string; what: string; result: string }>;
  /** Lines sent back to the writer: the pipeline re-runs from the script (once per film). */
  rewrite: { brief: string } | null;
  agent: { turns: number; calls: Record<string, number>; usd: number };
}

export interface ShowrunnerOptions {
  channel: ChannelId;
  title: string;
  /** The film's treatment (central idea, story shape, look). */
  treatment: string;
  /** The narration as segments (id, role, text). */
  segments: Array<{ id: string; role: string; text: string }>;
  /** Whether the writer may still be asked (false on the second pass of a film). */
  canRewrite: boolean;
  durationS: number;
  /** Whole-film score text and the agents' reports, current. */
  report: () => Promise<string>;
  watch: (fromS: number, toS: number) => Promise<{ strip: string; text: string }>;
  redesign: (shots: Array<{ shotId: string; note: string }>) => Promise<string>;
  reEdit: (note: string) => Promise<string>;
  redoSound: (note: string) => Promise<string>;
  memoryDir?: string;
  log?: (s: string) => void;
}

const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

export async function showrunnerAgent(o: ShowrunnerOptions): Promise<ShowrunnerDecision> {
  const log = o.log ?? (() => {});
  const rounds: ShowrunnerDecision["rounds"] = [];
  const watched: Array<[number, number]> = [];
  let decision: { approved: boolean; summary: string } | null = null;
  let rewrite: ShowrunnerDecision["rewrite"] = null;
  let noteSaved = false;
  const sendBacks = () => rounds.length;
  // after a send-back the film changed: the next approval needs a fresh look at it
  let unchecked: string | null = null;
  const seen = (from: number, to: number) => watched.some(([a, b]) => a <= from + 1 && b >= to - 1);
  const tools: AgentTool[] = [
    {
      name: "film_report",
      description: "The whole-film score against the channel (every gap with the agent that owns it) and what each agent reported about its own work.",
      schema: z.object({}),
      run: (async () => o.report()) as AgentTool["run"],
    },
    {
      name: "watch",
      description: "Watch a stretch of the planned film with its sound (up to 15 s): a strip of frames and a listening report.",
      schema: z.object({ fromS: z.number(), toS: z.number() }),
      run: (async (i: { fromS: number; toS: number }) => {
        const from = Math.max(0, i.fromS), to = Math.min(o.durationS, Math.min(i.toS, from + 15));
        const w = await o.watch(from, to).catch((e: Error) => ({ strip: "", text: `could not render: ${e.message.slice(0, 200)}` }));
        if (w.strip) { watched.push([from, to]); unchecked = null; }
        return w.strip ? [{ type: "text" as const, text: w.text }, await img(w.strip)] : w.text;
      }) as AgentTool["run"],
    },
    {
      name: "redesign_shots",
      description: "Send shots back to the scene designer with a reason each (what is wrong, what it should show instead). It redesigns only these, renders and looks at them, and reports.",
      schema: z.object({ shots: z.array(z.object({ shotId: z.string(), note: z.string() })).min(1).max(10) }),
      run: (async (i: { shots: Array<{ shotId: string; note: string }> }) => {
        if (sendBacks() >= 6) return "refused: six send-backs already — decide and approve, or say what is still wrong";
        const r = await o.redesign(i.shots);
        unchecked = "scene designer";
        rounds.push({ to: "scene designer", what: i.shots.map((s) => `${s.shotId}: ${s.note}`).join(" | ").slice(0, 600), result: r.slice(0, 400) });
        return r;
      }) as AgentTool["run"],
    },
    {
      name: "re_edit",
      description: "Send the cut back to the editor with what to change and why (holds, bursts, cuts, transitions).",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        if (sendBacks() >= 6) return "refused: six send-backs already";
        const r = await o.reEdit(i.note);
        unchecked = "editor";
        rounds.push({ to: "editor", what: i.note.slice(0, 400), result: r.slice(0, 400) });
        return r;
      }) as AgentTool["run"],
    },
    {
      name: "redo_sound",
      description: "Send the sound back to the sound designer (a fresh selection and placement of hits and music) with what was wrong.",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        if (sendBacks() >= 6) return "refused: six send-backs already";
        const r = await o.redoSound(i.note);
        unchecked = "sound designer";
        rounds.push({ to: "sound designer", what: i.note.slice(0, 400), result: r.slice(0, 400) });
        return r;
      }) as AgentTool["run"],
    },
    {
      name: "rewrite_lines",
      description: "Send lines back to the writer (the costly loop: the narration is re-recorded and the film planned again, once per film). Name the segment ids, quote the lines, and say what to change and why. This ends your review: the film comes back to you after it is planned again.",
      schema: z.object({ segments: z.array(z.object({ id: z.string(), note: z.string() })).min(1), why: z.string() }),
      run: (async (i: { segments: Array<{ id: string; note: string }>; why: string }) => {
        if (!o.canRewrite) return "refused: the script was already sent back once for this film — fix what you can downstream, then approve and name what is still wrong";
        const lines = i.segments.map((s) => `- [${s.id}] "${o.segments.find((x) => x.id === s.id)?.text.slice(0, 300) ?? "?"}" → ${s.note}`);
        rewrite = { brief: `${i.why}\n${lines.join("\n")}` };
        decision = { approved: false, summary: `sent back to the writer: ${i.why}` };
        rounds.push({ to: "writer", what: rewrite.brief.slice(0, 600), result: "the film will be planned again from the script" });
        return "Recorded. The pipeline will re-run from the script. Stop now.";
      }) as AgentTool["run"],
    },
    {
      name: "approve",
      description: "Approve the film (nothing more can be fixed by sending it back) with a summary and anything still below the channel's level. Refused until you have watched the opening and the ending.",
      schema: z.object({ summary: z.string(), stillBelowChannel: z.array(z.string()).default([]) }),
      run: (async (i: { summary: string; stillBelowChannel: string[] }) => {
        if (unchecked) return `refused: the ${unchecked} changed the film since you last watched — watch the stretch it changed (and call film_report) before approving`;
        if (!seen(0, Math.min(12, o.durationS))) return "refused: watch the opening first";
        if (!seen(Math.max(0, o.durationS - 12), o.durationS)) return "refused: watch the ending first";
        decision = { approved: true, summary: `${i.summary}${i.stillBelowChannel.length ? ` Still below the channel: ${i.stillBelowChannel.join("; ")}` : ""}` };
        return "Approved. If this film taught you something about running a film, call note_lesson once; then stop.";
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's showrunner.",
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
  const skill = await readFile(new URL("../skills/showrunner.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const system = [cached(skill), plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}The film is ${o.durationS.toFixed(1)} s long.${o.canRewrite ? "" : " The script was already sent back once: the writer cannot be asked again."}`)];
  const user = `Run this film: "${o.title}".\n\nTREATMENT:\n${o.treatment.slice(0, 3000)}\n\nNARRATION:\n${o.segments.map((s) => `[${s.id} ${s.role}] ${s.text}`).join("\n")}\n\nStart with film_report, then watch the opening.`;
  log(`  showrunner: reviewing "${o.title.slice(0, 60)}" (${MODELS.sonnet})…`);
  let grace = 1;
  const run = await agentLoop({ stage: "showrunner.agent", model: MODELS.sonnet, system, user, tools, effort: "medium", maxTurns: 30, maxTokens: 24000, done: () => decision !== null && (rewrite !== null || noteSaved || grace-- <= 0), nudge: "You have not decided. Watch what you have not seen, send back what is wrong, then approve (or send lines to the writer).", log });
  const d = (decision as { approved: boolean; summary: string } | null) ?? { approved: false, summary: "the showrunner did not decide within its turns" };
  const out: ShowrunnerDecision = { approved: d.approved, summary: d.summary, rounds, rewrite, agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.title.slice(0, 60)}": ${out.approved ? "approved" : rewrite ? "sent back to the writer" : "not approved"}; send-backs: ${rounds.map((r) => r.to).join(", ") || "none"}; ${d.summary.slice(0, 240).replace(/\s+/g, " ")}\n`);
  }
  log(`  showrunner: ${out.approved ? "approved" : rewrite ? "sent the script back" : "not approved"} after ${rounds.length} send-back(s), ${run.turns} turns, $${out.agent.usd}`);
  return out;
}
