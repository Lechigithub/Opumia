import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TimedScript, type ChannelId, type FactSheet, type ScriptDraft } from "@opumia/contracts";
import { ffprobe } from "@opumia/ingest";
import { alignWords, tokensFromAlignment } from "./align.js";
import { remainingCharacters, ttsWithTimestamps } from "./elevenlabs.js";
import { applyPronunciations, loadLexicon } from "./pronunciation.js";

export * from "./elevenlabs.js";
export * from "./align.js";
export * from "./pronunciation.js";

/** Per-channel narrator defaults (premade/professional voices on the account). Override with OPUMIA_VOICE_ID. */
export const CHANNEL_VOICES: Record<ChannelId, { voiceId: string; name: string; speed: number; stability: number; style: number }> = {
  "magnates-media": { voiceId: "VMCgCMbBs53ElBxVD4VB", name: "Steven - Deep Documentary Narrator", speed: 1.12, stability: 0.4, style: 0.35 },
  "logically-answered": { voiceId: "nPczCjzI2devNBz1zQrb", name: "Brian", speed: 1.05, stability: 0.45, style: 0.25 },
  "big-company": { voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George", speed: 1.0, stability: 0.5, style: 0.2 },
  "modern-mba": { voiceId: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", speed: 1.05, stability: 0.5, style: 0.2 },
  "how-money-works": { voiceId: "cjVigY5qzO86Huf0OWal", name: "Eric", speed: 1.08, stability: 0.45, style: 0.25 },
  moon: { voiceId: "3YzGaTGef0x5PLEK9yGq", name: "Atlas", speed: 1.05, stability: 0.45, style: 0.3 },
};

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

export interface NarrateOptions {
  draft: ScriptDraft;
  facts: FactSheet;
  outDir: string;
  libraryRoot: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  log?: (s: string) => void;
}

/** Synthesize the whole script in one request (best prosody), then split timings back onto segments. */
export async function narrate(o: NarrateOptions): Promise<{ script: TimedScript; audioPath: string; alignmentPath: string; characters: number }> {
  const log = o.log ?? (() => {});
  const voice = CHANNEL_VOICES[o.draft.styleProfileId];
  const voiceId = o.voiceId ?? process.env.OPUMIA_VOICE_ID ?? voice.voiceId;
  const modelId = o.modelId ?? process.env.OPUMIA_TTS_MODEL ?? "eleven_multilingual_v2";
  const lexicon = await loadLexicon(o.libraryRoot);

  const fullText = o.draft.segments.map((s) => s.text).join(" ");
  const pron = applyPronunciations(fullText, lexicon, modelId);
  if (Object.keys(pron.applied).length) log(`  narration: pronunciation rules ${Object.keys(pron.applied).join(", ")} (${pron.mode})`);

  const remaining = await remainingCharacters();
  if (remaining !== null && remaining < pron.text.length * 1.1) throw new Error(`ElevenLabs quota too low: ${remaining} chars left, need ${pron.text.length}`);
  log(`  narration: ${pron.text.length} chars → ElevenLabs ${modelId} voice ${voiceId} (quota left ${remaining ?? "?"})`);

  const tts = await ttsWithTimestamps({ voiceId, modelId, text: pron.text, speed: o.speed ?? voice.speed, stability: voice.stability, style: voice.style, seed: 1234 });
  await mkdir(o.outDir, { recursive: true });
  const audioPath = path.join(o.outDir, "narration.mp3");
  const alignmentPath = path.join(o.outDir, "narration.alignment.json");
  await writeFile(audioPath, tts.audio);
  await writeFile(alignmentPath, JSON.stringify({ alignment: tts.alignment, normalized: tts.normalized ?? null }) + "\n");

  const tokens = tokensFromAlignment(tts.alignment);
  const allWords = o.draft.segments.flatMap((s) => words(s.text));
  const aligned = alignWords(allWords, tokens);
  const matched = aligned.filter((w) => w.matched).length;
  log(`  narration: aligned ${matched}/${aligned.length} words directly (rest interpolated)`);

  const probe = await ffprobe(audioPath, "audio");
  const durationS = probe.durationS ?? (tokens.length ? tokens[tokens.length - 1]!.endS : 0);

  const claimsById = new Map(o.facts.claims.map((c) => [c.id, c]));
  let cursor = 0;
  const segments = o.draft.segments.map((s) => {
    const n = words(s.text).length;
    const ws = aligned.slice(cursor, cursor + n);
    cursor += n;
    const pr = Object.fromEntries(Object.entries(pron.applied).filter(([w]) => s.text.includes(w)));
    return {
      id: s.id,
      role: s.role,
      text: s.text,
      startS: ws[0]?.startS ?? 0,
      endS: ws[ws.length - 1]?.endS ?? 0,
      words: ws.map((w) => ({ word: w.word, startS: w.startS, endS: w.endS })),
      claims: s.claimIds.map((id) => claimsById.get(id)).filter((c) => c !== undefined).map((c) => ({ text: c.text, sourceUrl: c.sourceUrl })),
      pronunciations: pr,
    };
  });
  // Segments must not overlap: clamp each start to the previous end.
  for (let i = 1; i < segments.length; i++) if (segments[i]!.startS < segments[i - 1]!.endS) segments[i]!.startS = segments[i - 1]!.endS;

  const script = TimedScript.parse({
    schemaVersion: 1,
    id: `ts_${o.draft.id.slice(3)}`,
    title: o.draft.title,
    styleProfileId: o.draft.styleProfileId,
    aspect: o.draft.aspect,
    language: "en",
    voice: { provider: "elevenlabs", voiceId, modelId, audioPath },
    segments,
    durationS,
    generatedAt: new Date().toISOString(),
  });
  const wpm = (allWords.length / Math.max(1, durationS)) * 60;
  log(`  narration: ${durationS.toFixed(2)} s, ${Math.round(wpm)} wpm`);
  return { script, audioPath, alignmentPath, characters: tts.characters };
}

/**
 * Broadcast-style fit: time-compress narration by ≤ 6 % with FFmpeg atempo (pitch-preserving) and
 * rescale every word timestamp by the same factor, so captions stay frame-exact. Keeps the raw take.
 */
export async function tempoFit(script: TimedScript, targetS: number, log: (s: string) => void = () => {}): Promise<TimedScript> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { copyFile, stat } = await import("node:fs/promises");
  const factor = script.durationS / targetS;
  if (factor <= 1) return script;
  if (factor > 1.06) throw new Error(`tempoFit: ${(factor * 100 - 100).toFixed(1)}% exceeds the 6% limit`);
  const src = script.voice.audioPath;
  const raw = src.replace(/\.mp3$/, ".raw.mp3");
  if (!(await stat(raw).catch(() => null))) await copyFile(src, raw);
  await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-filter:a", `atempo=${factor.toFixed(5)}`, "-c:a", "libmp3lame", "-b:a", "192k", src]);
  const r = (x: number) => Math.round((x / factor) * 1000) / 1000;
  const probe = await ffprobe(src, "audio");
  log(`  narration: tempo-fit ×${factor.toFixed(3)} → ${probe.durationS?.toFixed(2)} s (raw take kept)`);
  return TimedScript.parse({
    ...script,
    segments: script.segments.map((s) => ({ ...s, startS: r(s.startS), endS: r(s.endS), words: s.words.map((w) => ({ ...w, startS: r(w.startS), endS: r(w.endS) })) })),
    durationS: probe.durationS ?? r(script.durationS),
  });
}
