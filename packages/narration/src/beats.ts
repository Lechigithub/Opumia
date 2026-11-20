/**
 * Dramatic beats: ElevenLabs SSML <break> tags only where a documentary narrator really holds — never after every
 * short sentence (natural punctuation and clause structure do the breathing). Tags never reach the word list
 * (tokensFromAlignment skips them), so captions stay word-exact.
 *
 *  - at the end of a loop-opening segment (rehook / twist) ... 0.45 s
 *  - before a new chapter (inside a take) .................... 0.7 s
 */
export interface BeatSegment {
  role: string;
  chapter?: string;
  text: string;
}

const brk = (s: number) => ` <break time="${s.toFixed(2)}s" />`;
const CLIFF = new Set(["rehook", "twist"]);

export function withBeats(segs: BeatSegment[]): string {
  const out: string[] = [];
  let sinceBreak = 2;
  segs.forEach((seg, k) => {
    const next = segs[k + 1];
    // Split only at sentence-final punctuation followed by whitespace (never inside "62.5" or "$7.2").
    const sentences = seg.text.split(/(?<=[.?!]["”']?)\s+(?=["“']?[A-Z0-9$€£])/);
    sentences.forEach((raw, j) => {
      const s = raw.trim();
      if (!s) return;
      const last = j === sentences.length - 1;
      let pause = 0;
      if (last && next && seg.chapter && next.chapter && next.chapter !== seg.chapter) pause = 0.7;
      else if (last && CLIFF.has(seg.role)) pause = 0.45;
      if (pause && next !== undefined) {
        out.push(s + brk(pause));
        sinceBreak = 0;
      } else {
        out.push(s);
        sinceBreak++;
      }
    });
  });
  return out.join(" ");
}

/** Remove break tags (for character counts and logs). */
export const stripBeats = (s: string) => s.replace(/\s*<break time="[\d.]+s" \/>/g, "");
