import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { directVoice, voiceAgent, type LineMeasure, type VoiceAgentReport, loadPronunciationLexicon, savePronunciationLexicon, sentencesOf, type Lexicon, type LineDirection } from "@opumia/agents";
import { TimedScript, type FactSheet, type ScriptDraft } from "@opumia/contracts";
import { asrBackend, diffSpeech, espeakIpa, measureProsody, pcm, phonemeMatch, phonemeTokens, spokenPhonemes, transcribe, type PronunciationCheck } from "@opumia/senses";
import { alignWords, tokensFromAlignment } from "./align.js";
import { remainingCharacters, ttsWithTimestamps, type CharAlignment } from "./elevenlabs.js";
import { ttsModel, type ChannelVoice } from "./voice.js";

/**
 * Directed narration: the script is spoken line by line under a voice director, then LISTENED TO and corrected.
 *
 *  1. Voice director (one model call): delivery per line (pace, pause after, emphasis) and every risky word with
 *     its correct pronunciation; pronunciations are remembered across films (data/pronunciation-lexicon.json).
 *  2. Each line is its own take (neighbouring lines passed as context, so prosody flows). Takes are cached.
 *  3. Pauses are set in code from the alignment: silence inside a line is capped, the gap between lines follows
 *     the director (most lines run on; a held beat is rare) — the reference narrator's rhythm, not a TTS default.
 *  4. Listen-back: Whisper transcribes the result and it is compared word for word with the script; the phoneme
 *     checker compares the SOUNDS of every risky word with its target pronunciation.
 *  5. Only failing lines are regenerated (new take; respelling for a word that sounded wrong), then re-checked.
 *  6. Pace is left as the voice spoke it: no speed push and no tempo change (owner decision 2026-11-22).
 */
const run = promisify(execFile);
const SR = 44100;
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
  /** B7: the listening voice director (default on; OPUMIA_VOICE_AGENT=off skips it). */
  voiceAgent?: boolean;
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
}

interface Unit { seg: number; text: string; words: string[]; dir: LineDirection }
interface Take { audio: Float32Array; words: Array<{ word: string; startS: number; endS: number }>; key: string }

const GAP = { none: 0.03, short: 0.1, beat: 0.36 } as const;
const CHAPTER_GAP = 0.6;
const MAX_INNER_PAUSE = 0.19;
const KEPT_INNER_PAUSE = 0.11;

