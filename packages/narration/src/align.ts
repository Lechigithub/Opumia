import type { CharAlignment } from "./elevenlabs.js";

export interface Token {
  text: string;
  startS: number;
  endS: number;
}

export const normWord = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");

/** Group per-character timings into whitespace-delimited tokens. */
export function tokensFromAlignment(a: CharAlignment): Token[] {
  const out: Token[] = [];
  let cur: Token | null = null;
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i]!;
    const s = a.character_start_times_seconds[i]!;
    const e = a.character_end_times_seconds[i]!;
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { text: ch, startS: s, endS: e };
    else {
      cur.text += ch;
      cur.endS = e;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Map each script word onto the aligned tokens. Robust to SSML/phoneme markup and text
 * normalisation: greedy forward matching with a lookahead window, then interpolation for
 * any word that could not be matched (e.g. a pronunciation-tagged word).
 */
export function alignWords(scriptWords: string[], tokens: Token[]): Array<{ word: string; startS: number; endS: number; matched: boolean }> {
  const res = scriptWords.map((word) => ({ word, startS: NaN, endS: NaN, matched: false }));
  let t = 0;
  for (let i = 0; i < scriptWords.length; i++) {
    const w = normWord(scriptWords[i]!);
    if (!w) continue;
    for (let k = t; k < Math.min(tokens.length, t + 10); k++) {
      const tk = normWord(tokens[k]!.text);
      if (tk && (tk === w || tk.startsWith(w) || w.startsWith(tk))) {
        res[i]!.startS = tokens[k]!.startS;
        res[i]!.endS = tokens[k]!.endS;
        res[i]!.matched = true;
        t = k + 1;
        break;
      }
    }
  }
  // Interpolate gaps between matched neighbours.
  const lastEnd = tokens.length ? tokens[tokens.length - 1]!.endS : 0;
  for (let i = 0; i < res.length; i++) {
    if (res[i]!.matched) continue;
    let p = i - 1;
    while (p >= 0 && !res[p]!.matched) p--;
    let n = i + 1;
    while (n < res.length && !res[n]!.matched) n++;
    const from = p >= 0 ? res[p]!.endS : 0;
    const to = n < res.length ? res[n]!.startS : lastEnd;
    const span = n - p - 1;
    const slot = Math.max(0, to - from) / Math.max(1, span);
    const pos = i - p - 1;
    res[i]!.startS = from + slot * pos;
    res[i]!.endS = from + slot * (pos + 1);
  }
  // Enforce monotonic, non-negative timings.
  let prev = 0;
  for (const r of res) {
    r.startS = Math.max(prev, Math.round(r.startS * 1000) / 1000);
    r.endS = Math.max(r.startS, Math.round(r.endS * 1000) / 1000);
    prev = r.startS;
  }
  return res;
}
