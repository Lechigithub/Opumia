// Audio-only test of directed narration on a cached script (no film render).
//   npx tsx apps/cli/src/dev/narrate-test.ts out/<job-with-script> [outName]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FactSheet, ScriptDraft } from "@opumia/contracts";
import { narrateDirected, resolveChannelVoice } from "@opumia/narration";
import { measurePace, measureProsody, pcm } from "@opumia/senses";
import { loadExemplars, pausesFromLevels } from "../exemplars.js";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const src = path.resolve(process.argv[2]!);
const out = path.resolve("out", process.argv[3] ?? `voice-test-${path.basename(src)}`);
const draft = ScriptDraft.parse(JSON.parse(readFileSync(path.join(src, "script.draft.json"), "utf8")));
const facts = FactSheet.parse(JSON.parse(readFileSync(path.join(src, "facts.json"), "utf8")));
const channel = draft.styleProfileId;
const ex = await loadExemplars("data", channel);
const voice = await resolveChannelVoice(channel as never, "data", console.log);
if (process.env.TEST_STABILITY) voice.settings.stability = Number(process.env.TEST_STABILITY);
if (process.env.TEST_STYLE) voice.settings.style = Number(process.env.TEST_STYLE);
if (process.env.TEST_SPEED) voice.settings.speed = Number(process.env.TEST_SPEED);
const t0 = Date.now();
const r = await narrateDirected({ draft, facts, outDir: out, dataDir: "data", channel, voice, ...(ex ? { narrator: { wpm: ex.narrator.wpm.p50, wpmLow: ex.narrator.wpm.p25 } } : {}), log: console.log });
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s — ${r.report.characters} chars billed, director $${r.report.directorUsd.toFixed(3)}`);
writeFileSync(path.join(out, "timed-script.json"), JSON.stringify(r.script, null, 2));
const words = r.script.segments.flatMap((s) => s.words.map((w) => ({ word: w.word, start: w.startS, end: w.endS })));
const pace = measurePace(words);
const pros = await measureProsody(r.audioPath);
const x = await pcm(r.audioPath, { sr: 8000 });
const db: number[] = [];
for (let i = 0; i + 800 <= x.length; i += 800) {
  let e = 0;
  for (let k = 0; k < 800; k++) e += x[i + k]! * x[i + k]!;
  db.push(10 * Math.log10(e / 800 + 1e-12));
}
const ps = pausesFromLevels(db);
{
  let g = 0;
  for (let i = 0; i + 1 < words.length; i++) if (words[i + 1]!.start - words[i]!.end >= 0.25) g++;
  console.log(`word-gap pauses >= 0.25 s: ${((g / r.script.durationS) * 60).toFixed(1)}/min (reference narrator, same definition on Whisper timings: 2.6/min, range 1.6-6)`);
}
const n = ex?.narrator;
console.log(`pace ${pace.wpm} wpm (narrator ${n?.wpm.p25}–${n?.wpm.p75}), sentence spread ${pace.sentenceWpmStd} (narrator ${n?.sentenceWpmStd})`);
console.log(`pauses ${ps.perMin}/min, median ${ps.medianS} s (narrator ${n?.pausesPerMin.p25}–${n?.pausesPerMin.p75}/min, ${n?.pauseMedianS} s)`);
console.log(`pitch travel ${pros.f0RangeSt} st (narrator >= ${n?.prosody.f0RangeSt.p25}), melody ${pros.melodySt} (>= ${n?.prosody.melodySt.p25}), dynamics ${pros.energyStdDb} dB (>= ${n?.prosody.energyStdDb.p25})`);
console.log("pronunciation:", r.report.pronunciation.map((c) => `${c.word} ${c.ok ? "ok" : "BAD"} ${c.score}${c.form === "respelling" ? " (respelled)" : ""}`).join(" | "));
