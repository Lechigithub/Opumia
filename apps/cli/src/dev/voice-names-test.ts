// Build list 5, item 25, live: the names of a script are solved before narration — the subject's own pronunciation
// as the target and a strict check (consonants AND the stressed vowel) of the voice saying each name alone.
// The Nokia proof film's "Elop" (guessed /ˈɛlɒp/; the man says /ˈiːlɒp/) must pass. Costs a few cents of speech.
//   npx tsx apps/cli/src/dev/voice-names-test.ts [Name …]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Lexicon } from "@opumia/agents";
import { resolveChannelVoice, solveNames, ttsModel } from "@opumia/narration";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const extra = process.argv.slice(2);
const lexicon: Lexicon = {
  Elop: { kind: "name", ipa: "ˈɛlɒp", respelling: "EL-op", spoken: "" },
  ...Object.fromEntries(extra.map((n) => [n, { kind: "name" as const, ipa: "", respelling: "", spoken: "" }])),
};
const voice = await resolveChannelVoice("magnates-media", "data", console.log);
const out = mkdtempSync(path.join(tmpdir(), "names-"));
const r = await solveNames({ lexicon, scriptText: `Stephen Elop wrote the memo. ${extra.join(" ")}`, people: ["Stephen Elop"], voice, modelId: ttsModel(), dataDir: "data", libraryDir: "Library", outDir: out, log: console.log });
for (const c of r.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.term} as "${c.text}" (${c.form}) target /${c.target}/ (${c.targetSource}) heard [${c.heard}] consonants ${c.consonants} score ${c.score} vowel ${c.vowel}`);
const e = r.lexicon.Elop!;
console.log(`Elop → target /${e.ipa}/ (${e.ipaSource ?? "director"}), verified ${JSON.stringify(e.verified)}; ${r.takes} take(s), ${r.characters} chars, $${r.usd.toFixed(4)} Claude`);
// Wikipedia's article on Elop carries no IPA; the web lookup found the long vowel (/ˈiːlɑp/) on one run in four and
// NONE on the others (memoised either way). Sourced: the passing form must carry the long vowel. Unsourced: the voice's
// own plain reading must be kept — not a respelling built on the director's guessed /ˈɛlɒp/ (the Nokia fault).
const v = Object.values(e.verified ?? {})[0];
const pass = !r.unsolved.includes("Elop") && (e.ipaSource === "sourced" ? /i/.test(e.ipa) : v?.form === "plain");
console.log(pass ? "PASS names" : "FAIL names");
process.exit(pass ? 0 : 1);
