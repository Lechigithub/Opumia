/**
 * Eyes for jumps (build list 2, step 1): what a viewer sees as a mistake in the picture, measured frame by frame on a
 * rendered film (or any video — the same function runs on the reference so its band can be measured). No model.
 *
 *  jump_cut   the same picture on both sides of a sudden change (the same framing, the same picture pushed in or
 *             out, an element vanishing over it) with NOTHING bridging it. The reference changes the same picture
 *             6–11 times a minute, but always through a designed transition — a light flash, a colour flash, a whip
 *             with motion blur, a dissolve — so a bridged change is style and only an unbridged one is a jump.
 *  pop        inside a shot, part of the frame changes in one frame with no motion before or after (an element that
 *             appears or vanishes instead of entering)
 *  flicker    brightness that pumps up and down frame to frame for ≥ 5 frames
 *  cuts       every cut found (for cuts a minute and for the other checks)
 */
import { run } from "./ff.js";

export interface PictureEvent { atS: number; kind: "jump_cut" | "pop" | "flicker"; detail: string }
export interface JumpReport { seconds: number; fps: number; cuts: number[]; events: PictureEvent[]; jumpCutsPerMin: number; popsPerMin: number; bridgedPerMin: number; transitions: Record<string, number> }

const W = 64, Hh = 36;

