import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RenderManifest } from "@opumia/contracts";

const run = promisify(execFile);
const ff = (args: string[]) => run("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });

export interface LoudnessStats {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

/** Build the pre-master mix: voice chain, music ducked by a voice sidechain, SFX placed at frame-exact delays. */
function mixGraph(m: RenderManifest) {
  const fps = m.fps;
  const durS = m.durationFrames / fps;
  const voice = m.audio.find((a) => a.role === "narration");
  if (!voice) throw new Error("manifest has no narration track");
  const music = m.audio.find((a) => a.role === "music");
  const sfx = m.audio.filter((a) => a.role === "sfx");
  const inputs: string[] = ["-i", voice.src];
  const chains: string[] = [];
  // Voice: clean low end, gentle compression, short de-ess shelf.
  chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=90:makeup=2,equalizer=f=6500:t=q:w=2:g=-2,apad=whole_dur=${durS.toFixed(3)}[vo]`);
  const mixIns: string[] = [];
  let idx = 1;
  if (music) {
    inputs.push("-stream_loop", "-1", "-i", music.src);
    const fi = (music.fadeInFrames / fps).toFixed(2);
    const fo = (music.fadeOutFrames / fps).toFixed(2);
    chains.push(`[vo]asplit=2[vomix][vokey]`);
    chains.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${durS.toFixed(3)},asetpts=N/SR/TB,volume=${music.gainDb}dB,afade=t=in:d=${fi},afade=t=out:st=${Math.max(0, durS - Number(fo)).toFixed(2)}:d=${fo}[mus]`);
    // Duck the bed under the voice (≈ duckUnderNarrationDb of gain reduction while speaking).
    const ratio = Math.min(20, Math.max(2, Math.abs(music.duckUnderNarrationDb ?? -10) / 2));
    chains.push(`[mus][vokey]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=15:release=350:makeup=1[ducked]`);
    mixIns.push("[vomix]", "[ducked]");
    idx++;
  } else mixIns.push("[vo]");
  for (const s of sfx) {
    inputs.push("-i", s.src);
    const ms = Math.round((s.startFrame / fps) * 1000);
    const len = ((s.endFrame - s.startFrame) / fps).toFixed(3);
    chains.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${len},afade=t=out:st=${Math.max(0, Number(len) - 0.08).toFixed(3)}:d=0.08,volume=${s.gainDb}dB,adelay=${ms}|${ms}[s${idx}]`);
    mixIns.push(`[s${idx}]`);
    idx++;
  }
  chains.push(`${mixIns.join("")}amix=inputs=${mixIns.length}:duration=first:dropout_transition=0:normalize=0,atrim=0:${durS.toFixed(3)}[mix]`);
  return { inputs, graph: chains.join(";") };
}

const LN = (target: number, tp: number) => `loudnorm=I=${target}:TP=${tp}:LRA=11`;

/** Two-pass EBU R128 mastering to the manifest's LUFS target (default −14) with a −1.5 dBTP ceiling. */
export async function masterAudio(m: RenderManifest, outWav: string, truePeak = -1.5): Promise<LoudnessStats> {
  const { inputs, graph } = mixGraph(m);
  // Pass 1: measure.
  const p1 = await ff([...inputs, "-filter_complex", `${graph};[mix]${LN(m.loudnessTargetLufs, truePeak)}:print_format=json[out]`, "-map", "[out]", "-f", "null", "-"]);
  const j = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/s.exec(p1.stderr)?.[0] ?? "{}") as Record<string, string>;
  if (!j.input_i) throw new Error("loudnorm pass 1 produced no measurement");
  // Pass 2: linear normalisation with the measured values, then a limiter for safety.
  const ln2 = `${LN(m.loudnessTargetLufs, truePeak)}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,alimiter=limit=${Math.pow(10, (truePeak - 0.3) / 20).toFixed(4)}:level=false`;
  await ff([...inputs, "-filter_complex", `${graph};[mix]${ln2},aresample=48000[out]`, "-map", "[out]", "-c:a", "pcm_s24le", outWav]);
  return measureLoudness(outWav);
}

export async function measureLoudness(file: string): Promise<LoudnessStats> {
  const r = await ff(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const tail = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => Number(re.exec(tail)?.[1] ?? NaN);
  return { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/) };
}

/** Mux the silent Remotion render with the master; AAC 48 kHz, faststart for platforms. */
export async function muxFinal(videoSilent: string, masterWav: string, out: string) {
  await ff(["-i", videoSilent, "-i", masterWav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest", "-movflags", "+faststart", out]);
}
