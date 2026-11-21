import { mean, median, pcm, pct, probeDuration, r3, std } from "./ff.js";

/**
 * Ears: objective measurements of a narration, a sound effect or a music bed — the same method on our audio and
 * on reference films. No model can listen for us, so "robotic" is measured: how much the pitch moves, how the
 * energy breathes, how pauses are placed.
 */

// ---------------------------------------------------------------------------------------------------------
// Voice prosody

export interface Prosody {
  seconds: number;
  voicedShare: number;
  /** Median pitch of the voiced frames (Hz). */
  f0Hz: number;
  /** Pitch range p10–p90 in semitones: how far the voice travels (flat/robotic reads are narrow). */
  f0RangeSt: number;
  /** Std of per-second median pitch in semitones: phrase-level melody. */
  melodySt: number;
  /** Std of voiced frame level in dB: emphasis and dynamics. */
  energyStdDb: number;
  pausesPerMin: number;
  pauseMedianS: number;
  /** Share of pauses of 0.45 s or more (deliberate beats). */
  longPauseShare: number;
}

const SR = 16000;

/**
 * Autocorrelation pitch tracker (40 ms frames, 10 ms hop, 65–350 Hz) on band-limited audio.
 * `keep(tSeconds)` restricts analysis to wanted moments (e.g. where a reference mix is voice-only).
 */
export async function measureProsody(file: string, o: { ss?: number; t?: number; keep?: (t: number) => boolean } = {}): Promise<Prosody> {
  const x = await pcm(file, { ...(o.ss !== undefined ? { ss: o.ss } : {}), ...(o.t !== undefined ? { t: o.t } : {}), sr: SR, af: "highpass=f=70,lowpass=f=900" });
  const N = 640;
  const HOP = 160;
  const minLag = Math.floor(SR / 350);
  const maxLag = Math.ceil(SR / 65);
  const f0: Array<number | null> = [];
  const db: number[] = [];
  const times: number[] = [];
  // Level reference: the loud part of this file.
  const levels: number[] = [];
  for (let i = 0; i + N + maxLag < x.length; i += HOP) {
    let e = 0;
    for (let k = 0; k < N; k++) e += x[i + k]! * x[i + k]!;
    levels.push(10 * Math.log10(e / N + 1e-12));
  }
  const loud = pct(levels, 0.9);
  const gate = loud - 28;
  let fi = 0;
  for (let i = 0; i + N + maxLag < x.length; i += HOP, fi++) {
    const t = i / SR + (o.ss ?? 0);
    const lv = levels[fi]!;
    if (o.keep && !o.keep(t)) continue;
    times.push(t);
    db.push(lv);
    if (lv < gate) {
      f0.push(null);
      continue;
    }
    let e0 = 0;
    for (let k = 0; k < N; k++) e0 += x[i + k]! * x[i + k]!;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      let e1 = 0;
      for (let k = 0; k < N; k += 2) {
        const a = x[i + k]!;
        const b = x[i + k + lag]!;
        c += a * b;
        e1 += b * b;
      }
      const r = c / Math.sqrt((e0 / 2) * e1 + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    f0.push(best > 0.6 && bestLag ? SR / bestLag : null);
  }
  const voiced = f0.filter((v): v is number => v !== null);
  const med = median(voiced) || 120;
  // Octave errors: keep within one octave of the median.
  const st = voiced.filter((v) => v > med / 1.9 && v < med * 1.9).map((v) => 12 * Math.log2(v / med));
  // Phrase melody: per-second median pitch.
  const perSec = new Map<number, number[]>();
  f0.forEach((v, k) => {
    if (v === null || v < med / 1.9 || v > med * 1.9) return;
    const s = Math.floor(times[k]!);
    (perSec.get(s) ?? perSec.set(s, []).get(s)!).push(12 * Math.log2(v / med));
  });
  const secMed = [...perSec.values()].filter((a) => a.length >= 15).map(median);
  // Pauses: runs of frames under the gate, 0.18 s or longer, between speech.
  const pauses: number[] = [];
  let runLen = 0;
  let seenSpeech = false;
  for (let k = 0; k < db.length; k++) {
    const silent = db[k]! < gate;
    const contiguous = k === 0 || times[k]! - times[k - 1]! < 0.02;
    if (silent && contiguous) runLen++;
    else {
      if (seenSpeech && runLen * 0.01 >= 0.18 && runLen * 0.01 < 4) pauses.push(runLen * 0.01);
      runLen = silent ? 1 : 0;
      if (!silent) seenSpeech = true;
    }
  }
  const seconds = times.length * 0.01;
  const voicedDb = db.filter((_, k) => f0[k] !== null);
  return {
    seconds: r3(seconds),
    voicedShare: r3(voiced.length / Math.max(1, f0.length)),
    f0Hz: r3(med),
    f0RangeSt: r3(pct(st, 0.9) - pct(st, 0.1)),
    melodySt: r3(std(secMed)),
    energyStdDb: r3(std(voicedDb)),
    pausesPerMin: r3((pauses.length / Math.max(1, seconds)) * 60),
    pauseMedianS: r3(median(pauses)),
    longPauseShare: r3(pauses.filter((p) => p >= 0.45).length / Math.max(1, pauses.length)),
  };
}

/** Pace from word timings: overall wpm and how much the pace varies sentence to sentence. */
export function measurePace(words: Array<{ word: string; start: number; end: number }>): { wpm: number; sentenceWpmStd: number; sentences: number } {
  if (words.length < 2) return { wpm: 0, sentenceWpmStd: 0, sentences: 0 };
  const wpm = (words.length / Math.max(1, words.at(-1)!.end - words[0]!.start)) * 60;
  const rates: number[] = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.!?]["”']?$/.test(words[i]!.word) || i === words.length - 1) {
      const n = i - from + 1;
      const d = words[i]!.end - words[from]!.start;
      if (n >= 5 && d > 0.8) rates.push((n / d) * 60);
      from = i + 1;
    }
  }
  return { wpm: r3(wpm), sentenceWpmStd: r3(std(rates)), sentences: rates.length };
}

