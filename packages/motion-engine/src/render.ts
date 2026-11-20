import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { RenderManifest } from "@opumia/contracts";

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

/** Render the video track (muted) with Remotion; audio is mastered separately with FFmpeg. */
export async function renderVideo(o: { manifest: RenderManifest; look: Look; publicDir: string; out: string; log?: (s: string) => void }) {
  const log = o.log ?? (() => {});
  const url = await serveUrl(o.publicDir, log, true);
  const inputProps = { manifest: o.manifest, look: o.look };
  const composition = await selectComposition({ serveUrl: url, id: "Documentary", inputProps });
  let last = -1;
  await renderMedia({
    composition,
    serveUrl: url,
    codec: "h264",
    crf: o.manifest.output.crf,
    pixelFormat: "yuv420p",
    muted: true,
    outputLocation: o.out,
    inputProps,
    concurrency: Math.max(2, Math.floor(availableParallelism() / 2)),
    timeoutInMilliseconds: 120_000,
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 10) * 10;
      if (pct !== last) {
        last = pct;
        log(`    render ${pct}%`);
      }
    },
  });
  return o.out;
}

export async function renderThumbnailStill(o: { publicDir: string; bg: string; headline: string; accentWord?: string; accent: string; placement: "top" | "middle" | "bottom"; width: number; height: number; out: string; log?: (s: string) => void }) {
  const url = await serveUrl(o.publicDir, o.log ?? (() => {}), true);
  const inputProps = { bg: o.bg, headline: o.headline, accentWord: o.accentWord, accent: o.accent, placement: o.placement, w: o.width, h: o.height };
  const composition = await selectComposition({ serveUrl: url, id: "Thumbnail", inputProps });
  await renderStill({ composition, serveUrl: url, output: o.out, inputProps, imageFormat: "jpeg", jpegQuality: 92 });
  return o.out;
}
