import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { directVoice, voiceAgent, runOnPauses, type LineMeasure, type VoiceAgentReport, type Tone, loadPronunciationLexicon, savePronunciationLexicon, sentencesOf, type Lexicon, type LineDirection } from "@opumia/agents";
import { TimedScript, type FactSheet, type ScriptDraft } from "@opumia/contracts";
import { asrBackend, diffSpeech, espeakIpa, measureProsody, pcm, phonemeMatch, phonemeTokens, spokenPhonemes, transcribe, type PronunciationCheck } from "@opumia/senses";
import { alignWords, tokensFromAlignment } from "./align.js";
import { SR, tighten } from "./passage.js";
import { remainingCharacters, ttsWithTimestamps, type CharAlignment } from "./elevenlabs.js";
import { ttsModel, type ChannelVoice } from "./voice.js";
import { solveNames, type NameCheck } from "./names.js";

/**
 * Directed narration: the script is spoken line by line under a voice director, then LISTENED TO and corrected.
 *
 *  1. Voice director (one model call): delivery per line (pace, pause after, emphasis) and every risky word with
 *     its correct pronunciation; pronunciations are remembered across films (data/pronunciation-lexicon.json).
 *  2. Each line is its own take (neighbouring lines passed as context, so prosody flows). Takes are cached.
 *  3. Sentences are spoken in passages (one take each, never cut inside); passages meet on their own room sound
 *     with crossfades, a held beat filled with room tone — never digital silence (build list 2, step 3).
 *  4. Listen-back: Whisper transcribes the result and it is compared word for word with the script; the phoneme
 *     checker compares the SOUNDS of every risky word with its target pronunciation.
 *  5. Only failing lines are regenerated (new take; respelling for a word that sounded wrong), then re-checked.
 *  6. Pace is left as the voice spoke it: no speed push and no tempo change (owner decision 2026-11-22).
 */
const run = promisify(execFile);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export interface DirectedOptions {
  draft: ScriptDraft;
  facts: FactSheet;
  outDir: string;
  dataDir: string;
  channel: string;
  voice: ChannelVoice;
  modelId?: string;
  /** Reference narrator band (data/exemplars): target pace and pauses, and its expressiveness. */
  narrator?: { wpm: number; wpmLow: number; f0RangeSt?: number; melodySt?: number };
  /** Build list 5, item 25: the Library (its read-only IPA cache is a pronunciation source). */
  libraryDir?: string;
  /** Build list 5, item 23: the writer rewords one sentence for speech (same facts); null keeps it. */
  reword?: (o: { text: string; why: string; context: string }) => Promise<string | null>;
  log?: (s: string) => void;
}

export interface NarrationReport {
  lines: number;
  takes: number;
  retakes: number;
  characters: number;
  wpm: number;
  tempo: number;
  asr: string | null;
  wer: number | null;
  speechIssues: Array<{ kind: string; expected: string; heard: string; atS: number }>;
  pronunciation: Array<PronunciationCheck & { form: "plain" | "respelling" }>;
  unresolved: string[];
  directorUsd: number;
  /** B7: what the listening voice director changed. */
  delivery?: VoiceAgentReport;
  /** Build list 5, item 25: every name's check before the first take; names no form could make right. */
  names?: { checks: NameCheck[]; unsolved: string[] };
  /** Build list 5, item 23: delivery problems still open after the voice director (blocking for the gate). */
  deliveryUnresolved?: string[];
}

/** A passage: consecutive sentences spoken in ONE take (no cut inside it). `emphases` holds each sentence's word. */
interface Unit { seg: number; text: string; words: string[]; dir: LineDirection; emphases?: string[]; role: string; chapter?: string; sentences: number; /** item 24 */ act: number; tone?: Tone; fall?: boolean }

/** Build list 5, item 24: acts of the story — its chapters, or for one continuous film the setup, the rise and the fall. */
const ACT_OF_ROLE: Record<string, number> = { cold_open: 0, hook: 0, thesis: 0, context: 0, rise: 1, twist: 1, climax: 1, rehook: 1, chapter: 1, fall: 2, resolution: 2, cta: 2 };

/** Build list 5, item 23: a tone changes the voice's steadiness and expressiveness for one take — never its speed. */
const TONE_SETTINGS: Record<Tone, { stability: number; style: number }> = { grave: { stability: 0.12, style: -0.2 }, dry: { stability: 0.1, style: -0.3 }, wry: { stability: -0.03, style: 0.1 }, urgent: { stability: -0.08, style: 0.2 }, warm: { stability: 0.04, style: -0.05 } };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
interface Take { audio: Float32Array; words: Array<{ word: string; startS: number; endS: number }>; key: string }

const GAP = { none: 0.03, short: 0.1, beat: 0.36 } as const;
const CHAPTER_GAP = 0.6;

