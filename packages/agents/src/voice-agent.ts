/**
 * The voice director as an agent that hears its own takes (build list B7). The one-call voice director
 * (voice-director.ts) still marks pace, pauses, emphasis and risky words before the first takes. This agent then
 * listens to every line take — measured, because the model cannot hear audio: pitch travel and melody of the line,
 * whether the emphasised word really lifts (pitch, level), how the line ends (a statement falls), the word-by-word
 * contour, runs of lines with the same shape — against the channel narrator's band. It orders retakes of the lines
 * that sound flat or wrong (a fresh take, or the emphasis moved to another word), compares the takes and keeps the
 * better one. Correctness (words, pronunciation) is still checked afterwards by the listen-back loop in
 * narration/directed.ts, which only replaces lines that are wrong.
 *
 *  skill    packages/agents/skills/voice.md
 *  tools    read_delivery, hear_line, retake, choose_take, submit_delivery, note_lesson
 *  memory   <memoryDir>/<channel>.md, owner-notes.md (data/agents/voice/)
 *  limit    a retake budget (default a quarter of the lines): ElevenLabs characters cost money.
 */
import { readMemory } from "./lessons.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { agentLoop, cached, plain, type AgentTool, ROLE_MODEL } from "./llm.js";

export interface LineMeasure {
  seconds: number;
  wpm: number;
  /** p10–p90 pitch range in semitones */
  rangeSt: number;
  melodySt: number;
  dynamicsDb: number;
  /** the emphasised word against the rest of the line */
  emphasis: { word: string; liftDb: number; liftSt: number } | null;
  /** pitch of the last word against the line's median (negative = falls) */
  endingSt: number;
  /** per word: [word, semitones from the line median, dB from the line mean] */
  contour: Array<[string, number, number]>;
}
export interface VoiceLine { text: string; role: string; pace: string; emphasis: string; question: boolean }
export interface VoiceAgentReport { retakes: number; changed: number[]; flagsBefore: number; flagsAfter: number; notices: { before: Record<number, string[]>; after: Record<number, string[]> }; note: string; agent: { turns: number; calls: Record<string, number>; usd: number } }