// ---------------------------------------------------------------------------------------------------------
// Spectrum helper

function fftMag(re: Float64Array): Float64Array {
  const n = re.length;
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j]!, re[i]!];
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i]!, im[i]!);
  return mag;
}

// ---------------------------------------------------------------------------------------------------------
// Sound effects

export type SoundFamily = "sub_boom" | "thud" | "impact" | "whoosh" | "riser" | "click" | "shimmer" | "texture";
export interface SoundCharacter {
  seconds: number;
  peakDb: number;
  /** Spectral centroid of the loudest second (Hz): low = boom/thud, high = click/shimmer. */
  centroidHz: number;
  /** Share of energy under 150 Hz. */
  lowShare: number;
  /** Time from the start to the loudest moment (s): short = hit, long = whoosh/riser. */
  attackS: number;
  /** Where the energy sits in time, 0 (front-loaded hit) .. 1 (builds to the end, a riser). */
  energyCentre: number;
  family: SoundFamily;
}

export async function measureSound(file: string): Promise<SoundCharacter> {
  const sr = 22050;
  const x = await pcm(file, { sr, t: 8 });
  const seconds = Math.min(await probeDuration(file), 600);
  const hop = 512;
  const env: number[] = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let e = 0;
    for (let k = 0; k < hop; k++) e += x[i + k]! * x[i + k]!;
    env.push(Math.sqrt(e / hop));
  }
  let peakI = 0;
  for (let i = 1; i < env.length; i++) if (env[i]! > env[peakI]!) peakI = i;
  let peak = 1e-9;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > peak) peak = Math.abs(x[i]!);
  const total = env.reduce((t, v) => t + v * v, 0) || 1;
  const energyCentre = env.reduce((t, v, i) => t + v * v * i, 0) / total / Math.max(1, env.length - 1);
  // Spectrum around the loudest moment.
  const N = 4096;
  const start = Math.max(0, Math.min(x.length - N, peakI * hop - N / 4));
  const frame = new Float64Array(N);
  for (let i = 0; i < N; i++) frame[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const mag = fftMag(frame);
  let num = 0;
  let den = 0;
  let low = 0;
  for (let i = 1; i < mag.length; i++) {
    const p = mag[i]! * mag[i]!;
    const f = (i * sr) / N;
    num += f * p;
    den += p;
    if (f < 150) low += p;
  }
  const centroidHz = den ? num / den : 0;
  const lowShare = den ? low / den : 0;
  const attackS = (peakI * hop) / sr;
  const family: SoundFamily =
    seconds > 2.5 && energyCentre > 0.6 ? "riser"
    : lowShare > 0.55 && centroidHz < 250 ? "sub_boom"
    : centroidHz < 700 && attackS < 0.25 ? "thud"
    : attackS >= 0.35 && seconds >= 0.8 && centroidHz >= 700 ? "whoosh"
    : seconds < 0.35 && centroidHz > 2500 ? "click"
    : centroidHz > 4500 ? "shimmer"
    : attackS < 0.25 ? "impact"
    : "texture";
  return { seconds: r3(seconds), peakDb: r3(20 * Math.log10(peak)), centroidHz: Math.round(centroidHz), lowShare: r3(lowShare), attackS: r3(attackS), energyCentre: r3(energyCentre), family };
}

