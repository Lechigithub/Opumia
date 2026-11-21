import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TimedScript, type ChannelId, type FactSheet, type ScriptDraft } from "@opumia/contracts";
import { ffprobe } from "@opumia/ingest";
import { alignWords, tokensFromAlignment } from "./align.js";
import { remainingCharacters, ttsWithTimestamps } from "./elevenlabs.js";
import { applyPronunciations, loadLexicon } from "./pronunciation.js";
import type { ChannelVoice } from "./voice.js";
import { withBeats } from "./beats.js";

export * from "./elevenlabs.js";
export * from "./align.js";
export * from "./pronunciation.js";
export * from "./voice.js";
export * from "./measure.js";
export * from "./beats.js";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

export interface NarrateOptions {
  draft: ScriptDraft;
  facts: FactSheet;
  outDir: string;
  libraryRoot: string;
  modelId?: string;
  /** Resolved narrator (see resolveChannelVoice). */
  voice: ChannelVoice;
  speed?: number;
  log?: (s: string) => void;
}

/** Synthesize the whole script in one request (best prosody), then split timings back onto segments. */
export async function narrate(o: NarrateOptions): Promise<{ script: TimedScript; audioPath: string; alignmentPath: string; characters: number }> {
  const log = o.log ?? (() => {});
  const voice = o.voice;
  const voiceId = voice.voiceId;
  const modelId = o.modelId ?? process.env.OPUMIA_TTS_MODEL ?? "eleven_multilingual_v2";
  const lexicon = await loadLexicon(o.libraryRoot);

  const fullText = o.draft.segments.map((s) => s.text).join(" ");
  const pron = applyPronunciations(fullText, lexicon, modelId);
  if (Object.keys(pron.applied).length) log(`  narration: pronunciation rules ${Object.keys(pron.applied).join(", ")} (${pron.mode})`);

  const remaining = await remainingCharacters();
  if (remaining !== null && remaining < pron.text.length * 1.1) throw new Error(`ElevenLabs quota too low: ${remaining} chars left, need ${pron.text.length}`);
  log(`  narration: ${pron.text.length} chars → ElevenLabs ${modelId} voice ${voice.name} (${voiceId}) stability ${voice.settings.stability} style ${voice.settings.style} speed ${voice.settings.speed} (quota left ${remaining ?? "?"})`);

  await mkdir(o.outDir, { recursive: true });
  const audioPath = path.join(o.outDir, "narration.mp3");
  const alignmentPath = path.join(o.outDir, "narration.alignment.json");

  // Chunk at chapter/segment boundaries (≤ CHUNK_CHARS) so long-form stays within request limits and
  // each take keeps stable prosody; neighbours are passed as previous_text/next_text for continuity.
  const CHUNK_CHARS = 4500;
  const chunks: Array<{ segs: typeof o.draft.segments }> = [];
  for (const seg of o.draft.segments) {
    const cur = chunks[chunks.length - 1];
    const curLen = cur ? cur.segs.reduce((n, x) => n + x.text.length + 1, 0) : Infinity;
    const chapterBreak = cur && seg.chapter && cur.segs[cur.segs.length - 1]!.chapter !== seg.chapter && curLen > CHUNK_CHARS * 0.5;
    if (!cur || curLen + seg.text.length > CHUNK_CHARS || chapterBreak) chunks.push({ segs: [seg] });
    else cur.segs.push(seg);
  }
  const GAP_S = 0.6; // takes break at chapter boundaries: a held beat before the new chapter
  const allWords = o.draft.segments.flatMap((s) => words(s.text));
  const aligned: ReturnType<typeof alignWords> = [];
  const alignDump: unknown[] = [];
  const parts: string[] = [];
  let offset = 0;
  let characters = 0;
  for (const [k, ch] of chunks.entries()) {
    // Pronunciations per segment, then dramatic <break> beats (skipped by the aligner, so captions stay exact).
    const text = withBeats(ch.segs.map((x) => ({ role: x.role, ...(x.chapter ? { chapter: x.chapter } : {}), text: applyPronunciations(x.text, lexicon, modelId).text })));
    const prev = k > 0 ? chunks[k - 1]!.segs.map((x) => x.text).join(" ").slice(-300) : undefined;
    const next = k < chunks.length - 1 ? chunks[k + 1]!.segs.map((x) => x.text).join(" ").slice(0, 300) : undefined;
    if (chunks.length > 1) log(`    chunk ${k + 1}/${chunks.length}: ${text.length} chars`);
    const tts = await ttsWithTimestamps({ voiceId, modelId, text, speed: o.speed ?? voice.settings.speed, stability: voice.settings.stability, similarityBoost: voice.settings.similarityBoost, style: voice.settings.style, seed: 1234, ...(prev ? { previousText: prev } : {}), ...(next ? { nextText: next } : {}) });
    characters += tts.characters;
    const part = path.join(o.outDir, chunks.length > 1 ? `narration.part${String(k + 1).padStart(2, "0")}.mp3` : "narration.mp3");
    await writeFile(part, tts.audio);
    parts.push(part);
    const chWords = ch.segs.flatMap((x) => words(x.text));
    for (const w of alignWords(chWords, tokensFromAlignment(tts.alignment))) aligned.push({ ...w, startS: w.startS + offset, endS: w.endS + offset });
    alignDump.push({ offsetS: offset, alignment: tts.alignment });
    offset += ((await ffprobe(part, "audio")).durationS ?? 0) + GAP_S;
  }
  if (parts.length > 1) {
    // Stitch: decode each take, add a short silence between, re-encode once (no MP3 frame gaps).
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const inputs = parts.flatMap((p) => ["-i", p]);
    const filt = parts.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=${i < parts.length - 1 ? GAP_S : 0}[a${i}]`).join(";") + `;${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`;
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filt, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", audioPath], { timeout: 300_000 });
    log(`  narration: stitched ${parts.length} takes`);
  }
  await writeFile(alignmentPath, JSON.stringify({ chunks: alignDump }) + "\n");
  const matched = aligned.filter((w) => w.matched).length;
  log(`  narration: aligned ${matched}/${aligned.length} words directly (rest interpolated)`);

  const probe = await ffprobe(audioPath, "audio");
  const durationS = probe.durationS ?? (aligned.length ? aligned[aligned.length - 1]!.endS : 0);

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
      ...(s.chapter ? { chapter: s.chapter } : {}),
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
  return { script, audioPath, alignmentPath, characters };
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
export * from "./directed.js";
