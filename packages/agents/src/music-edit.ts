/**
 * Music editing (build list B6): what a music editor does to beds that were chosen for their mood.
 *  - Cut on phrases: a cue change falls on a bar line of the outgoing bed, and the incoming bed enters on its own
 *    downbeat (bars = four beats of the measured beat grid).
 *  - Endings that land: the last bed is placed so its own ending arrives with the film's last frame, instead of
 *    being faded out mid-phrase.
 *  - Energy arc: the beds' measured loudness over the film, against the channel's bed arc (data from sound.json of
 *    every reference film: loud at the start, settling under the voice).
 * Pure functions over the measured music profile (no model call).
 */
import type { Storyboard } from "@opumia/contracts";
import type { MusicProfileLike } from "./sound-timeline.js";

type Cue = Storyboard["music"][number];
const r2 = (x: number) => Math.round(x * 100) / 100;

const barOf = (p: MusicProfileLike) => (p.beat.periodS > 0.2 ? p.beat.periodS * 4 : 0);

/** Distance (s) of a film moment from the nearest bar line of a cue's bed. */
export function offBar(c: Cue, p: MusicProfileLike, atS: number): number {
  const bar = barOf(p);
  if (!bar) return 0;
  const x = (((atS - c.startS + (c.inS ?? 0) - p.beat.offsetS) % bar) + bar) % bar;
  return r2(Math.min(x, bar - x));
}

/** Move every cue change onto a bar line of the outgoing bed (within half a bar) and enter the next bed on a downbeat. */
export function snapCueChanges(cues: Cue[], prof: (id: string) => MusicProfileLike | undefined, avoid: (t: number) => boolean = () => false): { cues: Cue[]; moved: Array<{ from: number; to: number }> } {
  const out = cues.map((c) => ({ ...c }));
  const moved: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!, next = out[i]!;
    const p = prof(prev.assetId), q = prof(next.assetId);
    if (!p || !q) continue;
    const bar = barOf(p);
    if (bar) {
      const t = next.startS;
      const phase = (((t - prev.startS + (prev.inS ?? 0) - p.beat.offsetS) % bar) + bar) % bar;
      const cands = [t - phase, t - phase + bar].filter((x) => x > prev.startS + 4 && x < next.endS - 4 && !avoid(x));
      const to = cands.sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
      if (to !== undefined && Math.abs(to - t) <= bar / 2 + 1e-6 && Math.abs(to - t) > 0.02) {
        moved.push({ from: r2(t), to: r2(to) });
        prev.endS = r2(to);
        next.startS = r2(to);
      }
    }
    const qb = barOf(q);
    if (qb) {
      // enter the incoming bed on its own downbeat nearest its chosen entry point
      const k = Math.round(((next.inS ?? 0) - q.beat.offsetS) / qb);
      next.inS = r2(Math.max(0, q.beat.offsetS + k * qb));
    }
  }
  return { cues: out, moved };
}

/** Seconds between the last bed's own end and the film's end (0 = the music ends with the film). */
export function endingGap(cues: Cue[], prof: (id: string) => MusicProfileLike | undefined): number | null {
  const last = cues.at(-1);
  const p = last ? prof(last.assetId) : undefined;
  if (!last || !p) return null;
  return r2(Math.abs(p.seconds - ((last.inS ?? 0) + (last.endS - last.startS))));
}

/** Place the last bed so its ending lands on the film's end (when the bed is long enough). */
export function landEnding(cues: Cue[], prof: (id: string) => MusicProfileLike | undefined): { cues: Cue[]; ok: boolean; why: string } {
  const out = cues.map((c) => ({ ...c }));
  const last = out.at(-1);
  const p = last ? prof(last.assetId) : undefined;
  if (!last || !p) return { cues: out, ok: false, why: "no last cue" };
  const span = last.endS - last.startS;
  if (p.seconds < span) return { cues: out, ok: false, why: `the bed is ${Math.round(p.seconds)} s, shorter than its ${Math.round(span)} s span — choose a longer bed or split the cue` };
  last.inS = r2(p.seconds - span);
  return { cues: out, ok: true, why: `the last bed now starts ${last.inS} s in and ends with the film` };
}

/** Bed loudness per tenth of the film (dB, music energy of the bed at that moment + its gain; drop-outs silent). */
export function bedArc(cues: Cue[], prof: (id: string) => MusicProfileLike | undefined, durS: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < 10; d++) {
    const xs: number[] = [];
    for (let t = (d * durS) / 10; t < ((d + 1) * durS) / 10; t += 1) {
      const c = cues.find((x) => t >= x.startS && t < x.endS);
      const p = c ? prof(c.assetId) : undefined;
      if (!c || !p || (c.drops ?? []).some((x) => t >= x.startS && t < x.endS)) continue;
      const blk = Math.floor((t - c.startS + (c.inS ?? 0)) / 5);
      const e = p.energyDb[Math.min(p.energyDb.length - 1, Math.max(0, blk))];
      if (e !== undefined) xs.push(e + c.gainDb);
    }
    out.push(xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : NaN);
  }
  return out;
}

/** Mean absolute difference (dB) between our arc and the channel's after both are levelled to mean 0. */
export function arcDistance(ours: number[], ref: number[]): number | null {
  const pairs = ours.map((v, i) => [v, ref[i]] as const).filter(([a, b]) => Number.isFinite(a) && b !== undefined && Number.isFinite(b)) as Array<readonly [number, number]>;
  if (pairs.length < 5) return null;
  const ma = pairs.reduce((t, [a]) => t + a, 0) / pairs.length, mb = pairs.reduce((t, [, b]) => t + b, 0) / pairs.length;
  return r2(pairs.reduce((t, [a, b]) => t + Math.abs(a - ma - (b - mb)), 0) / pairs.length);
}
