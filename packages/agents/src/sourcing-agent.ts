/**
 * Sourcing as an agent (build list B8). The pooled search (resolver/resolve.ts — plan, every source, rated by eye,
 * re-plan) stays the first pass. This agent then owns its result like a picture researcher: it reads the coverage
 * report (what each shot needed, what was placed and how well it fitted, what else was seen), LOOKS at the placed
 * pictures beside their lines, and fixes what a viewer would catch — a picture that contradicts its line (film strips
 * under "a photo taken with no film"), a stand-in where the story needs the real subject, a weak fit, a missing
 * picture — by searching again with better words, or by giving the shot to the scene designer as a designed shot.
 * It is measured against the channel: how often a line naming someone shows real footage or photos of them
 * (channel profile relations.lineToPicture), and the share of weak picks.
 *
 *  skill    packages/agents/skills/sourcing.md
 *  tools    read_coverage, look_at, find_picture, drop_picture, submit_sourcing, note_lesson
 *  memory   <memoryDir>/<channel>.md, owner-notes.md (data/agents/sourcing/)
 * The picture tools are the resolver's (makeSceneTools), handed in as functions.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelId, ResolutionReport } from "@opumia/contracts";
import * as z from "zod/v4";
import { loadChannelProfile } from "./channel-profile.js";
import { readMemory } from "./lessons.js";
import { agentLoop, cached, plain, type AgentTool, ROLE_MODEL } from "./llm.js";

export interface CoverageRow { shotId: string; line: string; need: string; must: string; when?: string; bestFit: number; footage?: { ref: string; origin: string; provider: string; fit: number; shows: string } | null; scenePictures: number; missing: boolean; candidates: Array<{ source: string; ref: string; fit: number; shows: string; wrongEra?: boolean; banner?: boolean }> }
export interface SourcingAgentReport { pass: boolean; before: SourcingMeasure; after: SourcingMeasure; ops: string[]; note: string; agent: { turns: number; calls: Record<string, number>; usd: number } }
export interface SourcingMeasure { shots: number; placed: number; weak: number; realNeeded: number; realMet: number; nameReal: number; channelNameReal: number | null }

export interface SourcingAgentOptions {
  channel: ChannelId;
  data: string;
  jobDir: string;
  title: string;
  rows: CoverageRow[];
  resolution: ResolutionReport;
  /** Named people/companies of the film (a line naming one should show the real subject). */
  subjects: string[];
  findPicture: (i: { shotId: string; want: string; as: "footage" | "slot"; kind: "video" | "image" }) => Promise<{ ok: true; depicts: string; fit?: number; preview: string } | { ok: false; why: string }>;
  memoryDir?: string;
  log?: (s: string) => void;
}

const sha = (s: string, n = 14) => createHash("sha1").update(s).digest("hex").slice(0, n);
const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

