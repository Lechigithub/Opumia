/**
 * Build list 5, item 22: ONE shared timeline of the moments a cut or a hit can land on — the cut points of the edit,
 * the stressed words of the narration (the voice director's emphasis, one word per line), the story turns the writer
 * marked (segment roles) and the pauses between lines. The editor and the sound designer both read it, so a hit, a cut
 * and a stressed word line up instead of being placed by two stages that never see each other.
 *
 * No model call. Built from the storyboard, the timed script and `voice-direction.json` (if the voice director ran).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Storyboard, TimedScript } from "@opumia/contracts";

export interface CutPoint { atS: number; fromShot: string | null; toShot: string }
export interface StressedWord { atS: number; endS: number; word: string; segId: string; line: number }
export interface StoryTurn { atS: number; segId: string; role: string; strength: number; text: string }
export interface Pause { startS: number; endS: number }
export interface CutTimeline { cuts: CutPoint[]; stressed: StressedWord[]; turns: StoryTurn[]; pauses: Pause[]; durationS: number }

/**
 * How much each writer-marked role turns the story (the music changes, a hit lands, a drop-out may come before it).
 * Roles that only continue the thought (hook, thesis, context) are weak turns; the arc's pivots are strong.
 */
export const TURN_STRENGTH: Record<string, number> = { climax: 1, twist: 0.95, fall: 0.9, rehook: 0.8, chapter: 0.75, rise: 0.6, resolution: 0.55, context: 0.35, thesis: 0.25, hook: 0.2 };

const clean = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Stressed words: each line's emphasis word found in order through the narration's words. */
export function stressedWords(script: TimedScript, lines: Array<{ emphasis: string }>): StressedWord[] {
  const words = script.segments.flatMap((sg) => sg.words.map((w) => ({ ...w, segId: sg.id })));
  // sentence boundaries: a word ending in . ! ? closes a line
  const lineOf: number[] = [];
  let line = 0;
  for (const w of words) {
    lineOf.push(line);
    if (/[.!?]["”’)]*$/.test(w.word)) line++;
  }
  const out: StressedWord[] = [];
  lines.forEach((l, i) => {
    const e = clean(l.emphasis.split(/\s+/)[0] ?? "");
    if (!e) return;
    const k = words.findIndex((w, j) => lineOf[j] === i && clean(w.word) === e) ?? -1;
    const kk = k >= 0 ? k : words.findIndex((w, j) => lineOf[j]! >= i && clean(w.word).startsWith(e));
    if (kk < 0) return;
    const w = words[kk]!;
    out.push({ atS: w.startS, endS: w.endS, word: w.word, segId: w.segId, line: i });
  });
  return out;
}

export function buildCutTimeline(o: { storyboard: Pick<Storyboard, "shots">; script: TimedScript; emphasis?: Array<{ emphasis: string }> }): CutTimeline {
  const shots = [...o.storyboard.shots].sort((a, b) => a.startS - b.startS);
  const cuts: CutPoint[] = shots.map((s, i) => ({ atS: s.startS, fromShot: i ? shots[i - 1]!.id : null, toShot: s.id })).filter((c) => c.fromShot !== null);
  const turns: StoryTurn[] = [];
  let prev = "";
  for (const sg of o.script.segments) {
    const st = TURN_STRENGTH[sg.role] ?? 0;
    // a turn is where the role changes (the writer marked a new beat), or a chapter starts
    const chapterStart = sg.chapter && sg.chapter !== o.script.segments[o.script.segments.indexOf(sg) - 1]?.chapter;
    if (sg.startS > 1 && (sg.role !== prev || chapterStart) && st > 0) turns.push({ atS: sg.startS, segId: sg.id, role: chapterStart && st < 0.75 ? "chapter" : sg.role, strength: chapterStart ? Math.max(st, 0.75) : st, text: sg.text.slice(0, 80) });
    prev = sg.role;
  }
  const words = o.script.segments.flatMap((sg) => sg.words);
  const pauses: Pause[] = [];
  for (let i = 1; i < words.length; i++) if (words[i]!.startS - words[i - 1]!.endS >= 0.25) pauses.push({ startS: words[i - 1]!.endS, endS: words[i]!.startS });
  return { cuts, stressed: o.emphasis ? stressedWords(o.script, o.emphasis) : [], turns, pauses, durationS: o.script.durationS };
}

/** Read the voice director's emphasis from a job folder (voice-direction.json), if it ran. */
export async function emphasisOf(jobDir: string): Promise<Array<{ emphasis: string }> | undefined> {
  const f = path.join(jobDir, "voice-direction.json");
  if (!existsSync(f)) return undefined;
  const v = JSON.parse(await readFile(f, "utf8")) as { dv?: { lines?: Array<{ emphasis: string }> }; lines?: Array<{ emphasis: string }> };
  return v.dv?.lines ?? v.lines;
}

export const nearestCut = (tl: CutTimeline, t: number) => tl.cuts.reduce<CutPoint | null>((b, c) => (!b || Math.abs(c.atS - t) < Math.abs(b.atS - t) ? c : b), null);
export const nearestStress = (tl: CutTimeline, t: number) => tl.stressed.reduce<StressedWord | null>((b, c) => (!b || Math.abs(c.atS - t) < Math.abs(b.atS - t) ? c : b), null);
