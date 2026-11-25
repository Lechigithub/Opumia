import { execFile } from "node:child_process";
import { rename, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { FilmDesignSystem, RenderManifest } from "@opumia/contracts";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "remotion", "index.tsx");
const FILM_STUB = path.join(here, "remotion", "film", "stub.tsx");
const COMPOSITES_STUB = path.join(here, "remotion", "film", "composites-stub.tsx");
/** The channel's craft as shared tools (techniques, never a look): kits and composites import them as "@craft". */
const CRAFT = path.join(here, "remotion", "craft.tsx");

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
  // Step 5: a job's own motion-design kit (design/film/index.tsx beside its public/ folder) is bundled as "@film";
  // without one, the empty stub is.
  const jobFilm = path.join(path.dirname(publicDir), "design", "film", "index.tsx");
  const film = existsSync(jobFilm) ? jobFilm : FILM_STUB;
  // the scene designer's per-scene composites (hand film method: one bespoke layered component per scene)
  const jobComp = path.join(path.dirname(publicDir), "design", "film", "composites.tsx");
  const composites = existsSync(jobComp) ? jobComp : COMPOSITES_STUB;
  log(`  render: bundling Remotion project${film === jobFilm ? " with the film's own design kit" : ""}…`);
  const url = await bundle({
    entryPoint: ENTRY,
    publicDir,
    onProgress: () => {},
    // the kit lives in the job folder: it resolves react, remotion and the Google fonts from the engine's own packages
    webpackOverride: (cfg) => ({ ...cfg, resolve: { ...(cfg.resolve ?? {}), modules: [...((cfg.resolve?.modules as string[]) ?? ["node_modules"]), path.join(here, "..", "node_modules"), path.join(here, "..", "..", "..", "node_modules")], alias: { ...((cfg.resolve?.alias as Record<string, string>) ?? {}), "@film": film, "@craft": CRAFT, "@composites": composites } } }),
  });
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

/**
 * Build list 3, item 17: re-render only the frame ranges that changed and splice them into the film's existing silent
 * video (frame-exact trims, one re-encode of the whole picture at the manifest's quality). The ranges are merged when
 * they touch; the manifest must have the same length as the film it replaces.
 */
export async function renderStretches(o: { manifest: RenderManifest; look: Look; design?: FilmDesignSystem; publicDir: string; previous: string; out: string; ranges: Array<[number, number]>; log?: (s: string) => void }): Promise<{ out: string; frames: number }> {
  const log = o.log ?? (() => {});
  const last = o.manifest.durationFrames - 1;
  const ranges = [...o.ranges].map(([a, b]) => [Math.max(0, a), Math.min(last, b)] as [number, number]).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const m = merged.at(-1);
    if (m && r[0] <= m[1] + 1) m[1] = Math.max(m[1], r[1]);
    else merged.push([...r]);
  }
  if (!merged.length) return { out: o.previous, frames: 0 };
  const url = await serveUrl(o.publicDir, log, true);
  const inputProps = { manifest: o.manifest, look: o.look, ...(o.design ? { design: o.design } : {}) };
  const composition = await selectComposition({ serveUrl: url, id: "Documentary", inputProps });
  const part = (i: number) => o.out.replace(/\.mp4$/, `.stretch${String(i + 1).padStart(2, "0")}.mp4`);
  const t0 = Date.now();
  for (const [i, range] of merged.entries()) {
    await renderMedia({ chromiumOptions: GL, composition, serveUrl: url, codec: "h264", crf: o.manifest.output.crf, pixelFormat: "yuv420p", muted: true, frameRange: range, outputLocation: part(i), inputProps, concurrency: Math.max(2, availableParallelism() - 1), timeoutInMilliseconds: 180_000 });
  }
  // [old 0..a) [new a..b] [old b+1..c) … [old ..end]
  const inputs = ["-i", o.previous, ...merged.flatMap((_, i) => ["-i", part(i)])];
  const pieces: string[] = [];
  const filters: string[] = [];
  let at = 0;
  merged.forEach(([a, b], i) => {
    if (a > at) (filters.push(`[0:v]trim=start_frame=${at}:end_frame=${a},setpts=PTS-STARTPTS[o${i}]`), pieces.push(`[o${i}]`));
    filters.push(`[${i + 1}:v]setpts=PTS-STARTPTS[n${i}]`);
    pieces.push(`[n${i}]`);
    at = b + 1;
  });
  if (at <= last) (filters.push(`[0:v]trim=start_frame=${at}:end_frame=${last + 1},setpts=PTS-STARTPTS[oz]`), pieces.push("[oz]"));
  filters.push(`${pieces.join("")}concat=n=${pieces.length}:v=1:a=0,fps=${o.manifest.fps}[v]`);
  const tmp = o.out.replace(/\.mp4$/, ".splice.mp4");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[v]", "-c:v", "libx264", "-crf", String(o.manifest.output.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp], { timeout: 900_000 });
  await rename(tmp, o.out);
  await Promise.all(merged.map((_, i) => unlink(part(i)).catch(() => {})));
  const frames = merged.reduce((n, [a, b]) => n + b - a + 1, 0);
  log(`  render: ${frames} of ${o.manifest.durationFrames} frames re-rendered in ${merged.length} stretch(es), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { out: o.out, frames };
}

/** Thumbnail from a composed scene spec (real cutouts on the film's colour world), frozen after its entrances. */
export async function renderThumbnailScene(o: { publicDir: string; spec: unknown; slots: Record<string, string>; design?: unknown; finish?: unknown; width?: number; height?: number; out: string; fresh?: boolean; log?: (s: string) => void }): Promise<string> {
  // A new bundle only when public/ gained files since the last one (Remotion snapshots public/ at bundle time).
  const url = await serveUrl(o.publicDir, o.log ?? (() => {}), o.fresh ?? true);
  const inputProps = { spec: o.spec, slots: o.slots, ...(o.design ? { design: o.design } : {}), ...(o.finish ? { finish: o.finish } : {}), w: o.width ?? 1280, h: o.height ?? 720 };
  const composition = await selectComposition({ serveUrl: url, id: "ThumbnailScene", inputProps });
  await renderStill({ chromiumOptions: GL, composition, serveUrl: url, output: o.out, inputProps, frame: 80, imageFormat: "jpeg", jpegQuality: 93 });
  return o.out;
}

/** WebGL backend for Three.js scenes: ANGLE on macOS/Windows, software ANGLE in Linux containers. */
export const GL = { gl: (process.platform === "linux" ? "swangle" : "angle") as "angle" | "swangle" };

/** Shared bundle access for other render helpers (frame gate). */
export const serveUrlFor = (publicDir: string, log: (s: string) => void, fresh = false) => serveUrl(publicDir, log, fresh);
