// Render a hand-made Remotion film project (its own entry, its own public folder), silent.
//   npx tsx packages/motion-engine/src/hand/render-film.ts <job-dir> [--frames a-b | --stills t1,t2,… | --sheet from-to]
//   <job-dir>/src/index.ts is the entry, <job-dir>/public the media; writes <job-dir>/picture.mp4 or <job-dir>/stills/*.jpg
//   --entry src/entries/s03.ts   render one scene's own entry (the film agent's scene builders: a broken scene never
//                                breaks another's render); --offset S: film time of the entry's frame 0 (stills and
//                                frames are given in film seconds); --stills-dir, --out, --scale for where and how big
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
const here = path.dirname(new URL(import.meta.url).pathname);
const job = path.resolve(process.argv[2]!);
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const offset = Number(arg("--offset") ?? 0);
const url = await bundle({
  entryPoint: path.join(job, arg("--entry") ?? path.join("src", "index.ts")), publicDir: path.join(job, "public"), symlinkPublicDir: true, onProgress: () => {},
  webpackOverride: (cfg) => ({ ...cfg, resolve: { ...(cfg.resolve ?? {}), modules: [...((cfg.resolve?.modules as string[]) ?? ["node_modules"]), path.join(here, "..", "..", "node_modules"), path.join(here, "..", "..", "..", "..", "node_modules")], alias: { ...((cfg.resolve?.alias as Record<string, string>) ?? {}), "@craft": path.join(here, "..", "remotion", "craft.tsx") } } }),
});
const comp = await selectComposition({ serveUrl: url, id: "Film" });
const stills = arg("--stills");
if (stills) {
  const dir = path.join(job, arg("--stills-dir") ?? "stills");
  await mkdir(dir, { recursive: true });
  for (const s of stills.split(",")) {
    const frame = Math.max(0, Math.min(comp.durationInFrames - 1, Math.round((Number(s) - offset) * comp.fps)));
    const out = path.join(dir, `t${Number(s).toFixed(2)}.jpg`);
    await renderStill({ composition: comp, serveUrl: url, output: out, frame, imageFormat: "jpeg", jpegQuality: 85, scale: 0.5 });
    console.log(out);
  }
} else {
  const fr = arg("--frames")?.split("-").map(Number) as [number, number] | undefined;
  const out = path.join(job, arg("--out") ?? (fr ? `picture_${fr[0]}-${fr[1]}.mp4` : "picture.mp4"));
  const last = comp.durationInFrames - 1;
  await renderMedia({ composition: comp, serveUrl: url, codec: "h264", outputLocation: out, crf: 18, muted: true, concurrency: Number(arg("--concurrency") ?? 6), scale: Number(arg("--scale") ?? 1), frameRange: fr ? [Math.max(0, Math.round((fr[0] - offset) * comp.fps)), Math.min(last, Math.round((fr[1] - offset) * comp.fps) - 1)] : undefined, onProgress: ({ progress }) => { if (Math.round(progress * 100) % 20 === 0) process.stdout.write(`\r  render ${Math.round(progress * 100)}%`); } });
  console.log("\n" + out);
}
// the bundle links public/ (no copy of every clip per render) and is removed once rendered
if (path.isAbsolute(url) && path.resolve(url).startsWith(path.resolve(tmpdir()))) await rm(url, { recursive: true, force: true }).catch(() => {});
