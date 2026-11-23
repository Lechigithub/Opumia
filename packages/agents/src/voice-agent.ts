/**
 * The voice director as an agent that hears its own takes (build list B7; build list 5, items 23–24). The one-call
 * voice director (voice-director.ts) marks pauses, emphasis and risky words before the first takes. This agent then
 * listens to every take — measured, because the model cannot hear audio: pitch travel and melody, whether the stressed
 * word really lifts, how a statement ends (it falls), pauses inside a sentence where a speaker would run on, runs of
 * lines with the same shape, and the colour of each act — and fixes what a listener would notice.
 *
 * Build list 5, item 23: these delivery problems are BLOCKING. The agent cannot submit while one is open on a line it
 * has not tried to fix at least twice. It fixes them without ever touching the pace (speed stays 1.0): a fresh take,
 * the stress moved, a tone direction for the take, a falling ending, the line's punctuation re-set for speech (words
 * unchanged), or the writer asked to reword the line. What is still open after that is reported as unresolved.
 * Build list 5, item 24: the agent plans a colour per act (dry, grave, wry, urgent, warm) and the acts are checked by
 * ear: their measured pitch, travel and dynamics must differ the way the plan says, and a story told in one colour
 * from start to end is itself a problem.
 *
 * Judged on sounding human only — never against the reference narrator's speed or pause count (owner, 2026-11-23).
 *
 *  skill    packages/agents/skills/voice.md
 *  tools    read_delivery, hear_line, plan_tone, hear_acts, retake, adjust_punctuation, ask_writer, choose_take,
 *           submit_delivery, note_lesson
 *  memory   <memoryDir>/<channel>.md, owner-notes.md (data/agents/voice/)
 */
import { readMemory } from "./lessons.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import type { Band } from "./channel-profile.js";
import { agentLoop, cached, plain, type AgentTool, ROLE_MODEL } from "./llm.js";

export interface LineMeasure {
  seconds: number;
  wpm: number;
  /** median pitch of the line (Hz) — for the colour of an act */
  f0Hz?: number;
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
  /** item 23: pauses of ≥ 0.25 s inside a sentence after a word with no punctuation — where a speaker runs on */
  innerPauses?: Array<{ after: string; gapS: number }>;
  /** ears: how human the take sounds (trained voice taste, 0–1) and the real narrators' lowest tenth */
  humanness?: { score: number; realP10: number };
}
export const TONES = ["dry", "grave", "wry", "urgent", "warm"] as const;
export type Tone = (typeof TONES)[number];
export interface VoiceLine { text: string; role: string; pace: string; emphasis: string; question: boolean; /** item 24: the act this line belongs to (0-based) */ act?: number }
export interface RetakeDirection { emphasis?: string; tone?: Tone; /** the statement must end falling (the take is made without a continuation after it) */ fall?: boolean }
export interface VoiceAgentReport {
  retakes: number;
  changed: number[];
  flagsBefore: number;
  flagsAfter: number;
  notices: { before: Record<number, string[]>; after: Record<number, string[]> };
  /** item 23: blocking delivery problems still open after the agent, by line */
  unresolved: Record<number, string[]>;
  /** item 24: the colour planned per act and whether the acts were heard that way */
  tone: { plan: Array<{ act: number; tone: Tone; why: string }>; heard: Array<{ act: number; tone: Tone | null; f0St: number; rangeSt: number; dynamicsDb: number; melodySt: number; asPlanned: boolean | null }>; oneColour: boolean } | null;
  punctuation: Array<{ line: number; from: string; to: string }>;
  reworded: Array<{ line: number; from: string; to: string }>;
  measures: Record<string, number>;
  note: string;
  agent: { turns: number; calls: Record<string, number>; usd: number };
}

