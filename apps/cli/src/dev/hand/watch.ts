// Watch and listen to a stretch as closely as I can without eyes in real time or ears (owner, 2026-11-25: "you judge
// the pass by watching and listening to the films and the reference"):
//   - picture: EVERY other frame (12 a second) as sheets of 2 s (6×4, read left to right, top to bottom), so motion,
//     easing, entrances and holds are seen as they happen, not as three stills;
//   - sound: the spectrogram and waveform of the same stretch (left = start, right = end) and a report: every word with
//     its time (local Whisper), loudness each quarter second, sharp sound onsets (hits), hard cuts.
// The same function on ours and on the reference, side by side when two films are given.
//   npx tsx apps/cli/src/dev/hand/watch.ts <out-dir> <fromS> <toS> label=film.mp4[@offset] [label=film.mp4[@offset]]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { transcribe } from "@opumia/senses";

const [outDir, fromA, toA, ...films] = process.argv.slice(2);
const from = Number(fromA), to = Number(toA), len = to - from;
// WATCH_FPS=6 for an overview (4 s a sheet); 12 (default, 2 s a sheet) to see motion and easing
const VF = Number(process.env.WATCH_FPS ?? 12), SPAN = 24 / VF;
mkdirSync(outDir!, { recursive: true });
const ff = (a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);

const report: string[] = [];
for (const spec of films) {
  const [label, rest] = spec.split("=") as [string, string];
  const [file, off] = rest.split("@") as [string, string | undefined];
  const ss = from + Number(off ?? 0);
  // picture: 12 fps, 2 s per sheet
  for (let t = 0; t < len - 0.01; t += SPAN) {
    ff(["-ss", (ss + t).toFixed(2), "-t", String(SPAN), "-i", file, "-vf", `fps=${VF},` + "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,tile=6x4", "-frames:v", "1", "-q:v", "4", path.join(outDir!, `${label}_v_${(from + t).toFixed(0).padStart(3, "0")}.jpg`)]);
  }
  // sound: spectrogram over waveform for the whole stretch
  const wav = path.join(outDir!, `${label}.wav`);
  ff(["-ss", ss.toFixed(2), "-t", len.toFixed(2), "-i", file, "-vn", "-ac", "1", "-ar", "16000", wav]);
  ff(["-i", wav, "-filter_complex", `[0:a]showspectrumpic=s=1600x240:legend=0:scale=log:fscale=log:color=intensity[s];[0:a]showwavespic=s=1600x100:colors=white[w];[s][w]vstack`, "-frames:v", "1", path.join(outDir!, `${label}_a.png`)]);
  // words
  const tr = await transcribe(wav, { dataDir: path.join(process.cwd(), "data") }).catch(() => null);
  const words = (tr?.words ?? []).map((w) => `${(from + w.start).toFixed(2)} ${w.word}`);
  // loudness every 0.25 s (momentary LUFS) and onsets: a jump of ≥ 6 dB in the 2–8 kHz band against the last 0.25 s
  const lufs = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", wav, "-af", "ebur128=metadata=1,ametadata=print:key=lavfi.r128.M", "-f", "null", "-"], { encoding: "utf8" }).stderr.split("\n").filter((l) => l.includes("lavfi.r128.M=")).map((l) => Number(l.split("=")[1]));
  const step = Math.max(1, Math.round(lufs.length / (len * 4)));
  const loud = lufs.filter((_, i) => i % step === 0).map((v, i) => `${(from + i * 0.25).toFixed(2)}:${v.toFixed(0)}`);
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", wav, "-af", "highpass=f=2000,lowpass=f=8000", "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], { maxBuffer: 1 << 28 });
  const n = Math.floor(raw.length / 2), win = 400; // 25 ms
  const db: number[] = [];
  for (let i = 0; i + win <= n; i += win) { let s = 0; for (let k = i; k < i + win; k++) { const v = raw.readInt16LE(k * 2) / 32768; s += v * v; } db.push(10 * Math.log10(s / win + 1e-10)); }
  const onsets: string[] = [];
  for (let i = 10; i < db.length; i++) { const prev = Math.max(...db.slice(i - 10, i)); if (db[i]! - prev >= 6 && db[i]! > -45 && (!onsets.length || i * 0.025 - Number(onsets.at(-1)!.split(" ")[0]) + from > 0.3)) onsets.push(`${(from + i * 0.025).toFixed(2)} (+${(db[i]! - prev).toFixed(0)} dB)`); }
  // hard cuts at 12 fps
  const g = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", ss.toFixed(2), "-t", len.toFixed(2), "-i", file, "-vf", "fps=12,scale=96:54,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const F = 96 * 54, nf = Math.floor(g.length / F), d: number[] = [];
  for (let i = 1; i < nf; i++) { let s = 0; for (let k = 0; k < F; k++) s += Math.abs(g[i * F + k]! - g[(i - 1) * F + k]!); d.push(s / F); }
  const cuts = d.map((v, i) => ({ v, i })).filter(({ v, i }) => v > 18 && v > 2.5 * Math.max(d[i - 1] ?? 0, d[i + 1] ?? 0, 1.5)).map(({ i }) => (from + (i + 1) / 12).toFixed(2));
  report.push(`## ${label} (${file} from ${ss.toFixed(1)} s)\nWORDS: ${words.join(" | ")}\nCUTS: ${cuts.join(", ") || "none"}\nONSETS (bright sound hits): ${onsets.join(", ") || "none"}\nLOUDNESS (s:LUFS): ${loud.join(" ")}\n`);
}
writeFileSync(path.join(outDir!, "report.md"), report.join("\n"));
console.log(report.join("\n"));
