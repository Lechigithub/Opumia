// The researcher's own score: research a fixed set of topics and record how much was verified, so a change to
// the research skill, tools or loop is kept only if the score improves. No script, no narration, no film.
//   npx tsx apps/cli/src/dev/research-score.ts "Topic one" "Topic two" …
// History: data/agents/research/score-history.json. Sheets: out/research-score/<slug>/facts.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { researchTopic, usageLedger } from "@opumia/agents";
import { usableClaims } from "@opumia/contracts";
import { closeBrowser, pageTextViaBrowser, youtubeTranscript } from "@opumia/resolver";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const data = process.env.OPUMIA_DATA_DIR ?? "data";
const memoryDir = path.join(data, "agents", "research");
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
const results: Array<{ topic: string; ok: boolean; verified: number; supported: number; quotes: number; figures: number; sources: number; scenes: number; contrasts: number; gaps: string[]; seconds: number; usd: number; error?: string }> = [];
for (const topic of process.argv.slice(2)) {
  const before = usageLedger().reduce((t, r) => t + r.usd, 0);
  const t0 = Date.now();
  console.log(`\n### ${topic}`);
  try {
    const fs = await researchTopic({ topic, format: "90-second 16:9 mini-documentary", minClaims: 12, memoryDir, browserRead: pageTextViaBrowser, videoTranscript: youtubeTranscript, log: console.log });
    const out = path.resolve("out", "research-score", slug(topic));
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "facts.json"), JSON.stringify(fs, null, 2));
    const u = usableClaims(fs);
    results.push({ topic, ok: true, verified: u.length, supported: u.filter((c) => c.verdict === "supported").length, quotes: u.filter((c) => c.kind === "quote").length, figures: u.filter((c) => c.kind === "number").length, sources: new Set(u.map((c) => new URL(c.sourceUrl).hostname)).size, scenes: fs.story?.scenes.length ?? 0, contrasts: fs.story?.contrasts.length ?? 0, gaps: fs.gaps ?? [], seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round((usageLedger().reduce((t, r) => t + r.usd, 0) - before) * 1000) / 1000 });
    for (const c of u) console.log(`  [${c.id}] (${c.kind}, ${c.verdict}) ${c.text.slice(0, 150)} — ${new URL(c.sourceUrl).hostname}`);
    if (fs.gaps?.length) console.log(`  GAPS: ${fs.gaps.join(" | ")}`);
  } catch (e) {
    results.push({ topic, ok: false, verified: 0, supported: 0, quotes: 0, figures: 0, sources: 0, scenes: 0, contrasts: 0, gaps: [], seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round((usageLedger().reduce((t, r) => t + r.usd, 0) - before) * 1000) / 1000, error: (e as Error).message.slice(0, 200) });
    console.log(`  FAILED: ${(e as Error).message.slice(0, 300)}`);
  }
}
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(); } catch { return "?"; } })();
mkdirSync(memoryDir, { recursive: true });
const hf = path.join(memoryDir, "score-history.json");
const hist = existsSync(hf) ? (JSON.parse(readFileSync(hf, "utf8")) as unknown[]) : [];
hist.push({ at: new Date().toISOString(), commit, mode: process.env.OPUMIA_RESEARCH === "legacy" ? "legacy" : "agent", results });
writeFileSync(hf, JSON.stringify(hist, null, 2) + "\n");
console.log("\nRESEARCH SCORE");
for (const r of results) console.log(`  ${r.topic.slice(0, 44).padEnd(44)} ${r.ok ? `${r.verified} verified (${r.supported} fully), ${r.quotes} quotes, ${r.figures} figures, ${r.sources} sources, ${r.scenes} scenes, ${r.contrasts} contrasts, ${r.gaps.length} gap(s)` : `FAILED ${r.error}`} | ${r.seconds} s, $${r.usd}`);
await closeBrowser();