export interface VoiceAgentOptions {
  channel: string;
  title: string;
  lines: VoiceLine[];
  /** The channel narrator's expressiveness (exemplars) — context only, never a pace target. */
  narrator?: { f0RangeSt?: number; melodySt?: number; wpm?: number } | null;
  /** Measure the current take of a line. */
  measure: (i: number) => Promise<LineMeasure>;
  /** Make a new take of a line (a fresh seed; optionally another stressed word, a tone, a falling end). A candidate, not yet chosen. */
  retake: (i: number, o: RetakeDirection) => Promise<{ id: string; m: LineMeasure }>;
  /** Make a candidate take the line's take. */
  choose: (i: number, id: string) => Promise<void>;
  /** item 23: re-set a line's punctuation for speech (the words are unchanged; checked in code). Makes a candidate take. */
  repunctuate?: (i: number, text: string) => Promise<{ id: string; m: LineMeasure }>;
  /** item 23: ask the writer to reword a line for speech (same facts). Returns the new line text and a candidate take, or null. */
  reword?: (i: number, why: string) => Promise<{ id: string; text: string; m: LineMeasure } | null>;
  budget?: number;
  memoryDir?: string;
  log?: (s: string) => void;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
const wordsOf = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);

/** The kinds of delivery problem a listener notices. Every one of them blocks submission (item 23). */
export const BLOCKING = ["rising_end", "stress_missed", "run_on_pause", "flat", "same_shape", "synthetic"] as const;

/** What a listener would notice in a line's delivery, as [kind, detail]. */
export function deliveryIssues(l: VoiceLine, m: LineMeasure, prev: LineMeasure | null, typical: { rangeSt: number; melodySt: number }): Array<[typeof BLOCKING[number], string]> {
  const f: Array<[typeof BLOCKING[number], string]> = [];
  const words = l.text.split(/\s+/).length;
  if (words >= 6 && m.rangeSt < typical.rangeSt * 0.6) f.push(["flat", `flat (pitch travel ${r1(m.rangeSt)} st, the line median ${r1(typical.rangeSt)})`]);
  if (m.emphasis && m.emphasis.liftDb < 0.5 && m.emphasis.liftSt < 0.5) f.push(["stress_missed", `emphasis on "${m.emphasis.word}" did not land (+${r1(m.emphasis.liftDb)} dB, +${r1(m.emphasis.liftSt)} st)`]);
  if (!l.question && words >= 4 && m.endingSt > 1.5) f.push(["rising_end", `statement ends rising (+${r1(m.endingSt)} st) — sounds unsure or listing`]);
  if (m.humanness && m.humanness.score < m.humanness.realP10) f.push(["synthetic", `sounds synthetic to the ear (humanness ${m.humanness.score} against real narrators' lowest tenth ${m.humanness.realP10}) — a fresh take with another tone, or the line re-set for speech`]);
  for (const p of m.innerPauses ?? []) f.push(["run_on_pause", `stops ${p.gapS.toFixed(2)} s after "${p.after}" in the middle of the sentence — a speaker would run on`]);
  if (prev && words >= 6 && Math.abs(m.rangeSt - prev.rangeSt) < 0.6 && Math.abs(m.endingSt - prev.endingSt) < 0.8 && Math.abs(m.melodySt - prev.melodySt) < 0.3) f.push(["same_shape", "same shape as the line before (a run of identical lines reads synthetic)"]);
  return f;
}
/** Back-compatible: the details only. */
export function deliveryFlags(l: VoiceLine, m: LineMeasure, prev: LineMeasure | null, typical: { rangeSt: number; melodySt: number }): string[] {
  return deliveryIssues(l, m, prev, typical).map(([, d]) => d);
}

