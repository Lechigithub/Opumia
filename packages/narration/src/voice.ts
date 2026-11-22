import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import { findVoiceByName } from "./elevenlabs.js";

export interface VoiceSettings {
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
}

export interface ChannelVoice {
  voiceId: string;
  name: string;
  settings: VoiceSettings;
}

/**
 * Per-channel narrator defaults. A `voiceName` is resolved via /v1/voices once and cached in data/voice-calibration.json.
 *
 * Owner decision (2026-11-22): a voice speaks at ITS OWN natural pace — speed 1.0 on every line, never pushed
 * toward the reference narrator's words-per-minute and never time-stretched. The reference teaches expressiveness
 * (pitch travel, melody, pauses, variety), not speed. The voice's natural pace is MEASURED in passage mode the first
 * time it is used (measure.ts) — never written in code: scripts are cut to it and the gates check against it.
 */
export const CHANNEL_VOICES: Record<ChannelId, { voiceId?: string; voiceName?: string; name: string; settings: VoiceSettings }> = {
  // MagnatesMedia: the account's "Christopher" voice.
  "magnates-media": { voiceName: "Christopher", name: "Christopher", settings: { stability: 0.28, similarityBoost: 0.8, style: 0.55, speed: 1.0 } },
  "logically-answered": { voiceId: "nPczCjzI2devNBz1zQrb", name: "Brian", settings: { stability: 0.45, similarityBoost: 0.8, style: 0.25, speed: 1.0 } },
  "big-company": { voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George", settings: { stability: 0.5, similarityBoost: 0.8, style: 0.2, speed: 1.0 } },
  "modern-mba": { voiceId: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", settings: { stability: 0.5, similarityBoost: 0.8, style: 0.2, speed: 1.0 } },
  "how-money-works": { voiceId: "cjVigY5qzO86Huf0OWal", name: "Eric", settings: { stability: 0.45, similarityBoost: 0.8, style: 0.25, speed: 1.0 } },
  moon: { voiceId: "3YzGaTGef0x5PLEK9yGq", name: "Atlas", settings: { stability: 0.45, similarityBoost: 0.8, style: 0.3, speed: 1.0 } },
};

/**
 * The narration model. Eleven v4 (owner decision 2026-11-22): measured on the same script and voice against
 * Multilingual v2 — phrase melody 3.55 vs 2.79, pitch travel 14.2 vs 11.4 st, dynamics 6.2 vs 5.8 dB.
 * OPUMIA_TTS_MODEL overrides it.
 */
export const DEFAULT_TTS_MODEL = "eleven_v4";
export const ttsModel = () => process.env.OPUMIA_TTS_MODEL ?? DEFAULT_TTS_MODEL;

/** Shape of data/voice-calibration.json: `_voices` holds the resolved narrator per channel; other keys are wpm calibrations. */
export interface VoiceCalibrationFile {
  _voices?: Record<string, { query?: string; voiceId: string; name: string; settings: VoiceSettings; resolvedAt?: string; audition?: unknown }>;
  [calKey: string]: unknown;
}

export async function readCalibration(dataDir: string): Promise<VoiceCalibrationFile> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "voice-calibration.json"), "utf8")) as VoiceCalibrationFile;
  } catch {
    return {};
  }
}

export async function writeCalibration(dataDir: string, cal: VoiceCalibrationFile): Promise<void> {
  const p = path.join(dataDir, "voice-calibration.json");
  // Stable key order: _voices first, then calibration keys sorted.
  const ordered: VoiceCalibrationFile = {};
  if (cal._voices) ordered._voices = Object.fromEntries(Object.entries(cal._voices).sort(([a], [b]) => a.localeCompare(b)));
  for (const k of Object.keys(cal).filter((k) => k !== "_voices").sort()) ordered[k] = cal[k];
  await writeFile(`${p}.tmp`, JSON.stringify(ordered, null, 2) + "\n");
  await rename(`${p}.tmp`, p);
}

/**
 * The active narrator for a channel: OPUMIA_VOICE_ID override → cached resolution in voice-calibration.json →
 * resolve `voiceName` through ElevenLabs /v1/voices (and cache it) → static voiceId.
 */
export async function resolveChannelVoice(channel: ChannelId, dataDir: string, log: (s: string) => void = () => {}): Promise<ChannelVoice> {
  const def = CHANNEL_VOICES[channel];
  if (process.env.OPUMIA_VOICE_ID) return { voiceId: process.env.OPUMIA_VOICE_ID, name: "override", settings: def.settings };
  const cal = await readCalibration(dataDir);
  const hit = cal._voices?.[channel];
  if (hit && (!def.voiceName || hit.query === def.voiceName)) return { voiceId: hit.voiceId, name: hit.name, settings: def.settings }; // settings live in code; the cache only remembers which voice the name resolved to
  if (def.voiceName) {
    const v = await findVoiceByName(def.voiceName);
    if (!v) throw new Error(`ElevenLabs voice "${def.voiceName}" not found in the account or the voice library`);
    if (v.source !== "account") throw new Error(`ElevenLabs voice "${def.voiceName}" is only in the shared library (${v.name}); add it to the account first`);
    log(`  narration: resolved voice "${def.voiceName}" → ${v.name} (${v.voiceId})`);
    cal._voices = { ...(cal._voices ?? {}), [channel]: { query: def.voiceName, voiceId: v.voiceId, name: v.name, settings: def.settings, resolvedAt: new Date().toISOString().slice(0, 10) } };
    await writeCalibration(dataDir, cal);
    return { voiceId: v.voiceId, name: v.name, settings: def.settings };
  }
  return { voiceId: def.voiceId!, name: def.name, settings: def.settings };
}

/** Key under which measured words-per-minute is stored for a voice + model + settings. */
export const calibrationKey = (v: ChannelVoice, modelId: string) => `${v.voiceId}|${modelId}|${v.settings.speed}|s${v.settings.stability}|st${v.settings.style}`;
