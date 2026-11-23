/**
 * Build list 5, item 25: every proper name is solved and checked BEFORE the first take.
 *
 * The Nokia proof film said "Elop" wrong although its listen-back passed: the voice director had guessed /ˈɛlɒp/
 * (the man says /ˈiːlɒp/, "EE-lop"), and the in-line check compares only the consonant skeleton, which both share.
 * So, for every name, place, brand and foreign word in the script:
 *  1. **The target is the subject's own pronunciation** where it exists: the IPA in the lead of its Wikipedia article
 *     (`{{IPAc-en}}` / `/…/`), read from `Library/wiki_ipa_cache.json` (read-only), our own memo
 *     `data/.cache/wiki-ipa.json`, or fetched once. It replaces the director's guess in the lexicon.
 *  2. **The voice says the name alone, in a short carrier line**, and the recogniser's sounds of that word are checked
 *     strictly: consonants ≥ 0.8, overall ≥ 0.6, AND the stressed vowel must be the target's (an isolated word is
 *     the one place this recogniser hears vowels well enough to judge).
 *  3. Forms are tried in order — as written, the director's respelling, then up to three respellings proposed for
 *     the exact target (one Haiku call for all failing names) — and the first that passes is stored as the name's
 *     verified form for this voice and model. Every later film reuses it without a take.
 * A name no form passes is returned as unsolved: the narration gate blocks on it (`unsolvedNames`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MODELS, ROLE_MODEL, plain, structured, webResearch, type Lexicon, type LexiconEntry } from "@opumia/agents";
import { espeakIpa, phonemeMatch, phonemeTokens, spokenPhonemes } from "@opumia/senses";
import * as z from "zod/v4";
import { alignWords, tokensFromAlignment } from "./align.js";
import { ttsWithTimestamps, type CharAlignment } from "./elevenlabs.js";
import type { ChannelVoice } from "./voice.js";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const NAMEISH = new Set<LexiconEntry["kind"]>(["name", "place", "brand", "foreign"]);

// ---- 1. the subject's own pronunciation (Wikipedia lead)

const VOWEL_CLASS: Array<string[]> = [["i", "ɪ", "y"], ["e", "ɛ", "eɪ", "eə"], ["æ", "a"], ["ɑ", "ɒ", "ɔ"], ["ʌ", "ə", "ɜ", "ɐ", "ɚ", "ɝ"], ["u", "ʊ"], ["oʊ", "o", "əʊ"], ["aɪ"], ["aʊ"], ["ɔɪ"], ["ø", "œ"]];
const classOf = (v: string) => VOWEL_CLASS.findIndex((c) => c.includes(v));
const isVowel = (t: string) => classOf(t) >= 0;

/** The vowel carrying the main stress (the first vowel after ˈ, else the first vowel). */
export function stressedVowel(ipa: string): string | null {
  const at = ipa.indexOf("ˈ");
  const toks = phonemeTokens(at >= 0 ? ipa.slice(at) : ipa);
  return toks.find(isVowel) ?? null;
}

