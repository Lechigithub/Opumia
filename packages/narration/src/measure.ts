/**
 * First-use voice measurement (automatic, once per voice and model).
 *
 * A voice speaks at its own natural pace, so the platform has to know that pace before it cuts a script. The
 * first time a voice is used, it reads a short standard passage the way production records narration (one take
 * per sentence, speed as set, neighbours as context); its pace and expressiveness are measured and stored in
 * data/voice-calibration.json under `_natural`. Every later film reads the stored value — no call is made.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { measureProsody } from "@opumia/senses";
import { ttsWithTimestamps } from "./elevenlabs.js";
import { CHANNEL_VOICES, readCalibration, writeCalibration, type ChannelVoice } from "./voice.js";

const run = promisify(execFile);

export interface VoiceMeasure {
  /** Words a minute at natural speed, with production's usual gaps between lines. */
  wpm: number;
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
/** Average gap production leaves between lines (most lines continue the thought; a few hold a beat). */
const LINE_GAP_S = 0.12;

export const naturalKey = (voiceId: string, modelId: string) => `${voiceId}|${modelId}`;

/** The stored measurement for a voice on a model, else the value written in code, else null. */
export async function storedVoiceMeasure(dataDir: string, voiceId: string, modelId: string): Promise<VoiceMeasure | null> {
  const cal = (await readCalibration(dataDir)) as { _natural?: Record<string, VoiceMeasure> };
  const hit = cal._natural?.[naturalKey(voiceId, modelId)];
  if (hit) return hit;
  for (const [ch, def] of Object.entries(CHANNEL_VOICES)) {
    const known = def.naturalWpm?.[modelId];
    const resolved = (cal as { _voices?: Record<string, { voiceId: string }> })._voices?.[ch]?.voiceId ?? def.voiceId;
    if (known && resolved === voiceId) return { wpm: known, characters: 0, measuredAt: "", source: "code" };
  }
  return null;
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
  let words = 0;
  let spoken = 0;
  let characters = 0;
  const files: string[] = [];
  for (const [i, text] of PASSAGE.entries()) {
    const tts = await ttsWithTimestamps({ voiceId: o.voice.voiceId, modelId: o.modelId, text, speed: o.voice.settings.speed, stability: o.voice.settings.stability, similarityBoost: o.voice.settings.similarityBoost, style: o.voice.settings.style, seed: 4000 + i, ...(i > 0 ? { previousText: PASSAGE[i - 1]! } : {}), ...(PASSAGE[i + 1] ? { nextText: PASSAGE[i + 1]! } : {}) });
    characters += tts.characters;
    const a = tts.alignment;
    const idx = a.characters.map((c, k) => (c.trim() ? k : -1)).filter((k) => k >= 0);
    if (idx.length) spoken += a.character_end_times_seconds[idx.at(-1)!]! - a.character_start_times_seconds[idx[0]!]!;
    words += text.split(/\s+/).length;
    const f = path.join(dir, `${i}.mp3`);
    await writeFile(f, tts.audio);
    files.push(f);
  }
  const wpm = Math.round((words / ((spoken + (PASSAGE.length - 1) * LINE_GAP_S) / 60)) * 10) / 10;
  // One file of the whole passage for the expressiveness measures.
  const joined = path.join(dir, "passage.mp3");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:a]`).join("")}concat=n=${files.length}:v=0:a=1[a]`, "-map", "[a]", "-c:a", "libmp3lame", "-b:a", "160k", joined], { timeout: 120_000 }).catch(() => {});
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
