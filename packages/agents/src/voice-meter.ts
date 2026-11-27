// The voice meter: how a passage is built, against the channel's own narration (2026-11-27). The script referee showed
// our scripts read as machine-written; comparing sentences showed why (MagnatesMedia, 6,789 sentences, against ours):
// typical sentence 20 words (ours 15), a third of sentences 25+ words (ours 15 %), a figure in 1 sentence in 6 (ours 1
// in 3), a question in 1 in 50 (ours 1 in 12), the narrator commenting in the present in about 1 in 4, spoken
// connectors ("of course", "in fact", "actually", "just", "also"…), little "had" / "later" timeline stepping.
// The bands are measured on 300-word stretches of the films the writer may study (never the held-back ones); the meter
// is code, instant and free, so the writer can tune every paragraph against exact targets.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface VoiceStats { sentence: number; long: number; figures: number; questions: number; present: number; connectors: number; stepping: number }
export type VoiceBand = Record<keyof VoiceStats, { lo: number; mid: number; hi: number }>;

const PRESENT = /\b(is|are|isn't|aren't|has|have|can|can't|does|do|don't|doesn't|means|makes|works|gets|it's|that's|they're|there's|you're|we're|would|wouldn't)\b/i;
const CONNECTORS = /\b(of course|in fact|actually|just|also|however|basically|essentially|obviously|really|even|still|now|so|but|and so|which means)\b/gi;
const STEPPING = /\b(had|later|afterward|afterwards|subsequently|previously)\b/gi;
const sentences = (t: string) => t.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

export function voiceStats(text: string): VoiceStats {
  const ss = sentences(text);
  const n = Math.max(1, ss.length), w = Math.max(1, words(text));
  const L = ss.map(words).sort((a, b) => a - b);
  return {
    sentence: L.length ? L[Math.floor(L.length / 2)]! : 0,
    long: ss.filter((s) => words(s) >= 25).length / n,
    figures: ss.filter((s) => /\d/.test(s)).length / n,
    questions: ss.filter((s) => s.endsWith("?")).length / n,
    present: ss.filter((s) => PRESENT.test(s) && !/\d/.test(s)).length / n,
    connectors: ((text.match(CONNECTORS) ?? []).length / w) * 100,
    stepping: ((text.match(STEPPING) ?? []).length / w) * 100,
  };
}

const pct = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q, l = Math.floor(i); return s[l]! + (s[Math.ceil(i)]! - s[l]!) * (i - l); };
/** The channel's band on 300-word stretches (10th–90th percentile: where 8 in 10 of its own stretches sit; the middle as the target), built once. */
export function voiceBand(o: { data: string; channel?: string; films: Array<{ id: string; lines: string[] }>; held?: Set<string> }): VoiceBand {
  const f = path.join(o.data, "story-profile", `${o.channel ?? "magnates-media"}-voice.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as VoiceBand;
  const rows: VoiceStats[] = [];
  for (const film of o.films) {
    if (o.held?.has(film.id)) continue;
    const ws = film.lines.join(" ").split(/\s+/);
    for (let i = 0; i + 300 <= ws.length; i += 300) rows.push(voiceStats(ws.slice(i, i + 300).join(" ")));
  }
  const keys = Object.keys(rows[0] ?? {}) as Array<keyof VoiceStats>;
  const band = Object.fromEntries(keys.map((k) => { const xs = rows.map((r) => r[k]); return [k, { lo: Math.round(pct(xs, 0.1) * 1000) / 1000, mid: Math.round(pct(xs, 0.5) * 1000) / 1000, hi: Math.round(pct(xs, 0.9) * 1000) / 1000 }]; })) as VoiceBand;
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(band, null, 1));
  renameSync(`${f}.tmp`, f);
  return band;
}

const LABEL: Record<keyof VoiceStats, [string, (x: number) => string, string, string]> = {
  sentence: ["typical sentence", (x) => `${Math.round(x)} words`, "write longer, flowing sentences that carry one thought with its aside", "break up some long sentences"],
  long: ["sentences of 25+ words", (x) => `${Math.round(x * 100)} %`, "let more sentences run on, joined with and, but, as, because", "fewer very long sentences"],
  figures: ["sentences with a figure", (x) => `${Math.round(x * 100)} %`, "", "keep only the figures the story turns on; tell the rest without numbers"],
  questions: ["questions", (x) => `${Math.round(x * 100)} %`, "", "make most questions statements; the channel asks rarely"],
  present: ["the narrator commenting in the present", (x) => `${Math.round(x * 100)} %`, "step out of the story more: say what it means, now (\"It's crazy really, as…\", \"No one would have blamed him\")", "stay in the story more"],
  connectors: ["spoken connectors per 100 words (of course, in fact, actually, just, also…)", (x) => x.toFixed(1), "let the narrator talk: of course, in fact, actually, just, also, even, still", "fewer connectors"],
  stepping: ["timeline stepping per 100 words (had, later…)", (x) => x.toFixed(1), "", "tell it forwards in the simple past; drop had / later"],
};
/** The meter in the writer's words: each measure against the channel's band, what to change where it is outside. */
export function voiceReport(s: VoiceStats, b: VoiceBand): string {
  const rows = (Object.keys(LABEL) as Array<keyof VoiceStats>).map((k) => {
    const [name, fmt, up, down] = LABEL[k], v = s[k], { lo, mid, hi } = b[k];
    const out = v < lo && up ? ` — LOW: ${up}` : v > hi && down ? ` — HIGH: ${down}` : "";
    return `   · ${name}: ${fmt(v)} (the channel ${fmt(lo)}–${fmt(hi)}, typically ${fmt(mid)})${out}`;
  });
  return `- how it is built, against the channel's own narration (the voice meter):\n${rows.join("\n")}`;
}
export function voiceOff(s: VoiceStats, b: VoiceBand): Array<keyof VoiceStats> {
  return (Object.keys(LABEL) as Array<keyof VoiceStats>).filter((k) => (s[k] < b[k].lo && LABEL[k][2]) || (s[k] > b[k].hi && LABEL[k][3]));
}
/** The targets, for a writer's instructions. */
export function voiceTargets(b: VoiceBand): string {
  return `The channel's voice, measured on its own narration (aim for the typical value): a typical sentence of ${Math.round(b.sentence.mid)} words with about ${Math.round(b.long.mid * 100)} % of sentences running 25+ words; a figure in about ${Math.round(b.figures.mid * 100)} % of sentences; questions in about ${Math.round(b.questions.mid * 100)} %; the narrator commenting in the present in about ${Math.round(b.present.mid * 100)} %; about ${b.connectors.mid.toFixed(1)} spoken connectors per 100 words; almost no "had" or "later".`;
}