/** IPA from a Wikipedia article's lead wikitext: {{IPAc-en|ˈ|iː|l|ɒ|p}}, {{IPA|/…/}} or a bare /…/. */
export function ipaFromWikitext(wt: string): string[] {
  const out: string[] = [];
  for (const m of wt.matchAll(/\{\{IPAc-en\|([^}]+)\}\}/g)) {
    const parts = m[1]!.split("|").filter((p) => !p.includes("=") && !/^(lang|pron|local|US|UK|also|ipa|audio|Canada|CA|uk|us|ca)$/i.test(p.trim()));
    // IPAc-en writes each sound as its own parameter; a label inside it ("US") was filtered above
    const s = parts.join("").replace(/\s+/g, "");
    if (s && /\p{L}/u.test(s)) out.push(s);
  }
  for (const m of wt.matchAll(/\{\{IPA(?:-[a-z]+)?\|\/?([^}|/]+)\/?/g)) out.push(m[1]!.trim());
  if (!out.length) for (const m of wt.slice(0, 3000).matchAll(/\/([ˈˌa-zɑæɒɔəɛɜɪʊʌθðʃʒŋːˑ.ɡɹ ]{3,40})\//g)) out.push(m[1]!.trim());
  return out;
}

async function readJson<T>(f: string): Promise<T | null> {
  return readFile(f, "utf8").then((t) => JSON.parse(t) as T, () => null);
}

/**
 * The subject's own IPA for a term, or null. `article` is the page to read (a person's full name for a surname).
 * The Library cache is read and never written; our memo lives in data/.cache/wiki-ipa.json.
 */
export async function ownPronunciation(o: { term: string; article: string; dataDir: string; libraryDir?: string }): Promise<string | null> {
  const lib = o.libraryDir ? await readJson<Record<string, string | null>>(path.join(o.libraryDir, "wiki_ipa_cache.json")) : null;
  if (lib && typeof lib[o.term] === "string" && lib[o.term]) return lib[o.term]!;
  const memoF = path.join(o.dataDir, ".cache", "wiki-ipa.json");
  const memo = (await readJson<Record<string, string | null>>(memoF)) ?? {};
  const key = `${o.article}|${o.term}`;
  if (key in memo) return memo[key] ?? null;
  let ipa: string | null = null;
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(o.article.replace(/ /g, "_"))}&prop=wikitext&section=0&redirects=1&format=json&formatversion=2`;
    const res = await fetch(url, { headers: { "user-agent": "opumia-narration/1.0 (pronunciation lookup)" }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const wt = ((await res.json()) as { parse?: { wikitext?: string } }).parse?.wikitext ?? "";
      const cands = ipaFromWikitext(wt);
      // the IPA that belongs to THIS term: its consonants must match the term as written (a surname's IPA in a full-name article)
      const plainIpa = await espeakIpa(o.term).catch(() => "");
      let best: { ipa: string; c: number } | null = null;
      for (const c of cands) {
        const m = phonemeMatch(c, plainIpa);
        const back = phonemeMatch(plainIpa, c);
        const fit = Math.min(m.consonants, back.consonants);
        if (fit >= 0.6 && (!best || fit > best.c)) best = { ipa: c, c: fit };
      }
      ipa = best?.ipa ?? null;
    } else if (res.status !== 404) return null; // a passing failure: not memoised
  } catch {
    return null;
  }
  // No IPA in the article (Stephen Elop's has none): how the person or place is said, found on the web — a cited
  // pronunciation guide, an interview introduction, a name dictionary. Accepted only with a source.
  if (!ipa) {
    // a failed lookup is not remembered (only a search that found no source is)
    const w = await webPronunciation(o.term, o.article).catch(() => undefined);
    if (w === undefined) return null;
    // build list 5: a web search that found nothing is NOT remembered either — the lookup's answer varies run to run
    // (Elop: found on one run in four), so a NONE must never stick for good
    if (w === null) return null;
    // proof film (WeWork): the lookup returned "/group.softbank/" for SoftBank and "Son Masayoshi" in Japanese order for
    // "Masayoshi Son" — a target the voice can never match. Only real IPA whose consonants fit the name as written (in
    // either word order) is used.
    if (!/^[\p{L}ˈˌːˑ.\s‿ʰʲʷ̩̯̃ʼ-]+$/u.test(w) || /[a-z]{5,}\.[a-z]/i.test(w) || /group|http|www/i.test(w)) return null;
    const spelt = await espeakIpa(o.term).catch(() => "");
    if (spelt) {
      const words = w.trim().split(/\s+/);
      const orders = [w, [...words].reverse().join(" ")];
      const fit = Math.max(...orders.map((x) => Math.min(phonemeMatch(x, spelt).consonants, phonemeMatch(spelt, x).consonants)));
      if (fit < 0.6) return null;
      if (words.length > 1 && orders[1] && Math.min(phonemeMatch(orders[1], spelt).consonants, phonemeMatch(spelt, orders[1]).consonants) > Math.min(phonemeMatch(w, spelt).consonants, phonemeMatch(spelt, w).consonants)) {
        ipa = orders[1];
      }
    }
    ipa = ipa ?? w;
  }
  memo[key] = ipa;
  await mkdir(path.dirname(memoF), { recursive: true });
  await writeFile(memoF + ".tmp", JSON.stringify(memo, null, 1) + "\n");
  await rename(memoF + ".tmp", memoF);
  return ipa;
}

/** One web lookup (Haiku with web search): the cited pronunciation of a name, as IPA, or null. */
export async function webPronunciation(term: string, article: string): Promise<string | null> {
  const r = await webResearch({
    stage: "voice.names.web",
    // one cheap lookup per name, ever (memoised, NONE included); Sonnet found no more than Haiku on Elop at 70× the cost
    model: MODELS.haiku,
    maxSearches: 6,
    maxFetches: 3,
    system: [plain("You find how a name is actually pronounced — by the person themselves, or as their own organisation, a pronunciation guide, a talk page or forum quoting an interview, or a broadcaster introducing them says it. Never guess from the spelling alone. A written respelling in a source (\"EE-lop\") is evidence: convert it to IPA.")],
    user: `How is "${term}" pronounced${article !== term ? ` (as in ${article})` : ""}? Search for what sources say about how it is said — pronunciation guides, the Wikipedia talk page, forums quoting an interview, news introductions. If the evidence you find points one way (even informal sources quoting how the person says it), give that pronunciation with the best source. End your answer with ONE line exactly in this form:\nPRONUNCIATION IPA=/<General American IPA with ˈ before the stressed syllable>/ SOURCE=<url>\nand only if nothing you found says how it is said:\nPRONUNCIATION NONE`,
  });
  const m = /PRONUNCIATION IPA=\/([^/\n]{2,40})\/\s+SOURCE=(\S+)/.exec(r.text);
  if (m && /^https?:\/\//.test(m[2]!)) return m[1]!.trim();
  if (/PRONUNCIATION NONE/.test(r.text)) return null;
  throw new Error("no pronunciation line in the answer");
}

// ---- 2. the voice says the name; the sounds are checked strictly

export interface NameCheck { term: string; target: string; targetSource: "director" | "sourced"; form: "plain" | "respelling"; text: string; score: number; consonants: number; vowel: boolean; heard: string; ok: boolean }

/**
 * Strict check of one word's sounds in an isolated carrier take. The stressed vowel is required only when the target
 * is SOURCED (the subject's own pronunciation): against the voice director's guess it is not — the Nokia proof film's
 * fault was exactly that, a guessed /ˈɛlɒp/ failing the voice's own correct "EE-lop" and forcing the respelling "EL-op".
 */
export function judgeName(target: string, spoken: string, o: { strictVowel?: boolean } = { strictVowel: true }): { score: number; consonants: number; vowel: boolean; ok: boolean } {
  const m = phonemeMatch(target, spoken);
  const want = stressedVowel(target);
  const heardV = phonemeTokens(spoken).filter(isVowel);
  // the stressed vowel must appear among the word's spoken vowels (the recogniser may add a reduced one around it)
  const vowel = !want || heardV.some((v) => classOf(v) === classOf(want));
  return { score: m.score, consonants: m.consonants, vowel, ok: m.consonants >= 0.8 && m.score >= 0.6 && (vowel || o.strictVowel === false) };
}

const Respellings = z.object({ names: z.array(z.object({ term: z.string(), respellings: z.array(z.string()).describe("up to three plain respellings a text-to-speech voice will read as the target sounds, hyphenated syllables, stressed syllable in capitals (e.g. EE-lop)") })) });

export interface SolveNamesResult { checks: NameCheck[]; unsolved: string[]; takes: number; characters: number; usd: number; lexicon: Lexicon }

/**
 * Solve every name-like term of the script before narration. Returns the updated lexicon (entries carry
 * `verified[voiceId|modelId]` and `works`); terms verified earlier for this voice and model cost nothing.
 */
export async function solveNames(o: { lexicon: Lexicon; scriptText: string; people: string[]; voice: ChannelVoice; modelId: string; dataDir: string; libraryDir?: string; outDir: string; log?: (s: string) => void }): Promise<SolveNamesResult> {
  const log = o.log ?? (() => {});
  const vkey = `${o.voice.voiceId}|${o.modelId}`;
  const lex: Lexicon = { ...o.lexicon };
  const dir = path.join(o.outDir, "takes", "names");
  await mkdir(dir, { recursive: true });
  const checks: NameCheck[] = [];
  let takes = 0, characters = 0, usd = 0;
  const terms = Object.entries(lex).filter(([t, e]) => NAMEISH.has(e.kind) && !e.spoken && o.scriptText.includes(t));
  // the shortest form of a name is what lines say most ("Elop" for "Stephen Elop"): solve every term, cheap
  const todo = terms.filter(([, e]) => !e.verified?.[vkey]);
  if (!todo.length) return { checks, unsolved: [], takes, characters, usd, lexicon: lex };

  // 1. the subject's own pronunciation
  for (const [term, e] of todo) {
    const article = e.kind === "name" ? (o.people.find((p) => p.includes(term)) ?? term) : term;
    const own = await ownPronunciation({ term, article, dataDir: o.dataDir, ...(o.libraryDir ? { libraryDir: o.libraryDir } : {}) }).catch(() => null);
    if (own && own.replace(/[/ ]/g, "") !== e.ipa.replace(/[/ ]/g, "")) {
      log(`    name: "${term}" — its own pronunciation /${own}/ replaces the guess /${e.ipa}/`);
      lex[term] = { ...e, ipa: own, ipaSource: "sourced" };
    } else if (own) lex[term] = { ...e, ipaSource: "sourced" };
  }

  // 2. carrier takes
  const say = async (term: string, form: "plain" | "respelling", text: string): Promise<NameCheck | null> => {
    const e = lex[term]!;
    const target = e.ipa?.trim() ? e.ipa : await espeakIpa(e.respelling || term).catch(() => "");
    if (!target) return null;
    const line = `And the name was ${text}.`;
    const req = { voiceId: o.voice.voiceId, modelId: o.modelId, text: line, speed: o.voice.settings.speed, stability: o.voice.settings.stability, similarityBoost: o.voice.settings.similarityBoost, style: o.voice.settings.style, seed: parseInt(sha(line).slice(0, 6), 16) % 100000 };
    const key = sha(JSON.stringify(req));
    const mp3 = path.join(dir, `${key}.mp3`), meta = path.join(dir, `${key}.json`);
    let al: CharAlignment;
    if (existsSync(mp3) && existsSync(meta)) al = JSON.parse(await readFile(meta, "utf8")) as CharAlignment;
    else {
      const r = await ttsWithTimestamps(req);
      takes++;
      characters += r.characters;
      await writeFile(mp3, r.audio);
      await writeFile(meta, JSON.stringify(r.alignment));
      al = r.alignment;
    }
    const ws = line.split(/\s+/);
    const aligned = alignWords(ws, tokensFromAlignment(al));
    const nameWords = text.split(/\s+/).length;
    const a = aligned[4], b = aligned[4 + nameWords - 1];
    if (!a || !b) return null;
    const heard = await spokenPhonemes(mp3, Math.max(0, a.startS - 0.06), b.endS + 0.1, o.dataDir).catch(() => "");
    const sourced = e.ipaSource === "sourced";
    const j = judgeName(target, heard, { strictVowel: sourced });
    return { term, target, targetSource: sourced ? "sourced" : "director", form, text, ...j, heard: phonemeTokens(heard).join(" ") };
  };
  const passed = new Map<string, NameCheck>();
  const bestOf = new Map<string, NameCheck>();
  const keep = (c: NameCheck | null) => {
    if (!c) return;
    checks.push(c);
    const b = bestOf.get(c.term);
    if (!b || c.score + (c.vowel ? 0.5 : 0) > b.score + (b.vowel ? 0.5 : 0)) bestOf.set(c.term, c);
    if (c.ok && !passed.has(c.term)) passed.set(c.term, c);
  };
  for (const [term] of todo) {
    const e = lex[term]!;
    keep(await say(term, "plain", term));
    if (!passed.has(term) && e.respelling) keep(await say(term, "respelling", e.respelling.toLowerCase().replace(/[^a-z' -]/g, "")));
  }
  // 3. fresh respellings for the exact target, one call for every failing name
  const failing = todo.filter(([t]) => !passed.has(t));
  if (failing.length) {
    const r = await structured({
      stage: "voice.names",
      model: ROLE_MODEL.checks,
      system: [plain("You write respellings that make an English text-to-speech voice pronounce a name exactly as its IPA says. Respell for the sounds, especially the stressed vowel (/iː/ → EE, /ɛ/ → EH, /eɪ/ → AY, /ɑː/ → AH, /oʊ/ → OH, /aɪ/ → EYE, /uː/ → OO). Hyphenate syllables; write the stressed one in capitals.")],
      user: failing.map(([t]) => { const b = bestOf.get(t); return `${t}: target /${lex[t]!.ipa}/ — the voice said ${b ? `[${b.heard}] for "${b.text}"` : "nothing usable"}`; }).join("\n"),
      schema: Respellings,
      effort: "low",
      maxTokens: 2000,
    }).catch(() => null);
    if (r) usd += r.usage.usd;
    for (const [term] of failing) {
      const alts = (r?.data.names.find((n) => n.term === term)?.respellings ?? []).slice(0, 3);
      for (const alt of alts) {
        if (passed.has(term)) break;
        keep(await say(term, "respelling", alt.toLowerCase().replace(/[^a-z' -]/g, "")));
        const p = passed.get(term);
        if (p) lex[term] = { ...lex[term]!, respelling: alt };
      }
    }
  }
  const at = new Date().toISOString();
  for (const [term] of todo) {
    const p = passed.get(term);
    if (!p) continue;
    const e = lex[term]!;
    lex[term] = { ...e, works: p.form, verified: { ...(e.verified ?? {}), [vkey]: { form: p.form, text: p.text, score: p.score, consonants: p.consonants, vowel: p.vowel, at } } };
  }
  const unsolved = todo.filter(([t]) => !passed.has(t)).map(([t]) => t);
  // a respelled form that passed is what every line says (speakText uses `works`)
  log(`  names solved before narration: ${passed.size}/${todo.length} (${takes} carrier take(s), ${characters} characters)${unsolved.length ? ` — UNSOLVED: ${unsolved.join(", ")}` : ""}`);
  return { checks, unsolved, takes, characters, usd, lexicon: lex };
}
