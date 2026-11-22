/**
 * First-use voice measurement (automatic, once per voice and model).
 *
 * A voice speaks at its own natural pace, so the platform has to know that pace before it cuts a script. The
 * first time a voice is used, it reads a short standard passage the way production records narration NOW (build list
 * 3, L12): one passage take, trimmed and its pauses shortened exactly as the narration does (passage.ts) — not one
 * take per sentence, which measured 171 wpm for a voice that narrates passages at about 161 (film 2: narrated twice).
 * Its pace and expressiveness are stored in data/voice-calibration.json under `_natural` with a "|passage" key; every
 * later film reads the stored value — no call is made.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { measureProsody } from "@opumia/senses";
import { alignWords, tokensFromAlignment } from "./align.js";
import { ttsWithTimestamps } from "./elevenlabs.js";
import { SR, tighten } from "./passage.js";
import { pcm } from "@opumia/senses";
import { readCalibration, writeCalibration, type ChannelVoice } from "./voice.js";

const run = promisify(execFile);

export interface VoiceMeasure {
  /** Words a minute at natural speed, measured on the standard passage in passage mode. */
  wpm: number;
  /** The pace of this voice's real narrations (running mean of the last films), once there are any: scripts are cut to it. */
  observedWpm?: number;
  observed?: number[];
  pitchTravelSt?: number;
  melodySt?: number;
  dynamicsDb?: number;
  /** True when the voice measures clearly flatter than the channel's reference narrator. */
  flat?: boolean;
  characters: number;
  measuredAt: string;
  source: "measured" | "code";
}

/** Plain documentary prose: mixed sentence lengths, a figure, a question, a turn. No hard names. */
const PASSAGE = [
  "For most of the last century, one company decided what a photograph was.",
  "It sold the cameras, it sold the film, and it sold the paper the pictures were printed on.",
  "Then, in a small laboratory, one of its own engineers built something that needed none of those things.",
  "His managers looked at it for a few minutes and asked a simple question.",
  "Why would anyone want to look at their pictures on a screen?",
  "Thirty years later, that question had cost them almost everything.",
];
export const naturalKey = (voiceId: string, modelId: string) => `${voiceId}|${modelId}|passage`;

/** The stored measurement for a voice on a model, else the value written in code, else null. */
export async function storedVoiceMeasure(dataDir: string, voiceId: string, modelId: string): Promise<VoiceMeasure | null> {
  const cal = (await readCalibration(dataDir)) as { _natural?: Record<string, VoiceMeasure> };
  const m = cal._natural?.[naturalKey(voiceId, modelId)] ?? null;
  // what the scripts are cut to: the voice's real narrations once there are some, else the standard passage
  return m ? { ...m, wpm: m.observedWpm ?? m.wpm } : null;
}

/**
 * The voice's natural pace and expressiveness: read from the store, or measured now (about 480 characters of
 * speech) and stored. `reference` is the channel narrator's expressiveness floor, used only to flag a flat voice.
 */
export async function ensureVoiceMeasured(o: { dataDir: string; voice: ChannelVoice; modelId: string; reference?: { melodySt: number; pitchTravelSt: number }; log?: (s: string) => void }): Promise<VoiceMeasure> {
  const log = o.log ?? (() => {});
  const cal = (await readCalibration(o.dataDir)) as { _natural?: Record<string, VoiceMeasure> };
  const key = naturalKey(o.voice.voiceId, o.modelId);
  const hit = cal._natural?.[key];
  if (hit) return hit;
  log(`  voice: "${o.voice.name}" has not been measured on ${o.modelId} yet — reading the standard passage once (about ${PASSAGE.join(" ").length} characters)…`);
  const dir = path.join(o.dataDir, ".cache", "voice-measure", key.replace(/[^\w.-]+/g, "_"));
  await mkdir(dir, { recursive: true });
  // One take of the whole passage, kept the way the narration keeps a passage.
  const text = PASSAGE.join(" ");
  const tts = await ttsWithTimestamps({ voiceId: o.voice.voiceId, modelId: o.modelId, text, speed: o.voice.settings.speed, stability: o.voice.settings.stability, similarityBoost: o.voice.settings.similarityBoost, style: o.voice.settings.style, seed: 4000 });
  const characters = tts.characters;
  const raw = path.join(dir, "passage.raw.mp3");
  await writeFile(raw, tts.audio);
  const audio = await pcm(raw, { sr: SR });
  const words = text.split(/\s+/);
  const aligned = alignWords(words, tokensFromAlignment(tts.alignment)).map((w) => ({ word: w.word, startS: w.startS, endS: w.endS }));
  const kept = tighten(audio, aligned);
  const first = kept.words[0]?.startS ?? 0, last = kept.words.at(-1)?.endS ?? kept.audio.length / SR;
  const wpm = Math.round((words.length / Math.max(0.05, (last - first) / 60)) * 10) / 10;
  const joined = path.join(dir, "passage.mp3");
  const f32 = path.join(dir, "passage.f32");
  await writeFile(f32, Buffer.from(kept.audio.buffer, kept.audio.byteOffset, kept.audio.byteLength));
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", f32, "-c:a", "libmp3lame", "-b:a", "160k", joined], { timeout: 120_000 }).catch(() => {});
  const p = await measureProsody(joined).catch(() => null);
  const m: VoiceMeasure = {
    wpm,
    ...(p ? { pitchTravelSt: p.f0RangeSt, melodySt: p.melodySt, dynamicsDb: p.energyStdDb } : {}),
    ...(p && o.reference && (p.melodySt < o.reference.melodySt * 0.75 || p.f0RangeSt < o.reference.pitchTravelSt * 0.75) ? { flat: true } : {}),
    characters,
    measuredAt: new Date().toISOString().slice(0, 10),
    source: "measured",
  };
  const fresh = (await readCalibration(o.dataDir)) as { _natural?: Record<string, VoiceMeasure> };
  fresh._natural = { ...(fresh._natural ?? {}), [key]: m };
  await writeCalibration(o.dataDir, fresh);
  log(`  voice: "${o.voice.name}" on ${o.modelId} — natural pace ${m.wpm} wpm${p ? `, pitch travel ${p.f0RangeSt} st, melody ${p.melodySt}` : ""}${m.flat ? " — FLAT against the channel's narrator: expect a less lively film; consider another voice" : ""} (stored; not measured again)`);
  return m;
}

/**
 * Learn the voice's pace from a real narration (words over speaking time, lead and tail excluded): the running mean of
 * the last five films becomes the pace scripts are cut to, so a script fits its narration the first time.
 */
export async function recordNarrationPace(dataDir: string, voiceId: string, modelId: string, wpm: number): Promise<void> {
  if (!(wpm > 80 && wpm < 260)) return;
  const cal = (await readCalibration(dataDir)) as { _natural?: Record<string, VoiceMeasure> };
  const key = naturalKey(voiceId, modelId);
  const m = cal._natural?.[key];
  if (!m) return;
  const observed = [...(m.observed ?? []), Math.round(wpm * 10) / 10].slice(-5);
  cal._natural = { ...(cal._natural ?? {}), [key]: { ...m, observed, observedWpm: Math.round((observed.reduce((a, b) => a + b, 0) / observed.length) * 10) / 10 } };
  await writeCalibration(dataDir, cal);
}

