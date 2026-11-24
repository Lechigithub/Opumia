// Ears-scored delivery settings for one voice: the same three lines at several stability/style settings, each scored
// dry and in the film's mix (the engine's narrator room + the film's bed).
//   npx tsx apps/cli/src/dev/hand/voice-settings.ts out/hand-ftx <voiceId>
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
import { ttsWithTimestamps } from "@opumia/narration";
import { loadKeys } from "../../keys.js";
import { LINES } from "./script.js";
const root = process.cwd(), data = path.join(root, "data");
loadKeys(root);
const [jobArg, voiceId] = process.argv.slice(2) as [string, string];
const job = path.resolve(jobArg), dir = path.join(job, "voice-settings"); await mkdir(dir, { recursive: true });
const ROOM = "aecho=0.8:0.6:31|53:0.14|0.09,aecho=0.8:0.5:23|41:0.18|0.11";
const SET: Array<[string, number, number]> = [["s35y40", 0.35, 0.4], ["s50y20", 0.5, 0.2], ["s25y60", 0.25, 0.6], ["s45y00", 0.45, 0], ["s60y35", 0.6, 0.35]];
const lines = [LINES[3]!, LINES[7]!, LINES[8]!];
for (const [tag, st, sy] of SET) {
  const files: string[] = [];
  for (const [i, L] of lines.entries()) {
    const f = path.join(dir, `${tag}_${i}.mp3`);
    if (!existsSync(f)) await writeFile(f, (await ttsWithTimestamps({ voiceId, modelId: "eleven_v4", text: L.text.replace(/Binance/g, "Bye-nance"), stability: st, similarityBoost: 0.8, style: sy, speed: 1, seed: 11 })).audio);
    files.push(f);
  }
  const cat = path.join(dir, `${tag}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:a]`).join("")}concat=n=${files.length}:v=0:a=1[o]`, "-map", "[o]", "-ar", "48000", cat]);
  const mixed = path.join(dir, `${tag}_mix.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", cat, "-ss", "20", "-i", path.join(job, "ears", "stem-bed.wav"), "-filter_complex", `[0:a]${ROOM}[v];[v][1:a]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5[o]`, "-map", "[o]", mixed]);
  const w = (f: string) => Array.from({ length: 6 }, (_, i) => ({ file: f, t: i * 4, dur: 4 }));
  const dry = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: w(cat) });
  const mv = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: w(mixed) });
  const mm = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items: w(mixed) });
  console.log(`${tag}: dry ${dry?.median} | in mix: voice ${mv?.median} mix ${mm?.median}`);
}