/** The text sent to the voice: expansions always; respelling only for the terms listed; emphasis in capitals. */
function speakText(u: Unit, lex: Lexicon, respell: Set<string>, vkey = ""): string {
  let t = u.text;
  for (const [term, e] of Object.entries(lex).sort((a, b) => b[0].length - a[0].length)) {
    if (!t.includes(term)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    const v = e.verified?.[vkey];
    if (e.spoken) t = t.replace(re, e.spoken);
    // item 25: the form that passed the name check for this voice and model, exactly as it was checked
    else if (v && !respell.has(term)) { if (v.form === "respelling") t = t.replace(re, v.text.replace(/^./, (c) => c.toUpperCase())); }
    else if ((respell.has(term) || e.works === "respelling") && e.respelling) t = t.replace(re, e.respelling.toLowerCase().replace(/[^a-z' ]/g, "").replace(/^./, (c) => c.toUpperCase()));
  }
  for (const raw of u.emphases ?? [u.dir.emphasis]) {
    const em = raw.replace(/[^\p{L}'-]/gu, "");
    if (em.length > 2 && !Object.keys(lex).some((k) => k.includes(em))) t = t.replace(new RegExp(`\\b${em}\\b`), em.toUpperCase());
  }
  return t;
}

/** The quietest 120 ms of a take that is not digital silence: its room, to fill a pause longer than the takes' own. */
function roomOf(audio: Float32Array): Float32Array {
  const W = Math.round(0.12 * SR);
  let best = -1, bestE = Infinity;
  for (let i = 0; i + W < audio.length; i += Math.round(W / 4)) {
    let e = 0;
    for (let k = 0; k < W; k++) e += audio[i + k]! * audio[i + k]!;
    if (e > 1e-10 * W && e < bestE) (bestE = e), (best = i);
  }
  if (best < 0) { const n = new Float32Array(W); for (let k = 0; k < W; k++) n[k] = (Math.random() - 0.5) * 2e-4; return n; }
  return audio.slice(best, best + W);
}

async function writeMp3(samples: Float32Array, out: string): Promise<void> {
  const raw = `${out}.f32`;
  await writeFile(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", raw, "-c:a", "libmp3lame", "-b:a", "192k", `${out}.tmp.mp3`], { timeout: 300_000 });
  await rename(`${out}.tmp.mp3`, out);
  await import("node:fs/promises").then((fs) => fs.unlink(raw).catch(() => {}));
}

export async function narrateDirected(o: DirectedOptions): Promise<{ script: TimedScript; audioPath: string; alignmentPath: string; characters: number; report: NarrationReport; /** the script as spoken (item 23: punctuation re-set or lines reworded for speech) */ draft: ScriptDraft }> {
  const log = o.log ?? (() => {});
  const voice = o.voice;
  const modelId = o.modelId ?? ttsModel();
  await mkdir(path.join(o.outDir, "takes"), { recursive: true });

  // Lines = sentences, kept inside their segments.
  // item 23: the voice director may re-set punctuation or have the writer reword a line; the draft returned carries it
  const draft: ScriptDraft = structuredClone(o.draft);
  const raw: Array<{ seg: number; text: string; role: string; chapter?: string }> = [];
  draft.segments.forEach((s, si) => {
    for (const t of sentencesOf(s.text)) raw.push({ seg: si, text: t, role: s.role, ...(s.chapter ? { chapter: s.chapter } : {}) });
  });

  // 1. Voice director + pronunciation lexicon.
  const lexAll = await loadPronunciationLexicon(o.dataDir);
  const scriptText = raw.map((r) => r.text).join(" ");
  const known: Lexicon = Object.fromEntries(Object.entries(lexAll).filter(([t]) => scriptText.includes(t)));
  const people = (o.facts.story?.characters ?? []).map((c) => c.name);
  // Build list 3, item 23: the direction of an unchanged script is reused (the same passages, emphases and pauses), so a
  // re-run or a ladder rung does not re-direct and re-record lines that did not change; melody stops varying run to run.
  const dirFile = path.join(o.outDir, "voice-direction.json");
  const dirKey = sha(`${o.channel}|${raw.map((r) => `${r.role}:${r.text}`).join("\n")}`);
  const cachedDir = existsSync(dirFile) ? (JSON.parse(await readFile(dirFile, "utf8")) as { key: string; dv: Awaited<ReturnType<typeof directVoice>> }) : null;
  const dv = cachedDir?.key === dirKey ? cachedDir.dv : await directVoice({ channel: o.channel, sentences: raw.map((r) => ({ text: r.text, role: r.role })), people, known, ...(o.narrator ? { narratorWpm: o.narrator.wpm } : {}) });
  if (cachedDir?.key !== dirKey) await writeFile(dirFile, JSON.stringify({ key: dirKey, dv }, null, 1) + "\n");
  let lex: Lexicon = { ...known, ...dv.terms };
  // 1b. Build list 5, item 25: every name, place and brand is solved and checked BEFORE the first take — its own
  // pronunciation as the target, the voice saying it alone, a strict check of its sounds including the stressed vowel.
  const vkey = `${voice.voiceId}|${modelId}`;
  let names: { checks: NameCheck[]; unsolved: string[] } | undefined;
  {
    const sn = await solveNames({ lexicon: lex, scriptText, people, voice, modelId, dataDir: o.dataDir, outDir: o.outDir, ...(o.libraryDir ? { libraryDir: o.libraryDir } : {}), log }).catch((e: Error) => { log(`  ! name check failed: ${e.message.slice(0, 160)}`); return null; });
    if (sn) {
      lex = sn.lexicon;
      names = { checks: sn.checks, unsolved: sn.unsolved };
      await savePronunciationLexicon(o.dataDir, { ...lexAll, ...lex });
    }
  }
  // Step 3 (seamless voice): sentences are spoken in passages — consecutive sentences of one segment and chapter, up to
  // about 600 characters, ending at a held beat — so the voice is never cut inside a passage: its intonation runs
  // across sentences, and its breaths and pauses are its own. Passages meet on their own room sound.
  const units: Unit[] = [];
  for (const [i, r] of raw.entries()) {
    const d = dv.lines[i]!;
    const cur = units.at(-1);
    const prevDir = i > 0 ? dv.lines[i - 1]! : null;
    const join = cur && cur.seg === r.seg && cur.chapter === r.chapter && cur.text.length + r.text.length < 600 && prevDir?.pauseAfter !== "beat";
    if (join) {
      cur.text = `${cur.text} ${r.text}`;
      cur.words = words(cur.text);
      cur.emphases = [...(cur.emphases ?? []), d.emphasis];
      cur.dir = { ...cur.dir, pauseAfter: d.pauseAfter };
      cur.sentences++;
    } else units.push({ seg: r.seg, text: r.text, words: words(r.text), dir: d, emphases: [d.emphasis], role: r.role, ...(r.chapter ? { chapter: r.chapter } : {}), sentences: 1, act: 0 });
  }
  {
    // acts: chapters when there are chapters, else setup → rise → fall by segment role (never going back)
    const chapters = [...new Set(units.map((u) => u.chapter).filter(Boolean))];
    let act = 0;
    for (const u of units) {
      act = chapters.length >= 2 ? Math.max(0, chapters.indexOf(u.chapter)) : Math.max(act, ACT_OF_ROLE[u.role] ?? act);
      u.act = act;
    }
  }
  log(`  voice director: ${raw.length} sentences in ${units.length} passage(s) — ${units.filter((u) => u.dir.pace === "fast").length} fast, ${units.filter((u) => u.dir.pace === "slow").length} slow, ${units.filter((u) => u.dir.pauseAfter === "beat").length} held beat(s); ${Object.keys(lex).length} risky word(s): ${Object.keys(lex).slice(0, 14).join(", ")}${Object.keys(lex).length > 14 ? ", …" : ""}`);

  const remaining = await remainingCharacters();
  if (remaining !== null && remaining < scriptText.length * 1.3) throw new Error(`ElevenLabs quota too low: ${remaining} chars left, need about ${Math.round(scriptText.length * 1.3)}`);

  // 2. Takes (cached by exact request).
  // Every line is spoken at the voice's natural speed. The director's pace note shapes the pauses around a
  // line (step 3), never the speed of the voice itself.
  const base = voice.settings.speed;
  const speedOf = (_p: LineDirection["pace"]) => base;
  let characters = 0;
  let takesMade = 0;
  const alignDump: unknown[] = [];
  const takeOf = async (i: number, attempt: number, respell: Set<string>): Promise<Take> => {
    const u = units[i]!;
    const text = speakText(u, lex, respell, vkey);
    const prev = units.slice(Math.max(0, i - 2), i).map((x) => x.text).join(" ").slice(-300);
    // item 23: a statement that must fall is taken without the continuation after it (the voice ends it)
    const next = u.fall ? undefined : units[i + 1]?.text.slice(0, 200);
    const ts = u.tone ? TONE_SETTINGS[u.tone] : { stability: 0, style: 0 };
    const req = { voiceId: voice.voiceId, modelId, text, speed: speedOf(u.dir.pace), stability: clamp(voice.settings.stability + ts.stability, 0.05, 0.95), similarityBoost: voice.settings.similarityBoost, style: clamp(voice.settings.style + ts.style, 0, 1), seed: (parseInt(sha(text).slice(0, 6), 16) % 100000) + attempt * 101, ...(prev ? { previousText: prev } : {}), ...(next ? { nextText: next } : {}) };
    const key = sha(JSON.stringify(req));
    const mp3 = path.join(o.outDir, "takes", `${key}.mp3`);
    const meta = path.join(o.outDir, "takes", `${key}.json`);
    let alignment: CharAlignment;
    if (existsSync(mp3) && existsSync(meta)) alignment = JSON.parse(await readFile(meta, "utf8")) as CharAlignment;
    else {
      const tts = await ttsWithTimestamps(req);
      characters += tts.characters;
      takesMade++;
      await writeFile(mp3, tts.audio);
      await writeFile(meta, JSON.stringify(tts.alignment));
      alignment = tts.alignment;
    }
    const audio = await pcm(mp3, { sr: SR });
    const aligned = alignWords(u.words, tokensFromAlignment(alignment)).map((w) => ({ word: w.word, startS: w.startS, endS: w.endS }));
    const t = tighten(audio, aligned);
    return { audio: t.audio, words: t.words, key };
  };
  const pool = async <T>(n: number, jobs: Array<() => Promise<T>>): Promise<T[]> => {
    const out = new Array<T>(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
      for (let k = next++; k < jobs.length; k = next++) out[k] = await jobs[k]!();
    }));
    return out;
  };
  log(`  narration: ${units.length} line takes → ElevenLabs ${modelId}, voice ${voice.name}, speed ${speedOf("slow").toFixed(2)}–${speedOf("fast").toFixed(2)} (quota left ${remaining ?? "?"})`);
  // build list 5, item 32: a long narration records more lines at once (3 for a short, up to 8)
  const takes = await pool(Math.min(8, Math.max(3, Math.ceil(units.length / 15))), units.map((_, i) => () => takeOf(i, 0, new Set())));

  // 2b. B7: the voice director listens to every take (measured) and retakes lines that sound flat or wrong.
  let delivery: VoiceAgentReport | undefined;
  if (units.length >= 3) {
    const lineFile = async (t: Take) => {
      const f = path.join(o.outDir, "takes", `${t.key}.tight.mp3`);
      if (!existsSync(f)) await writeMp3(t.audio, f);
      return f;
    };
    const measureTake = async (i: number, t: Take): Promise<LineMeasure> => {
      const f = await lineFile(t);
      const whole = await measureProsody(f).catch(() => null);
      const lineHz = whole?.f0Hz || 0;
      const levelOf = (a: number, b: number) => {
        const x = t.audio.subarray(Math.max(0, Math.floor(a * SR)), Math.min(t.audio.length, Math.ceil(b * SR)));
        let e = 0;
        for (let k = 0; k < x.length; k++) e += x[k]! * x[k]!;
        return 10 * Math.log10(e / Math.max(1, x.length) + 1e-12);
      };
      const lineDb = levelOf(t.words[0]?.startS ?? 0, t.words.at(-1)?.endS ?? t.audio.length / SR);
      const contour: Array<[string, number, number]> = [];
      for (const w of t.words) {
        const p = w.endS - w.startS >= 0.08 ? await measureProsody(f, { ss: w.startS, t: Math.max(0.08, w.endS - w.startS) }).catch(() => null) : null;
        const st = p?.f0Hz && lineHz ? 12 * Math.log2(p.f0Hz / lineHz) : 0;
        contour.push([w.word, Math.round(st * 10) / 10, Math.round((levelOf(w.startS, w.endS) - lineDb) * 10) / 10]);
      }
      const em = units[i]!.dir.emphasis.toLowerCase().replace(/[^\p{L}'-]/gu, "");
      const k = em ? contour.findIndex(([w]) => w.toLowerCase().replace(/[^\p{L}'-]/gu, "") === em) : -1;
      const rest = contour.filter((_, q) => q !== k);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      const voicedEnd = [...contour].reverse().find(([, st]) => st !== 0);
      const secs = (t.words.at(-1)?.endS ?? 0) - (t.words[0]?.startS ?? 0);
      return {
        seconds: Math.round(secs * 100) / 100, wpm: secs > 0 ? (t.words.length / secs) * 60 : 0, f0Hz: lineHz,
        innerPauses: runOnPauses(t.words),
        rangeSt: whole?.f0RangeSt ?? 0, melodySt: whole?.melodySt ?? 0, dynamicsDb: whole?.energyStdDb ?? 0,
        emphasis: k >= 0 ? { word: contour[k]![0], liftDb: Math.round((contour[k]![2] - mean(rest.map((x) => x[2]))) * 10) / 10, liftSt: Math.round((contour[k]![1] - mean(rest.map((x) => x[1]))) * 10) / 10 } : null,
        endingSt: voicedEnd?.[1] ?? 0, contour,
      };
    };
    const candidates = new Map<string, { i: number; take: Take; set: Partial<Unit>; text?: string }>();
    let nCand = 0;
    /** A candidate take of a line with other text (punctuation re-set, or the writer's rewording). */
    const candidateWithText = async (i: number, text: string) => {
      const u = units[i]!;
      const keep = { text: u.text, words: u.words };
      u.text = text;
      u.words = words(text);
      const t = await takeOf(i, 20 + ++nCand, new Set()).finally(() => Object.assign(u, keep));
      const id = `c${nCand}`;
      candidates.set(id, { i, take: t, set: {}, text });
      // measured against the new words
      u.text = text; u.words = words(text);
      try { return { id, m: await measureTake(i, t) }; } finally { Object.assign(u, keep); }
    };
    delivery = await voiceAgent({
      channel: o.channel, title: o.draft.title,
      lines: units.map((u) => ({ text: u.text, role: u.role, pace: u.dir.pace, emphasis: u.dir.emphasis, question: /\?\s*$/.test(u.text), act: u.act })),
      narrator: o.narrator ?? null,
      measure: (i) => measureTake(i, takes[i]!),
      retake: async (i, r) => {
        const u = units[i]!;
        const keep = { dir: u.dir, emphases: u.emphases, tone: u.tone, fall: u.fall };
        if (r.emphasis) (u.dir = { ...u.dir, emphasis: r.emphasis }), (u.emphases = [r.emphasis]);
        if (r.tone) u.tone = r.tone;
        if (r.fall) u.fall = true;
        const set = { dir: u.dir, emphases: u.emphases, tone: u.tone, fall: u.fall };
        const t = await takeOf(i, 20 + ++nCand, new Set()).finally(() => Object.assign(u, keep));
        const id = `c${nCand}`;
        candidates.set(id, { i, take: t, set });
        return { id, m: await measureTake(i, t) };
      },
      repunctuate: async (i, text) => candidateWithText(i, text),
      ...(o.reword ? {
        reword: async (i: number, why: string) => {
          const u = units[i]!;
          const segText = draft.segments[u.seg]!.text;
          if (!segText.includes(u.text)) return null;
          const nt = (await o.reword!({ text: u.text, why, context: segText }).catch(() => null))?.trim();
          if (!nt || nt === u.text) return null;
          const c = await candidateWithText(i, nt);
          return { ...c, text: nt };
        },
      } : {}),
      choose: async (i, id) => {
        const c = candidates.get(id);
        if (!c || c.i !== i) return;
        takes[i] = c.take;
        const u = units[i]!;
        Object.assign(u, c.set);
        if (c.text && c.text !== u.text) {
          // the new wording becomes the script's: the segment's text carries it (words and captions follow)
          const sg = draft.segments[u.seg]!;
          if (sg.text.includes(u.text)) sg.text = sg.text.replace(u.text, c.text);
          u.text = c.text;
          u.words = words(c.text);
        }
      },
      memoryDir: path.join(o.dataDir, "agents", "voice"), log,
    }).catch((e: Error) => { log(`  ! voice director (listening) failed: ${e.message.slice(0, 200)} — the first takes are kept`); return undefined; });
  }

  // 3. Assemble with directed gaps.
  const audioPath = path.join(o.outDir, "narration.mp3");
  const assemble = async () => {
    const gaps = units.map((u, i) => (i === units.length - 1 ? 0.12 : units[i + 1]!.chapter !== u.chapter && units[i + 1]!.chapter ? CHAPTER_GAP : GAP[u.dir.pauseAfter]));
    // Passages meet on their own room sound: the pause between the last word of one and the first word of the next
    // is the takes' tail + lead room. A shorter wanted pause overlaps the two rooms with an equal-power crossfade; a
    // longer one is filled with room tone looped from the passage before (never digital silence).
    const XF = Math.round(0.04 * SR);
    const parts: Float32Array[] = [];
    const timed: Array<{ word: string; startS: number; endS: number; unit: number }> = [];
    let acc = new Float32Array(0);
    const append = (x: Float32Array, overlap: number) => {
      const ov = Math.max(0, Math.min(overlap, acc.length, x.length));
      const out = new Float32Array(acc.length + x.length - ov);
      out.set(acc.subarray(0, acc.length - ov), 0);
      for (let k = 0; k < ov; k++) { const g = k / Math.max(1, ov - 1); out[acc.length - ov + k] = acc[acc.length - ov + k]! * Math.cos((g * Math.PI) / 2) + x[k]! * Math.sin((g * Math.PI) / 2); }
      out.set(x.subarray(ov), acc.length);
      acc = out;
      return acc.length - x.length;
    };
    takes.forEach((t, i) => {
      if (i === 0) { append(t.audio, 0); for (const w of t.words) timed.push({ word: w.word, startS: w.startS, endS: w.endS, unit: i }); return; }
      const prev = takes[i - 1]!;
      const natural = (prev.audio.length / SR - (prev.words.at(-1)?.endS ?? prev.audio.length / SR)) + (t.words[0]?.startS ?? 0);
      const want = Math.max(0.18, gaps[i - 1]!);
      let start: number;
      if (want <= natural) start = append(t.audio, Math.round((natural - want) * SR) + XF);
      else {
        // fill: room tone from the passage before, looped with crossfades, long enough for the wanted pause
        const room = roomOf(prev.audio);
        let fill = new Float32Array(0);
        const need = Math.round((want - natural) * SR) + 2 * XF;
        while (fill.length < need) { const nx = new Float32Array(fill.length + room.length - Math.min(XF, fill.length)); nx.set(fill.subarray(0, fill.length - Math.min(XF, fill.length))); const o0 = fill.length - Math.min(XF, fill.length); for (let k = 0; k < room.length; k++) { const g = k < XF && fill.length ? k / XF : 1; nx[o0 + k] = (k < XF && fill.length ? fill[o0 + k]! * (1 - g) : 0) + room[k]! * g; } fill = nx; }
        append(fill.subarray(0, need), XF);
        start = append(t.audio, XF);
      }
      for (const w of t.words) timed.push({ word: w.word, startS: w.startS + start / SR, endS: w.endS + start / SR, unit: i });
    });
    void parts;
    await writeMp3(acc, audioPath);
    return { timed, durationS: acc.length / SR };
  };
  let asm = await assemble();

  // 4–5. Listen back, check the sounds of risky words, regenerate only what failed.
  const asr = await asrBackend(o.dataDir);
  const report: NarrationReport = { lines: units.length, takes: 0, retakes: 0, characters: 0, wpm: 0, tempo: 1, asr, wer: null, speechIssues: [], pronunciation: [], unresolved: [], directorUsd: cachedDir?.key === dirKey ? 0 : dv.usd, ...(delivery ? { delivery, deliveryUnresolved: Object.entries(delivery.unresolved).map(([k, f]) => `line ${Number(k) + 1}: ${f.join("; ")}`).concat(delivery.tone?.oneColour ? ["the story is told in one colour from start to end"] : []) } : {}), ...(names ? { names } : {}) };
  const phonemeTerms = Object.entries(lex).filter(([, e]) => ["name", "place", "brand", "foreign", "rare"].includes(e.kind) && (e.ipa || e.respelling));
  const respellFor = new Map<number, Set<string>>();
  /** Best take seen per line (fewest problems), so a retake can never make a line worse. */
  const best = new Map<number, { take: Take; flags: number }>();
  const failedTerms = new Map<number, Map<string, number>>();
  if (!asr) log(`  ! no speech recogniser available (install whisper-cpp + a model in data/models/, or set CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_TOKEN): narration is NOT verified`);
  for (let round = 0; asr && round < 4; round++) {
    const heard = await transcribe(audioPath, { dataDir: o.dataDir });
    const diff = diffSpeech(asm.timed.map((w) => ({ word: w.word, startS: w.startS })), heard.words);
    const unitAt = (t: number) => asm.timed.reduce((best, w) => (Math.abs(w.startS - t) < Math.abs(best.startS - t) ? w : best), asm.timed[0]!).unit;
    const bad = new Map<number, string[]>();
    const flag = (u: number, why: string) => bad.set(u, [...(bad.get(u) ?? []), why]);
    const checks: NarrationReport["pronunciation"] = [];
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    // SOUND CHECK. The sounds of each whole line are recognised once; every risky word's target pronunciation
    // is looked for around the place in the line where the word is spoken. The consonant skeleton must be
    // right (what this recogniser hears reliably); vowel and stress errors are beyond it.
    const lineSounds = new Map<string, string>();
    const soundOk = new Set<string>(); // `${unit}|${normalised word}` for words whose sounds passed
    for (const [term, e] of phonemeTerms) {
      const tw = words(term).map(norm);
      const target = e.ipa && e.ipa.trim() ? e.ipa : await espeakIpa(e.respelling || term).catch(() => "");
      if (!target) continue;
      for (let u = 0; u < units.length; u++) {
        const uw = units[u]!.words.map(norm);
        const at = uw.findIndex((_, k) => tw.every((x, q) => (uw[k + q] ?? "").replace(/s$/, "") === x.replace(/s$/, "")));
        if (at < 0) continue;
        // the sounds of a short window around the word itself (a passage is too long to place a word inside it
        // reliably): the word's own aligned time ± 0.3 s
        const wsU = asm.timed.filter((w) => w.unit === u);
        const wA = wsU.length === uw.length ? wsU[at] : undefined, wB = wsU.length === uw.length ? wsU[at + tw.length - 1] : undefined;
        const key = wA && wB ? `${u}@${wA.startS.toFixed(2)}` : `${u}`;
        if (!lineSounds.has(key)) lineSounds.set(key, wA && wB ? await spokenPhonemes(audioPath, Math.max(0, wA.startS - 0.3), wB.endS + 0.3, o.dataDir).catch(() => "") : wsU.length ? await spokenPhonemes(audioPath, Math.max(0, wsU[0]!.startS - 0.05), wsU.at(-1)!.endS + 0.12, o.dataDir).catch(() => "") : "");
        const spoken = lineSounds.get(key)!;
        if (!spoken) continue;
        // Position of the word in the line by its own aligned time in the take (film 1: by characters, "1975" — four
        // characters, but "nineteen seventy-five" spoken — sent the check for "Kodak" to the sounds of the year).
        // Character counts remain the fallback when the alignment does not cover the line word for word.
        const ws = wsU;
        let frac: number;
        if (wA && wB) {
          // the window is centred on the word: its sounds sit in the middle
          const from = Math.max(0, wA.startS - 0.3), to = wB.endS + 0.3;
          frac = ((wA.startS + wB.endS) / 2 - from) / Math.max(0.1, to - from);
        } else if (ws.length === uw.length && ws[at] && ws[at + tw.length - 1]) {
          const from = Math.max(0, ws[0]!.startS - 0.05), to = ws.at(-1)!.endS + 0.12;
          frac = ((ws[at]!.startS + ws[at + tw.length - 1]!.endS) / 2 - from) / Math.max(0.1, to - from);
        } else {
          const chars = uw.map((x) => x.length + 1);
          const before = chars.slice(0, at).reduce((n, x) => n + x, 0) + chars.slice(at, at + tw.length).reduce((n, x) => n + x, 0) / 2;
          frac = before / Math.max(1, chars.reduce((n, x) => n + x, 0));
        }
        const m = phonemeMatch(target, spoken, { frac });
        const form = respellFor.get(u)?.has(term) || e.works === "respelling" ? "respelling" : "plain";
        const ok = m.score >= 0.55 && m.consonants >= 0.8;
        checks.push({ word: term, score: m.score, consonants: m.consonants, target: m.target, spoken: m.spoken.slice(0, 80), ok, form });
        if (ok) for (const x of tw) soundOk.add(`${u}|${x.replace(/s$/, "")}`);
        else {
          flag(u, `"${term}" sounded wrong (consonants ${m.consonants}, heard ${m.spoken.slice(0, 40)})`);
          // First failure: a fresh take of the same text. Second failure of the same word: respell it.
          const ft = failedTerms.get(u) ?? new Map<string, number>();
          ft.set(term, (ft.get(term) ?? 0) + 1);
          failedTerms.set(u, ft);
          if ((ft.get(term) ?? 0) >= 2) respellFor.set(u, new Set([...(respellFor.get(u) ?? []), term]));
        }
      }
    }
    // WORD CHECK. Whisper hears without being told the names, so a mangled name comes back as a different
    // word. A name spelled differently but whose sounds passed is only a spelling variant, not an error.
    // A second opinion on words the recogniser did not hear: the SOUNDS of that stretch against the words' own sounds.
    // The transcriber drops words read in another manner (a quotation acted out) — film 1 voice test: "cute, but please
    // don't tell anyone" was spoken (consonants 0.91; wrong words 0.22) and reported missing four retakes running.
    const confirmed = new Set<typeof diff.issues[number]>();
    {
      const real = diff.issues.filter((x) => x.kind !== "extra");
      const groups: Array<typeof real> = [];
      for (const is of real) { const g = groups.at(-1); if (g && is.atS - g.at(-1)!.atS < 1.5) g.push(is); else groups.push([is]); }
      for (const g of groups) {
        const from = Math.min(...g.map((x) => x.atS)), to = Math.max(...g.map((x) => x.atS));
        const span = asm.timed.filter((w) => w.startS >= from - 0.02 && w.startS <= to + 0.02);
        if (!span.length) continue;
        const phrase = span.map((w) => w.word).join(" ");
        const target = await espeakIpa(phrase).catch(() => "");
        const heardS = target ? await spokenPhonemes(audioPath, Math.max(0, span[0]!.startS - 0.15), span.at(-1)!.endS + 0.15, o.dataDir).catch(() => "") : "";
        const m = target && heardS ? phonemeMatch(target, heardS, { frac: 0.5 }) : null;
        if (m && m.consonants >= 0.75 && m.score >= 0.6) for (const x of g) confirmed.add(x);
      }
    }
    for (const is of diff.issues) {
      if (is.kind === "extra" || confirmed.has(is)) continue;
      const u = unitAt(is.atS);
      if (is.kind === "substituted" && soundOk.has(`${u}|${norm(is.expected).replace(/s$/, "")}`)) continue;
      flag(u, `${is.kind} "${is.expected}"${is.heard ? ` heard "${is.heard}"` : ""}`);
    }
    // word error counts only what neither the transcriber nor the sound check heard
    const scriptWords = Math.max(1, asm.timed.length);
    report.wer = Math.round(((diff.issues.filter((x) => x.kind !== "extra" && !confirmed.has(x)).length) / scriptWords) * 1000) / 1000;
    if (confirmed.size) log(`  listen-back: ${confirmed.size} word(s) the transcriber missed were confirmed spoken by their sounds`);
    void diff.wer;
    report.speechIssues = diff.issues.filter((x) => x.kind !== "extra").map((x) => ({ kind: x.kind, expected: x.expected, heard: x.heard, atS: Math.round(x.atS * 10) / 10 }));
    report.pronunciation = checks;
    log(`  listen-back ${round + 1} (${heard.backend}, ${heard.seconds} s): word error ${((report.wer ?? diff.wer) * 100).toFixed(1)} %, ${checks.filter((c) => !c.ok).length}/${checks.length} risky word(s) sound wrong, ${bad.size} line(s) to redo${bad.size ? ` — ${[...bad.entries()].slice(0, 4).map(([u, w]) => `line ${u + 1}: ${w[0]}`).join("; ")}` : ""}`);
    // Keep the best take per line; a line whose retake came out worse goes back to its better take.
    let reverted = 0;
    for (let u = 0; u < units.length; u++) {
      const flags = bad.get(u)?.length ?? 0;
      const b = best.get(u);
      if (!b || flags <= b.flags) best.set(u, { take: takes[u]!, flags });
      else if (takes[u] !== b.take) {
        takes[u] = b.take;
        reverted++;
      }
    }
    if (reverted) asm = await assemble();
    if (!bad.size || round === 3) {
      report.unresolved = [...best.entries()].filter(([, b]) => b.flags > 0).map(([u, b]) => `line ${u + 1}: ${b.flags} problem(s) left${bad.get(u)?.[0] ? ` — ${bad.get(u)![0]}` : ""}`);
      break;
    }
    const redo = [...bad.keys()].filter((u) => (best.get(u)?.flags ?? 1) > 0);
    if (!redo.length) {
      report.unresolved = [];
      break;
    }
    const fresh = await pool(3, redo.map((u) => () => takeOf(u, round + 1, respellFor.get(u) ?? new Set())));
    redo.forEach((u, k) => (takes[u] = fresh[k]!));
    report.retakes += redo.length;
    asm = await assemble();
  }
  // Remember what worked, for every later film.
  for (const c of report.pronunciation) {
    const e = lex[c.word];
    if (!e) continue;
    e.checks = { ok: (e.checks?.ok ?? 0) + (c.ok ? 1 : 0), fail: (e.checks?.fail ?? 0) + (c.ok ? 0 : 1) };
    if (c.ok) e.works = c.form;
  }
  await savePronunciationLexicon(o.dataDir, { ...lexAll, ...lex });

  // 6. Pace is left as spoken.
  let timed = asm.timed;
  let durationS = asm.durationS;
  // No tempo change: the narration keeps the pace the voice spoke it at (a stretched voice sounds synthetic).
  const factor = 1 as number;
  if (factor > 1.012) {
    const rawTake = audioPath.replace(/\.mp3$/, ".untimed.mp3");
    await rename(audioPath, rawTake);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", rawTake, "-filter:a", `atempo=${factor.toFixed(5)}`, "-c:a", "libmp3lame", "-b:a", "192k", audioPath], { timeout: 300_000 });
    timed = timed.map((w) => ({ ...w, startS: w.startS / factor, endS: w.endS / factor }));
    durationS = durationS / factor;
    report.tempo = Math.round(factor * 1000) / 1000;
  }
  report.wpm = Math.round((timed.length / Math.max(1, durationS)) * 60);
  report.takes = takesMade;
  report.characters = characters;
  log(`  narration: ${durationS.toFixed(2)} s, ${report.wpm} wpm${factor > 1.012 ? ` (tempo ×${factor.toFixed(3)})` : ""}; ${takesMade} take(s), ${report.retakes} line(s) redone${report.unresolved.length ? `; UNRESOLVED: ${report.unresolved.slice(0, 3).join("; ")}` : ""}`);

  const alignmentPath = path.join(o.outDir, "narration.alignment.json");
  await writeFile(alignmentPath, JSON.stringify({ directed: true, lines: units.map((u, i) => ({ text: u.text, ...u.dir, take: takes[i]!.key })) }) + "\n");
  alignDump.length = 0;
  await writeFile(path.join(o.outDir, "narration.report.json"), JSON.stringify(report, null, 2) + "\n");

  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const claimsById = new Map(o.facts.claims.map((c) => [c.id, c]));
  let cursor = 0;
  const segments = draft.segments.map((s) => {
    const n = words(s.text).length;
    const ws = timed.slice(cursor, cursor + n);
    cursor += n;
    return {
      id: s.id,
      role: s.role,
      ...(s.chapter ? { chapter: s.chapter } : {}),
      text: s.text,
      startS: r3(ws[0]?.startS ?? 0),
      endS: r3(ws.at(-1)?.endS ?? 0),
      words: ws.map((w) => ({ word: w.word, startS: r3(w.startS), endS: r3(Math.max(w.endS, w.startS + 0.02)) })),
      claims: s.claimIds.map((id) => claimsById.get(id)).filter((c) => c !== undefined).map((c) => ({ text: c.text, sourceUrl: c.sourceUrl })),
      pronunciations: Object.fromEntries(Object.entries(lex).filter(([t]) => s.text.includes(t)).map(([t, e]) => [t, e.ipa || e.respelling || e.spoken])),
    };
  });
  for (let i = 1; i < segments.length; i++) if (segments[i]!.startS < segments[i - 1]!.endS) segments[i]!.startS = segments[i - 1]!.endS;
  const script = TimedScript.parse({ schemaVersion: 1, id: `ts_${draft.id.slice(3)}`, title: draft.title, styleProfileId: draft.styleProfileId, aspect: draft.aspect, language: "en", voice: { provider: "elevenlabs", voiceId: voice.voiceId, modelId, audioPath }, segments, durationS: r3(durationS), generatedAt: new Date().toISOString() });
  return { script, audioPath, alignmentPath, characters, report, draft };
}
