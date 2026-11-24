// Voice sound quality and mix only (owner, 2026-11-24): the same narration through variants of the voice chain, each
// mixed over the film's own bed at the film's level, ears-scored where the narrator speaks (four window grids). Same
// words in every variant, so the scores compare. A variant that wins goes into motion-engine/audio.ts for every film.
//   npx tsx apps/cli/src/dev/hand/voice-chain.ts out/<job> <narration.mp3>
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
import { RenderManifest } from "@opumia/contracts";
import { premixStems } from "@opumia/motion-engine";
const root = process.cwd(), data = path.join(root, "data"), job = path.resolve(process.argv[2]!), narr = path.resolve(process.argv[3]!);
const m = RenderManifest.parse(JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8")));
const st = await premixStems(m, path.join(job, "ears"));
const W = JSON.parse(await readFile(path.join(job, "narration-words.json"), "utf8")) as Array<{ startS: number; endS: number }>;
const lufs = (f: string) => { const o = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr; return Number([...o.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)![1]); };
const gain = -16 - lufs(narr);
const ROOM = "aecho=1:1:31|53:0.14|0.09,aecho=1:1:23|41:0.12|0.08";
const EQ = "highpass=f=70,equalizer=f=160:t=q:w=1.0:g=2,equalizer=f=380:t=q:w=1.4:g=-2,equalizer=f=3200:t=q:w=1.2:g=1.5";
const COMP = "acompressor=threshold=-24dB:ratio=2.2:attack=20:release=250:makeup=2,acompressor=threshold=-12dB:ratio=4:attack=3:release=60:makeup=1";
const V: Record<string, string> = {
  current: `${EQ},deesser=i=0.35:m=0.5:f=0.5,${COMP},highshelf=f=11000:g=1,${ROOM}`,
  dry: `${EQ},deesser=i=0.35:m=0.5:f=0.5,${COMP},highshelf=f=11000:g=1`,
  room_light: `${EQ},deesser=i=0.35:m=0.5:f=0.5,${COMP},highshelf=f=11000:g=1,aecho=1:1:31|53:0.08|0.05`,
  presence: `highpass=f=70,equalizer=f=160:t=q:w=1.0:g=2,equalizer=f=380:t=q:w=1.4:g=-2,equalizer=f=3200:t=q:w=1.2:g=3,deesser=i=0.35:m=0.5:f=0.5,${COMP},highshelf=f=11000:g=2,${ROOM}`,
  gentle_comp: `${EQ},deesser=i=0.35:m=0.5:f=0.5,acompressor=threshold=-22dB:ratio=1.6:attack=25:release=300:makeup=1.5,highshelf=f=11000:g=1,${ROOM}`,
  warm: `highpass=f=60,equalizer=f=140:t=q:w=1.0:g=3,equalizer=f=380:t=q:w=1.4:g=-1,equalizer=f=3200:t=q:w=1.2:g=1.5,deesser=i=0.35:m=0.5:f=0.5,${COMP},highshelf=f=11000:g=1,${ROOM}`,
};
const span = W.at(-1)!.endS;
const spoken = (t: number, d: number) => W.reduce((a, w) => a + Math.max(0, Math.min(w.endS + 0.12, t + d) - Math.max(w.startS, t)), 0) >= 0.75 * d;
for (const [name, chain] of Object.entries(V)) {
  const out = path.join(job, "ears", `vchain_${name}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", narr, "-i", st.bed, "-filter_complex", `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${gain.toFixed(2)}dB,${chain}[v];[1:a]aresample=48000,aformat=channel_layouts=stereo[b];[v][b]amix=inputs=2:normalize=0:duration=first[o]`, "-map", "[o]", "-ar", "48000", out]);
  const meds: number[] = [];
  for (const o of [0, 1, 2, 3]) {
    const wins = Array.from({ length: Math.floor((span - o) / 4) }, (_, i) => ({ file: out, t: o + i * 4, dur: 4 })).filter((w) => spoken(w.t, w.dur));
    meds.push((await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: wins }))?.median ?? NaN);
  }
  console.log(`${name.padEnd(12)} voice ${(meds.reduce((a, b) => a + b, 0) / 4).toFixed(3)}  (${meds.map((x) => x.toFixed(3)).join(" ")})`);
}
