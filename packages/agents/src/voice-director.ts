import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

/**
 * Voice director: reads the script before it is spoken and returns (1) how each line should be delivered
 * (pace, the pause after it, the word to lean on) and (2) every word a synthetic voice is likely to get wrong —
 * names, places, brands, foreign words, acronyms, abbreviations, figures — with its correct pronunciation.
 *
 * Pronunciations are remembered across films in data/pronunciation-lexicon.json: a name is solved once.
 */
export interface LexiconEntry {
  kind: "name" | "place" | "brand" | "foreign" | "acronym" | "abbreviation" | "figure" | "rare";
  /** IPA (General American) of the correct pronunciation; empty for figures/abbreviations. */
  ipa: string;
  /** Plain respelling that makes a voice say it right ("bal-WAH-nee"); used only if the plain spelling fails the check. */
  respelling: string;
  /** How to write it for the voice when it must always be expanded ("Aug" → "August", "CMS" → "C M S"); empty = as written. */
  spoken: string;
  /** Which form passed the phoneme check last time: "plain" or "respelling". */
  works?: "plain" | "respelling";
  checks?: { ok: number; fail: number };
  /** Build list 5, item 25: where the target pronunciation came from (the person's or place's own, from Wikipedia, beats the director's guess). */
  ipaSource?: "director" | "sourced";
  /** Build list 5, item 25: the form that passed the name check before narration, per voice and model (`voiceId|modelId`). */
  verified?: Record<string, { form: "plain" | "respelling"; text: string; score: number; consonants: number; vowel: boolean; at: string }>;
}
export type Lexicon = Record<string, LexiconEntry>;

const file = (dataDir: string) => path.join(dataDir, "pronunciation-lexicon.json");
export async function loadPronunciationLexicon(dataDir: string): Promise<Lexicon> {
  try {
    return JSON.parse(await readFile(file(dataDir), "utf8")) as Lexicon;
  } catch {
    return {};
  }
}
export async function savePronunciationLexicon(dataDir: string, lex: Lexicon): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(lex).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(`${file(dataDir)}.tmp`, JSON.stringify(sorted, null, 1) + "\n");
  await rename(`${file(dataDir)}.tmp`, file(dataDir));
}

export interface LineDirection { pace: "slow" | "normal" | "fast"; pauseAfter: "none" | "short" | "beat"; emphasis: string }
export interface VoiceDirection { lines: LineDirection[]; terms: Lexicon; usd: number }

const Out = z.object({
  lines: z.array(z.object({ index: z.number(), pace: z.enum(["slow", "normal", "fast"]), pauseAfter: z.enum(["none", "short", "beat"]), emphasis: z.string().describe("the one word of this line the narrator leans on, or empty") })),
  terms: z.array(
    z.object({
      term: z.string().describe("exactly as written in the script"),
      kind: z.enum(["name", "place", "brand", "foreign", "acronym", "abbreviation", "figure", "rare"]),
      ipa: z.string().describe("IPA, General American, of the correct pronunciation (empty for figures/abbreviations)"),
      respelling: z.string().describe('plain lower-case respelling with hyphens and the stressed syllable in capitals, e.g. "bal-WAH-nee" (empty for figures/abbreviations)'),
      spoken: z.string().describe("only when it must be rewritten for the voice (an abbreviation or symbol the voice would misread): the words to speak; else empty"),
    }),
  ),
});

export async function directVoice(o: { channel: string; sentences: Array<{ text: string; role: string }>; people: string[]; known: Lexicon; narratorWpm?: number }): Promise<VoiceDirection> {
  const knownTerms = Object.keys(o.known);
  const { data, usage } = await structured({
    stage: "voice.direct",
    model: MODELS.sonnet,
    system: [
      plain(`You are the voice director for the YouTube documentary channel ${o.channel}. The narration will be spoken by a synthetic voice, one line at a time. The real channel's narrator is alive: energy and emphasis change from line to line, and a real pause is saved for a turn or a reveal. The voice speaks every line at its own natural pace — it is never sped up or slowed down — so your pace note shapes the breathing room around a line, not the speed of the voice.

1. DELIVERY, for every line (index from the list): pace = "fast" for momentum, lists and build-up; "normal" for explanation; "slow" only for a reveal, a verdict or a line that must land. pauseAfter = "none" when the next line continues the same thought (most lines); "short" at the end of a thought; "beat" only before a turn or after a reveal (at most one line in six). emphasis = the single word the narrator leans on, or empty.

2. PRONUNCIATION: list EVERY word or phrase a synthetic voice could misread — people's names, company and product names, places, foreign words, acronyms (say whether letters are spelled out), abbreviations ("Aug", "Inc.", "vs"), unusual figures and symbols, technical or rare words (drug names, chemicals, legal terms). Give the correct pronunciation as IPA and as a respelling. Use the pronunciation the person or company uses themselves. Do not list ordinary English words. "spoken" is only for abbreviations, acronyms and symbols that must be written out for the voice.${knownTerms.length ? ` Already solved in earlier films (do not repeat): ${knownTerms.slice(0, 200).join(", ")}.` : ""}`),
    ],
    user: `PEOPLE IN THE STORY: ${o.people.join(", ") || "—"}\n\nLINES:\n${o.sentences.map((s, i) => `[${i}] (${s.role}) ${s.text}`).join("\n")}`,
    schema: Out,
    effort: "low",
    maxTokens: 12000,
  });
  const lines: LineDirection[] = o.sentences.map((_, i) => {
    const d = data.lines.find((x) => x.index === i);
    return d ? { pace: d.pace, pauseAfter: d.pauseAfter, emphasis: d.emphasis.trim() } : { pace: "normal", pauseAfter: "none", emphasis: "" };
  });
  // Beats are rare by rule: keep at most one in six, the latest ones winning ties toward turns.
  const beats = lines.map((l, i) => ({ l, i })).filter((x) => x.l.pauseAfter === "beat");
  const maxBeats = Math.max(1, Math.floor(lines.length / 6));
  for (const x of beats.slice(maxBeats)) x.l.pauseAfter = "short";
  const text = o.sentences.map((s) => s.text).join(" ");
  const terms: Lexicon = {};
  for (const t of data.terms) {
    const term = t.term.trim();
    if (!term || term.length > 60 || o.known[term] || !text.includes(term)) continue;
    terms[term] = { kind: t.kind, ipa: t.ipa.replace(/^\/|\/$/g, "").trim(), respelling: t.respelling.trim(), spoken: t.spoken.trim() };
  }
  return { lines, terms, usd: usage.usd };
}
