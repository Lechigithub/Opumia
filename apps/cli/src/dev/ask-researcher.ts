// Ask the researcher for specific facts, the way the writer does (quick mode: find, verify, finish).
//   npx tsx apps/cli/src/dev/ask-researcher.ts "Film topic" "Fact one?" ["Fact two?" …]
import { researchAgent, usageLedger } from "@opumia/agents";
import { closeBrowser, pageTextViaBrowser, youtubeTranscript } from "@opumia/resolver";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const [topic, ...questions] = process.argv.slice(2);
if (!topic || !questions.length) throw new Error('usage: ask-researcher.ts "Film topic" "Fact?" …');
const t0 = Date.now();
const r = await researchAgent({ topic, format: "", want: 0, questions, idStart: 0, browserRead: pageTextViaBrowser, videoTranscript: youtubeTranscript, log: () => {} });
for (const c of r.claims) console.log(`[${c.id}] (${c.verdict}) ${c.text} — ${new URL(c.sourceUrl).hostname}`);
console.log(`gaps: ${JSON.stringify(r.gaps)} | ${r.agent.turns} turns, ${r.agent.pagesRead} page(s) read, ${Math.round((Date.now() - t0) / 1000)} s, $${usageLedger().reduce((t, x) => t + x.usd, 0).toFixed(3)}`);
await closeBrowser();
