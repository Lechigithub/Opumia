// Does the mastering stage (loudness target, limiter) cost the mix? Same premix, mastered several ways, ears-scored.
//   npx tsx apps/cli/src/dev/hand/master-test.ts out/hand-ftx
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
import { RenderManifest } from "@opumia/contracts";
import { premixStems } from "@opumia/motion-engine";
const root = process.cwd(), data = path.join(root, "data"), job = path.resolve(process.argv[2]!);
const m = RenderManifest.parse(JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8")));
const st = await premixStems(m, path.join(job, "ears"));
const V: Record<string, string> = {
  lufs14: "loudnorm=I=-14:TP=-1.5:LRA=11",
  lufs12_5_limit: "loudnorm=I=-12.5:TP=-1.5:LRA=11,alimiter=limit=0.8:level=false",
  lufs14_limit: "loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.8:level=false",
  lufs16: "loudnorm=I=-16:TP=-1.5:LRA=11",
};
for (const [k, af] of Object.entries(V)) {
  const out = path.join(job, "ears", `m_${k}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", st.mix, "-af", af, out]);
  const items = Array.from({ length: 18 }, (_, i) => ({ file: out, t: i * 4, dur: 4 }));
  const x = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items });
  const v = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items });
  console.log(`${k}: voice ${v?.median} mix ${x?.median}`);
}
const items = Array.from({ length: 18 }, (_, i) => ({ file: path.join(job, "film_16x9.mp4"), t: i * 4, dur: 4 }));
console.log(`the film's master: mix ${(await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items }))?.median}`);
