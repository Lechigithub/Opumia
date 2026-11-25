// "Listen" to a film's opening without ears: the words spoken (local Whisper) with their timing, the speaking rate and
// pauses, and the loudness every half second (how music and effects rise and fall around the voice).
//   npx tsx apps/cli/src/dev/hand/listen.ts <audio.wav> …
import { spawnSync } from "node:child_process";
import path from "node:path";
import { transcribe } from "@opumia/senses";
for (const f of process.argv.slice(2)) {
  const r = await transcribe(f, { dataDir: path.join(process.cwd(), "data") });
  const w = r.words;
  const dur = w.at(-1)!.endS - w[0]!.startS;
  const gaps = w.slice(1).map((x, i) => x.startS - w[i]!.endS);
  const o = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128=metadata=1,ametadata=print:key=lavfi.r128.M", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const M = [...o.matchAll(/lavfi\.r128\.M=(-?[\d.]+)/g)].map((m) => Number(m[1])).filter((_, i) => i % 5 === 0);
  const sorted = [...M].filter((x) => x > -70).sort((a, b) => a - b);
  console.log(`== ${path.basename(f)}: ${w.length} words in ${dur.toFixed(0)} s = ${(w.length / dur * 60).toFixed(0)} wpm; pauses >= 0.4 s: ${gaps.filter((g) => g >= 0.4).length}; loudness range p10..p90 ${sorted[Math.floor(sorted.length * 0.1)]?.toFixed(1)}..${sorted[Math.floor(sorted.length * 0.9)]?.toFixed(1)} LUFS`);
  console.log(`   loudness every 0.5 s: ${M.slice(0, 180).map((x) => (x < -60 ? "_" : x < -30 ? "." : x < -22 ? "-" : x < -17 ? "=" : "#")).join("")}`);
  console.log(`   words: ${w.map((x) => x.word).join(" ").slice(0, 700)}`);
}
