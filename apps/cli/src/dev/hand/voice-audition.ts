// Ears-scored voice audition: one line, many voices (and models); each take scored dry and in the film's own mix
// (room + the film's bed). Audio measured locally; ElevenLabs characters are the only spend.
//   npx tsx apps/cli/src/dev/hand/voice-audition.ts out/hand-ftx
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
import { ttsWithTimestamps } from "@opumia/narration";
import { loadKeys } from "../../keys.js";

const root = process.cwd(), data = path.join(root, "data");
loadKeys(root);
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const dir = path.join(job, "audition"); await mkdir(dir, { recursive: true });
const LINE = "Binance agreed to buy the company, and one day later it walked away, saying the problems were beyond its control or ability to help.";
const VOICES: Array<[string, string, string]> = [
  ["RolvCZ4e0AkAR2dzyTx0", "Christopher", "eleven_v4"], ["RolvCZ4e0AkAR2dzyTx0", "Christopher-v2", "eleven_multilingual_v2"],
  ["3H55HGnNE1XjYxigHSAS", "MarcusK", "eleven_v4"], ["S75jVZ0i3J6Xa5BbK8CE", "Spartan", "eleven_v4"], ["VMCgCMbBs53ElBxVD4VB", "Steven", "eleven_v4"],
  ["MFZUKuGQUsGJPQjTS4wC", "WarmGrounded", "eleven_v4"], ["zs057lc0shdaAFXkm2Fm", "Patrick", "eleven_v4"], ["3YzGaTGef0x5PLEK9yGq", "Atlas", "eleven_v4"],
  ["8Al3hFcl1x3aCwvxoEJC", "Jefferson", "eleven_v4"], ["nPczCjzI2devNBz1zQrb", "Brian", "eleven_v4"], ["iP95p4xoKVk53GoZ742B", "Chris", "eleven_v4"], ["CwhRBWXzGAHq8TQ4Fs17", "Roger", "eleven_v4"],
];
const bed = path.join(job, "ears", "stem-bed.wav");
const ROOM = "aecho=0.8:0.5:23|41:0.18|0.11";
const rows: string[] = [];
for (const [id, name, model] of VOICES) {
  const mp3 = path.join(dir, `${name}.mp3`);
  if (!existsSync(mp3)) {
    const t = await ttsWithTimestamps({ voiceId: id, modelId: model, text: LINE, stability: 0.35, similarityBoost: 0.8, style: 0.4, speed: 1, seed: 11 }).catch((e) => { console.log(`${name}: ${String(e).slice(0, 120)}`); return null; });
    if (!t) continue;
    await writeFile(mp3, t.audio);
  }
  const mixed = path.join(dir, `${name}_mix.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-ss", "45", "-i", bed, "-filter_complex", `[0:a]aresample=48000,${ROOM}[v];[1:a]volume=2dB[b];[v][b]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5[o]`, "-map", "[o]", mixed]);
  const win = (f: string) => [0, 2.5, 5].map((t) => ({ file: f, t, dur: 4 }));
  const dry = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: win(mp3) });
  const mv = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: win(mixed) });
  const mm = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items: win(mixed) });
  rows.push(`${name.padEnd(15)} dry ${dry?.median}  mixed-voice ${mv?.median}  mixed-mix ${mm?.median}`);
  console.log(rows.at(-1));
}
await writeFile(path.join(dir, "results.txt"), rows.join("\n"));
