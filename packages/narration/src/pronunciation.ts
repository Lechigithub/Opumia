import path from "node:path";
import { readJsonSafe } from "@opumia/ingest";

/** IPA lexicon from Library/wiki_ipa_cache.json (read-only). Entries with null IPA are skipped. */
export async function loadLexicon(libraryRoot: string): Promise<Record<string, string>> {
  const j = await readJsonSafe<Record<string, string | null>>(path.join(libraryRoot, "wiki_ipa_cache.json"), 0);
  if (!j.ok) return {};
  return Object.fromEntries(Object.entries(j.value).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0));
}

export interface PronunciationResult {
  text: string;
  applied: Record<string, string>;
  mode: "phoneme_tag" | "inline_ipa" | "none";
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Apply IPA rules where the TTS model supports them:
 *  - eleven_flash_v2*: SSML <phoneme alphabet="ipa" ph="…">word</phoneme>
 *  - eleven_v4: inline "/ipa/"
 *  - other models: no markup (rules recorded on the TimedScript for QA/reference only).
 */
export function applyPronunciations(text: string, lexicon: Record<string, string>, modelId: string): PronunciationResult {
  const hits: Record<string, string> = {};
  for (const [word, ipa] of Object.entries(lexicon)) {
    if (new RegExp(`\\b${esc(word)}\\b`).test(text)) hits[word] = ipa;
  }
  const mode: PronunciationResult["mode"] = /^eleven_flash_v2/.test(modelId) ? "phoneme_tag" : modelId === "eleven_v4" ? "inline_ipa" : "none";
  if (mode === "none" || !Object.keys(hits).length) return { text, applied: hits, mode: Object.keys(hits).length ? mode : "none" };
  let out = text;
  for (const [word, ipa] of Object.entries(hits)) {
    const re = new RegExp(`\\b${esc(word)}\\b`, "g");
    out = out.replace(re, mode === "phoneme_tag" ? `<phoneme alphabet="ipa" ph="${ipa}">${word}</phoneme>` : `/${ipa}/`);
  }
  return { text: out, applied: hits, mode };
}
