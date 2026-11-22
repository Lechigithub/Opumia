/**
 * Pixel-level craft: how sharp, contrasty and finished a picture is — measured the same way on the reference
 * channel's thumbnails and frames and on ours (ffmpeg decode + plain TS, no model). Every picture is scaled to
 * 640×360 grey first, so a 1080p reference frame, a 1280×720 thumbnail and a half-size preview compare fairly.
 *
 *  sharpTop     sharpness of the sharpest tenth of the frame (Laplacian variance, 90th percentile of 40×40 blocks):
 *               the hero's detail. A soft, upscaled subject scores low however busy the rest is.
 *  sharpMedian  sharpness of the typical block (a blurred or smeared frame scores low).
 *  contrast     luma spread between the 5th and 95th percentile (0–255).
 *  grain        fine texture in the flattest fifth of the frame (film grain, noise; 0 = digitally clean).
 */
import { execFile } from "node:child_process";

export interface Craft { sharpTop: number; sharpMedian: number; contrast: number; grain: number }

const W = 640;
const H = 360;
const B = 40;

function gray(file: string, atS?: number): Promise<Buffer> {
  return new Promise((res, rej) =>
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", ...(atS ? ["-ss", String(atS)] : []), "-i", file, "-vf", `scale=${W}:${H}:flags=area,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 21 }, (e, out) => (e ? rej(e) : out.length >= W * H ? res(out) : rej(new Error("short frame")))),
  );
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]! : 0;
};

export async function measureCraft(file: string, atS?: number): Promise<Craft> {
  const g = await gray(file, atS);
  const lap = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      lap[i] = 4 * g[i]! - g[i - 1]! - g[i + 1]! - g[i - W]! - g[i + W]!;
    }
  const blocks: Array<{ v: number; flat: number }> = [];
  for (let by = 0; by < H / B; by++)
    for (let bx = 0; bx < W / B; bx++) {
      let s = 0, s2 = 0, n = 0, l = 0, l2 = 0;
      for (let y = by * B + 1; y < (by + 1) * B - 1; y++)
        for (let x = bx * B + 1; x < (bx + 1) * B - 1; x++) {
          const v = lap[y * W + x]!;
          s += v;
          s2 += v * v;
          const p = g[y * W + x]!;
          l += p;
          l2 += p * p;
          n++;
        }
      const lapVar = s2 / n - (s / n) ** 2;
      const lumVar = l2 / n - (l / n) ** 2;
      blocks.push({ v: lapVar, flat: lumVar });
    }
  const luma = Array.from(g.subarray(0, W * H));
  const flattest = [...blocks].sort((a, b) => a.flat - b.flat).slice(0, Math.ceil(blocks.length / 5));
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    sharpTop: r(pct(blocks.map((b) => b.v), 0.9)),
    sharpMedian: r(pct(blocks.map((b) => b.v), 0.5)),
    contrast: r(pct(luma, 0.95) - pct(luma, 0.05)),
    grain: r(Math.sqrt(flattest.reduce((t, b) => t + b.v, 0) / Math.max(1, flattest.length))),
  };
}

export interface CraftBand { count: number; sharpTop: { p10: number; median: number }; sharpMedian: { p10: number; median: number }; contrast: { p10: number; median: number }; grain: { p10: number; median: number; p90: number } }

export function craftBand(xs: Craft[]): CraftBand {
  const k = <K extends keyof Craft>(key: K) => xs.map((x) => x[key]);
  return {
    count: xs.length,
    sharpTop: { p10: pct(k("sharpTop"), 0.1), median: pct(k("sharpTop"), 0.5) },
    sharpMedian: { p10: pct(k("sharpMedian"), 0.1), median: pct(k("sharpMedian"), 0.5) },
    contrast: { p10: pct(k("contrast"), 0.1), median: pct(k("contrast"), 0.5) },
    grain: { p10: pct(k("grain"), 0.1), median: pct(k("grain"), 0.5), p90: pct(k("grain"), 0.9) },
  };
}

/** Where a picture falls below the reference's own bar. */
export function craftIssues(c: Craft, band: CraftBand, what = "picture", o: { grain?: boolean } = {}): Array<{ kind: string; detail: string }> {
  const out: Array<{ kind: string; detail: string }> = [];
  if (c.sharpTop < band.sharpTop.p10) out.push({ kind: "soft_image", detail: `the sharpest part of the ${what} has detail ${Math.round(c.sharpTop)}; the channel's sharpest parts are ${Math.round(band.sharpTop.p10)}+ (median ${Math.round(band.sharpTop.median)}). The hero is soft — a low-resolution or upscaled source.` });
  else if (c.sharpMedian < band.sharpMedian.p10) out.push({ kind: "smeared_image", detail: `the typical part of the ${what} has detail ${Math.round(c.sharpMedian)}; the channel's is ${Math.round(band.sharpMedian.p10)}+ (median ${Math.round(band.sharpMedian.median)}). Too much is blurred or smeared.` });
  if (o.grain && c.grain < band.grain.p10) out.push({ kind: "too_clean", detail: `fine texture ${c.grain}; the channel's ${what}s carry ${band.grain.p10}+ (median ${band.grain.median}) — real grain and detail everywhere. Ours reads digitally smooth: fill flat areas with detail (sharp photos, patterns, textures) and add grain.` });
  if (c.contrast < band.contrast.p10) out.push({ kind: "flat_contrast", detail: `contrast ${Math.round(c.contrast)}; the channel's is ${Math.round(band.contrast.p10)}+ (median ${Math.round(band.contrast.median)}). It looks washed out.` });
  return out;
}