// ---------------------------------------------------------------------------------------------------------
// Music

export interface MusicProfile {
  seconds: number;
  bpm: number;
  /** How clearly the beat stands out (0..1): low = ambient bed, high = driving pulse. */
  pulse: number;
  /** Level per 5 s in dB relative to the track's loud part (the energy arc). */
  energyDb: number[];
  /** First beat offset (s) and beat period (s) for cutting on the beat. */
  beat: { offsetS: number; periodS: number };
  brightnessHz: number;
}

export async function measureMusic(file: string, o: { t?: number } = {}): Promise<MusicProfile> {
  const sr = 11025;
  const x = await pcm(file, { sr, t: o.t ?? 150 });
  const hop = 110; // ≈ 100 Hz envelope
  const env: number[] = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let e = 0;
    for (let k = 0; k < hop; k++) e += x[i + k]! * x[i + k]!;
    env.push(Math.log10(e / hop + 1e-9));
  }
  const fps = sr / hop;
  const onset = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? v)));
  const mu = mean(onset);
  const on = onset.map((v) => v - mu);
  let bestLag = 0;
  let best = -Infinity;
  let zero = 0;
  for (let i = 0; i < on.length; i++) zero += on[i]! * on[i]!;
  const lagMin = Math.round((60 / 180) * fps);
  const lagMax = Math.round((60 / 60) * fps);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let c = 0;
    for (let i = 0; i + lag < on.length; i++) c += on[i]! * on[i + lag]!;
    // Mild preference for 90–140 BPM, where most beds sit.
    const bpm = (60 * fps) / lag;
    const w = 1 - 0.15 * Math.abs(Math.log2(bpm / 112));
    if (c * w > best) {
      best = c * w;
      bestLag = lag;
    }
  }
  const period = bestLag / fps;
  // Beat phase: the offset whose comb collects the most onset energy.
  let bestOff = 0;
  let bestSum = -Infinity;
  for (let off = 0; off < bestLag; off++) {
    let s = 0;
    for (let i = off; i < onset.length; i += bestLag) s += onset[i]!;
    if (s > bestSum) {
      bestSum = s;
      bestOff = off;
    }
  }
  const seg = Math.round(5 * fps);
  const lv: number[] = [];
  for (let i = 0; i + seg <= env.length; i += seg) lv.push(10 * mean(env.slice(i, i + seg)));
  const top = pct(lv, 0.9);
  // Brightness from one mid-track frame.
  const N = 4096;
  const frame = new Float64Array(N);
  const s0 = Math.max(0, Math.floor(x.length / 2) - N / 2);
  for (let i = 0; i < N; i++) frame[i] = (x[s0 + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const mag = fftMag(frame);
  let num = 0;
  let den = 0;
  for (let i = 1; i < mag.length; i++) {
    const p = mag[i]! * mag[i]!;
    num += ((i * sr) / N) * p;
    den += p;
  }
  return { seconds: r3(x.length / sr), bpm: r3((60 * fps) / Math.max(1, bestLag)), pulse: r3(Math.max(0, Math.min(1, best / (zero || 1)))), energyDb: lv.map((v) => r3(v - top)), beat: { offsetS: r3(bestOff / fps), periodS: r3(period) }, brightnessHz: Math.round(den ? num / den : 0) };
}
