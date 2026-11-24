// Whole-narration ears: each candidate narration dry, and in the film's room + bed (median over 4 s windows).
//   npx tsx apps/cli/src/dev/hand/voice-compare.ts out/hand-ftx christopher patrick marcus
import { execFileSync } from "node:child_process";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const [jobArg, ...tags] = process.argv.slice(2);
const job = path.resolve(jobArg!);
for (const t of tags) {
  const f = path.join(job, `narration-${t}.mp3`);
  const mixed = path.join(job, "ears", `nar-${t}-mix.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", f, "-i", path.join(job, "ears", "stem-bed.wav"), "-filter_complex", "[0:a]aresample=48000,aecho=0.8:0.5:23|41:0.18|0.11[v];[1:a]anull[b];[v][b]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5[o]", "-map", "[o]", mixed]);
  const w = (x: string) => Array.from({ length: 18 }, (_, i) => ({ file: x, t: i * 4, dur: 4 }));
  const dry = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: w(f) });
  const mv = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: w(mixed) });
  const mm = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items: w(mixed) });
  console.log(`${t}: dry ${dry?.median} | in film mix: voice ${mv?.median} mix ${mm?.median}`);
}
