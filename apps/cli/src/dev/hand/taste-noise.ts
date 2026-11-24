// How much the picture-taste median moves with the sample grid alone: the same film, frames every 2 s, offset by
// 0 / 0.5 / 1 / 1.5 s. The spread is the measure's own noise.
//   npx tsx apps/cli/src/dev/hand/taste-noise.ts <film.mp4> …
import { execFileSync } from "node:child_process";
import path from "node:path";
import { scoreTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
for (const film of process.argv.slice(2)) {
  const span = Math.min(120, Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", film]).toString()) - 0.5);
  const meds: number[] = [];
  for (const off of [0, 0.5, 1, 1.5]) {
    const ts = Array.from({ length: Math.floor((span - off) / 2) }, (_, i) => 1 + off + i * 2).filter((t) => t < span);
    const sc = (await scoreTaste({ root, data, channel: "magnates-media", kind: "shot", items: ts.map((t) => ({ file: path.resolve(film), t })) })).map((x) => x?.score ?? NaN).filter(Number.isFinite).sort((a, b) => a - b);
    meds.push(sc[Math.floor(sc.length / 2)]!);
  }
  const mean = meds.reduce((a, b) => a + b, 0) / meds.length;
  console.log(`${film}: medians ${meds.map((x) => x.toFixed(2)).join(" ")} | mean ${mean.toFixed(2)} | spread ${(Math.max(...meds) - Math.min(...meds)).toFixed(2)}`);
}
