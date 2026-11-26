// film-tools mix: the film's sound from the agent's mix.json, at the channel's measured levels, muxed with its picture.
//   npx tsx apps/cli/src/film-agent/mix.ts <job> [--picture picture.mp4] [--out film_16x9.mp4]
// mix.json: { "beds": [{ "file": "Library/music/…mp3", "from": 0, "to": 30, "inS": 12, "gainDb"?: 0 }],
//             "cues": [{ "t": 4.1, "file": "Library/sfx/…mp3", "db": -8 }], "drops": [{ "from": 63.9, "to": 64.6 }] }
// Levels (build list 6, 37 MagnatesMedia films): the narration enters at −16 LUFS; a bed sits ≈ 15.8 dB under the
// voice in the cold open (first 15 s) and ≈ 19.1 dB in the body, ducked under the voice; master −12.5 LUFS, limiter
// at −1.8 dBFS so peaks stay ≤ −1.5 dB.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.env.OPUMIA_ROOT ?? process.cwd();
const job = path.resolve(process.argv[2]!);
const opt = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const spec = JSON.parse(readFileSync(path.join(job, "mix.json"), "utf8")) as { beds?: Array<{ file: string; from: number; to: number; inS?: number; gainDb?: number }>; cues?: Array<{ t: number; file: string; db?: number }>; drops?: Array<{ from: number; to: number }> };
const abs = (f: string) => (path.isAbsolute(f) ? f : existsSync(path.join(job, f)) ? path.join(job, f) : path.join(ROOT, f));
const lufs = (f: string, extra: string[] = []) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", ...extra, "-i", f, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const m = [...r.matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)].map((x) => Number(x[1]));
  return m.length ? m[m.length - 1]! : -23;
};
const voice = existsSync(path.join(job, "narration.mp3")) ? path.join(job, "narration.mp3") : path.join(job, "narration-shaped.mp3");
const VOICE = -16, COLD = 15, UNDER_COLD = 15.8, UNDER_BODY = 19.1;
const vGain = VOICE - lufs(voice);
const ins: string[] = ["-i", voice];
const fl: string[] = [`[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${vGain.toFixed(2)}dB,asplit=2[v][vkey]`];
const beds: string[] = [];
for (const [i, b] of (spec.beds ?? []).entries()) {
  const f = abs(b.file);
  const len = Math.max(0.5, b.to - b.from);
  const bl = lufs(f, ["-ss", String(b.inS ?? 0), "-t", String(len)]);
  const target = VOICE - (b.from < COLD ? UNDER_COLD : UNDER_BODY);
  const g = target - bl + (b.gainDb ?? 0);
  ins.push("-ss", String(b.inS ?? 0), "-t", String(len), "-i", f);
  const ms = Math.round(b.from * 1000);
  fl.push(`[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${g.toFixed(2)}dB,afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, len - 1.2).toFixed(2)}:d=1.2,adelay=${ms}|${ms}[b${i}]`);
  beds.push(`[b${i}]`);
}
let bedOut = "";
if (beds.length) {
  fl.push(`${beds.join("")}amix=inputs=${beds.length}:normalize=0:duration=longest[bedraw]`);
  const drop = (spec.drops ?? []).map((d) => `between(t,${d.from},${d.to})`).join("+");
  fl.push(`[bedraw]volume='if(${drop || "0"},0.06,1)':eval=frame[beddrop]`);
  fl.push(`[beddrop][vkey]sidechaincompress=threshold=0.04:ratio=4:attack=25:release=350[bed]`);
  bedOut = "[bed]";
} else fl.push(`[vkey]anullsink`);
const cues: string[] = [];
const base = 1 + (spec.beds?.length ?? 0);
for (const [i, c] of (spec.cues ?? []).entries()) {
  ins.push("-i", abs(c.file));
  const ms = Math.round(c.t * 1000);
  fl.push(`[${base + i}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${c.db ?? -10}dB,adelay=${ms}|${ms}[s${i}]`);
  cues.push(`[s${i}]`);
}
fl.push(`[v]${bedOut}${cues.join("")}amix=inputs=${1 + (bedOut ? 1 : 0) + cues.length}:normalize=0:duration=longest[m]`);
const pre = path.join(job, "premix.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", ...ins, "-filter_complex", fl.join(";"), "-map", "[m]", "-c:a", "pcm_s24le", pre], { maxBuffer: 1 << 26 });
const r = spawnSync("ffmpeg", ["-hide_banner", "-i", pre, "-af", "loudnorm=I=-12.5:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const j = JSON.parse(r.slice(r.lastIndexOf("{"), r.lastIndexOf("}") + 1)) as Record<string, string>;
const af = `loudnorm=I=-12.5:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,alimiter=limit=0.8128:level=false,aresample=48000`;
const master = path.join(job, "master.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", pre, "-af", af, "-c:a", "pcm_s24le", master]);
const pic = path.join(job, opt("--picture") ?? "picture.mp4");
const outF = path.join(job, opt("--out") ?? "film_16x9.mp4");
if (existsSync(pic)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", pic, "-i", master, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "20", "-maxrate", "10M", "-bufsize", "20M", "-preset", "slow", "-c:a", "aac", "-b:a", "256k", "-shortest", outF]);
const fin = spawnSync("ffmpeg", ["-hide_banner", "-i", existsSync(outF) ? outF : master, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const I = /^\s+I:\s+(-?[\d.]+) LUFS/m.exec(fin)?.[1], P = /^\s+Peak:\s+(-?[\d.]+) dBFS/m.exec(fin)?.[1];
console.log(`mixed: voice ${vGain >= 0 ? "+" : ""}${vGain.toFixed(1)} dB → −16 LUFS, ${spec.beds?.length ?? 0} bed(s), ${spec.cues?.length ?? 0} cue(s), ${spec.drops?.length ?? 0} drop-out(s); master ${I} LUFS, peak ${P} dB → ${existsSync(pic) ? path.basename(outF) : "master.wav (no picture.mp4 yet)"}`);