/** Pauses inside a sentence after a word with no punctuation (item 23). `words` carry their written punctuation. */
export function runOnPauses(words: Array<{ word: string; startS: number; endS: number }>, minGapS = 0.25): Array<{ after: string; gapS: number }> {
  const out: Array<{ after: string; gapS: number }> = [];
  for (let k = 0; k + 1 < words.length; k++) {
    const w = words[k]!;
    if (/[.,;:!?…—–)"”'’-]$/.test(w.word)) continue;
    const gap = words[k + 1]!.startS - w.endS;
    if (gap >= minGapS) out.push({ after: w.word, gapS: Math.round(gap * 100) / 100 });
  }
  return out;
}

// ---- item 24: the colour of an act, heard

/** What each colour sounds like against the film's own average delivery (signs on the four measured dimensions). */
const TONE_SIGN: Record<Tone, Partial<Record<"f0St" | "rangeSt" | "dynamicsDb" | "melodySt", -1 | 1>>> = {
  grave: { f0St: -1, rangeSt: -1 },
  dry: { rangeSt: -1, melodySt: -1 },
  wry: { melodySt: 1 },
  urgent: { dynamicsDb: 1, f0St: 1 },
  warm: {},
};
const SCALE = { f0St: 1, rangeSt: 2, dynamicsDb: 1.5, melodySt: 0.6 } as const;
type ActVec = { f0St: number; rangeSt: number; dynamicsDb: number; melodySt: number };

export function actColours(lines: VoiceLine[], ms: LineMeasure[]): Array<{ act: number } & ActVec> {
  const film = med(ms.map((m) => m.f0Hz ?? 0).filter((x) => x > 0));
  const acts = [...new Set(lines.map((l) => l.act ?? 0))].sort((a, b) => a - b);
  const all = { rangeSt: med(ms.map((m) => m.rangeSt)), dynamicsDb: med(ms.map((m) => m.dynamicsDb)), melodySt: med(ms.map((m) => m.melodySt)) };
  return acts.map((a) => {
    const xs = ms.filter((_, i) => (lines[i]!.act ?? 0) === a);
    const f0 = med(xs.map((m) => m.f0Hz ?? 0).filter((x) => x > 0));
    return { act: a, f0St: r1(film && f0 ? 12 * Math.log2(f0 / film) : 0), rangeSt: r1(med(xs.map((m) => m.rangeSt)) - all.rangeSt), dynamicsDb: r1(med(xs.map((m) => m.dynamicsDb)) - all.dynamicsDb), melodySt: r1(med(xs.map((m) => m.melodySt)) - all.melodySt) };
  });
}
const dist = (a: ActVec, b: ActVec) => Math.sqrt((["f0St", "rangeSt", "dynamicsDb", "melodySt"] as const).reduce((t, k) => t + ((a[k] - b[k]) / SCALE[k]) ** 2, 0));
/** Spread of colour across the acts: the largest distance between two acts (0 with one act). */
export function toneVariety(v: ActVec[]): number {
  let d = 0;
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) d = Math.max(d, dist(v[i]!, v[j]!));
  return r3(d);
}
export function heardAs(t: Tone, v: ActVec): boolean | null {
  const s = TONE_SIGN[t];
  const ks = Object.keys(s) as Array<keyof ActVec>;
  if (!ks.length) return null;
  // the colour is heard when every dimension it moves goes the planned way by at least a fifth of its scale
  return ks.every((k) => (s[k]! > 0 ? v[k] >= SCALE[k] * 0.2 : v[k] <= -SCALE[k] * 0.2));
}
export const ONE_COLOUR_BELOW = 0.8;

/**
 * Build list 5, item 4: the voice's craft measures — human delivery only (never speed or pause counts against the
 * reference narrator). The same function scores any narration given its lines and their measured takes.
 */
export function voiceCraftMeasures(lines: VoiceLine[], ms: LineMeasure[]): Record<string, number> {
  const typical = { rangeSt: med(ms.map((m) => m.rangeSt)), melodySt: med(ms.map((m) => m.melodySt)) };
  const issues = lines.map((l, i) => deliveryIssues(l, ms[i]!, i ? ms[i - 1]! : null, typical));
  const statements = lines.filter((l) => !l.question && l.text.split(/\s+/).length >= 4).length;
  const stressed = ms.filter((m) => m.emphasis).length;
  const has = (k: string) => issues.filter((f) => f.some(([kind]) => kind === k)).length;
  const acts = actColours(lines, ms);
  return {
    risingEnds: r3(has("rising_end") / Math.max(1, statements)),
    landedStress: r3(stressed ? 1 - has("stress_missed") / stressed : 1),
    runOnPausesPerLine: r3(issues.reduce((t, f) => t + f.filter(([k]) => k === "run_on_pause").length, 0) / Math.max(1, lines.length)),
    flatLines: r3(has("flat") / Math.max(1, lines.length)),
    sameShape: r3(has("same_shape") / Math.max(1, lines.length)),
    ...(acts.length >= 2 ? { toneVariety: toneVariety(acts) } : {}),
  };
}

