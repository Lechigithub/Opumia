// The thumbnail's render (the film agent's packaging): its own Remotion entry, only the ThumbnailScene composition.
// Films themselves are rendered from each job's own project (hand/render-film.ts).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILM_STUB = path.join(here, "remotion", "film", "stub.tsx");
/** The channel's craft as shared tools (techniques, never a look). */
const CRAFT = path.join(here, "remotion", "craft.tsx");

const THUMB_ENTRY = path.join(here, "remotion", "thumb", "index.tsx");
const thumbBundles = new Map<string, string>();
/** The thumbnail's own bundle: only ThumbnailScene (no film kit, no documentary scenes). */
async function thumbUrl(publicDir: string, log: (s: string) => void, fresh: boolean) {
  const hit = thumbBundles.get(publicDir);
  if (hit && !fresh) return hit;
  log("  thumbnail: bundling…");
  const url = await bundle({
    entryPoint: THUMB_ENTRY, publicDir, onProgress: () => {},
    webpackOverride: (cfg) => ({ ...cfg, resolve: { ...(cfg.resolve ?? {}), modules: [...((cfg.resolve?.modules as string[]) ?? ["node_modules"]), path.join(here, "..", "node_modules"), path.join(here, "..", "..", "..", "node_modules")], alias: { ...((cfg.resolve?.alias as Record<string, string>) ?? {}), "@film": FILM_STUB, "@craft": CRAFT } } }),
  });
  thumbBundles.set(publicDir, url);
  return url;
}

/** Thumbnail from a composed scene spec (real cutouts on the film's colour world), frozen after its entrances. */
export async function renderThumbnailScene(o: { publicDir: string; spec: unknown; slots: Record<string, string>; design?: unknown; finish?: unknown; width?: number; height?: number; out: string; fresh?: boolean; log?: (s: string) => void }): Promise<string> {
  // A new bundle only when public/ gained files since the last one (Remotion snapshots public/ at bundle time).
  const url = await thumbUrl(o.publicDir, o.log ?? (() => {}), o.fresh ?? true);
  const inputProps = { spec: o.spec, slots: o.slots, ...(o.design ? { design: o.design } : {}), ...(o.finish ? { finish: o.finish } : {}), w: o.width ?? 1280, h: o.height ?? 720 };
  const composition = await selectComposition({ serveUrl: url, id: "ThumbnailScene", inputProps });
  await renderStill({ chromiumOptions: GL, composition, serveUrl: url, output: o.out, inputProps, frame: 80, imageFormat: "jpeg", jpegQuality: 93 });
  return o.out;
}

/** WebGL backend for Three.js scenes: ANGLE on macOS/Windows, software ANGLE in Linux containers. */
export const GL = { gl: (process.platform === "linux" ? "swangle" : "angle") as "angle" | "swangle" };

