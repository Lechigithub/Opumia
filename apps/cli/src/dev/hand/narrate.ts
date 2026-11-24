// Hand-made film: narration with ElevenLabs only (no Claude call). Every line gets three takes (seeds), each is
// heard back (local Whisper word error) and scored by the ears (voice humanness against real narrators); the best
// take per line is kept, trimmed on its own alignment, and the lines are joined with the written gaps.
//   OPUMIA_NO_CLAUDE=1 npx tsx apps/cli/src/dev/hand/narrate.ts out/hand-ftx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
import { TimedScript } from "@opumia/contracts";
import { resolveChannelVoice, tokensFromAlignment, alignWords, ttsModel, ttsWithTimestamps, type CharAlignment } from "@opumia/narration";
import { diffSpeech, transcribe } from "@opumia/senses";
import { loadKeys } from "../../keys.js";
import { LINES, TITLE } from "./script.js";

const root = process.cwd();
loadKeys(root);
const data = path.join(root, "data");
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const TAG = process.env.VOICE_TAG ?? "";
const takes = path.join(job, TAG ? `takes-${TAG}` : "takes");
await mkdir(takes, { recursive: true });
const SR = 44100;
const SAY: Record<string, string> = { Binance: "Bye-nance" }; // the lexicon's verified form for this voice

const base = await resolveChannelVoice("magnates-media", data, console.log);
// an audition voice (hand film only): VOICE_ID + VOICE_TAG; the platform's channel voice is not changed
const voice = process.env.VOICE_ID ? { ...base, voiceId: process.env.VOICE_ID, settings: { ...base.settings, stability: Number(process.env.VOICE_STAB ?? 0.35), style: Number(process.env.VOICE_STYLE ?? 0.4) } } : base;
const model = ttsModel();
const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

interface Take { file: string; words: Array<{ word: string; startS: number; endS: number }>; wer: number; human: number; seed: number }
const chosen: Take[] = [];
for (const [i, L] of LINES.entries()) {
  const spoken = L.text.split(/\s+/).map((w) => { const k = w.replace(/[^A-Za-z-]/g, ""); return SAY[k] ? w.replace(k, SAY[k]!) : w; }).join(" ");
  const cands: Take[] = [];
  for (const seed of (process.env.SEEDS ? process.env.SEEDS.split(",").map(Number) : TAG ? [11, 23] : [11, 23, 37])) {
    // a cached take is reused only if it was spoken from this exact text (a reused tag once served an old script)
    const old = path.join(takes, `${L.id}-s${seed}.json`);
    const sameText = (f: string) => existsSync(f) && (JSON.parse(readFileSync(f, "utf8")) as { alignment: CharAlignment }).alignment.characters.join("") === spoken;
    const raw = sameText(old) ? old : path.join(takes, `${L.id}-s${seed}-${createHash("sha1").update(spoken).digest("hex").slice(0, 8)}.json`);
    let r: { audio: string; alignment: CharAlignment };
    if (existsSync(raw)) r = JSON.parse(await readFile(raw, "utf8"));
    else {
      const t = await ttsWithTimestamps({ voiceId: voice.voiceId, modelId: model, text: spoken, ...voice.settings, seed, previousText: LINES[i - 1]?.text, nextText: LINES[i + 1]?.text });
      r = { audio: t.audio.toString("base64"), alignment: t.alignment };
      await writeFile(raw, JSON.stringify(r));
    }
    const mp3 = raw.replace(/\.json$/, ".mp3");
    if (!existsSync(mp3)) await writeFile(mp3, Buffer.from(r.audio, "base64"));
    const toks = tokensFromAlignment(r.alignment);
    const aw = alignWords(L.text.split(/\s+/), toks);
    const t0 = Math.max(0, (toks[0]?.startS ?? 0) - 0.03);
    const t1 = (toks.at(-1)?.endS ?? dur(mp3)) + 0.09;
    const wav = raw.replace(/\.json$/, ".wav");
    ff(["-i", mp3, "-ss", String(t0), "-to", String(t1), "-ar", String(SR), "-ac", "1", "-af", "afade=t=in:d=0.01,areverse,afade=t=in:d=0.03,areverse", wav]);
    const words = aw.map((w) => ({ word: w.word, startS: Math.max(0, w.startS - t0), endS: Math.max(0, w.endS - t0) }));
    const heard = await transcribe(wav, { dataDir: data });
    const wer = diffSpeech(words.map((w) => ({ word: w.word, startS: w.startS })), heard.words).wer;
    const hum = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: [{ file: wav, t: 0, dur: Math.min(6, dur(wav)) }] });
    cands.push({ file: wav, words, wer, human: hum?.scores[0] ?? 0, seed });
  }
  cands.sort((a, b) => a.wer - b.wer || b.human - a.human);
  const best = cands[0]!;
  console.log(`${L.id}: ${cands.map((c) => `s${c.seed} wer ${(c.wer * 100).toFixed(0)}% human ${c.human.toFixed(2)}`).join(" | ")} → s${best.seed}`);
  chosen.push(best);
}

// join with the written gaps
let t = 0;
const segs = [] as Array<Record<string, unknown>>;
const parts: string[] = [];
const sil = (s: number, f: string) => ff(["-f", "lavfi", "-i", `anullsrc=r=${SR}:cl=mono`, "-t", String(s), f]);
for (const [i, L] of LINES.entries()) {
  const c = chosen[i]!;
  const d = dur(c.file);
  parts.push(c.file);
  segs.push({ id: L.id, role: L.role, text: L.text, startS: t, endS: t + d, words: c.words.map((w) => ({ word: w.word, startS: +(t + w.startS).toFixed(3), endS: +(t + Math.max(w.startS, w.endS)).toFixed(3) })), claims: [], pronunciations: {} });
  t += d;
  if (L.gapAfter > 0) { const g = path.join(takes, `gap-${L.id}.wav`); sil(L.gapAfter, g); parts.push(g); t += L.gapAfter; }
}
const list = path.join(takes, "concat.txt");
await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
const out = path.join(job, TAG ? `narration-${TAG}.mp3` : "narration.mp3");
ff(["-f", "concat", "-safe", "0", "-i", list, "-c:a", "libmp3lame", "-b:a", "192k", out]);
const timed = TimedScript.parse({ schemaVersion: 1, id: path.basename(job), title: TITLE, styleProfileId: "magnates-media", aspect: "16:9", language: "en", voice: { provider: "elevenlabs", voiceId: voice.voiceId, modelId: model, audioPath: out }, segments: segs, durationS: +dur(out).toFixed(3), generatedAt: new Date().toISOString() });
await writeFile(path.join(job, TAG ? `timed-script-${TAG}.json` : "timed-script.json"), JSON.stringify(timed, null, 2));
const words = LINES.reduce((a, l) => a + l.text.split(/\s+/).length, 0);
console.log(`narration ${timed.durationS.toFixed(1)} s, ${words} words, ${(words / (timed.durationS / 60)).toFixed(0)} wpm`);
