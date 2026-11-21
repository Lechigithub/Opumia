import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { FilmDesignSystem, RenderManifest } from "@opumia/contracts";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "remotion", "index.tsx");

export interface Look {
  accent: string;
  saturate: number;
  contrast: number;
  vignette: number;
  grain: number;
}

/** Derive the grade from the StyleProfile look stats (saturation, greyscale share). */
export function lookFromProfile(look: { saturation: { p50: number } | null; greyShare: { p50: number } | null }, accent = "#f5c518"): Look {
  const sat = look.saturation?.p50 ?? 0.35;
  return { accent, saturate: Math.round((0.85 + sat * 0.5) * 100) / 100, contrast: 1.06, vignette: 0.5, grain: (look.greyShare?.p50 ?? 0.3) > 0.3 ? 0.3 : 0.18 };
}

const bundles = new Map<string, string>();
/** bundle() snapshots publicDir, so any change to the job's media requires a fresh bundle. */
async function serveUrl(publicDir: string, log: (s: string) => void, fresh = false) {
  const hit = bundles.get(publicDir);
  if (hit && !fresh) return hit;
  log("  render: bundling Remotion project…");
  const url = await bundle({ entryPoint: ENTRY, publicDir, onProgress: () => {} });
  bundles.set(publicDir, url);
  return url;
}

/** Split the timeline into ≤ maxChunks frame ranges, cutting only at shot boundaries (never mid-transition). */
export function chunkRanges(m: RenderManifest, maxChunks: number, minChunkS = 20): Array<[number, number]> {
  const total = m.durationFrames;
  const n = Math.max(1, Math.min(maxChunks, Math.floor(total / (minChunkS * m.fps))));
  if (n === 1) return [[0, total - 1]];
  const cuts = [...new Set(m.video.filter((l) => l.ref !== "captions" && l.zIndex <= 2).map((l) => l.startFrame))].filter((f) => f > 0 && f < total).sort((a, b) => a - b);
  const bounds = [0];
  for (let k = 1; k < n; k++) {
    const ideal = Math.round((total * k) / n);
    const best = cuts.reduce((b, f) => (Math.abs(f - ideal) < Math.abs(b - ideal) ? f : b), cuts[0] ?? ideal);
    if (best > bounds[bounds.length - 1]! + m.fps * 5) bounds.push(best);
  }
  bounds.push(total);
  return bounds.slice(0, -1).map((b, i) => [b, bounds[i + 1]! - 1] as [number, number]);
}

/**
 * Render the video track (muted) with Remotion; audio is mastered separately with FFmpeg.
 * Long timelines render as parallel chunks (frame ranges cut at shot boundaries) and are
 * concatenated losslessly with FFmpeg's concat demuxer.
 */
export async function renderVideo(o: { manifest: RenderManifest; look: Look; design?: FilmDesignSystem; publicDir: string; out: string; maxChunks?: number; minChunkS?: number; log?: (s: string) => void }) {
  const log = o.log ?? (() => {});
  const url = await serveUrl(o.publicDir, log, true);
  const inputProps = { manifest: o.manifest, look: o.look, ...(o.design ? { design: o.design } : {}) };
  const composition = await selectComposition({ serveUrl: url, id: "Documentary", inputProps });
  const cores = availableParallelism();
  const ranges = chunkRanges(o.manifest, o.maxChunks ?? Math.max(1, Math.min(4, Math.floor(cores / 3))), o.minChunkS ?? 20);
  const perChunk = Math.max(2, Math.floor(cores / ranges.length));
  const t0 = Date.now();
  if (ranges.length > 1) log(`  render: ${ranges.length} parallel chunks × ${perChunk} threads (${ranges.map(([a, b]) => `${(a / o.manifest.fps).toFixed(0)}–${((b + 1) / o.manifest.fps).toFixed(0)} s`).join(", ")})`);
  const progress = ranges.map(() => 0);
  let last = -1;
  const partPath = (i: number) => (ranges.length === 1 ? o.out : o.out.replace(/\.mp4$/, `.chunk${String(i + 1).padStart(2, "0")}.mp4`));
  // A chunk that fails (e.g. a compositor timeout under load) is retried once with lower concurrency;
  // chunks that already finished are kept.
  const renderChunk = (range: [number, number], i: number, concurrency: number) =>
      renderMedia({
        chromiumOptions: GL,
        composition,
        serveUrl: url,
        codec: "h264",
        crf: o.manifest.output.crf,
        pixelFormat: "yuv420p",
        muted: true,
        frameRange: range,
        outputLocation: partPath(i),
        inputProps,
        concurrency,
        timeoutInMilliseconds: 180_000,
        onProgress: ({ progress: p }) => {
          progress[i] = p;
          const pct = Math.floor((progress.reduce((a, b) => a + b, 0) / ranges.length) * 10) * 10;
          if (pct !== last) {
            last = pct;
            log(`    render ${pct}%`);
          }
        },
      });
  await Promise.all(
    ranges.map(async (range, i) => {
      try {
        await renderChunk(range, i, perChunk);
      } catch (err) {
        log(`  render: chunk ${i + 1} failed (${(err as Error).message.split("\n")[0]!.slice(0, 120)}); retrying with concurrency 2`);
        await renderChunk(range, i, 2);
      }
    }),
  );
  if (ranges.length > 1) {
    const list = o.out.replace(/\.mp4$/, ".chunks.txt");
    await writeFile(list, ranges.map((_, i) => `file '${path.basename(partPath(i))}'`).join("\n") + "\n");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", o.out], { cwd: path.dirname(o.out), timeout: 600_000 });
    await Promise.all(ranges.map((_, i) => unlink(partPath(i)).catch(() => {})));
    await unlink(list).catch(() => {});
  }
  log(`  render: ${o.manifest.durationFrames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s (${(o.manifest.durationFrames / ((Date.now() - t0) / 1000)).toFixed(1)} fps)`);
  return o.out;
}

