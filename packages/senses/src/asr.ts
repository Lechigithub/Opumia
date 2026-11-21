import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./ff.js";

/**
 * Speech recognition (Whisper) behind one interface, two backends:
 *  - local:      whisper.cpp (`whisper-cli`, Homebrew) with a ggml model in data/models/ — development and
 *                single-machine production; free.
 *  - cloudflare: Workers AI `@cf/openai/whisper-large-v3-turbo` over the REST API (CLOUDFLARE_ACCOUNT_ID +
 *                CLOUDFLARE_AI_TOKEN) — production; serverless, nothing to install in the container.
 * Same model family on both, so results match. Select with OPUMIA_ASR=local|cloudflare (default: local when
 * the binary and model exist, else cloudflare when credentials exist).
 */
export interface AsrWord { word: string; start: number; end: number }
export interface Transcript { text: string; words: AsrWord[]; backend: "local" | "cloudflare"; seconds: number }

const LOCAL_MODELS = ["ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.bin", "ggml-medium.en-q5_0.bin", "ggml-small.en.bin"];
function localModel(dataDir: string): string | null {
  if (process.env.OPUMIA_WHISPER_MODEL && existsSync(process.env.OPUMIA_WHISPER_MODEL)) return process.env.OPUMIA_WHISPER_MODEL;
  for (const m of LOCAL_MODELS) if (existsSync(path.join(dataDir, "models", m))) return path.join(dataDir, "models", m);
  return null;
}
async function hasBinary(): Promise<boolean> {
  return run("whisper-cli", ["--help"]).then(() => true, (e: { code?: string }) => e.code !== "ENOENT");
}

export async function asrBackend(dataDir: string): Promise<"local" | "cloudflare" | null> {
  const want = process.env.OPUMIA_ASR;
  const local = Boolean(localModel(dataDir)) && (await hasBinary());
  const cf = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN);
  if (want === "local") return local ? "local" : null;
  if (want === "cloudflare") return cf ? "cloudflare" : null;
  return local ? "local" : cf ? "cloudflare" : null;
}

/** Names and rare terms the recogniser should expect (improves spelling of proper nouns). */
export interface TranscribeOptions { dataDir: string; prompt?: string; language?: string }

