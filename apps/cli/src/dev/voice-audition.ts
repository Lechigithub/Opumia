/**
 * Voice audition + calibration for a channel narrator.
 *
 *   npx tsx apps/cli/src/dev/voice-audition.ts [channel]
 *
 * Resolves the channel's voice by name (ElevenLabs /v1/voices), renders one dramatic test passage under a
 * grid of voice settings, measures each take (pace, sentence-end pauses, pitch movement, loudness range)
 * and stores the winning settings + measured pace in data/voice-calibration.json. Takes are written to
 * out/voice-audition/<channel>/ so a human can listen and override.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChannelId } from "@opumia/contracts";
import { withBeats, alignWords, readCalibration, resolveChannelVoice, tokensFromAlignment, ttsWithTimestamps, writeCalibration, calibrationKey, type VoiceSettings } from "@opumia/narration";
import { loadKeys } from "../keys.js";

const ROOT = process.cwd();
loadKeys(ROOT);
const run = promisify(execFile);
const channel = (process.argv[2] ?? "magnates-media") as ChannelId;
const DATA = path.join(ROOT, "data");
const OUT = path.join(ROOT, "out", "voice-audition", channel);
const MODEL = process.env.OPUMIA_TTS_MODEL ?? "eleven_multilingual_v2";

// Original MagnatesMedia-style test passage: paradox cold open, a number, a pause beat, a cliffhanger.
// Original passage in the reference channel's prose shape (~19-word sentences, connected, one contrast).
const PASSAGE =
  "In 2007, one Finnish company sold more smartphones than Apple, BlackBerry and Microsoft put together, and its executives were so sure of their lead that they barely looked up. " +
  "Engineers inside the building were warning that the software was slow and the touchscreen was coming, but every warning seemed to disappear somewhere between the lab and the boardroom. " +
  "So when a phone with no keyboard went on sale in California that summer, the people in charge treated it as a curiosity rather than a threat. " +
  "Within four years, the company that had owned the market would be asking a rival for help, and the man sent to save it would describe it as a burning platform.";

const GRID: Array<{ id: string; s: VoiceSettings }> = [
  { id: "A_s38_1.08", s: { stability: 0.38, similarityBoost: 0.8, style: 0.35, speed: 1.08 } },
  { id: "B_s40_1.10", s: { stability: 0.4, similarityBoost: 0.8, style: 0.35, speed: 1.1 } },
  { id: "C_s42_1.12", s: { stability: 0.42, similarityBoost: 0.8, style: 0.35, speed: 1.12 } },
  { id: "D_s40_1.12", s: { stability: 0.4, similarityBoost: 0.8, style: 0.35, speed: 1.12 } },
];

/** Autocorrelation pitch track on 16 kHz mono PCM → semitone std of voiced frames (intonation movement). */
function pitchStats(pcm: Float32Array, sr = 16000) {
  const frame = 640; // 40 ms
  const minLag = Math.floor(sr / 300);
  const maxLag = Math.floor(sr / 70);
  const f0: number[] = [];
  for (let off = 0; off + frame + maxLag < pcm.length; off += frame / 2) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += pcm[off + i]! ** 2;
    const rms = Math.sqrt(e / frame);
    if (rms < 0.02) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      let n1 = 0;
      let n2 = 0;
      for (let i = 0; i < frame; i++) {
        const a = pcm[off + i]!;
        const b = pcm[off + i + lag]!;
        c += a * b;
        n1 += a * a;
        n2 += b * b;
      }
      const r = c / Math.sqrt(n1 * n2 + 1e-9);
      if (r > best) (best = r), (bestLag = lag);
    }
    if (best > 0.55 && bestLag) f0.push(sr / bestLag);
  }
  const st = f0.map((f) => 12 * Math.log2(f / 100));
  const mean = st.reduce((a, b) => a + b, 0) / Math.max(1, st.length);
  const sd = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, st.length));
  const sorted = [...f0].sort((a, b) => a - b);
  return { medianHz: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), semitoneSd: Math.round(sd * 100) / 100, voicedFrames: f0.length };
}