export async function sourcingAgent(o: SourcingAgentOptions): Promise<{ resolution: ResolutionReport; dropped: string[]; report: SourcingAgentReport }> {
  const log = o.log ?? (() => {});
  const prof = await loadChannelProfile(o.data, o.channel);
  const nameRef = prof ? (prof.relations.lineToPicture.name?.picture.real_footage ?? 0) + (prof.relations.lineToPicture.name?.picture.real_photo ?? 0) : null;
  const rows = new Map(o.rows.map((r) => [r.shotId, { ...r }]));
  const dropped = new Set<string>();
  const replaced = new Map<string, { depicts: string; fit: number; preview: string; origin: string }>();
  const ops: string[] = [];
  const looked = new Set<string>();
  let accepted: string | null = null, noteSaved = false;
  const thumbOfRef = (ref: string) => path.join(o.jobDir, "downloads", "thumbs", `${sha(ref)}.jpg`);
  const primary = (id: string) => o.resolution.media.find((m) => m.shotId === id && m.role === "primary");
  const names = (line: string) => o.subjects.filter((s) => line.toLowerCase().includes(s.toLowerCase().split(/\s+/).at(-1)!));
  const fitOf = (id: string) => replaced.get(id)?.fit ?? rows.get(id)?.footage?.fit ?? 0;
  const originOf = (id: string) => replaced.get(id)?.origin ?? primary(id)?.origin ?? rows.get(id)?.footage?.origin ?? "";
  const measure = (): SourcingMeasure => {
    const rs = [...rows.values()].filter((r) => r.need !== "none");
    const placed = rs.filter((r) => !dropped.has(r.shotId) && (replaced.has(r.shotId) || r.footage || r.scenePictures > 0));
    const weak = placed.filter((r) => (replaced.has(r.shotId) || r.footage) && fitOf(r.shotId) <= 6).length;
    const real = rs.filter((r) => r.need === "real");
    const realMet = real.filter((r) => !dropped.has(r.shotId) && originOf(r.shotId) === "press").length;
    const named = [...rows.values()].filter((r) => names(r.line).length);
    const nameReal = named.length ? named.filter((r) => !dropped.has(r.shotId) && originOf(r.shotId) === "press").length / named.length : 0;
    return { shots: rs.length, placed: placed.length, weak, realNeeded: real.length, realMet, nameReal: Math.round(nameReal * 100) / 100, channelNameReal: nameRef === null ? null : Math.round(nameRef * 100) / 100 };
  };
  const before = measure();
  const mText = (m: SourcingMeasure) => `${m.placed} of ${m.shots} shots that need a picture have one; ${m.weak} placed pick(s) fit 6/10 or less; real subject needed on ${m.realNeeded}, met with real press material on ${m.realMet}; lines naming a subject show real footage/photos ${Math.round(m.nameReal * 100)} %${m.channelNameReal !== null ? ` (the channel: ${Math.round(m.channelNameReal * 100)} %)` : ""}.`;

  const tools: AgentTool[] = [
    {
      name: "read_coverage",
      description: "Every shot: its line, the year it is set in, what it needed (real subject / period / staged / object / none), what must be seen, what was placed (source, fit /10, what it shows), and the best other candidates seen. Weak picks and named subjects are marked.",
      schema: z.object({}),
      run: (async () => {
        const out = [...rows.values()].map((r) => {
          const cur = replaced.get(r.shotId);
          const placed = dropped.has(r.shotId) ? "DROPPED → designed shot" : cur ? `NEW ${cur.origin} fit ${cur.fit}: ${cur.depicts}` : r.footage ? `${r.footage.origin}/${r.footage.provider} fit ${r.footage.fit}: ${r.footage.shows}` : r.scenePictures ? `${r.scenePictures} picture slot(s), no footage` : "NOTHING";
          const nm = names(r.line);
          const alt = r.candidates.filter((c) => c.ref !== r.footage?.ref).slice(0, 3).map((c) => `${c.source} ${c.fit}: ${c.shows.slice(0, 70)}`).join(" | ");
          return `${r.shotId} [${r.need}${r.when ? `, ${r.when}` : ""}${nm.length ? `, names ${nm.join("/")}` : ""}] "${r.line.slice(0, 110)}"\n   must show: ${r.must}\n   placed: ${placed}${(cur?.fit ?? r.footage?.fit ?? 10) <= 6 && !dropped.has(r.shotId) ? "  ← WEAK" : ""}\n   also seen: ${alt || "—"}`;
        });
        return `${out.join("\n")}\n\n${mText(measure())}`;
      }) as AgentTool["run"],
    },
    {
      name: "look_at",
      description: "See the placed picture of up to four shots beside their lines (and the best runner-up of each, when a preview exists). Judge: does it show what the line says, at the line's time, without contradicting it?",
      schema: z.object({ shotIds: z.array(z.string()).min(1).max(4) }),
      run: (async (i: { shotIds: string[] }) => {
        const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const id of i.shotIds) {
          const r = rows.get(id);
          if (!r) { blocks.push({ type: "text", text: `${id}: no such shot` }); continue; }
          looked.add(id);
          const cur = replaced.get(id);
          const file = cur?.preview || (r.footage ? thumbOfRef(r.footage.ref) : "");
          blocks.push({ type: "text", text: `${id} — line: "${r.line}" (set ${r.when ?? "?"}) — placed: ${cur ? cur.depicts : r.footage?.shows ?? "no footage"}` });
          if (file && existsSync(file)) blocks.push(await img(file));
          else blocks.push({ type: "text", text: "(no preview of the placed picture)" });
          const ru = r.candidates.find((c) => c.ref !== r.footage?.ref && existsSync(thumbOfRef(c.ref)));
          if (ru) { blocks.push({ type: "text", text: `runner-up (${ru.source}, fit ${ru.fit}): ${ru.shows}` }); blocks.push(await img(thumbOfRef(ru.ref))); }
        }
        return blocks;
      }) as AgentTool["run"],
    },
    {
      name: "find_picture",
      description: "Search every source again for one shot with better words (what a stock or news library would call it: concrete, visible things — never abstract ideas), rate the previews by eye against the line and its year, and place the best one as the shot's footage. For a real subject, name them (press is searched).",
      schema: z.object({ shotId: z.string(), want: z.string(), kind: z.enum(["video", "image"]).default("video") }),
      run: (async (i: { shotId: string; want: string; kind: "video" | "image" }) => {
        if (!rows.has(i.shotId)) return `no shot ${i.shotId}`;
        // proof film 1 (2026-11-26): the only real press shot was replaced with stock ("real 1 → 0/9"). Real material of
        // the subject is never traded away.
        if (["press", "archival"].includes(originOf(i.shotId))) return `KEPT — ${i.shotId} already shows real ${originOf(i.shotId)} material of its subject; a stock picture never replaces it. Improve another shot.`;
        const r = await o.findPicture({ shotId: i.shotId, want: i.want, as: "footage", kind: i.kind });
        if (!r.ok) { ops.push(`find ${i.shotId}: none (${i.want})`); return `nothing placed: ${r.why}`; }
        replaced.set(i.shotId, { depicts: r.depicts, fit: r.fit ?? 6, preview: r.preview, origin: primary(i.shotId)?.origin ?? "stock" });
        dropped.delete(i.shotId);
        ops.push(`find ${i.shotId}: ${r.depicts.slice(0, 50)} (${r.fit})`);
        return [{ type: "text" as const, text: `placed (fit ${r.fit}): ${r.depicts}\n${mText(measure())}` }, ...(r.preview && existsSync(r.preview) ? [await img(r.preview)] : [])];
      }) as AgentTool["run"],
    },
    {
      name: "drop_picture",
      description: "Take a shot's picture away: the scene designer will build it as a designed shot (type, a document, a chart, the film's colour world). For a line no findable picture can show honestly.",
      schema: z.object({ shotId: z.string(), why: z.string() }),
      run: (async (i: { shotId: string; why: string }) => {
        if (!rows.has(i.shotId)) return `no shot ${i.shotId}`;
        if (["press", "archival"].includes(originOf(i.shotId))) return `KEPT — ${i.shotId} shows real ${originOf(i.shotId)} material of its subject; it is not dropped.`;
        dropped.add(i.shotId);
        replaced.delete(i.shotId);
        ops.push(`drop ${i.shotId} (${i.why.slice(0, 50)})`);
        return `dropped\n${mText(measure())}`;
      }) as AgentTool["run"],
    },
    {
      name: "submit_sourcing",
      description: "Hand the pictures to the scene designer. Refused until you have looked at every weak pick and every shot whose line names a subject.",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        const must = [...rows.values()].filter((r) => !dropped.has(r.shotId) && ((r.footage && fitOf(r.shotId) <= 6) || names(r.line).length)).map((r) => r.shotId).filter((id) => !looked.has(id) && !replaced.has(id));
        if (must.length) return `refused: look_at these first: ${must.join(", ")}`;
        accepted = i.note;
        return "Accepted. If this film taught you something about finding pictures, call note_lesson once; then stop.";
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's picture researcher.",
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
  const skill = await readFile(new URL("../skills/sourcing.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const system = [cached(skill), plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}Subjects of this film: ${o.subjects.join(", ") || "none named"}.`)];
  log(`  picture researcher: ${mText(before)} (${ROLE_MODEL.pictureResearcher})`);
  let grace = 1;
  const run = await agentLoop({ stage: "sourcing.agent", model: ROLE_MODEL.pictureResearcher, system, user: `Review the pictures found for "${o.title}" and fix what a viewer would catch. Start with read_coverage.`, tools, effort: "medium", maxTurns: 16, maxSeconds: 180, maxTokens: 20000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "Not submitted yet. Read the coverage, look at the weak and named shots, fix them, and submit.", log });
  // Dropped shots lose their footage (the scene designer builds them); picture slots stay.
  const resolution: ResolutionReport = { ...o.resolution, media: o.resolution.media.filter((m) => !(dropped.has(m.shotId) && m.role === "primary")) };
  const after = measure();
  const report: SourcingAgentReport = { pass: accepted !== null, before, after, ops, note: accepted ?? "not submitted", agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.title.slice(0, 60)}": weak ${before.weak} → ${after.weak}, real met ${before.realMet} → ${after.realMet}/${after.realNeeded}; ${ops.length} change(s); ${(accepted ?? "").slice(0, 200).replace(/\s+/g, " ")}\n`);
  }
  log(`  picture researcher: weak ${before.weak} → ${after.weak}, real ${before.realMet} → ${after.realMet}/${after.realNeeded}, ${ops.length} change(s), ${run.turns} turns, $${report.agent.usd}`);
  return { resolution, dropped: [...dropped], report };
}
