/**
 * Craft inventory: a caption placed on the depicted subject that FOLLOWS it as it moves. A deterministic point tracker
 * (no model): block matching of a luma patch around the point, frame to frame, on small frames — the same method a
 * motion-tracking plug-in uses. Returns the point's path in frame-relative units (0–1), one sample per tracked frame.
 */
import { rgbFrames } from "./ff.js";

export async function trackPoint(file: string, o: { ss: number; t: number; x: number; y: number; fps?: number; w?: number; h?: number }): Promise<Array<{ t: number; x: number; y: number }>> {
  const fps = o.fps ?? 8, W = o.w ?? 192, H = o.h ?? 108;
  const frames = await rgbFrames(file, { ss: o.ss, t: o.t, fps, w: W, h: H });
  if (frames.length < 2) return [{ t: 0, x: o.x, y: o.y }];
  const luma = frames.map((f) => {
    const l = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) l[i] = 0.299 * f[i * 3]! + 0.587 * f[i * 3 + 1]! + 0.114 * f[i * 3 + 2]!;
    return l;
  });
  const P = 8; // patch half-size
  const S = 10; // search radius per step
  let cx = Math.round(o.x * W), cy = Math.round(o.y * H);
  const out = [{ t: 0, x: o.x, y: o.y }];
  for (let k = 1; k < luma.length; k++) {
    const a = luma[k - 1]!, b = luma[k]!;
    let best = Infinity, bx = cx, by = cy;
    for (let dy = -S; dy <= S; dy++)
      for (let dx = -S; dx <= S; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx - P < 0 || ny - P < 0 || nx + P >= W || ny + P >= H || cx - P < 0 || cy - P < 0 || cx + P >= W || cy + P >= H) continue;
        let sad = 0;
        for (let yy = -P; yy <= P; yy += 2) for (let xx = -P; xx <= P; xx += 2) sad += Math.abs(a[(cy + yy) * W + cx + xx]! - b[(ny + yy) * W + nx + xx]!);
        // a small pull toward no motion so flat areas do not drift
        sad += (Math.abs(dx) + Math.abs(dy)) * 3;
        if (sad < best) (best = sad), (bx = nx), (by = ny);
      }
    cx = bx;
    cy = by;
    out.push({ t: Math.round((k / fps) * 1000) / 1000, x: Math.round((cx / W) * 1000) / 1000, y: Math.round((cy / H) * 1000) / 1000 });
  }
  return out;
}