/**
 * The band a human delivery sits in (owner rule, 2026-11-23: judged on sounding human, not on the reference
 * narrator's numbers). A listener hears a rising statement end, a stress that does not land, or a stop in the middle
 * of a sentence at once; a few per film are tolerable, more are not.
 */
export const VOICE_DELIVERY_BAND: Record<string, Band> = {
  risingEnds: { p10: 0, median: 0.04, p90: 0.1 },
  landedStress: { p10: 0.75, median: 0.9, p90: 1 },
  runOnPausesPerLine: { p10: 0, median: 0.03, p90: 0.1 },
  flatLines: { p10: 0, median: 0.04, p90: 0.12 },
  sameShape: { p10: 0, median: 0.04, p90: 0.12 },
  toneVariety: { p10: ONE_COLOUR_BELOW, median: 1.4, p90: 4 },
};

export async function voiceAgent(o: VoiceAgentOptions): Promise<VoiceAgentReport> {
  const log = o.log ?? (() => {});
  let current: LineMeasure[] = [];
  for (let i = 0; i < o.lines.length; i++) current.push(await o.measure(i));
  const typical = () => ({ rangeSt: med(current.map((m) => m.rangeSt)), melodySt: med(current.map((m) => m.melodySt)) });
  const issuesOf = (i: number, m = current[i]!) => deliveryIssues(o.lines[i]!, m, i ? current[i - 1]! : null, typical());
  const flagsOf = (i: number, m = current[i]!) => issuesOf(i, m).map(([, d]) => d);
  const flagCount = () => o.lines.reduce((t, _, i) => t + flagsOf(i).length, 0);
  const flagsBefore = flagCount();
  const noticeMap = () => Object.fromEntries(o.lines.map((_, i) => [i, flagsOf(i)]).filter(([, f]) => (f as string[]).length)) as Record<number, string[]>;
  const noticesBefore = noticeMap();
  const flagged = Object.keys(noticesBefore).length;
  // item 23: the budget follows the problems — two attempts per flagged line, at least four
  // proof film (Blockbuster): 10 whole-line retakes ($0.55) fixed none of 12 flags — a retake re-rolls the take, it
  // cannot place a stress. One retake per flagged line at most; a stress that does not land goes to the writer
  // (reword: the word where the sentence lands) or to punctuation, never to more retakes.
  const budget = Math.min(o.budget ?? Infinity, o.lines.length, Math.max(2, flagged));
  const acts = [...new Set(o.lines.map((l) => l.act ?? 0))];
  const heardLines = new Set<number>();
  const cands = new Map<number, Map<string, LineMeasure>>();
  const tries = new Map<number, number>();
  const candText = new Map<string, string>();
  const changed = new Set<number>();
  const punct: VoiceAgentReport["punctuation"] = [];
  const reworded: VoiceAgentReport["reworded"] = [];
  let tonePlan: Array<{ act: number; tone: Tone; why: string }> | null = null;
  let actsHeard = false;
  let retakes = 0, submitted: string | null = null, noteSaved = false, heard = 0;
  const row = (i: number, m = current[i]!) => `line ${i} [${o.lines[i]!.role}${acts.length > 1 ? `, act ${o.lines[i]!.act ?? 0}` : ""}] ${m.seconds.toFixed(1)} s, travel ${r1(m.rangeSt)} st, melody ${r1(m.melodySt)}, dynamics ${r1(m.dynamicsDb)} dB, ending ${m.endingSt > 0 ? "+" : ""}${r1(m.endingSt)} st${m.emphasis ? `, emphasis "${m.emphasis.word}" +${r1(m.emphasis.liftDb)} dB/+${r1(m.emphasis.liftSt)} st` : ""}${m.innerPauses?.length ? `, stops inside: ${m.innerPauses.map((p) => `after "${p.after}" ${p.gapS}s`).join(", ")}` : ""} — "${o.lines[i]!.text.slice(0, 140)}"`;
  const contourText = (m: LineMeasure) => m.contour.map(([w, st, db]) => `${w}(${st > 0 ? "+" : ""}${r1(st)}st ${db > 0 ? "+" : ""}${r1(db)}dB)`).join(" ");
  const toneHeard = () => {
    const v = actColours(o.lines, current);
    return { v, variety: toneVariety(v), rows: v.map((a) => { const t = tonePlan?.find((p) => p.act === a.act)?.tone ?? null; return { act: a.act, tone: t, f0St: a.f0St, rangeSt: a.rangeSt, dynamicsDb: a.dynamicsDb, melodySt: a.melodySt, asPlanned: t ? heardAs(t, a) : null }; }) };
  };
  const oneColour = () => acts.length >= 2 && toneHeard().variety < ONE_COLOUR_BELOW;
  /** Lines with a blocking problem the agent has not yet tried twice to fix. */
  const openUntried = () => o.lines.map((_, i) => i).filter((i) => issuesOf(i).length && (tries.get(i) ?? 0) < 2);
  const addCand = (i: number, r: { id: string; m: LineMeasure }) => {
    (cands.get(i) ?? cands.set(i, new Map()).get(i)!).set(r.id, r.m);
    tries.set(i, (tries.get(i) ?? 0) + 1);
    return `candidate ${r.id}: ${row(i, r.m)}\n  contour: ${contourText(r.m)}\n  notices: ${flagsOf(i, r.m).join("; ") || "none"}\nCurrent take for comparison: ${row(i)} — notices: ${flagsOf(i).join("; ") || "none"}`;
  };

  const tools: AgentTool[] = [
    {
      name: "read_delivery",
      description: "Every line as measured from its take — pitch travel, melody, dynamics, how it ends, whether the stress landed, stops inside the sentence — and what a listener would notice. Every notice BLOCKS submission until you have tried to fix it.",
      schema: z.object({}),
      run: (async () => {
        const t = typical();
        const all = o.lines.map((_, i) => { const f = flagsOf(i); return `${row(i)}${f.length ? `\n    ! ${f.join("; ")}` : ""}`; });
        return `${all.join("\n")}\n\nTypical line: travel ${r1(t.rangeSt)} st, melody ${r1(t.melodySt)}. ${flagCount()} thing(s) a listener would notice on ${Object.keys(noticeMap()).length} line(s). Acts: ${acts.length}. Retakes left: ${budget - retakes}. The voice always speaks at its own natural pace — never fix by speed.`;
      }) as AgentTool["run"],
    },
    {
      name: "hear_line",
      description: "One line in detail: its measures and the word-by-word contour (each word's pitch in semitones from the line's median and its level in dB from the line's mean), and any candidate takes of it.",
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
      name: "plan_tone",
      description: "Plan the colour of each act (dry, grave, wry, urgent, warm), following the story: a human narrator shifts tone as the story turns. Required before submitting when the narration has more than one act.",
      schema: z.object({ acts: z.array(z.object({ act: z.number().int().min(0), tone: z.enum(TONES), why: z.string() })) }),
      run: (async (i: { acts: Array<{ act: number; tone: Tone; why: string }> }) => {
        const missing = acts.filter((a) => !i.acts.some((x) => x.act === a));
        if (missing.length) return `refused: plan every act (${acts.join(", ")}); missing ${missing.join(", ")}`;
        if (acts.length >= 2 && new Set(i.acts.map((a) => a.tone)).size < 2) return "refused: one colour for the whole story is the problem being fixed — give the acts the colours the story asks for";
        tonePlan = i.acts.filter((a) => acts.includes(a.act));
        return `Planned. Now hear_acts to check the takes carry it; retake an act's lines with its tone where they do not.`;
      }) as AgentTool["run"],
    },
    {
      name: "hear_acts",
      description: "Each act's colour as heard: median pitch (semitones from the film's), pitch travel, dynamics and melody against the film's own average, and whether that matches the planned colour.",
      schema: z.object({}),
      run: (async () => {
        actsHeard = true;
        const h = toneHeard();
        return `${h.rows.map((a) => `act ${a.act} (${a.tone ?? "no plan"}): pitch ${a.f0St > 0 ? "+" : ""}${a.f0St} st, travel ${a.rangeSt > 0 ? "+" : ""}${a.rangeSt} st, dynamics ${a.dynamicsDb > 0 ? "+" : ""}${a.dynamicsDb} dB, melody ${a.melodySt > 0 ? "+" : ""}${a.melodySt} — ${a.asPlanned === null ? "no measurable target" : a.asPlanned ? "heard as planned" : "NOT heard as planned"}`).join("\n")}\nSpread across acts ${h.variety} (one colour below ${ONE_COLOUR_BELOW}${oneColour() ? " — the story is told in ONE colour" : ""}).\nWhat each colour does here: grave = lower and less travel; dry = less travel and melody; wry = more melody; urgent = more dynamics and higher; warm = no fixed shape.`;
      }) as AgentTool["run"],
    },
    {
      name: "retake",
      description: "A new take of a line: optionally lean on a different word (emphasis), give the take a tone (dry, grave, wry, urgent, warm — it changes the voice's steadiness and expressiveness, never its speed), or make the statement end falling (fall). A candidate; compare with hear_line and choose_take. Each costs characters — there is a budget.",
      schema: z.object({ line: z.number().int().min(0), emphasis: z.string().optional(), tone: z.enum(TONES).optional(), fall: z.boolean().optional(), why: z.string() }),
      run: (async (i: { line: number; emphasis?: string; tone?: Tone; fall?: boolean; why: string }) => {
        if (!o.lines[i.line]) return `no line ${i.line}`;
        if (!heardLines.has(i.line)) return `refused: hear_line ${i.line} first — retake only what you have listened to`;
        if (retakes >= budget) return `refused: the retake budget (${budget}) is spent — choose among the takes you have, or re-set punctuation / ask the writer, then submit`;
        if (i.emphasis && !o.lines[i.line]!.text.toLowerCase().includes(i.emphasis.toLowerCase())) return `"${i.emphasis}" is not a word of that line`;
        if (flagsOf(i.line).length && flagsOf(i.line).every((f) => /did not land/.test(f))) return "refused: a retake re-rolls the take and cannot place a stress (measured on the proof film: 10 retakes, 0 stresses fixed). Use reword (the writer puts the word where the sentence lands) or repunctuate (end the sentence on the word).";
        retakes++;
        const r = await o.retake(i.line, { ...(i.emphasis ? { emphasis: i.emphasis } : {}), ...(i.tone ? { tone: i.tone } : {}), ...(i.fall ? { fall: true } : {}) });
        return addCand(i.line, r);
      }) as AgentTool["run"],
    },
    {
      name: "adjust_punctuation",
      description: "Re-set a line's punctuation for speech — a comma where the speaker should breathe, none where they should run on, a full stop instead of a listing comma so the statement falls. The WORDS must stay exactly the same (checked). Makes a candidate take.",
      schema: z.object({ line: z.number().int().min(0), text: z.string(), why: z.string() }),
      run: (async (i: { line: number; text: string; why: string }) => {
        const l = o.lines[i.line];
        if (!l) return `no line ${i.line}`;
        if (!o.repunctuate) return "not available here";
        if (wordsOf(i.text).join(" ") !== wordsOf(l.text).join(" ")) return "refused: only punctuation may change — the words must be identical, in the same order";
        if (retakes >= budget) return `refused: the retake budget (${budget}) is spent`;
        retakes++;
        const r = await o.repunctuate(i.line, i.text);
        punct.push({ line: i.line, from: l.text, to: i.text });
        candText.set(r.id, i.text);
        return addCand(i.line, r);
      }) as AgentTool["run"],
    },
    {
      name: "ask_writer",
      description: "Ask the writer to reword a line so it can be spoken naturally (same facts, about the same length) — for a line no take or punctuation can save. Makes a candidate take of the new line.",
      schema: z.object({ line: z.number().int().min(0), why: z.string() }),
      run: (async (i: { line: number; why: string }) => {
        const l = o.lines[i.line];
        if (!l) return `no line ${i.line}`;
        if (!o.reword) return "the writer is not reachable in this run";
        if ((tries.get(i.line) ?? 0) < 1) return "refused: try a retake or punctuation first — the writer is the last resort";
        const r = await o.reword(i.line, i.why);
        if (!r) return "the writer kept the line as it is";
        reworded.push({ line: i.line, from: l.text, to: r.text });
        candText.set(r.id, r.text);
        return addCand(i.line, r);
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
        const nt = candText.get(i.id);
        if (nt) o.lines[i.line] = { ...o.lines[i.line]!, text: nt, question: /\?\s*$/.test(nt) };
        changed.add(i.line);
        return `line ${i.line} now uses ${i.id}. ${flagCount()} thing(s) a listener would notice across the narration.`;
      }) as AgentTool["run"],
    },
    {
      name: "submit_delivery",
      description: "Hand over the narration's delivery. Refused while a line has a delivery problem you have not tried to fix twice, or (more than one act) before the tone is planned and heard.",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        if (heard < 3 && o.lines.length >= 3) return `refused: hear at least three lines in detail first (${heard} so far)`;
        if (acts.length >= 2 && !tonePlan) return "refused: plan_tone first — the acts need their colours";
        if (acts.length >= 2 && !actsHeard) return "refused: hear_acts first — check the takes carry the planned colours";
        const open = openUntried();
        if (open.length && retakes < budget) return `refused: these lines still have a problem a listener would notice and have not had two attempts: ${open.slice(0, 10).map((k) => `${k} (${flagsOf(k)[0]})`).join("; ")}`;
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
  const system = [cached(skill), plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}Retake budget for this narration: ${budget} take(s). Acts: ${acts.length}.`)];
  log(`  voice director (listening): ${o.lines.length} lines, ${acts.length} act(s), ${flagsBefore} notice(s) on ${flagged} line(s), budget ${budget} take(s)…`);
  let grace = 1;
  const run = await agentLoop({
    stage: "voice.agent", model: ROLE_MODEL.voiceDirector, system,
    user: `Listen to the narration of "${o.title}" and fix every delivery problem a listener would notice, without touching the pace.${acts.length >= 2 ? " Plan the colour of each act and check the takes carry it." : ""} Start with read_delivery.`,
    tools, effort: "medium", maxTurns: 30, maxSeconds: 420, maxTokens: 16000, maxUsd: 0.7, fixed: 0.1, firstPassUsd: 0.25,
    finish: { message: "Your budget for the voice is used up. Choose the best take you have for each line and call submit_delivery NOW; what is still open will be reported." },
    done: () => submitted !== null && (noteSaved || grace-- <= 0),
    nudge: "Not submitted yet. Read the delivery, fix the flagged lines (retake, punctuation, writer), plan and hear the acts' tone, and submit.",
    log,
  });
  const flagsAfter = flagCount();
  const unresolved = noticeMap();
  const h = acts.length >= 2 ? toneHeard() : null;
  const report: VoiceAgentReport = {
    retakes, changed: [...changed].sort((a, b) => a - b), flagsBefore, flagsAfter, notices: { before: noticesBefore, after: unresolved }, unresolved,
    tone: h ? { plan: tonePlan ?? [], heard: h.rows, oneColour: oneColour() } : null,
    punctuation: punct, reworded, measures: voiceCraftMeasures(o.lines, current),
    note: submitted ?? "not submitted", agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 },
  };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.title.slice(0, 60)}": notices ${flagsBefore} → ${flagsAfter}; ${retakes} take(s), ${changed.size} line(s) changed${report.tone ? `; tone ${report.tone.plan.map((p) => p.tone).join("/") || "unplanned"}${report.tone.oneColour ? " (heard as one colour)" : ""}` : ""}; ${(submitted ?? "").slice(0, 200).replace(/\s+/g, " ")}\n`);
  }
  log(`  voice director (listening): notices ${flagsBefore} → ${flagsAfter}, ${retakes} take(s), ${changed.size} line(s) changed${report.tone ? `, tone ${report.tone.oneColour ? "ONE COLOUR" : "varied"}` : ""}, $${report.agent.usd}${Object.keys(unresolved).length ? ` — UNRESOLVED on ${Object.keys(unresolved).length} line(s)` : ""}`);
  current = [];
  return report;
}
