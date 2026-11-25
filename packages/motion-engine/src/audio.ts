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

/**
 * Music drop-outs: the bed falls away on a cliffhanger and slams back on the reveal. A short ramp each side
 * (volume with a timeline expression on the global clock, applied after the cue's adelay).
 */
function dipChain(cue: RenderManifest["audio"][number], fps: number): string {
  return (cue.dips ?? [])
    .map((d) => {
      const a = d.fromFrame / fps;
      const b = d.toFrame / fps;
      const g = Math.pow(10, d.gainDb / 20).toFixed(4);
      const r = 0.12; // ramp seconds
      return `,volume=eval=frame:volume='if(lt(t,${(a - r).toFixed(3)}),1,if(lt(t,${a.toFixed(3)}),1-(1-${g})*(t-${(a - r).toFixed(3)})/${r},if(lt(t,${b.toFixed(3)}),${g},if(lt(t,${(b + 0.04).toFixed(3)}),${g}+(1-${g})*(t-${b.toFixed(3)})/0.04,1))))'`;
    })
    .join("");
}

/** Build the pre-master mix: voice chain, music ducked by a voice sidechain, SFX placed at frame-exact delays. */
/**
 * Room tone. Measured on five MagnatesMedia films (2026-11-22): the quietest 1 % of the sound sits 21–33 dB below
 * the speech level — the track never falls to silence. Ours fell 34–53 dB below (a dry synthetic voice on digital
 * silence whenever the music drops out, which listeners read as artificial). A very low, filtered noise bed is
 * mixed under the whole film so the floor stays at the quiet end of the reference range. It is plain filtered
 * noise made by FFmpeg (no model, no recording).
 */
const ROOM_TONE_BELOW_VOICE_RMS_DB = 27;
/** RMS level of the brown-noise source after its filters, at amplitude 1 (measured). */
const TONE_SOURCE_RMS_DB = -19.1;

/**
 * Every narration enters the mix at one loudness (owner, hand film v9: switching to a voice ElevenLabs delivers 10.7 dB
 * quieter left the music 11 dB too loud against it). Music, effects and room tone are set against this fixed level.
 */
const NARRATION_LUFS = -16;
async function integratedLufs(file: string): Promise<number | null> {
  const r = await ff(["-i", file, "-af", "ebur128", "-f", "null", "-"]).catch(() => null);
  const all = [...(r?.stderr ?? "").matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)].map((x) => Number(x[1]));
  return all.length ? all[all.length - 1]! : null;
}
async function narrationGainDb(file: string): Promise<number> {
  const i = await integratedLufs(file);
  return i === null || !Number.isFinite(i) ? 0 : Math.max(-20, Math.min(20, NARRATION_LUFS - i));
}

async function overallRmsDb(file: string): Promise<number | null> {
  const r = await ff(["-i", file, "-af", "astats=metadata=0", "-f", "null", "-"]).catch(() => null);
  const all = [...(r?.stderr ?? "").matchAll(/RMS level dB:\s*(-?[\d.]+)/g)].map((x) => Number(x[1]));
  return all.length ? all[all.length - 1]! : null;
}

/**
 * Hand film 1 (docs/HAND-FILM-1.md): a dry TTS voice on a clean bed is what the ears hear as synthetic. Two early
 * reflections (23 / 41 ms, −15 / −19 dB) put the voice in a small room: measured on the same film, voice humanness
 * 0.37 → 0.54 and channel mix 0.25 → 0.35, with no audible echo.
 */
const VOICE_ROOM = "aecho=1:1:31|53:0.14|0.09,aecho=1:1:23|41:0.12|0.08"; // reflections only: in/out gain 1 (the earlier 0.8/0.6 and 0.8/0.5 gains cut the voice ≈ 14 dB and let the music overpower it — owner, hand film v9)

