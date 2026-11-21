import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pcm, run } from "./ff.js";

/**
 * Pronunciation checker: compares the SOUNDS the voice produced for a word with the sounds it should have
 * produced. Speech recognition alone cannot do this (it "corrects" a mangled name back to its spelling).
 *
 *  - target sounds:  an IPA string from the lexicon, or espeak-ng's phonemes for a respelling ("bal-WAH-nee")
 *  - spoken sounds:  wav2vec2 phoneme recognition (facebook/wav2vec2-lv-60-espeak-cv-ft, quantised ONNX on
 *                    onnxruntime-node — CPU is enough because only the risky words are checked)
 *  - score:          1 − weighted phoneme edit distance, target matched anywhere inside the spoken clip
 *                    (so neighbouring words bleeding into the clip do not count against it)
 */
const MODEL_REPO = "onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX";
const MODEL_FILES = ["vocab.json", "config.json", "onnx/model_quantized.onnx"] as const;

type Recogniser = (audio: Float32Array) => Promise<string>;
let recogniserP: Promise<Recogniser> | null = null;

/** Fetch the model once into data/models/phoneme (318 MB quantised ONNX + vocabulary). */
async function ensureModel(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const f of MODEL_FILES) {
    const out = path.join(dir, path.basename(f));
    if (existsSync(out)) continue;
    const res = await fetch(`https://huggingface.co/${MODEL_REPO}/resolve/main/${f}`, { signal: AbortSignal.timeout(900_000) });
    if (!res.ok || !res.body) throw new Error(`phoneme model download failed (${res.status}) for ${f}`);
    await writeFile(`${out}.part`, Buffer.from(await res.arrayBuffer()));
    await rename(`${out}.part`, out);
  }
}

/** wav2vec2 CTC phoneme recogniser on onnxruntime: normalise → logits → greedy CTC decode with the vocabulary. */
async function recogniser(dataDir: string): Promise<Recogniser> {
  if (!recogniserP) {
    recogniserP = (async () => {
      const dir = path.join(dataDir, "models", "phoneme");
      await ensureModel(dir);
      const ort = await import("onnxruntime-node");
      const vocab = JSON.parse(await readFile(path.join(dir, "vocab.json"), "utf8")) as Record<string, number>;
      const byId = new Map(Object.entries(vocab).map(([k, v]) => [v, k]));
      const pad = vocab["<pad>"] ?? 0;
      const session = await ort.InferenceSession.create(path.join(dir, "model_quantized.onnx"), { graphOptimizationLevel: "all" });
      return async (audio: Float32Array) => {
        let mean = 0;
        for (let k = 0; k < audio.length; k++) mean += audio[k]!;
        mean /= audio.length;
        let v = 0;
        for (let k = 0; k < audio.length; k++) v += (audio[k]! - mean) ** 2;
        const sd = Math.sqrt(v / audio.length) + 1e-7;
        const x = new Float32Array(audio.length);
        for (let k = 0; k < audio.length; k++) x[k] = (audio[k]! - mean) / sd;
        const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", x, [1, x.length]) });
        const logits = out[session.outputNames[0]!]!;
        const [, T, V] = logits.dims as [number, number, number];
        const data = logits.data as Float32Array;
        const toks: string[] = [];
        let last = -1;
        for (let t = 0; t < T; t++) {
          let best = 0;
          let bv = -Infinity;
          for (let c = 0; c < V; c++) {
            const val = data[t * V + c]!;
            if (val > bv) (bv = val), (best = c);
          }
          if (best !== last && best !== pad) {
            const sym = byId.get(best) ?? "";
            if (sym && !/^<.*>$/.test(sym) && sym !== "|") toks.push(sym);
          }
          last = best;
        }
        return toks.join(" ");
      };
    })();
  }
  return recogniserP;
}

/** Phonemes the voice actually produced in [start, end) of an audio file (IPA symbols, space-separated). */
export async function spokenPhonemes(file: string, start: number, end: number, dataDir: string): Promise<string> {
  const pad = 0.1;
  const ss = Math.max(0, start - pad);
  const audio = await pcm(file, { ss, t: end - start + pad * 2, sr: 16000 });
  if (audio.length < 1600) return "";
  return (await recogniser(dataDir))(audio);
}

/** espeak-ng phonemes of a text in IPA (the target for a respelling, or the default reading of a word). */
export async function espeakIpa(text: string, voice = "en-us"): Promise<string> {
  // Respellings ("bal-WAH-nee") are read as lower-case syllables; capitals would be spelled out letter by letter.
  const plain = /^[A-Za-z]+(-[A-Za-z]+)+$/.test(text.trim()) ? text.toLowerCase().replace(/-/g, "") : text;
  const { stdout } = await run("espeak-ng", ["-q", "--ipa=3", "-v", voice, plain]);
  return stdout.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------------------
// Phoneme comparison

const MULTI = ["tʃ", "dʒ", "aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ", "əʊ", "ɪə", "eə", "ʊə"];
const VOWELS = new Set(["a", "e", "i", "o", "u", "ɑ", "æ", "ʌ", "ɒ", "ɔ", "ə", "ɚ", "ɝ", "ɜ", "ɛ", "ɪ", "ʊ", "ɐ", "ᵻ", "aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ", "əʊ", "ɪə", "eə", "ʊə", "y", "ø", "œ"]);
const REDUCED = new Set(["ə", "ɐ", "ᵻ", "ɪ", "ʌ", "ɚ", "ɜ", "ɝ"]);
const PAIRS: Array<[string, string]> = [["p", "b"], ["t", "d"], ["k", "g"], ["f", "v"], ["s", "z"], ["ʃ", "ʒ"], ["θ", "ð"], ["tʃ", "dʒ"], ["n", "ŋ"], ["t", "ɾ"], ["d", "ɾ"], ["ɑ", "ɒ"], ["ɑ", "ɔ"], ["ɒ", "ɔ"], ["oʊ", "əʊ"], ["i", "ɪ"], ["u", "ʊ"], ["ɛ", "e"], ["æ", "a"], ["ɑ", "a"]];
const near = new Set(PAIRS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));

