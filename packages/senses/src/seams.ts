/**
 * Ears for joins (build list 2, step 1): where a voice track was cut and glued. A recorded voice never drops to
 * digital silence, never starts out of dead air at full level, and never stops dead mid-decay — a track assembled
 * from separate takes does all three at its joins. Measured on 5 ms frames, no model:
 *
 *  dead_air      a stretch of ≥ 20 ms below −75 dBFS inside the track (a real recording always has a noise floor)
 *  hard_onset    speech rising out of dead air (< −70 dBFS for the 40 ms before) to within 12 dB of speech level in
 *                ≤ 10 ms — a sentence glued on, its breath and room cut away
 *  hard_cutoff   speech falling from within 12 dB of speech level to < −70 dBFS in ≤ 10 ms — a decay cut short
 *  floor_jump    the room under the voice changes between two neighbouring pauses by ≥ 8 dB (two takes with
 *                different rooms or levels side by side)
 *
 * The same function runs on our narration, our mix and any reference audio, so its band can be measured.
 */
import { pcm } from "./ff.js";

export interface Seam { atS: number; kind: "dead_air" | "hard_onset" | "hard_cutoff" | "floor_jump"; detail: string }
export interface SeamReport { seconds: number; seams: Seam[]; perMin: number; speechDb: number; floorDb: number }

const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x));
const pct = (xs: number[], p: number) => { if (!xs.length) return -120; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!; };

export async function measureSeams(file: string, o: { ss?: number; t?: number } = {}): Promise<SeamReport> {
  const SR = 24000;
  const x = await pcm(file, { sr: SR, ...(o.ss !== undefined ? { ss: o.ss } : {}), ...(o.t !== undefined ? { t: o.t } : {}) });
  const H = Math.round(0.005 * SR);
  const n = Math.floor(x.length / H);
  const L = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let k = 0; k < H; k++) e += x[f * H + k]! * x[f * H + k]!;
    L[f] = db(Math.sqrt(e / H));
  }
  const all = Array.from(L);
  const speech = pct(all, 0.9);
  const pauseTh = speech - 30;
  const seams: Seam[] = [];
  const t = (f: number) => Math.round(((o.ss ?? 0) + f * 0.005) * 100) / 100;
  // dead air: ≥ 4 frames (20 ms) below −75 dBFS, not at the very start or end of the file
  for (let f = 0, a = -1; f <= n; f++) {
    const dead = f < n && L[f]! < -75;
    if (dead && a < 0) a = f;
    if (!dead && a >= 0) {
      if (f - a >= 4 && a > 2 && f < n - 2) seams.push({ atS: t(a), kind: "dead_air", detail: `${((f - a) * 5).toFixed(0)} ms of digital silence` });
      a = -1;
    }
  }
  // hard onsets and cutoffs around dead air
  for (let f = 9; f < n - 3; f++) {
    const pre = Math.max(...all.slice(f - 8, f));
    if (pre < -70 && L[f]! >= -70 && Math.max(L[f]!, L[f + 1]!, L[f + 2]!) >= speech - 12) seams.push({ atS: t(f), kind: "hard_onset", detail: `speech starts out of dead air at ${Math.round(Math.max(L[f]!, L[f + 1]!, L[f + 2]!) - speech)} dB under speech level within 10 ms` });
    const post = Math.max(...all.slice(f + 1, f + 9));
    if (post < -70 && L[f]! >= speech - 12 && f + 9 < n) seams.push({ atS: t(f), kind: "hard_cutoff", detail: "speech stops into dead air within 10 ms" });
  }
  // room under the voice: the floor of each pause (≥ 80 ms), compared with the pause before
  const floors: Array<{ f: number; floor: number }> = [];
  for (let f = 0, a = -1; f <= n; f++) {
    const q = f < n && L[f]! < pauseTh && L[f]! > -75;
    if (q && a < 0) a = f;
    if (!q && a >= 0) {
      if (f - a >= 16) floors.push({ f: a, floor: pct(all.slice(a + 2, f - 2), 0.5) });
      a = -1;
    }
  }
  for (let i = 1; i < floors.length; i++) if (Math.abs(floors[i]!.floor - floors[i - 1]!.floor) >= 8) seams.push({ atS: t(floors[i]!.f), kind: "floor_jump", detail: `room under the voice changes ${Math.round(floors[i]!.floor - floors[i - 1]!.floor)} dB from the pause before` });
  seams.sort((a, b) => a.atS - b.atS);
  const seconds = (n * H) / SR;
  return { seconds: Math.round(seconds * 10) / 10, seams, perMin: Math.round((seams.length / Math.max(1, seconds)) * 600) / 10, speechDb: Math.round(speech * 10) / 10, floorDb: Math.round(pct(all.filter((v) => v > -75), 0.05) * 10) / 10 };
}