async function grayFrames(file: string, fps: number, o: { ss?: number; t?: number }): Promise<Uint8Array[]> {
  const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...(o.ss !== undefined ? ["-ss", String(o.ss)] : []), ...(o.t !== undefined ? ["-t", String(o.t)] : []), "-i", file, "-vf", `fps=${fps},scale=${W}:${Hh}:flags=area,format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 30 } as never);
  const b = (r as unknown as { stdout: Buffer }).stdout;
  const out: Uint8Array[] = [];
  for (let i = 0; i + W * Hh <= b.length; i += W * Hh) out.push(new Uint8Array(b.buffer, b.byteOffset + i, W * Hh));
  return out;
}

function corr(a: Float64Array, b: Float64Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= a.length; mb /= b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]! - ma, y = b[i]! - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa < 1e-6 || sbb < 1e-6 ? 0 : sab / Math.sqrt(saa * sbb);
}
/** Edge structure: each pixel minus its 3×3 neighbourhood — unchanged by a colour wash or a brightness shift. */
function hp(f: Float64Array): Float64Array {
  const out = new Float64Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < Hh && xx >= 0 && xx < W) { s += f[yy * W + xx]!; c++; } }
    out[y * W + x] = f[y * W + x]! - s / c;
  }
  return out;
}
/** How alike two frames are as pictures, allowing for a punch-in or pull-out toward any point. */
export function samePicture(a: Uint8Array, b: Uint8Array): { score: number; how: string } {
  const fa = Float64Array.from(a), fb = Float64Array.from(b);
  const ha = hp(fa), hb = hp(fb);
  let score = Math.max(corr(fa, fb), corr(ha, hb)), how = "the same framing";
  for (const s of [1.08, 1.15, 1.22, 1.3, 1.4, 1.55, 1.75, 2]) for (const cx of [0.2, 0.35, 0.5, 0.65, 0.8]) for (const cy of [0.25, 0.5, 0.75]) {
    const za = zoom(a, s, cx, cy), zb = zoom(b, s, cx, cy);
    const zin = Math.max(corr(za, fb), corr(hp(za), hb)), zout = Math.max(corr(zb, fa), corr(hp(zb), ha));
    if (zin > score) (score = zin), (how = `the same picture pushed in ×${s}`);
    if (zout > score) (score = zout), (how = `the same picture pulled out ×${s}`);
  }
  // Build list 3, item 25: a heavy overlay (a card, a box of words) covers part of the picture and hides a jump from the
  // whole-frame comparison. The same picture still agrees region by region where it is not covered: the six best of
  // twelve tiles (4×3) are compared on their edge structure.
  if (score < 0.8) {
    const tiles: number[] = [];
    const TW = W / 4, TH = Hh / 3;
    for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 4; tx++) {
      const ta = new Float64Array(TW * TH), tb = new Float64Array(TW * TH);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) { const p = (ty * TH + y) * W + tx * TW + x; ta[y * TW + x] = ha[p]!; tb[y * TW + x] = hb[p]!; }
      tiles.push(corr(ta, tb));
    }
    const best6 = tiles.sort((x, y) => y - x).slice(0, 6);
    const regional = best6.reduce((t, v) => t + v, 0) / 6;
    if (best6[5]! > 0.75 && regional * 0.97 > score) (score = regional * 0.97), (how = "the same picture under an overlay (half the frame agrees)");
  }
  return { score, how };
}
/** A frame scaled up by `s` around (cx, cy) in 0..1 (a punch-in toward any point), resampled to the frame size. */
function zoom(f: Uint8Array, s: number, cx = 0.5, cy = 0.5): Float64Array {
  const out = new Float64Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(W - 1, Math.max(0, Math.round((x - W * cx) / s + W * cx)));
    const sy = Math.min(Hh - 1, Math.max(0, Math.round((y - Hh * cy) / s + Hh * cy)));
    out[y * W + x] = f[sy * W + sx]!;
  }
  return out;
}

export async function measureJumps(file: string, o: { fps?: number; ss?: number; t?: number } = {}): Promise<JumpReport> {
  const fps = o.fps ?? 24;
  const fr = await grayFrames(file, fps, o);
  const n = fr.length;
  const diff = new Float64Array(n);
  const mean = new Float64Array(n);
  const changedShare = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < W * Hh; k++) s += fr[i]![k]!;
    mean[i] = s / (W * Hh);
    if (!i) continue;
    let d = 0, ch = 0;
    for (let k = 0; k < W * Hh; k++) { const v = Math.abs(fr[i]![k]! - fr[i - 1]![k]!); d += v; if (v > 30) ch++; }
    diff[i] = d / (W * Hh);
    changedShare[i] = ch / (W * Hh);
  }
  // per-frame sharpness (edge energy): a whip or zoom blur dips it
  const sharp = new Float64Array(n);
  for (let i = 0; i < n; i++) { const h = hp(Float64Array.from(fr[i]!)); let e = 0; for (let k = 0; k < h.length; k++) e += Math.abs(h[k]!); sharp[i] = e / h.length; }
  /** What bridges a change at frame i, looking 4 frames either side: a flash, a blur, a dissolve — or nothing. */
  const bridge = (i: number): string | null => {
    const lo = Math.max(0, i - 5), hi = Math.min(n - 1, i + 4);
    const base = Math.min(mean[lo]!, mean[hi]!), sBase = Math.min(sharp[lo]!, sharp[hi]!);
    for (let k = lo + 1; k < hi; k++) {
      if (mean[k]! - base > 25) return "flash";
      if (sBase > 2 && sharp[k]! < sBase * 0.55) return "blur";
    }
    // dissolve: a frame in between that looks like a blend of the two sides
    const a = Float64Array.from(fr[lo]!), b = Float64Array.from(fr[hi]!);
    for (let k = lo + 1; k < hi; k++) { const m = Float64Array.from(fr[k]!); const ca = corr(m, a), cb = corr(m, b); if (ca > 0.45 && cb > 0.45 && ca < 0.97 && cb < 0.97) return "dissolve"; }
    return null;
  };
  const transitions: Record<string, number> = {};
  let bridged = 0;
  const local = (i: number) => { const w = Array.from(diff.slice(Math.max(1, i - 12), Math.min(n, i + 13))).sort((a, b) => a - b); return w[Math.floor(w.length / 2)] ?? 0; };
  const cuts: number[] = [];
  const events: PictureEvent[] = [];
  const T = (i: number) => Math.round(((o.ss ?? 0) + i / fps) * 100) / 100;
  for (let i = 1; i < n; i++) {
    const med = local(i);
    const isCut = diff[i]! > Math.max(14, med * 5) && changedShare[i]! > 0.35;
    const calm = (j: number) => j > 0 && j < n && diff[j]! < Math.max(2, med * 1.5);
    const isPop = !isCut && diff[i]! > Math.max(6, med * 6) && changedShare[i]! > 0.02 && calm(i - 1) && calm(i + 1);
    if (!isCut && !isPop) continue;
    if (isCut) cuts.push(T(i));
    // the same picture on both sides of a sudden change: a jump cut (a punch-in of one clip, or an element that
    // vanishes while the picture under it carries on)
    const same = samePicture(fr[i - 1]!, fr[i]!);
    const br = bridge(i);
    if (br) transitions[br] = (transitions[br] ?? 0) + 1;
    if (same.score >= 0.6 && br) bridged++;
    else if (same.score >= 0.6) events.push({ atS: T(i), kind: "jump_cut", detail: `cut to ${same.how}${isPop ? `; ${Math.round(changedShare[i]! * 100)} % of the frame changes at once` : ""}, with nothing bridging it (structure ${same.score.toFixed(2)})` });
    else if (isPop) events.push({ atS: T(i), kind: "pop", detail: `${Math.round(changedShare[i]! * 100)} % of the frame changes in one frame with no motion around it` });
  }
  // flicker: brightness alternating up/down ≥ 5 frames in a row by ≥ 2 levels, away from cuts
  for (let i = 3, run2 = 0; i < n; i++) {
    const d1 = mean[i]! - mean[i - 1]!, d0 = mean[i - 1]! - mean[i - 2]!;
    const nearCut = cuts.some((c) => Math.abs(c - T(i)) < 0.3);
    run2 = !nearCut && Math.abs(d1) >= 2 && Math.abs(d0) >= 2 && Math.sign(d1) !== Math.sign(d0) ? run2 + 1 : 0;
    if (run2 === 5) events.push({ atS: T(i - 5), kind: "flicker", detail: "brightness pumps frame to frame" });
  }
  const seconds = n / fps;
  const per = (k: string) => Math.round((events.filter((e) => e.kind === k).length / Math.max(1, seconds)) * 600) / 10;
  return { seconds: Math.round(seconds * 10) / 10, fps, cuts, events, jumpCutsPerMin: per("jump_cut"), popsPerMin: per("pop"), bridgedPerMin: Math.round((bridged / Math.max(1, seconds)) * 600) / 10, transitions };
}
