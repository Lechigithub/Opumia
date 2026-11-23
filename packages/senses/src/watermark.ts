/**
 * Build list 5, item 18: watermarks and channel bugs on footage (the "MTR" hand in the corner of the Nokia proof film's
 * Lumia clip). The pixel half of the check — no model:
 *
 *  - frames are sampled across the clip (a still is one frame) at 320×180, grey;
 *  - for each corner (22 % × 24 % of the frame) the share of PERSISTENT EDGES is measured: pixels whose gradient is
 *    strong in at least 85 % of the frames (an overlay keeps its edges; moving content does not);
 *  - the corner's motion is compared with the centre's: a corner that stays put while the picture moves, and holds
 *    edges, is a static overlay;
 *  - a 2×2 tile of the four corner crops (full resolution, middle frame) is written for a look by eye
 *    (agents/picture-measure.ts:watermarkCheck), because a still camera makes everything static and only the eye can
 *    tell an overlay from the scene there. Measured on the Nokia proof film: the MTR corner holds 12 % persistent
 *    edges, but so can a still background (an office at 18 %), so the pixel reading is a hint the eye confirms, never
 *    a verdict on its own.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { probeDuration, rgbFrames, run } from "./ff.js";

export type Corner = "top_left" | "top_right" | "bottom_left" | "bottom_right";
export const CORNERS: Corner[] = ["top_left", "top_right", "bottom_left", "bottom_right"];
export interface CornerReading { corner: Corner; persistentEdges: number; motion: number; staticOverlay: boolean }
export interface CornerMarks { frames: number; sceneMotion: number; corners: CornerReading[]; suspects: Corner[]; tile: string | null }

const W = 320;
const H = 180;
const CW = Math.round(W * 0.22);
const CH = Math.round(H * 0.24);

const box = (c: Corner | "centre"): [number, number, number, number] =>
  c === "centre" ? [Math.round(W * 0.3), Math.round(H * 0.3), Math.round(W * 0.4), Math.round(H * 0.4)]
    : [c.endsWith("left") ? 0 : W - CW, c.startsWith("top") ? 0 : H - CH, CW, CH];

export async function cornerMarks(file: string, o: { tileOut?: string; frames?: number } = {}): Promise<CornerMarks> {
  const still = /\.(jpe?g|png|webp)$/i.test(file);
  const dur = still ? 0 : await probeDuration(file).catch(() => 0);
  const n = o.frames ?? 8;
  const rgb = await rgbFrames(file, still ? { fps: 1, w: W, h: H } : { ss: Math.min(0.2, dur / 10), t: Math.max(0.5, dur - 0.3), fps: Math.max(0.5, n / Math.max(0.5, dur - 0.3)), w: W, h: H });
  const grey = rgb.slice(0, n).map((f) => {
    const g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = 0.299 * f[i * 3]! + 0.587 * f[i * 3 + 1]! + 0.114 * f[i * 3 + 2]!;
    return g;
  });
  const grad = (g: Float32Array, x: number, y: number) => {
    const i = y * W + x;
    return Math.abs(g[i + 1]! - g[i - 1]!) + Math.abs(g[i + W]! - g[i - W]!);
  };
  const motionIn = (b: [number, number, number, number]) => {
    if (grey.length < 2) return 0;
    let t = 0;
    let k = 0;
    for (let f = 1; f < grey.length; f++)
      for (let y = b[1]; y < b[1] + b[3]; y += 2)
        for (let x = b[0]; x < b[0] + b[2]; x += 2) (t += Math.abs(grey[f]![y * W + x]! - grey[f - 1]![y * W + x]!)), k++;
    return t / Math.max(1, k);
  };
  const sceneMotion = motionIn(box("centre"));
  const corners: CornerReading[] = CORNERS.map((c) => {
    const [x0, y0, w, h] = box(c);
    let persistent = 0;
    let px = 0;
    for (let y = Math.max(1, y0); y < Math.min(H - 1, y0 + h); y++)
      for (let x = Math.max(1, x0); x < Math.min(W - 1, x0 + w); x++) {
        px++;
        let strong = 0;
        for (const g of grey) if (grad(g, x, y) > 48) strong++;
        if (grey.length && strong >= Math.ceil(grey.length * 0.85)) persistent++;
      }
    const persistentEdges = Math.round((persistent / Math.max(1, px)) * 1000) / 1000;
    const motion = Math.round(motionIn([x0, y0, w, h]) * 100) / 100;
    // an overlay: edges that never move, in a corner much stiller than a picture that does move
    const staticOverlay = grey.length >= 3 && sceneMotion > 3 && persistentEdges > 0.015 && motion < sceneMotion * 0.35;
    return { corner: c, persistentEdges, motion, staticOverlay };
  });
  let tile: string | null = null;
  if (o.tileOut) {
    await mkdir(path.dirname(o.tileOut), { recursive: true });
    const at = still ? [] : ["-ss", (dur / 2).toFixed(2)];
    const crop = (c: Corner) => `crop=iw*0.26:ih*0.28:${c.endsWith("left") ? 0 : "iw*0.74"}:${c.startsWith("top") ? 0 : "ih*0.72"},scale=320:-2`;
    const fc = `[0:v]split=4[a][b][c][d];[a]${crop("top_left")}[A];[b]${crop("top_right")}[B];[c]${crop("bottom_left")}[C];[d]${crop("bottom_right")}[D];[A][B]hstack[T];[C][D]hstack[U];[T][U]vstack`;
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...at, "-i", file, "-frames:v", "1", "-filter_complex", fc, "-q:v", "3", o.tileOut]).catch(() => null);
    tile = existsSync(o.tileOut) ? o.tileOut : null;
  }
  return { frames: grey.length, sceneMotion: Math.round(sceneMotion * 100) / 100, corners, suspects: corners.filter((c) => c.staticOverlay || c.persistentEdges > 0.03).map((c) => c.corner), tile };
}
