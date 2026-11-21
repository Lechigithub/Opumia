// The writer's own score: run the writer on a fixed set of topics (jobs with cached facts) and record the result,
// so a change to the writer's skill, tools or loop is kept only if the score improves. No narration, no film.
//   npx tsx apps/cli/src/dev/writer-score.ts out/<job> [out/<job> …]
// History: data/agents/writer/score-history.json. Scripts: out/writer-score/<job>/script.draft.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FactSheet } from "@opumia/contracts";
import { buildStylePack, ensureReferenceFilms, ensureStoryBand, usageLedger, writeScript, type StoryReport } from "@opumia/agents";
import { resolveChannelVoice, storedVoiceMeasure, ttsModel } from "@opumia/narration";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const roots = { reference: process.env.OPUMIA_REFERENCE_DIR ?? "Reference", data: process.env.OPUMIA_DATA_DIR ?? "data" };
const memoryDir = path.join(roots.data, "agents", "writer");
const results: Array<{ job: string; topic: string; pass: boolean; measurements: number; seconds: number; usd: number; remaining: string[]; explain: number; viewer: number; quote: number; fact: number; opening: string; beats: number }> = [];
const earlier: Array<{ hook: string; ending: string; spine: string; beats?: string[] }> = [];
for (const arg of process.argv.slice(2)) {
  const src = path.resolve(arg);
  const job = JSON.parse(readFileSync(path.join(src, "job.json"), "utf8")) as { channel: string; aspect: "16:9" | "9:16"; durationS: number };
  const facts = FactSheet.parse(JSON.parse(readFileSync(path.join(src, "facts.json"), "utf8")));
  const pack = await buildStylePack(job.channel as never, roots);
  const storyBand = await ensureStoryBand({ ...roots, channelId: job.channel, log: console.log });
  const films = await ensureReferenceFilms({ ...roots, channelId: job.channel });
  const voice = await resolveChannelVoice(job.channel as never, roots.data);
  const wpm = Math.round((await storedVoiceMeasure(roots.data, voice.voiceId, ttsModel()))?.wpm ?? 150);
  let report: StoryReport | null = null;
  const before = usageLedger().reduce((t, r) => t + r.usd, 0);
  const t0 = Date.now();
  console.log(`\n### ${path.basename(src)} — ${facts.topic}`);
  // Each script in the set is shown the shapes of the ones written before it, as in production.
  const draft = await writeScript({ pack, facts, aspect: job.aspect, durationS: job.durationS <= 90 ? job.durationS - 3 : job.durationS, narrationWpm: wpm, recent: earlier, storyBand, films, memoryDir, onStory: (r) => (report = r), log: console.log });
  const out = path.resolve("out", "writer-score", path.basename(src));
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "script.draft.json"), JSON.stringify(draft, null, 2));
  const rp = report as StoryReport | null;
  const p = rp?.rounds.at(-1)?.profile;
  if (draft.blueprint) earlier.push({ hook: draft.blueprint.hook, ending: draft.blueprint.ending, spine: draft.blueprint.spine, ...(draft.blueprint.beats ? { beats: draft.blueprint.beats } : {}) });
  results.push({ job: path.basename(src), topic: facts.topic, pass: Boolean(rp?.pass), measurements: rp?.rounds.length ?? 0, seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round((usageLedger().reduce((t, r) => t + r.usd, 0) - before) * 1000) / 1000, remaining: rp?.remaining.map((x) => x.kind) ?? [], explain: p?.share.explain ?? 0, viewer: p?.viewerShare ?? 0, quote: p?.share.quote ?? 0, fact: p?.share.fact ?? 0, opening: draft.blueprint?.opening ?? "", beats: draft.blueprint?.beats?.length ?? 0 });
  console.log(`\n=== ${draft.title} (${draft.wordCount} words) ===\n${draft.segments.map((s) => `[${s.role}] ${s.text}`).join("\n")}`);
}
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(); } catch { return "?"; } })();
const skill = readFileSync("packages/agents/skills/writer.md", "utf8");
const entry = { at: new Date().toISOString(), commit, skillChars: skill.length, passed: results.filter((r) => r.pass).length, of: results.length, usd: Math.round(results.reduce((t, r) => t + r.usd, 0) * 1000) / 1000, results };
mkdirSync(memoryDir, { recursive: true });
const hf = path.join(memoryDir, "score-history.json");
const hist = existsSync(hf) ? (JSON.parse(readFileSync(hf, "utf8")) as unknown[]) : [];
hist.push(entry);
writeFileSync(hf, JSON.stringify(hist, null, 2) + "\n");
console.log(`\nWRITER SCORE: ${entry.passed}/${entry.of} accepted — $${entry.usd}`);
for (const r of results) console.log(`  ${r.job.padEnd(20)} ${r.pass ? "accepted" : `NOT accepted (${r.remaining.join(", ")})`} | ${r.measurements} measurement(s), ${r.seconds} s, $${r.usd} | explains ${Math.round(r.explain * 100)}% viewer ${Math.round(r.viewer * 100)}% quotes ${Math.round(r.quote * 100)}% facts ${Math.round(r.fact * 100)}% | ${r.beats} turns`);
