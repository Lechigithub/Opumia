// Which mix changes move the ears? Remix the film's own stems several ways and score voice humanness and channel mix.
//   npx tsx apps/cli/src/dev/hand/ears-mix.ts out/hand-ftx
import { execFileSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
import { RenderManifest } from "@opumia/contracts";
import { premixStems } from "@opumia/motion-engine";

const root = process.cwd(), data = path.join(root, "data");
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const dir = path.join(job, "ears"); await mkdir(dir, { recursive: true });
const m = RenderManifest.parse(JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8")));
const st = await premixStems(m, dir);
const ff = (a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
const V: Record<string, [string, number]> = {
  asis: ["anull", 0], bedUp6: ["anull", 6], bedDown6: ["anull", -6],
  room: ["aecho=0.8:0.5:23|41:0.18|0.11", 0],
  mic: ["acompressor=threshold=-20dB:ratio=3:attack=5:release=80,asoftclip=type=tanh:threshold=0.9,lowpass=f=12000,equalizer=f=120:t=q:w=1:g=2", 0],
  roomMicBedUp: ["aecho=0.8:0.5:23|41:0.18|0.11,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,asoftclip=type=tanh:threshold=0.9", 4],
};
for (const [k, [vf, bedDb]] of Object.entries(V)) {
  const out = path.join(dir, `v_${k}.wav`);
  ff(["-i", st.voice, "-i", st.bed, "-filter_complex", `[0:a]${vf}[v];[1:a]volume=${bedDb}dB[b];[v][b]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5[o]`, "-map", "[o]", out]);
  const items = Array.from({ length: 10 }, (_, i) => ({ file: out, t: 2 + i * 7.5, dur: 4 }));
  const v = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items });
  const x = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items });
  console.log(`${k}: voice ${v?.median} mix ${x?.median}`);
}