function mixGraph(m: RenderManifest, toneDb: number | null = null, stem: "all" | "voice" | "bed" = "all", voiceGainDb = 0) {
  const fps = m.fps;
  const durS = m.durationFrames / fps;
  const voice = m.audio.find((a) => a.role === "narration");
  if (!voice) throw new Error("manifest has no narration track");
  const music = m.audio.filter((a) => a.role === "music");
  const sfx = m.audio.filter((a) => a.role === "sfx");
  const inputs: string[] = ["-i", voice.src];
  const chains: string[] = [];
  // Broadcast narrator chain: rumble cut, chest warmth (+2 dB @ 160 Hz), boxiness dip (−2 dB @ 380 Hz), presence lift
  // (+1.5 dB @ 3.2 kHz), de-esser, two-stage compression (slow levelling, then a fast catch), soft air shelf.
  chains.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${voiceGainDb.toFixed(2)}dB,highpass=f=70,equalizer=f=160:t=q:w=1.0:g=2,equalizer=f=380:t=q:w=1.4:g=-2,equalizer=f=3200:t=q:w=1.2:g=1.5,deesser=i=0.35:m=0.5:f=0.5,acompressor=threshold=-24dB:ratio=2.2:attack=20:release=250:makeup=2,acompressor=threshold=-12dB:ratio=4:attack=3:release=60:makeup=1,highshelf=f=11000:g=1,${VOICE_ROOM},apad=whole_dur=${durS.toFixed(3)}[vo]`);
  const mixIns: string[] = [];
  let idx = 1;
  if (music.length) {
    // Each cue: looped source, trimmed to its span, faded (crossfades at cue changes), delayed to its start.
    const cueLabels: string[] = [];
    for (const cue of music) {
      inputs.push("-stream_loop", "-1", "-i", cue.src);
      const len = (cue.endFrame - cue.startFrame) / fps;
      const fi = (cue.fadeInFrames / fps).toFixed(2);
      const fo = (cue.fadeOutFrames / fps).toFixed(2);
      const ms = Math.round((cue.startFrame / fps) * 1000);
      chains.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${len.toFixed(3)},asetpts=N/SR/TB,volume=${cue.gainDb}dB,afade=t=in:d=${fi},afade=t=out:st=${Math.max(0, len - Number(fo)).toFixed(2)}:d=${fo},adelay=${ms}|${ms},apad=whole_dur=${durS.toFixed(3)}${dipChain(cue, fps)}[m${idx}]`);
      cueLabels.push(`[m${idx}]`);
      idx++;
    }
    // Duck the bed under the voice, each cue by its own depth (the channel ducks ≈ 14.5 dB over a film, less in a cold
    // open): every cue gets its own sidechain from the voice, then the ducked cues are mixed.
    chains.push(`[vo]asplit=${cueLabels.length + 1}[vomix]${cueLabels.map((_, k) => `[vokey${k}]`).join("")}`);
    const ducked = cueLabels.map((lab, k) => {
      // the whole-film duck (−14) keeps its calibrated ratio; a shallower duck is the ratio that takes about that many
      // dB off a bed while the voice sits ~16.5 dB over the sidechain threshold (a cold open's ≈ 9.5 dB gap)
      const d = Math.abs(music[k]!.duckUnderNarrationDb ?? -14);
      const ratio = d >= 14 ? Math.min(20, d / 1.2) : Math.max(1.2, 1 / (1 - Math.min(0.9, d / 16.5)));
      chains.push(`${lab}[vokey${k}]sidechaincompress=threshold=0.02:ratio=${ratio.toFixed(2)}:attack=15:release=350:makeup=1[dk${k}]`);
      return `[dk${k}]`;
    });
    chains.push(ducked.length > 1 ? `${ducked.join("")}amix=inputs=${ducked.length}:duration=longest:normalize=0[ducked]` : `${ducked[0]}anull[ducked]`);
    mixIns.push("[vomix]", "[ducked]");
  } else mixIns.push("[vo]");
  for (const s of sfx) {
    inputs.push("-i", s.src);
    const ms = Math.round((s.startFrame / fps) * 1000);
    const len = ((s.endFrame - s.startFrame) / fps).toFixed(3);
    chains.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${len},afade=t=out:st=${Math.max(0, Number(len) - 0.08).toFixed(3)}:d=0.08,volume=${s.gainDb}dB,adelay=${ms}|${ms}[s${idx}]`);
    mixIns.push(`[s${idx}]`);
    idx++;
  }
  if (toneDb !== null) {
    inputs.push("-f", "lavfi", "-i", `anoisesrc=color=brown:amplitude=1:sample_rate=48000:duration=${(durS + 1).toFixed(2)}:seed=7`);
    chains.push(`[${idx}:a]highpass=f=80,lowpass=f=1800,aformat=channel_layouts=stereo,volume=${(toneDb - TONE_SOURCE_RMS_DB).toFixed(2)}dB,afade=t=in:d=0.4[tone]`);
    mixIns.push("[tone]");
    idx++;
  }
  if (stem !== "all") {
    // One stem only (listen-back): the voice alone, or everything but the voice (music ducked by the voice, effects,
    // room tone). Unused branches go to a null sink.
    const voiceLabel = music.length ? "[vomix]" : "[vo]";
    const keep = stem === "voice" ? [voiceLabel] : mixIns.filter((l) => l !== voiceLabel);
    for (const l of mixIns.filter((l) => !keep.includes(l))) chains.push(`${l}anullsink`);
    if (!keep.length) keep.push("[silent]"), chains.push(`anullsrc=r=48000:cl=stereo,atrim=0:${durS.toFixed(3)}[silent]`);
    chains.push(`${keep.join("")}amix=inputs=${keep.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${durS.toFixed(3)},atrim=0:${durS.toFixed(3)}[mix]`);
    return { inputs, graph: chains.join(";") };
  }
  chains.push(`${mixIns.join("")}amix=inputs=${mixIns.length}:duration=first:dropout_transition=0:normalize=0,atrim=0:${durS.toFixed(3)}[mix]`);
  return { inputs, graph: chains.join(";") };
}

const LN = (target: number, tp: number) => `loudnorm=I=${target}:TP=${tp}:LRA=11`;

/** Two-pass EBU R128 mastering to the manifest's LUFS target (default −14) with a −1.5 dBTP ceiling. */
export async function masterAudio(m: RenderManifest, outWav: string, truePeak = -1.5): Promise<LoudnessStats> {
  const voice = m.audio.find((a) => a.role === "narration");
  const vGain = voice ? await narrationGainDb(voice.src) : 0;
  const vRms0 = voice ? await overallRmsDb(voice.src) : null;
  const vRms = vRms0 === null ? null : vRms0 + vGain;
  const { inputs, graph } = mixGraph(m, vRms === null ? null : vRms - ROOM_TONE_BELOW_VOICE_RMS_DB, "all", vGain);
  // Pass 1: measure.
  const p1 = await ff([...inputs, "-filter_complex", `${graph};[mix]${LN(m.loudnessTargetLufs, truePeak)}:print_format=json[out]`, "-map", "[out]", "-f", "null", "-"]);
  const j = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/s.exec(p1.stderr)?.[0] ?? "{}") as Record<string, string>;
  if (!j.input_i) throw new Error("loudnorm pass 1 produced no measurement");
  // Pass 2: linear normalisation with the measured values, then a limiter for safety.
  const ln2 = `${LN(m.loudnessTargetLufs, truePeak)}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,alimiter=limit=${Math.pow(10, (truePeak - 0.3) / 20).toFixed(4)}:level=false`;
  await ff([...inputs, "-filter_complex", `${graph};[mix]${ln2},aresample=48000[out]`, "-map", "[out]", "-c:a", "pcm_s24le", outWav]);
  return measureLoudness(outWav);
}

/**
 * Pre-master stems for listening back (no loudness normalisation, fast): the full mix, the voice alone and the bed
 * (music + effects + room tone) alone, as 48 kHz WAVs in dir. Same graph as the master.
 */
export async function premixStems(m: RenderManifest, dir: string): Promise<{ mix: string; voice: string; bed: string }> {
  const voice = m.audio.find((a) => a.role === "narration");
  const vGain = voice ? await narrationGainDb(voice.src) : 0;
  const vRms0 = voice ? await overallRmsDb(voice.src) : null;
  const tone = vRms0 === null ? null : vRms0 + vGain - ROOM_TONE_BELOW_VOICE_RMS_DB;
  const out = { mix: `${dir}/premix.wav`, voice: `${dir}/stem-voice.wav`, bed: `${dir}/stem-bed.wav` };
  for (const [stem, file] of [["all", out.mix], ["voice", out.voice], ["bed", out.bed]] as const) {
    const { inputs, graph } = mixGraph(m, tone, stem, vGain);
    await ff([...inputs, "-filter_complex", graph, "-map", "[mix]", "-c:a", "pcm_s16le", file]);
  }
  return out;
}

export async function measureLoudness(file: string): Promise<LoudnessStats> {
  const r = await ff(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const tail = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => Number(re.exec(tail)?.[1] ?? NaN);
  return { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/) };
}

/** Mux the silent Remotion render with the master; AAC 48 kHz, faststart for platforms. */
/**
 * The delivered master (build list 3, item 32). The render is kept at high quality (CRF 18, film grain included: film 1
 * was 155 MB for 88 s, 14 Mbps); the master is encoded once for delivery at CRF 20 capped at 10 Mbps (x264 slow,
 * high profile) — measured on film 1: 82 MB, SSIM 0.980 against the render, 35 s to encode. YouTube recommends about
 * 8 Mbps for 1080p.
 */
export async function muxFinal(videoSilent: string, masterWav: string, out: string) {
  // a long-form master takes minutes at preset slow: its own hour-long timeout
  await run("ffmpeg", ["-hide_banner", "-nostats", "-y", "-i", videoSilent, "-i", masterWav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-maxrate", "10M", "-bufsize", "20M", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest", "-movflags", "+faststart", out], { timeout: 3_600_000, maxBuffer: 32 * 1024 * 1024 });
}
