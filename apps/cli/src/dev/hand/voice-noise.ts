// How much the voice score (the ears' median over 4 s windows) moves with the window grid alone: offsets 0/1/2/3 s.
//   npx tsx apps/cli/src/dev/hand/voice-noise.ts <film.mp4> …
import { execFileSync } from "node:child_process";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
for (const film of process.argv.slice(2)) {
  const span = Math.min(120, Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", film]).toString()) - 0.5);
  const meds: number[] = [];
  for (const off of [0, 1, 2, 3]) {
    const wins = Array.from({ length: Math.floor((span - off) / 4) }, (_, i) => ({ file: path.resolve(film), t: off + i * 4, dur: 4 }));
    meds.push((await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: wins }))?.median ?? NaN);
  }
  console.log(`${film}: ${meds.map((x) => x.toFixed(3)).join(" ")} | mean ${(meds.reduce((a, b) => a + b, 0) / 4).toFixed(3)} | spread ${(Math.max(...meds) - Math.min(...meds)).toFixed(3)}`);
}