/** The text sent to the voice: expansions always; respelling only for the terms listed; emphasis in capitals. */
function speakText(u: Unit, lex: Lexicon, respell: Set<string>): string {
  let t = u.text;
  for (const [term, e] of Object.entries(lex).sort((a, b) => b[0].length - a[0].length)) {
    if (!t.includes(term)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    if (e.spoken) t = t.replace(re, e.spoken);
    else if ((respell.has(term) || e.works === "respelling") && e.respelling) t = t.replace(re, e.respelling.toLowerCase().replace(/[^a-z' ]/g, "").replace(/^./, (c) => c.toUpperCase()));
  }
  const em = u.dir.emphasis.replace(/[^\p{L}'-]/gu, "");
  if (em.length > 2 && !Object.keys(lex).some((k) => k.includes(em))) t = t.replace(new RegExp(`\\b${em}\\b`), em.toUpperCase());
  return t;
}

/**
 * Cut a take down to speech, working from the AUDIO (not the alignment, which can be late on a line's first
 * word): only stretches that are really silent are shortened — the lead-in, the tail, and pauses inside the
 * line longer than MAX_INNER_PAUSE. Word times follow the cuts.
 */
function tighten(audio: Float32Array, ws: Array<{ word: string; startS: number; endS: number }>): { audio: Float32Array; words: typeof ws } {
  const HOP = Math.round(0.01 * SR);
  const frames = Math.floor(audio.length / HOP);
  if (frames < 10) return { audio, words: ws };
  const env = new Float32Array(frames);
  let peak = 1e-9;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let k = 0; k < HOP; k++) e += audio[f * HOP + k]! * audio[f * HOP + k]!;
    env[f] = Math.sqrt(e / HOP);
    if (env[f]! > peak) peak = env[f]!;
  }
  const quiet = peak * 0.02; // −34 dB under the take's peak
  const total = audio.length / SR;
  // Silent runs as [startS, endS].
  const runs: Array<[number, number]> = [];
  let a = -1;
  for (let f = 0; f <= frames; f++) {
    const sil = f < frames && env[f]! < quiet;
    if (sil && a < 0) a = f;
    if (!sil && a >= 0) (runs.push([a * 0.01, f * 0.01]), (a = -1));
  }
  const cuts: Array<[number, number]> = [];
  for (const [r0, r1] of runs) {
    const len = r1 - r0;
    if (r0 <= 0.001) {
      if (len > 0.04) cuts.push([0, r1 - 0.025]); // lead-in: keep 25 ms of air before the first sound
    } else if (r1 >= total - 0.011) {
      if (len > 0.09) cuts.push([r0 + 0.06, total]); // tail: keep 60 ms so the last sound decays
    } else if (len > MAX_INNER_PAUSE) {
      const remove = len - KEPT_INNER_PAUSE;
      const mid = (r0 + r1) / 2;
      cuts.push([mid - remove / 2, mid + remove / 2]);
    }
  }
  if (!cuts.length) return { audio, words: ws };
  const keep: Array<[number, number]> = [];
  let pos = 0;
  for (const [c0, c1] of cuts) {
    if (c0 > pos) keep.push([pos, c0]);
    pos = Math.max(pos, c1);
  }
  if (pos < total) keep.push([pos, total]);
  const out = new Float32Array(keep.reduce((n, [k0, k1]) => n + Math.round((k1 - k0) * SR), 0));
  let o = 0;
  const FADE = Math.round(0.003 * SR);
  for (const [k0, k1] of keep) {
    const s0 = Math.round(k0 * SR);
    const n = Math.round((k1 - k0) * SR);
    for (let i = 0; i < n && o + i < out.length; i++) out[o + i] = (audio[s0 + i] ?? 0) * Math.max(0, Math.min(1, i / FADE, (n - 1 - i) / FADE));
    o += n;
  }
  const shift = (t: number) => t - cuts.reduce((r, [c0, c1]) => r + Math.max(0, Math.min(t, c1) - c0), 0);
  return { audio: out, words: ws.map((w) => ({ word: w.word, startS: Math.max(0, shift(w.startS)), endS: Math.max(0, shift(w.endS)) })) };
}

async function writeMp3(samples: Float32Array, out: string): Promise<void> {
  const raw = `${out}.f32`;
  await writeFile(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", raw, "-c:a", "libmp3lame", "-b:a", "192k", `${out}.tmp.mp3`], { timeout: 300_000 });
  await rename(`${out}.tmp.mp3`, out);
  await import("node:fs/promises").then((fs) => fs.unlink(raw).catch(() => {}));
}

export async function narrateDirected(o: DirectedOptions): Promise<{ script: TimedScript; audioPath: string; alignmentPath: string; characters: number; report: NarrationReport }> {
  const log = o.log ?? (() => {});
  const voice = o.voice;
  const modelId = o.modelId ?? ttsModel();
  await mkdir(path.join(o.outDir, "takes"), { recursive: true });

  // Lines = sentences, kept inside their segments.
  const raw: Array<{ seg: number; text: string; role: string; chapter?: string }> = [];
  o.draft.segments.forEach((s, si) => {
    for (const t of sentencesOf(s.text)) raw.push({ seg: si, text: t, role: s.role, ...(s.chapter ? { chapter: s.chapter } : {}) });
  });

  // 1. Voice director + pronunciation lexicon.
  const lexAll = await loadPronunciationLexicon(o.dataDir);
  const scriptText = raw.map((r) => r.text).join(" ");
  const known: Lexicon = Object.fromEntries(Object.entries(lexAll).filter(([t]) => scriptText.includes(t)));
  const people = (o.facts.story?.characters ?? []).map((c) => c.name);
  const dv = await directVoice({ channel: o.channel, sentences: raw.map((r) => ({ text: r.text, role: r.role })), people, known, ...(o.narrator ? { narratorWpm: o.narrator.wpm } : {}) });
  const lex: Lexicon = { ...known, ...dv.terms };
  const units: Unit[] = raw.map((r, i) => ({ seg: r.seg, text: r.text, words: words(r.text), dir: dv.lines[i]! }));
  log(`  voice director: ${units.length} lines — ${units.filter((u) => u.dir.pace === "fast").length} fast, ${units.filter((u) => u.dir.pace === "slow").length} slow, ${units.filter((u) => u.dir.pauseAfter === "beat").length} held beat(s); ${Object.keys(lex).length} risky word(s): ${Object.keys(lex).slice(0, 14).join(", ")}${Object.keys(lex).length > 14 ? ", …" : ""}`);

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
    const text = speakText(u, lex, respell);
    const prev = units.slice(Math.max(0, i - 2), i).map((x) => x.text).join(" ").slice(-300);
    const next = units[i + 1]?.text.slice(0, 200);
    const req = { voiceId: voice.voiceId, modelId, text, speed: speedOf(u.dir.pace), stability: voice.settings.stability, similarityBoost: voice.settings.similarityBoost, style: voice.settings.style, seed: 1234 + attempt * 101 + i, ...(prev ? { previousText: prev } : {}), ...(next ? { nextText: next } : {}) };
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
  const takes = await pool(3, units.map((_, i) => () => takeOf(i, 0, new Set())));

  // 2b. B7: the voice director listens to every take (measured) and retakes lines that sound flat or wrong.
  let delivery: VoiceAgentReport | undefined;
  if (o.voiceAgent !== false && process.env.OPUMIA_VOICE_AGENT !== "off" && units.length >= 3) {
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
        seconds: Math.round(secs * 100) / 100, wpm: secs > 0 ? (t.words.length / secs) * 60 : 0,
        rangeSt: whole?.f0RangeSt ?? 0, melodySt: whole?.melodySt ?? 0, dynamicsDb: whole?.energyStdDb ?? 0,
        emphasis: k >= 0 ? { word: contour[k]![0], liftDb: Math.round((contour[k]![2] - mean(rest.map((x) => x[2]))) * 10) / 10, liftSt: Math.round((contour[k]![1] - mean(rest.map((x) => x[1]))) * 10) / 10 } : null,
        endingSt: voicedEnd?.[1] ?? 0, contour,
      };
    };
    const candidates = new Map<string, { i: number; take: Take; dir: LineDirection }>();
    let nCand = 0;
    delivery = await voiceAgent({
      channel: o.channel, title: o.draft.title,
      lines: units.map((u) => ({ text: u.text, role: raw[units.indexOf(u)]!.role, pace: u.dir.pace, emphasis: u.dir.emphasis, question: /\?\s*$/.test(u.text) })),
      narrator: o.narrator ?? null,
      measure: (i) => measureTake(i, takes[i]!),
      retake: async (i, r) => {
        const u = units[i]!;
        const keep = u.dir;
        if (r.emphasis) u.dir = { ...u.dir, emphasis: r.emphasis };
        const t = await takeOf(i, 20 + ++nCand, new Set()).finally(() => { u.dir = keep; });
        const id = `c${nCand}`;
        candidates.set(id, { i, take: t, dir: r.emphasis ? { ...keep, emphasis: r.emphasis } : keep });
        return { id, m: await measureTake(i, t) };
      },
      choose: async (i, id) => {
        const c = candidates.get(id);
        if (!c || c.i !== i) return;
        takes[i] = c.take;
        units[i]!.dir = c.dir;
      },
      memoryDir: path.join(o.dataDir, "agents", "voice"), log,
    }).catch((e: Error) => { log(`  ! voice director (listening) failed: ${e.message.slice(0, 200)} — the first takes are kept`); return undefined; });
  }

  // 3. Assemble with directed gaps.
  const audioPath = path.join(o.outDir, "narration.mp3");
  const assemble = async () => {
    const gaps = units.map((u, i) => (i === units.length - 1 ? 0.12 : raw[i + 1]!.chapter !== raw[i]!.chapter && raw[i + 1]!.chapter ? CHAPTER_GAP : GAP[u.dir.pauseAfter]));
    const total = takes.reduce((n, t, i) => n + t.audio.length + Math.round(gaps[i]! * SR), 0);
    const out = new Float32Array(total);
    const timed: Array<{ word: string; startS: number; endS: number; unit: number }> = [];
    let pos = 0;
    takes.forEach((t, i) => {
      out.set(t.audio, pos);
      for (const w of t.words) timed.push({ word: w.word, startS: w.startS + pos / SR, endS: w.endS + pos / SR, unit: i });
      pos += t.audio.length + Math.round(gaps[i]! * SR);
    });
    await writeMp3(out, audioPath);
    return { timed, durationS: total / SR };
  };
  let asm = await assemble();

  // 4–5. Listen back, check the sounds of risky words, regenerate only what failed.
  const asr = await asrBackend(o.dataDir);
  const report: NarrationReport = { lines: units.length, takes: 0, retakes: 0, characters: 0, wpm: 0, tempo: 1, asr, wer: null, speechIssues: [], pronunciation: [], unresolved: [], directorUsd: dv.usd, ...(delivery ? { delivery } : {}) };
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
    const lineSounds = new Map<number, string>();
    const soundOk = new Set<string>(); // `${unit}|${normalised word}` for words whose sounds passed
    for (const [term, e] of phonemeTerms) {
      const tw = words(term).map(norm);
      const target = e.ipa && e.ipa.trim() ? e.ipa : await espeakIpa(e.respelling || term).catch(() => "");
      if (!target) continue;
      for (let u = 0; u < units.length; u++) {
        const uw = units[u]!.words.map(norm);
        const at = uw.findIndex((_, k) => tw.every((x, q) => (uw[k + q] ?? "").replace(/s$/, "") === x.replace(/s$/, "")));
        if (at < 0) continue;
        if (!lineSounds.has(u)) {
          const ws = asm.timed.filter((w) => w.unit === u);
          lineSounds.set(u, ws.length ? await spokenPhonemes(audioPath, Math.max(0, ws[0]!.startS - 0.05), ws.at(-1)!.endS + 0.12, o.dataDir).catch(() => "") : "");
        }
        const spoken = lineSounds.get(u)!;
        if (!spoken) continue;
        // Position of the word in the line by its own aligned time in the take (film 1: by characters, "1975" — four
        // characters, but "nineteen seventy-five" spoken — sent the check for "Kodak" to the sounds of the year).
        // Character counts remain the fallback when the alignment does not cover the line word for word.
        const ws = asm.timed.filter((w) => w.unit === u);
        let frac: number;
        if (ws.length === uw.length && ws[at] && ws[at + tw.length - 1]) {
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
    for (const is of diff.issues) {
      if (is.kind === "extra") continue;
      const u = unitAt(is.atS);
      if (is.kind === "substituted" && soundOk.has(`${u}|${norm(is.expected).replace(/s$/, "")}`)) continue;
      flag(u, `${is.kind} "${is.expected}"${is.heard ? ` heard "${is.heard}"` : ""}`);
    }
    report.wer = diff.wer;
    report.speechIssues = diff.issues.filter((x) => x.kind !== "extra").map((x) => ({ kind: x.kind, expected: x.expected, heard: x.heard, atS: Math.round(x.atS * 10) / 10 }));
    report.pronunciation = checks;
    log(`  listen-back ${round + 1} (${heard.backend}, ${heard.seconds} s): word error ${(diff.wer * 100).toFixed(1)} %, ${checks.filter((c) => !c.ok).length}/${checks.length} risky word(s) sound wrong, ${bad.size} line(s) to redo${bad.size ? ` — ${[...bad.entries()].slice(0, 4).map(([u, w]) => `line ${u + 1}: ${w[0]}`).join("; ")}` : ""}`);
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
  const segments = o.draft.segments.map((s) => {
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
  const script = TimedScript.parse({ schemaVersion: 1, id: `ts_${o.draft.id.slice(3)}`, title: o.draft.title, styleProfileId: o.draft.styleProfileId, aspect: o.draft.aspect, language: "en", voice: { provider: "elevenlabs", voiceId: voice.voiceId, modelId, audioPath }, segments, durationS: r3(durationS), generatedAt: new Date().toISOString() });
  return { script, audioPath, alignmentPath, characters, report };
}
