import type { TimedScript } from "@opumia/contracts";

export interface CaptionGroupOut {
  startS: number;
  endS: number;
  words: Array<{ text: string; startS: number; endS: number }>;
}

/** Group words into short caption chunks (≤ maxWords, break on punctuation / pauses). */
export function captionGroups(script: TimedScript, maxWords = 3, maxChars = 20): CaptionGroupOut[] {
  const words = script.segments.flatMap((s) => s.words);
  const groups: CaptionGroupOut[] = [];
  let cur: CaptionGroupOut | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const text = w.word.replace(/^["“(]+|["”)]+$/g, "");
    const chars = cur ? cur.words.map((x) => x.text).join(" ").length + 1 + text.length : text.length;
    const gap = cur ? w.startS - cur.words[cur.words.length - 1]!.endS : 0;
    if (!cur || cur.words.length >= maxWords || chars > maxChars || gap > 0.35) {
      if (cur) groups.push(cur);
      cur = { startS: w.startS, endS: w.endS, words: [] };
    }
    cur.words.push({ text, startS: w.startS, endS: w.endS });
    cur.endS = w.endS;
    if (/[.!?;:,]$/.test(w.word)) {
      groups.push(cur);
      cur = null;
    }
  }
  if (cur) groups.push(cur);
  // Each group holds until the next begins (max +0.6 s after its last word).
  for (let i = 0; i < groups.length; i++) {
    const next = groups[i + 1];
    groups[i]!.endS = next ? Math.min(next.startS, groups[i]!.endS + 0.6) : Math.min(script.durationS, groups[i]!.endS + 0.6);
  }
  return groups;
}

const ts = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(r).padStart(3, "0")}`;
};

/** SRT from caption groups (sentence-ish chunks for platforms; burned-in captions are word-level). */
export function toSrt(groups: CaptionGroupOut[]): string {
  return groups.map((g, i) => `${i + 1}\n${ts(g.startS)} --> ${ts(g.endS)}\n${g.words.map((w) => w.text).join(" ")}\n`).join("\n");
}
