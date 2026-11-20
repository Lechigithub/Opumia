import { CONTRAST, TENSION } from "./style-pack.js";

const FILLER_RE = /(untouchable\?|not for long|but (that|this) was (just|only) the beginning|little did (they|he|she) know|and that'?s when everything changed|buckle up|but there was (just )?one problem)/i;

/** Structural critique of a narration draft against the channel's measured narrative devices. */
export interface NarrativeIssue {
  kind: "chronological_open" | "late_hook_question" | "flat_stretch" | "bare_number" | "choppy_prose" | "number_dump" | "filler" | "date_list";
  where: string;
  detail: string;
}

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/** Sentence split that keeps decimals ("62.5"), "$7.2" and abbreviations like "U.S." intact. */
export const sentencesOf = (t: string) => t.split(/(?<=[.?!]["”']?)\s+(?=["“']?[A-Z0-9$€£])/).map((x) => x.trim()).filter(Boolean);
const NUMBER = /(\$|€|£)?\d[\d,.]*\s?(%|percent|billion|million|trillion|thousand)?/i;
const YEAR = /\b(1[5-9]\d\d|20\d\d)\b/;

/**
 * Checks (long-form; shorts get the first two):
 *  - the first sentence must not open chronologically (an old founding date) — open in media res;
 *  - the cold open (first ~30 s) must contain a question or tension turn ("how did this happen?");
 *  - no stretch longer than `maxGapS` without a tension turn (reversal, question, cliffhanger) or hook-ish beat;
 *  - numbers should be framed by contrast/scale (rival, per-person, multiple) — at most a third bare.
 */
export function critiqueNarrative(segs: Array<{ role: string; text: string }>, wpm: number, o: { short: boolean; maxGapS?: number; storyEndYear?: number }): NarrativeIssue[] {
  const issues: NarrativeIssue[] = [];
  const maxGap = o.maxGapS ?? 30;
  const sents: Array<{ t: number; text: string; seg: number; role: string }> = [];
  let t = 0;
  segs.forEach((sg, i) => {
    for (const s of sentencesOf(sg.text)) {
      sents.push({ t, text: s, seg: i + 1, role: sg.role });
      t += (countWords(s) / wpm) * 60;
    }
  });
  // In media res: the cold open (first 30 s) must not tell the origin — no old founding/birth date before the thesis.
  const years = sents.flatMap((s) => [...s.text.matchAll(/\b(1[5-9]\d\d|20\d\d)\b/g)].map((m) => Number(m[1])));
  const latest = o.storyEndYear ?? (years.length ? Math.max(...years) : new Date().getFullYear());
  const thesisAt = sents.find((x) => x.role === "thesis")?.t ?? 36;
  const origin = sents.find((s) => s.t < Math.min(36, thesisAt) && s.role !== "thesis" && /\b(born|founded|began|begins|started|starts|was established|set up|opened its doors)\b/i.test(s.text) && [...s.text.matchAll(/\b(1[5-9]\d\d|20\d\d)\b/g)].some((m) => Number(m[1]) < latest - 15));
  if (origin)
    issues.push({ kind: "chronological_open", where: `segment ${origin.seg}`, detail: `the cold open tells the origin ("${origin.text.slice(0, 90)}"). Open in media res — the peak, the paradox, the stakes — and save the origin for after the thesis.` });
  const open = sents.filter((s) => s.t < 30);
  if (!open.some((s) => /\?["”']?$/.test(s.text) || TENSION.test(s.text)))
    issues.push({ kind: "late_hook_question", where: "cold open", detail: "the first 30 s never turns: add the contradiction and a 'how did this happen?' style question before the thesis." });
  // Prose shape vs the reference (median 19 words; ≤ 6-word sentences 6 %; digits in 16 % of sentences).
  const lens = sents.map((x) => countWords(x.text)).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)] ?? 0;
  const tiny = lens.filter((n) => n <= 6).length / Math.max(1, lens.length);
  if (sents.length >= 8 && (median < 15 || tiny > 0.15))
    issues.push({ kind: "choppy_prose", where: "whole script", detail: `median sentence ${median} words, ${Math.round(tiny * 100)}% of sentences ≤ 6 words (reference: 19 words, 6%). Merge fragments into connected consequence chains.` });
  const digitShare = sents.filter((x) => /\d/.test(x.text)).length / Math.max(1, sents.length);
  if (sents.length >= 8 && digitShare > 0.3)
    issues.push({ kind: "number_dump", where: "whole script", detail: `${Math.round(digitShare * 100)}% of sentences carry a figure (reference: 16%). Keep the decisive numbers, bundle them into contrast sentences, cut the rest.` });
  const fill = sents.filter((x) => FILLER_RE.test(x.text));
  if (fill.length) issues.push({ kind: "filler", where: fill.map((f) => `segment ${f.seg}`).join(", "), detail: `stock filler re-hooks: ${fill.map((f) => `"${f.text.slice(0, 50)}"`).join("; ")}. Replace with a real consequence or question from the facts.` });
  let run = 0;
  for (const x of sents) {
    run = /^(In|By|On|At the end of|After|Between)\b[^.]{0,40}\b(1[5-9]\d\d|20\d\d)\b/.test(x.text) ? run + 1 : 0;
    if (run === 3) {
      issues.push({ kind: "date_list", where: `segment ${x.seg}`, detail: `three date-led sentences in a row ending "${x.text.slice(0, 60)}" — a timeline list. Rewrite as a consequence chain.` });
      break;
    }
  }
  if (!o.short) {
    const HOOKISH = new Set(["cold_open", "hook", "rehook", "twist"]);
    const marks = sents.filter((s) => TENSION.test(s.text) || /\?["”']?$/.test(s.text) || (HOOKISH.has(s.role) && s === sents.find((x) => x.seg === s.seg)));
    const pts = [0, ...marks.map((m) => m.t), t];
    for (let k = 1; k < pts.length; k++) {
      if (pts[k]! - pts[k - 1]! > maxGap) {
        const from = sents.find((s) => s.t >= pts[k - 1]!);
        const to = [...sents].reverse().find((s) => s.t <= pts[k]!);
        issues.push({ kind: "flat_stretch", where: `segments ${from?.seg}–${to?.seg}`, detail: `~${Math.round(pts[k]! - pts[k - 1]!)} s without a cliffhanger, reversal or question (starting "${from?.text.slice(0, 60)}…").` });
      }
    }
    const numeric = sents.filter((s) => NUMBER.test(s.text) && /\d/.test(s.text) && !YEAR.test(s.text.replace(/[^\d\s]/g, " ").trim()));
    const bare = numeric.filter((s) => !CONTRAST.test(s.text));
    if (numeric.length >= 4 && bare.length === numeric.length)
      issues.push({ kind: "bare_number", where: `${bare.length}/${numeric.length} number lines`, detail: `numbers are mostly bare: frame them against a rival, per person, a multiple or a lifetime (e.g. ${bare.slice(0, 2).map((b) => `"${b.text.slice(0, 70)}"`).join(", ")}).` });
  }
  return issues;
}