export async function renderThumbnailStill(o: { publicDir: string; bg: string; headline: string; accentWord?: string; accent: string; placement: "top" | "middle" | "bottom"; width: number; height: number; out: string; log?: (s: string) => void }) {
  const url = await serveUrl(o.publicDir, o.log ?? (() => {}), true);
  const inputProps = { bg: o.bg, headline: o.headline, accentWord: o.accentWord, accent: o.accent, placement: o.placement, w: o.width, h: o.height };
  const composition = await selectComposition({ serveUrl: url, id: "Thumbnail", inputProps });
  await renderStill({ chromiumOptions: GL, composition, serveUrl: url, output: o.out, inputProps, imageFormat: "jpeg", jpegQuality: 92 });
  return o.out;
}

/** Local thumbnail (no generated plate): Library focal object + fire/cash motif + 0–3 bold words. */
export async function renderLocalThumbnail(o: { publicDir: string; focal: string; flames?: string; cash?: string; headline: string; accentWord?: string; tone?: "crimson" | "gold" | "emerald"; width: number; height: number; out: string; log?: (s: string) => void }) {
  const url = await serveUrl(o.publicDir, o.log ?? (() => {}), true);
  const inputProps = { focal: o.focal, flames: o.flames, cash: o.cash, headline: o.headline, accentWord: o.accentWord, tone: o.tone, w: o.width, h: o.height };
  const composition = await selectComposition({ serveUrl: url, id: "ThumbnailLocal", inputProps });
  await renderStill({ chromiumOptions: GL, composition, serveUrl: url, output: o.out, inputProps, imageFormat: "jpeg", jpegQuality: 92 });
  return o.out;
}

/** Thumbnail from a composed scene spec (real cutouts on the film's colour world), frozen after its entrances. */
export async function renderThumbnailScene(o: { publicDir: string; spec: unknown; slots: Record<string, string>; design?: unknown; width?: number; height?: number; out: string; log?: (s: string) => void }): Promise<string> {
  const url = await serveUrl(o.publicDir, o.log ?? (() => {}), true);
  const inputProps = { spec: o.spec, slots: o.slots, ...(o.design ? { design: o.design } : {}), w: o.width ?? 1280, h: o.height ?? 720 };
  const composition = await selectComposition({ serveUrl: url, id: "ThumbnailScene", inputProps });
  await renderStill({ chromiumOptions: GL, composition, serveUrl: url, output: o.out, inputProps, frame: 80, imageFormat: "jpeg", jpegQuality: 93 });
  return o.out;
}

/** WebGL backend for Three.js scenes: ANGLE on macOS/Windows, software ANGLE in Linux containers. */
export const GL = { gl: (process.platform === "linux" ? "swangle" : "angle") as "angle" | "swangle" };

/** Shared bundle access for other render helpers (frame gate). */
export const serveUrlFor = (publicDir: string, log: (s: string) => void, fresh = false) => serveUrl(publicDir, log, fresh);
