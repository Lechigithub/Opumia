/**
 * A passage of narration as production keeps it (build list 2 step 3): one take, never cut inside; pauses shortened
 * only inside the TTS's own digital silence; dead air filled with the passage's own quiet room. Used by the narration
 * and by the voice's pace measurement, so the script is cut to the pace the narration really has.
 */
export const SR = 44100;

/**
 * Cut a passage's take to its speech plus its own room at both ends (never inside it). Word times follow the cut.
 */
export function tighten(audio: Float32Array, ws: Array<{ word: string; startS: number; endS: number }>): { audio: Float32Array; words: typeof ws } {
  // Step 3: a passage is never cut inside — its pauses, breaths and intonation are the voice's own. Only the silence
  // before the first sound and after the last is shortened, keeping LEAD of the take's own room before the first
  // sound and TAIL after the last (the decay and the room the next passage crossfades into).
  const HOP = Math.round(0.01 * SR);
  const frames = Math.floor(audio.length / HOP);
  if (frames < 10) return { audio, words: ws };
  const env = new Float32Array(frames);
  let peak = 1e-9;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let k = 0; k < HOP; k++) e += audio[f * HOP + k]! * audio[f * HOP + k]!;
    env[f] = Math.sqrt(e / HOP);
    if (env[f]! > peak) peak = env[f]!;
  }
  const quiet = peak * 0.02;
  let first = 0, last = frames - 1;
  while (first < frames && env[first]! < quiet) first++;
  while (last > first && env[last]! < quiet) last--;
  const a0 = Math.max(0, (first - LEAD_FRAMES) * HOP), a1 = Math.min(audio.length, (last + 1 + TAIL_FRAMES) * HOP);
  const shift = a0 / SR;
  let x = audio.slice(a0, a1);
  let wsx = ws.map((w) => ({ ...w, startS: Math.max(0, w.startS - shift), endS: Math.max(0, w.endS - shift) }));
  // The TTS writes its pauses as digital silence, and long (median 0.5 s; the channel's narrator 0.2 s). A pause is
  // shortened only INSIDE that digital silence — a cut through silence cannot be heard — down to MAX_PAUSE.
  const DEAD = 3e-4; // about −70 dBFS
  const runs: Array<[number, number]> = [];
  for (let k = 0, a = -1; k <= x.length; k++) {
    const d = k < x.length && Math.abs(x[k]!) < DEAD;
    if (d && a < 0) a = k;
    if (!d && a >= 0) { if (a > LEAD_FRAMES * HOP && k < x.length - TAIL_FRAMES * HOP) runs.push([a, k]); a = -1; }
  }
  const cuts = runs.filter(([a, b]) => (b - a) / SR > MAX_PAUSE).map(([a, b]) => { const rm = b - a - Math.round(MAX_PAUSE * SR); const mid = Math.round((a + b) / 2); return [mid - Math.floor(rm / 2), mid + Math.ceil(rm / 2)] as [number, number]; });
  if (cuts.length) {
    const keep: Float32Array[] = [];
    let pos = 0;
    for (const [c0, c1] of cuts) { keep.push(x.subarray(pos, c0)); pos = c1; }
    keep.push(x.subarray(pos));
    const y = new Float32Array(keep.reduce((n, k) => n + k.length, 0));
    let o = 0;
    for (const k of keep) { y.set(k, o); o += k.length; }
    const removedBefore = (t: number) => cuts.filter(([c0]) => c0 / SR < t).reduce((n, [c0, c1]) => n + (c1 - c0) / SR, 0);
    wsx = wsx.map((w) => ({ ...w, startS: w.startS - removedBefore(w.startS), endS: w.endS - removedBefore(w.endS) }));
    x = y;
  }
  // No digital silence left: every near-silent sample gets a quiet room (soft noise about −66 dBFS) under it, so the
  // voice never drops into or starts out of dead air. The mix lays the film's room tone on top.
  // The fill matches this passage's own quiet room (the 10th percentile of its non-silent 10 ms levels), so the room
  // does not change level between a natural pause and a filled one.
  const lv: number[] = [];
  for (let k = 0; k + HOP <= x.length; k += HOP) { let e = 0, live = 0; for (let q = 0; q < HOP; q++) { const v = x[k + q]!; e += v * v; if (Math.abs(v) >= DEAD) live++; } if (live > HOP * 0.9) lv.push(Math.sqrt(e / HOP)); }
  lv.sort((p, q) => p - q);
  const roomRms = Math.max(2e-4, Math.min(3e-3, lv[Math.floor(lv.length * 0.1)] ?? 5e-4));
  let seed = 12345;
  let pink = 0;
  const pinkRms = 0.03 / Math.sqrt(2 - 0.03) / Math.sqrt(3); // RMS of the filtered uniform noise below
  for (let k = 0; k < x.length; k++) {
    if (Math.abs(x[k]!) >= DEAD) continue;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pink = 0.97 * pink + 0.03 * ((seed / 0x7fffffff) * 2 - 1);
    x[k] = x[k]! + pink * (roomRms / pinkRms);
  }
  return { audio: x, words: wsx };
}
/** Longest pause kept inside a passage (the reference narrator: pauses of 0.25 s or more are rare, median 0.2 s). */
export const MAX_PAUSE = 0.22;
export const LEAD_FRAMES = 12; // 120 ms of the take's own room before the first sound
export const TAIL_FRAMES = 20; // 200 ms after the last: the decay and the room the next passage crossfades into