export async function transcribe(file: string, o: TranscribeOptions): Promise<Transcript> {
  const backend = await asrBackend(o.dataDir);
  if (!backend) throw new Error("no speech recogniser available: install whisper-cpp + a model in data/models/, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN");
  const t0 = Date.now();
  const r = backend === "local" ? await transcribeLocal(file, o) : await transcribeCloudflare(file, o);
  return { ...r, backend, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

async function toWav(file: string, dir: string): Promise<string> {
  const wav = path.join(dir, "in.wav");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ar", "16000", "-ac", "1", wav]);
  return wav;
}

async function transcribeLocal(file: string, o: TranscribeOptions): Promise<{ text: string; words: AsrWord[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opumia-asr-"));
  try {
    const wav = await toWav(file, dir);
    const out = path.join(dir, "out");
    // -ml 1 -sow: one word per segment, split on word boundaries → word timestamps.
    await run("whisper-cli", ["-m", localModel(o.dataDir)!, "-f", wav, "-l", o.language ?? "en", "-ml", "1", "-sow", "-oj", "-of", out, "-np", ...(o.prompt ? ["--prompt", o.prompt.slice(0, 800)] : [])], { maxBuffer: 64 << 20, timeout: 600_000 });
    const j = JSON.parse(await readFile(`${out}.json`, "utf8")) as { transcription: Array<{ text: string; offsets: { from: number; to: number } }> };
    const words = j.transcription.map((t) => ({ word: t.text.trim(), start: t.offsets.from / 1000, end: t.offsets.to / 1000 })).filter((w) => w.word && !/^\[.*\]$/.test(w.word));
    return { text: words.map((w) => w.word).join(" "), words };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribeCloudflare(file: string, o: TranscribeOptions): Promise<{ text: string; words: AsrWord[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opumia-asr-"));
  try {
    // Compact mono MP3 keeps the request small; Workers AI takes base64 audio for whisper-large-v3-turbo.
    const mp3 = path.join(dir, "in.mp3");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ar", "16000", "-ac", "1", "-b:a", "48k", mp3]);
    const audio = (await readFile(mp3)).toString("base64");
    const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo`;
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ audio, language: o.language ?? "en", ...(o.prompt ? { initial_prompt: o.prompt.slice(0, 800) } : {}) }), signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`Workers AI whisper ${res.status}`);
    const j = (await res.json()) as { result?: { text?: string; segments?: Array<{ words?: Array<{ word: string; start: number; end: number }> }>; words?: Array<{ word: string; start: number; end: number }> } };
    const words = (j.result?.words ?? j.result?.segments?.flatMap((s) => s.words ?? []) ?? []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.word);
    return { text: j.result?.text?.trim() ?? words.map((w) => w.word).join(" "), words };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Script vs speech: which words were skipped, swapped or misread.

export interface SpeechDiff {
  /** Word error rate against the script (0 = every word heard as written). */
  wer: number;
  issues: Array<{ kind: "missing" | "substituted" | "extra"; scriptIndex: number; expected: string; heard: string; atS: number }>;
}

const NUM: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", first: "1st", second: "2nd", third: "3rd" };
/** Comparable form of a word: lower-case, no punctuation, number words as digits, symbols spelled the same way. */
export const normWord = (w: string) => {
  const x = w.toLowerCase().replace(/[’']s\b/g, "s").replace(/[^\p{L}\p{N}$%€£.]/gu, "").replace(/\.$/, "").replace(/,/g, "");
  return NUM[x] ?? x;
};
/** Script words expanded the way they are spoken ("$9" → "9 dollars"), so figures compare fairly. */
function spokenForms(w: string): string[] {
  const m = /^([$€£])?(\d[\d,.]*)(%|[a-z]+)?$/i.exec(w.replace(/[^\p{L}\p{N}$%€£.,]/gu, "").replace(/[.,]$/, ""));
  if (!m) return [normWord(w)];
  const n = m[2]!.replace(/,/g, "").replace(/\.$/, "");
  return [n, ...(m[1] === "$" ? ["dollars"] : m[1] === "€" ? ["euros"] : m[1] === "£" ? ["pounds"] : []), ...(m[3] === "%" ? ["percent"] : m[3] ? [m[3].toLowerCase()] : [])].filter(Boolean);
}

/** Align script words to heard words (edit distance) and list what differs. Figures and unit words are lenient. */
export function diffSpeech(script: Array<{ word: string; startS: number }>, heard: AsrWord[]): SpeechDiff {
  // Hyphenated compounds are heard as separate words; dotted abbreviations lose their dots.
  const split = <T extends { word: string }>(ws: T[]) => ws.flatMap((w) => w.word.split(/[-–—/]/).filter(Boolean).map((part) => ({ ...w, word: part })));
  const B = split(heard).map((w) => ({ n: normWord(w.word).replace(/\./g, ""), raw: w.word, t: w.start })).filter((w) => w.n);
  // A compound the recogniser writes as one word ("Film-less" heard as "filmless") is compared as one word.
  const heardSet = new Set(B.map((w) => w.n));
  const joined = (w: string) => normWord(w.replace(/[-–—/]/g, "")).replace(/\./g, "");
  const A = script
    .flatMap((w) => (/[-–—/]/.test(w.word) && heardSet.has(joined(w.word)) ? [{ ...w, word: w.word.replace(/[-–—/]/g, "") }] : split([w])))
    .map((w) => ({ n: normWord(w.word).replace(/\./g, ""), forms: spokenForms(w.word), raw: w.word, t: w.startS }))
    .filter((w) => w.n);
  // Same word in another spelling (Shultz/Schultz, Walgreen/Walgreens, Aug/August): close enough for the
  // recogniser — whether it SOUNDS right is the phoneme checker's job.
  const close = (x: string, y: string) => {
    if (x.length < 3 || y.length < 3) return false;
    if (x.startsWith(y) || y.startsWith(x)) return Math.abs(x.length - y.length) <= 3;
    const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array<number>(y.length).fill(0)]);
    for (let j = 0; j <= y.length; j++) d[0]![j] = j;
    for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i]![j] = Math.min(d[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1), d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
    return d[x.length]![y.length]! <= (Math.max(x.length, y.length) >= 7 ? 2 : 1);
  };
  const eq = (a: (typeof A)[number], b: (typeof B)[number]) => a.n === b.n || a.forms.includes(b.n) || close(a.n, b.n) || (/\d/.test(a.n) && /\d/.test(b.n) && a.n.replace(/[^\d]/g, "") === b.n.replace(/[^\d]/g, ""));
  const n = A.length;
  const m = B.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i]![0] = i;
  for (let j = 0; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j - 1]! + (eq(A[i - 1]!, B[j - 1]!) ? 0 : 1), d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
  const issues: SpeechDiff["issues"] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (eq(A[i - 1]!, B[j - 1]!) ? 0 : 1)) {
      if (!eq(A[i - 1]!, B[j - 1]!)) issues.push({ kind: "substituted", scriptIndex: i - 1, expected: A[i - 1]!.raw, heard: B[j - 1]!.raw, atS: A[i - 1]!.t });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      issues.push({ kind: "missing", scriptIndex: i - 1, expected: A[i - 1]!.raw, heard: "", atS: A[i - 1]!.t });
      i--;
    } else {
      issues.push({ kind: "extra", scriptIndex: Math.max(0, i - 1), expected: "", heard: B[j - 1]!.raw, atS: B[j - 1]!.t });
      j--;
    }
  }
  issues.reverse();
  // A spoken figure expands into several heard words ("$9 billion" → "nine billion dollars"): drop the extras
  // that are just the unit words of an adjacent figure.
  const filtered = issues.filter((x) => !(x.kind === "extra" && /^(dollars?|percent|euros?|pounds?|point|and|a|the)$/i.test(normWord(x.heard))));
  return { wer: n ? Math.round((filtered.length / n) * 1000) / 1000 : 0, issues: filtered };
}