async function measure(file: string, words: string[], alignment: Parameters<typeof tokensFromAlignment>[0]) {
  const aligned = alignWords(words, tokensFromAlignment(alignment));
  const span = aligned.at(-1)!.endS - aligned[0]!.startS;
  const wpm = (words.length / span) * 60;
  // Pauses after sentence-final words vs mid-sentence gaps.
  const endGaps: number[] = [];
  const midGaps: number[] = [];
  for (let i = 0; i < aligned.length - 1; i++) {
    const gap = aligned[i + 1]!.startS - aligned[i]!.endS;
    (/[.?!]$/.test(words[i]!) ? endGaps : midGaps).push(gap);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 28 });
  const buf = stdout as unknown as Buffer;
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  // Emphasis dynamics: std of 100 ms RMS (dB) over voiced windows.
  const dbs: number[] = [];
  for (let off = 0; off + 1600 <= pcm.length; off += 1600) {
    let e = 0;
    for (let i = 0; i < 1600; i++) e += pcm[off + i]! ** 2;
    const db = 10 * Math.log10(e / 1600 + 1e-12);
    if (db > -40) dbs.push(db);
  }
  const mu = avg(dbs);
  const dynDb = Math.round(Math.sqrt(avg(dbs.map((d) => (d - mu) ** 2))) * 100) / 100;
  return { wpm: Math.round(wpm * 10) / 10, sentenceEndPauseS: Math.round(avg(endGaps) * 1000) / 1000, midGapS: Math.round(avg(midGaps) * 1000) / 1000, dynDb, ...pitchStats(pcm) };
}

const voice = await resolveChannelVoice(channel, DATA, console.log);
console.log(`voice: ${voice.name} (${voice.voiceId}), model ${MODEL}`);
await mkdir(OUT, { recursive: true });
const words = PASSAGE.split(/\s+/);
// Same beat rules the narration stage uses (cold-open role → cliffhanger pause at the end).
const SPOKEN = withBeats([{ role: "context", text: PASSAGE }, { role: "context", text: "" }]);
const results: Array<{ id: string; settings: VoiceSettings; m: Awaited<ReturnType<typeof measure>>; score: number }> = [];
for (const g of GRID) {
  const tts = await ttsWithTimestamps({ voiceId: voice.voiceId, modelId: MODEL, text: SPOKEN.trim(), ...g.s, seed: 1234 });
  const file = path.join(OUT, `${g.id}.mp3`);
  await writeFile(file, tts.audio);
  const m = await measure(file, words, tts.alignment);
  // Authoritative + dramatic, not flat or rushed:
  //  pace 185–195 wpm (reference channel p50 199), natural sentence-end breaths (≥ 0.3 s),
  //  pitch movement (semitone sd) high but not erratic (≤ 4.5), emphasis dynamics (RMS sd 4–9 dB).
  const pace = m.wpm >= 185 && m.wpm <= 195 ? 1 : Math.max(0, 1 - Math.abs(m.wpm - 190) / 30);
  const beats = Math.min(1, m.sentenceEndPauseS / 0.3);
  const intonation = m.semitoneSd <= 4.5 ? Math.min(1, m.semitoneSd / 3.2) : Math.max(0, 1 - (m.semitoneSd - 4.5) / 2);
  const dyn = m.dynDb >= 4 && m.dynDb <= 9 ? 1 : 0.6;
  const score = Math.round((0.35 * pace + 0.25 * beats + 0.3 * intonation + 0.1 * dyn) * 1000) / 1000;
  results.push({ id: g.id, settings: g.s, m, score });
  console.log(`${g.id.padEnd(11)} wpm ${m.wpm}  end-pause ${m.sentenceEndPauseS}s  pitch sd ${m.semitoneSd} st (median ${m.medianHz} Hz)  dyn ${m.dynDb} dB  → score ${score}`);
}
const best = [...results].sort((a, b) => b.score - a.score)[0]!;
const cal = await readCalibration(DATA);
const entry = cal._voices![channel]!;
entry.settings = best.settings;
entry.audition = { model: MODEL, passageWords: words.length, picked: best.id, takes: results.map((r) => ({ id: r.id, settings: r.settings, ...r.m, score: r.score })) };
// Seed the pace calibration for the picked settings (later narrations refine it).
const key = calibrationKey({ ...voice, settings: best.settings }, MODEL);
if (!cal[key]) cal[key] = { wpm: best.m.wpm, samples: 1 };
await writeCalibration(DATA, cal);
console.log(`picked ${best.id} → ${JSON.stringify(best.settings)}; takes in ${path.relative(ROOT, OUT)}/`);
