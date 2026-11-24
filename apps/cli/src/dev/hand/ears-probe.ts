// Do the ears judge the voice, or the recording around it? Score the same take dry, through the broadcast voice
// chain, and with chain + room tone + a music bed, and score real reference narration windows the same way.
//   npx tsx apps/cli/src/dev/hand/ears-probe.ts <take.wav> <bed.mp3> <outdir>
import { execFileSync } from "node:child_process";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";

const root = process.cwd();
const [take, bed, dir] = process.argv.slice(2) as [string, string, string];
const CHAIN = "highpass=f=70,equalizer=f=160:t=q:w=1.0:g=2,equalizer=f=380:t=q:w=1.4:g=-2,equalizer=f=3200:t=q:w=1.2:g=1.5,deesser=i=0.35:m=0.5:f=0.5,acompressor=threshold=-24dB:ratio=2.2:attack=20:release=250:makeup=2,acompressor=threshold=-12dB:ratio=4:attack=3:release=60:makeup=1";
const ff = (a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
const chain = path.join(dir, "chain.wav"), mixed = path.join(dir, "mixed.wav"), room = path.join(dir, "room.wav");
ff(["-i", take, "-af", CHAIN, chain]);
ff(["-i", take, "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.004", "-af", "", "-filter_complex", `[0:a]${CHAIN}[v];[1:a]lowpass=f=900[n];[v][n]amix=inputs=2:duration=first:normalize=0`, room].filter((x) => x !== "-af" && x !== ""));
ff(["-i", take, "-i", bed, "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.004", "-filter_complex", `[0:a]${CHAIN}[v];[1:a]volume=-20dB[b];[2:a]lowpass=f=900[n];[v][b][n]amix=inputs=3:duration=first:normalize=0`, mixed]);
for (const [k, f] of [["dry", take], ["chain", chain], ["room", room], ["mixed", mixed]] as const) {
  const r = await scoreSoundTaste({ root, data: path.join(root, "data"), channel: "magnates-media", kind: "voice", items: [0, 2].map((t) => ({ file: f, t, dur: 4 })) });
  console.log(k, r?.scores.join(" "));
}