/** IPA string → comparable phoneme tokens (stress, length and syllable marks removed; common variants merged). */
export function phonemeTokens(ipa: string): string[] {
  let s = ipa.normalize("NFC").replace(/[ˈˌːˑ.‿|‖/\[\]()_\-ʔ ̩ ̯ʰʲ͡]/g, "").replace(/\s+/g, "").replace(/ɹ|ɻ|ɾ̃/g, "r").replace(/ɡ/g, "g").replace(/ɫ/g, "l").replace(/ɝ|ɜr/g, "ɜ").replace(/ɚ/g, "ə").replace(/ɐ/g, "ə").replace(/ɔː/g, "ɔ").replace(/x/g, "k");
  const out: string[] = [];
  while (s.length) {
    const m = MULTI.find((x) => s.startsWith(x));
    const tok = m ?? s[0]!;
    out.push(tok);
    s = s.slice(tok.length);
  }
  return out.filter((t) => /\p{L}/u.test(t));
}

const cost = (a: string, b: string) => {
  if (a === b) return 0;
  if (near.has(`${a}|${b}`)) return 0.35;
  const va = VOWELS.has(a);
  const vb = VOWELS.has(b);
  if (va && vb) return REDUCED.has(a) || REDUCED.has(b) ? 0.3 : 0.6;
  return 1;
};

function semiGlobal(T: string[], S: string[], c: (a: string, b: string) => number): number {
  if (!T.length) return 1;
  if (!S.length) return 0;
  let prev = new Float64Array(S.length + 1); // free start anywhere in the spoken tokens
  for (let i = 1; i <= T.length; i++) {
    const cur = new Float64Array(S.length + 1);
    cur[0] = i;
    for (let j = 1; j <= S.length; j++) cur[j] = Math.min(prev[j - 1]! + c(T[i - 1]!, S[j - 1]!), prev[j]! + 1, cur[j - 1]! + 0.7);
    prev = cur;
  }
  let best = Infinity;
  for (let j = 0; j <= S.length; j++) best = Math.min(best, prev[j]!);
  return Math.max(0, 1 - best / T.length);
}

/**
 * How well the target phonemes are present in the spoken phonemes, 0..1.
 *  - `score`:      all phonemes, forgiving on vowels (the recogniser's vowels are noisy on synthetic voices)
 *  - `consonants`: the consonant skeleton only, strict — the part of a word this recogniser hears reliably.
 *                  A wrong or missing consonant, a hard g for a j, a dropped syllable all show here; a wrong
 *                  vowel or stress does not (that limit is real and reported, not hidden).
 * `around` restricts the search to the part of the clip where the word is expected (0..1 through the clip),
 * so a word cannot "pass" by matching sounds somewhere else in the line.
 */
export function phonemeMatch(targetIpa: string, spokenIpa: string, around?: { frac: number }): { score: number; consonants: number; target: string; spoken: string } {
  const T = phonemeTokens(targetIpa);
  let S = phonemeTokens(spokenIpa);
  if (around && S.length > T.length * 3) {
    const half = Math.max(8, Math.round(T.length * 1.8));
    const c = Math.round(Math.max(0, Math.min(1, around.frac)) * S.length);
    S = S.slice(Math.max(0, c - half), Math.min(S.length, c + half));
  }
  const cons = (xs: string[]) => xs.filter((x) => !VOWELS.has(x));
  // A word-final r is silent in many accents: it is not required of the speaker.
  const consT = (() => {
    const c = cons(T);
    return c.length > 2 && c.at(-1) === "r" && T.at(-1) === "r" ? c.slice(0, -1) : c;
  })();
  const strict = (a: string, b: string) => (a === b ? 0 : near.has(`${a}|${b}`) ? 0.5 : 1);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { score: r(semiGlobal(T, S, cost)), consonants: r(semiGlobal(consT, cons(S), strict)), target: T.join(" "), spoken: S.join(" ") };
}

export interface PronunciationCheck { word: string; score: number; consonants?: number; target: string; spoken: string; ok: boolean }

/** Check one spoken word against its target pronunciation (IPA, or a respelling read by espeak-ng). */
export async function checkPronunciation(o: { file: string; start: number; end: number; word: string; ipa?: string; respelling?: string; dataDir: string; voice?: string; threshold?: number }): Promise<PronunciationCheck> {
  const target = o.ipa && o.ipa.trim() ? o.ipa : await espeakIpa(o.respelling ?? o.word, o.voice);
  const spoken = await spokenPhonemes(o.file, o.start, o.end, o.dataDir);
  const m = phonemeMatch(target, spoken);
  // Short words give the recogniser little to hold on to: a looser bar for targets of five phonemes or fewer.
  const bar = o.threshold ?? (phonemeTokens(target).length <= 5 ? 0.5 : 0.66);
  return { word: o.word, score: m.score, consonants: m.consonants, target: m.target, spoken: m.spoken, ok: m.score >= 0.55 && m.consonants >= 0.8 };
}
