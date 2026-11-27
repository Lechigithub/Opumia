// The script referee (tools/referee/script_referee.py): does a narration read like the channel's? A topic-free style
// fingerprint proven on six held-back channel narrations (2026-11-27): held-back windows flagged 2 %, ours caught 86 %,
// cheap tricks on never-seen scripts 84 %; whole held-back narrations 0.95–0.99, their 90 s openings 0.75–1.00.
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ScriptVerdict { score: number; bar: number; pass: boolean; windows: number[]; weakWindows: number[]; structure: number; gaps: Array<{ what: string; ours: number; channel: number; more: boolean; push: number }>; cut?: Array<{ word: string; ours: number; channel: number; times: number }>; weakest?: Array<{ from: number; to: number; score: number; cut: string[]; craft: string[] }> }
// Blocking since 2026-11-27: with it the writer reached the bar on all three test topics ($0.35–0.58 a script); the
// two tricks it found (one opening formula, names repeated for pronouns) are now refused or trained against.
// OPUMIA_SCRIPT_REFEREE_BLOCK=0 turns it into a report only (tests).
export const SCRIPT_REFEREE_BLOCKS = process.env.OPUMIA_SCRIPT_REFEREE_BLOCK !== "0";

const modelFile = (data: string, channel: string) => path.join(data, "referee", `${channel}-script.json`);
/** The narrations held back from the referee's training: the writer may not read them either. */
export function heldBackScripts(data: string, channel = "magnates-media"): Set<string> {
  try { return new Set((JSON.parse(readFileSync(modelFile(data, channel), "utf8")) as { held: string[] }).held); } catch { return new Set(); }
}
export function scriptReferee(root: string, text: string, channel = "magnates-media"): ScriptVerdict | null {
  const data = path.join(root, "data");
  if (channel !== "magnates-media" || !existsSync(modelFile(data, channel))) return null;
  const py = process.env.OPUMIA_PY ?? path.join(process.env.HOME ?? "", "lechi_tts", "venv", "bin", "python");
  const d = mkdtempSync(path.join(tmpdir(), "sref-")), f = path.join(d, "script.txt");
  try {
    writeFileSync(f, text);
    const r = spawnSync(py, ["-I", path.join(root, "tools", "referee", "script_referee.py"), "score", f], { encoding: "utf8", timeout: 60_000 });
    const v = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1) ?? "null") as ScriptVerdict | { error: string } | null;
    return v && "score" in v ? v : null;
  } catch { return null; } finally { rmSync(d, { recursive: true, force: true }); }
}
/** The referee's verdict in the writer's words: the score, the bar and what pulls the script away from the channel. */
export function scriptRefereeReport(v: ScriptVerdict): string {
  const gap = (g: ScriptVerdict["gaps"][number]) => `${g.what}: ${g.more ? "more" : "less"} than the channel (yours ${g.ours}, the channel ${g.channel})`;
  return `- reads like the channel (the script referee, proven on held-back channel narrations): ${v.score} (bar ${v.bar}) — ${v.pass ? "yes" : "NOT YET"}${v.gaps.length ? `\n  what pulls it away from the channel, strongest first:\n${v.gaps.map((g) => `   · ${gap(g)}`).join("\n")}` : ""}${v.cut?.length ? `\n  in the weak stretches you use these words far more than the channel does — CUT them by rewriting those sentences (never add words to please this measure): ${v.cut.map((c) => `"${c.word}" ${c.times}×`).join(", ")}` : ""}${v.weakest?.length && v.weakest.length > 1 ? `\n  the weakest stretches, worst first (rewrite these; never add words to please the measure):\n${v.weakest.map((w) => `   · words ${w.from}–${w.to} (${w.score})${w.cut.length ? `: cut ${w.cut.map((x) => `"${x}"`).join(", ")}` : ""}${w.craft.length ? `${w.cut.length ? ";" : ":"} ${w.craft.join(", ")}` : ""}`).join("\n")}` : ""}${v.weakWindows.length && !(v.weakest && v.weakest.length > 1) ? `\n  weakest stretches: words ${v.weakWindows.map((i) => `${i * 50}–${i * 50 + 100}`).join(", ")}` : ""}`;
}

// ---- openings: the blocking run (2026-11-27) opened all three scripts "It's a [time] in [place], and…" — the writer
// found a shape the referee liked and used it everywhere. Our accepted openings are kept in a ledger, and an opening
// built like recent ones is refused (the channel's own openings vary: a quote, a question, a figure, a moment).
export interface OpeningEntry { topic: string; first: string; shape: string; at: string }
const ARTICLE = /^(a|an|the|this|that|one)$/;
/** The opening's build: its first two words, articles folded together ("It's a Thursday…" and "It's the night…" match). */
export function openingShape(text: string): string {
  const first = (text.trim().split(/(?<=[.?!])\s+/)[0] ?? "").toLowerCase().replace(/[“”"]/g, "");
  const w = first.match(/[a-z']+|\d+/g) ?? [];
  return w.slice(0, 2).map((x) => (ARTICLE.test(x) ? "ART" : /^\d/.test(x) ? "#" : x)).join(" ");
}
const WHEN = /\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|evening|night|afternoon|day|\d{4}s?|\d{1,2}(st|nd|rd|th))\b/;
/** The kind of opening: "when" when it opens on a date or a time of day within its first six words (our scripts had
 *  "One August morning…", "One Thursday in June…", "On a Monday in November…" in a row). */
export function openingKind(text: string): string {
  const first = (text.trim().split(/(?<=[.?!])\s+/)[0] ?? "").toLowerCase();
  return WHEN.test((first.match(/[a-z']+|\d+\w*/g) ?? []).slice(0, 6).join(" ")) ? "when" : "";
}
export function openingsLedger(memoryDir: string, channel: string): OpeningEntry[] {
  const f = path.join(memoryDir, `${channel}.openings.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as OpeningEntry]; } catch { return []; } });
}
/** Why this opening repeats a recent one (null when it is its own): the same build as two of the last eight
 *  openings on other topics, or as the last one. */
export function openingFormula(text: string, topic: string, ledger: OpeningEntry[]): string | null {
  const shape = openingShape(text);
  if (!shape) return null;
  const recent = ledger.filter((e) => e.topic !== topic).slice(-8);
  const kind = openingKind(text);
  const sameKind = kind ? recent.filter((e) => openingKind(e.first) === kind) : [];
  if (sameKind.length >= 3) return `your opening starts on a date or a time of day, like ${sameKind.length} of our last ${recent.length} openings (${sameKind.slice(-3).map((e) => `"${e.first.slice(0, 60)}"`).join(" | ")}) — our formula, not the channel's (4 of its 30 openings do). Open this story another way: the channel opens on a quotation, a question, a figure, a claim, a scene without a timestamp — whatever this story's strongest first moment is`;
  const same = recent.filter((e) => e.shape === shape);
  if (same.length >= 2 || (recent.at(-1)?.shape === shape)) return `your opening is built like ${same.length} of our recent openings ("${shape.replace("ART", "a/the")} …": ${same.slice(-3).map((e) => `"${e.first.slice(0, 70)}"`).join(" | ")}) — a formula reads as ours, not the channel's. Open this story its own way: the channel opens on a quotation, a question, a figure, a scene, a claim about the viewer — whatever this story's strongest first moment is`;
  return null;
}
