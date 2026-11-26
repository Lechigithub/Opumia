// Render a hand-made Remotion film project (its own entry, its own public folder), silent.
//   npx tsx packages/motion-engine/src/hand/render-film.ts <job-dir> [--frames a-b | --stills t1,t2,… | --sheet from-to]
//   <job-dir>/src/index.ts is the entry, <job-dir>/public the media; writes <job-dir>/picture.mp4 or <job-dir>/stills/*.jpg
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
const here = path.dirname(new URL(import.meta.url).pathname);
const job = path.resolve(process.argv[2]!);
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const url = await bundle({
  entryPoint: path.join(job, "src", "index.ts"), publicDir: path.join(job, "public"), onProgress: () => {},
  webpackOverride: (cfg) => ({ ...cfg, resolve: { ...(cfg.resolve ?? {}), modules: [...((cfg.resolve?.modules as string[]) ?? ["node_modules"]), path.join(here, "..", "..", "node_modules"), path.join(here, "..", "..", "..", "..", "node_modules")], alias: { ...((cfg.resolve?.alias as Record<string, string>) ?? {}), "@craft": path.join(here, "..", "remotion", "craft.tsx") } } }),
});
const comp = await selectComposition({ serveUrl: url, id: "Film" });
const stills = arg("--stills");
if (stills) {
  await mkdir(path.join(job, "stills"), { recursive: true });
  for (const s of stills.split(",")) {
    const frame = Math.round(Number(s) * comp.fps);
    const out = path.join(job, "stills", `t${Number(s).toFixed(2)}.jpg`);
    await renderStill({ composition: comp, serveUrl: url, output: out, frame, imageFormat: "jpeg", jpegQuality: 85, scale: 0.5 });
    console.log(out);
  }
} else {
  const fr = arg("--frames")?.split("-").map(Number) as [number, number] | undefined;
  const out = path.join(job, fr ? `picture_${fr[0]}-${fr[1]}.mp4` : "picture.mp4");
  await renderMedia({ composition: comp, serveUrl: url, codec: "h264", outputLocation: out, crf: 18, muted: true, concurrency: 6, frameRange: fr ? [Math.round(fr[0] * comp.fps), Math.round(fr[1] * comp.fps) - 1] : undefined, onProgress: ({ progress }) => { if (Math.round(progress * 100) % 20 === 0) process.stdout.write(`\r  render ${Math.round(progress * 100)}%`); } });
  console.log("\n" + out);
}