export interface VoiceAgentOptions {
  channel: string;
  title: string;
  lines: VoiceLine[];
  /** The channel narrator: whole-narration expressiveness (exemplars). */
  narrator?: { f0RangeSt?: number; melodySt?: number; wpm?: number } | null;
  /** Measure the current take of a line. */
  measure: (i: number) => Promise<LineMeasure>;
  /** Make a new take of a line (a fresh seed; optionally emphasis on another word). Returns its measure; it becomes a candidate, not yet chosen. */
  retake: (i: number, o: { emphasis?: string }) => Promise<{ id: string; m: LineMeasure }>;
  /** Make a candidate take the line's take. */
  choose: (i: number, id: string) => Promise<void>;
  budget?: number;
  memoryDir?: string;
  log?: (s: string) => void;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

/** What a listener would notice in a line's delivery. */
export function deliveryFlags(l: VoiceLine, m: LineMeasure, prev: LineMeasure | null, typical: { rangeSt: number; melodySt: number }): string[] {
  const f: string[] = [];
  const words = l.text.split(/\s+/).length;
  if (words >= 6 && m.rangeSt < typical.rangeSt * 0.6) f.push(`flat (pitch travel ${r1(m.rangeSt)} st, the line median ${r1(typical.rangeSt)})`);
  if (m.emphasis && m.emphasis.liftDb < 0.5 && m.emphasis.liftSt < 0.5) f.push(`emphasis on "${m.emphasis.word}" did not land (+${r1(m.emphasis.liftDb)} dB, +${r1(m.emphasis.liftSt)} st)`);
  if (!l.question && words >= 4 && m.endingSt > 1.5) f.push(`statement ends rising (+${r1(m.endingSt)} st) — sounds unsure or listing`);
  if (prev && words >= 6 && Math.abs(m.rangeSt - prev.rangeSt) < 0.6 && Math.abs(m.endingSt - prev.endingSt) < 0.8 && Math.abs(m.melodySt - prev.melodySt) < 0.3) f.push("same shape as the line before (a run of identical lines reads synthetic)");
  return f;
}

export async function voiceAgent(o: VoiceAgentOptions): Promise<VoiceAgentReport> {
  const log = o.log ?? (() => {});
  const budget = o.budget ?? Math.max(2, Math.ceil(o.lines.length / 4));
  let current: LineMeasure[] = [];
  for (let i = 0; i < o.lines.length; i++) current.push(await o.measure(i));
  const typical = () => {
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    return { rangeSt: med(current.map((m) => m.rangeSt)), melodySt: med(current.map((m) => m.melodySt)) };
  };
  const flagsOf = (i: number, m = current[i]!) => deliveryFlags(o.lines[i]!, m, i ? current[i - 1]! : null, typical());
  const flagCount = () => o.lines.reduce((t, _, i) => t + flagsOf(i).length, 0);
  const flagsBefore = flagCount();
  const noticeMap = () => Object.fromEntries(o.lines.map((_, i) => [i, flagsOf(i)]).filter(([, f]) => (f as string[]).length)) as Record<number, string[]>;
  const noticesBefore = noticeMap();
  const heardLines = new Set<number>();
  const cands = new Map<number, Map<string, LineMeasure>>();
  const changed = new Set<number>();
  let retakes = 0, submitted: string | null = null, noteSaved = false, heard = 0;
  const row = (i: number, m = current[i]!) => `line ${i} [${o.lines[i]!.role}, ${o.lines[i]!.pace}] ${m.seconds.toFixed(1)} s, ${Math.round(m.wpm)} wpm, travel ${r1(m.rangeSt)} st, melody ${r1(m.melodySt)}, dynamics ${r1(m.dynamicsDb)} dB, ending ${m.endingSt > 0 ? "+" : ""}${r1(m.endingSt)} st${m.emphasis ? `, emphasis "${m.emphasis.word}" +${r1(m.emphasis.liftDb)} dB/+${r1(m.emphasis.liftSt)} st` : ""} — "${o.lines[i]!.text.slice(0, 110)}"`;
  const contourText = (m: LineMeasure) => m.contour.map(([w, st, db]) => `${w}(${st > 0 ? "+" : ""}${r1(st)}st ${db > 0 ? "+" : ""}${r1(db)}dB)`).join(" ");

  const tools: AgentTool[] = [
    {
      name: "read_delivery",
      description: "Every line as measured from its take: length, pace, pitch travel, melody, dynamics, how it ends, whether the emphasis landed — and what a listener would notice. Plus the whole narration against the channel's narrator.",
      schema: z.object({}),
      run: (async () => {
        const t = typical();
        const all = o.lines.map((_, i) => { const f = flagsOf(i); return `${row(i)}${f.length ? `\n    ! ${f.join("; ")}` : ""}`; });
        const nar = o.narrator ? `The channel's narrator over a whole film: pitch travel ${o.narrator.f0RangeSt ?? "?"} st, melody ${o.narrator.melodySt ?? "?"} st, ${o.narrator.wpm ?? "?"} wpm (our voice keeps its own natural pace).` : "";
        return `${all.join("\n")}\n\nTypical line: travel ${r1(t.rangeSt)} st, melody ${r1(t.melodySt)}. ${flagCount()} thing(s) a listener would notice. Retakes left: ${budget - retakes}.\n${nar}`;
      }) as AgentTool["run"],
    },
    {
      name: "hear_line",
      description: "One line in detail: its measures and the word-by-word contour (each word's pitch in semitones from the line's median and its level in dB from the line's mean) — where the voice lifts, where it falls, which word it leans on. Also any candidate retakes of it.",
      schema: z.object({ line: z.number().int().min(0) }),
      run: (async (i: { line: number }) => {
        const m = current[i.line];
        if (!m) return `no line ${i.line}`;
        heard++;
        heardLines.add(i.line);
        const c = [...(cands.get(i.line) ?? new Map()).entries()].map(([id, cm]) => `candidate ${id}: ${row(i.line, cm)}\n  contour: ${contourText(cm)}\n  notices: ${flagsOf(i.line, cm).join("; ") || "none"}`);
        return `${row(i.line)}\n  contour: ${contourText(m)}\n  notices: ${flagsOf(i.line).join("; ") || "none"}${c.length ? `\n\n${c.join("\n\n")}` : ""}`;
      }) as AgentTool["run"],
    },
    {
      name: "retake",
      description: "Have the voice read a line again (a fresh take), optionally leaning on a different word (emphasis). The new take is a candidate; compare it with hear_line and choose_take. Each costs characters — there is a budget.",
      schema: z.object({ line: z.number().int().min(0), emphasis: z.string().optional(), why: z.string() }),
      run: (async (i: { line: number; emphasis?: string; why: string }) => {
        if (!o.lines[i.line]) return `no line ${i.line}`;
        if (!heardLines.has(i.line)) return `refused: hear_line ${i.line} first — retake only what you have listened to`;
        if (retakes >= budget) return `refused: the retake budget (${budget}) is spent — choose among the takes you have, then submit`;
        if (i.emphasis && !o.lines[i.line]!.text.toLowerCase().includes(i.emphasis.toLowerCase())) return `"${i.emphasis}" is not a word of that line`;
        retakes++;
        const r = await o.retake(i.line, i.emphasis ? { emphasis: i.emphasis } : {});
        (cands.get(i.line) ?? cands.set(i.line, new Map()).get(i.line)!).set(r.id, r.m);
        return `candidate ${r.id}: ${row(i.line, r.m)}\n  contour: ${contourText(r.m)}\n  notices: ${flagsOf(i.line, r.m).join("; ") || "none"}\nCurrent take for comparison: ${row(i.line)} — notices: ${flagsOf(i.line).join("; ") || "none"}`;
      }) as AgentTool["run"],
    },
    {
      name: "choose_take",
      description: "Make a candidate the line's take.",
      schema: z.object({ line: z.number().int().min(0), id: z.string() }),
      run: (async (i: { line: number; id: string }) => {
        const m = cands.get(i.line)?.get(i.id);
        if (!m) return `no candidate ${i.id} for line ${i.line}`;
        await o.choose(i.line, i.id);
        current[i.line] = m;
        changed.add(i.line);
        return `line ${i.line} now uses ${i.id}. ${flagCount()} thing(s) a listener would notice across the narration.`;
      }) as AgentTool["run"],
    },
    {
      name: "submit_delivery",
      description: "Hand over the narration's delivery. Refused until you have heard at least three lines in detail.",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        if (heard < 3) return `refused: hear at least three lines in detail first (${heard} so far)`;
        submitted = i.note;
        return "Accepted. If this narration taught you something, call note_lesson once; then stop.";
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's voice director.",
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
  const skill = await readFile(new URL("../skills/voice.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const system = [cached(skill), plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}Retake budget for this narration: ${budget} line(s).`)];
  log(`  voice director (listening): ${o.lines.length} lines, ${flagsBefore} notice(s), budget ${budget} retake(s)…`);
  let grace = 1;
  const run = await agentLoop({ stage: "voice.agent", model: ROLE_MODEL.voiceDirector, system, user: `Listen to the narration of "${o.title}" and fix the delivery where a listener would notice. Start with read_delivery.`, tools, effort: "medium", maxTurns: 16, maxSeconds: 240, maxTokens: 16000, done: () => submitted !== null && (noteSaved || grace-- <= 0), nudge: "Not submitted yet. Read the delivery, hear the lines that were flagged, retake or keep, and submit.", log });
  const flagsAfter = flagCount();
  const report: VoiceAgentReport = { retakes, changed: [...changed].sort((a, b) => a - b), flagsBefore, flagsAfter, notices: { before: noticesBefore, after: noticeMap() }, note: submitted ?? "not submitted", agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.title.slice(0, 60)}": notices ${flagsBefore} → ${flagsAfter}; ${retakes} retake(s), ${changed.size} line(s) changed; ${(submitted ?? "").slice(0, 200).replace(/\s+/g, " ")}\n`);
  }
  log(`  voice director (listening): notices ${flagsBefore} → ${flagsAfter}, ${retakes} retake(s), ${changed.size} line(s) changed, $${report.agent.usd}`);
  void current;
  current = [];
  return report;
}
