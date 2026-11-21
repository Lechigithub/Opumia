// The director's own score: direct jobs that already have a recorded narration and record whether the shot list
// was accepted, its pace against the channel and how much of its footage was confirmed in the sources.
//   npx tsx apps/cli/src/dev/director-score.ts out/<job> [out/<job> …]
// History: data/agents/director/score-history.json. Output: out/<job>/storyboard.agent.json, probes.agent.json
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FactSheet, LibraryIndex, TimedScript } from "@opumia/contracts";
import { buildStylePack, directStoryboardAgent, usageLedger, type DirectorReport } from "@opumia/agents";
import { makeFootageProbe } from "@opumia/resolver";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const roots = { reference: process.env.OPUMIA_REFERENCE_DIR ?? "Reference", data: process.env.OPUMIA_DATA_DIR ?? "data" };
const memoryDir = path.join(roots.data, "agents", "director");
const read = <T>(f: string) => JSON.parse(readFileSync(f, "utf8")) as T;
const index = LibraryIndex.parse(read(path.join(roots.data, "library-index.json")));
const results: Array<{ job: string; pass: boolean; measurements: number; seconds: number; usd: number; remaining: string[]; shots: number; cutsPerMin: number; probed: number; found: number }> = [];
for (const arg of process.argv.slice(2)) {
  const jobDir = path.resolve(arg);
  const job = read<{ channel: string }>(path.join(jobDir, "job.json"));
  const timed = TimedScript.parse(read(path.join(jobDir, "timed-script.json")));
  const facts = FactSheet.parse(read(path.join(jobDir, "facts.json")));
  const pack = await buildStylePack(job.channel as never, roots);
  let report: DirectorReport | null = null;
  const before = usageLedger().reduce((t, r) => t + r.usd, 0);
  const t0 = Date.now();
  console.log(`\n### ${path.basename(jobDir)}`);
  const { storyboard, probes } = await directStoryboardAgent({ pack, script: timed, facts, index, probe: makeFootageProbe({ jobDir, aspect: timed.aspect, era: "unspecified" }), memoryDir, onReport: (r) => (report = r), log: console.log });
  writeFileSync(path.join(jobDir, "storyboard.agent.json"), JSON.stringify(storyboard, null, 2));
  writeFileSync(path.join(jobDir, "probes.agent.json"), JSON.stringify(Object.fromEntries(probes), null, 1));
  const words = timed.segments.flatMap((s) => s.words);
  for (const sh of storyboard.shots) {
    const src = sh.source as { kind: string; designed?: string; props?: { background?: { query?: string }; brief?: string } };
    console.log(`  ${sh.id} ${(sh.endS - sh.startS).toFixed(1).padStart(4)}s ${probes.has(sh.id) ? "✓" : sh.entities?.length ? "★" : src.designed && src.designed !== "scene" ? "▣" : "·"} "${words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ").slice(0, 52)}" → ${src.designed && src.designed !== "scene" ? `[${src.designed}] ` : ""}${(src.props?.background?.query ?? "").slice(0, 46)}${sh.entities?.length ? ` {${sh.entities.map((e) => e.name).join(", ")}}` : ""}`);
  }
  const rp = report as DirectorReport | null;
  const last = rp?.rounds.at(-1);
  results.push({ job: path.basename(jobDir), pass: Boolean(rp?.pass), measurements: rp?.rounds.length ?? 0, seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round((usageLedger().reduce((t, r) => t + r.usd, 0) - before) * 1000) / 1000, remaining: rp?.remaining.map((x) => x.kind) ?? [], shots: storyboard.shots.length, cutsPerMin: last?.cutsPerMin ?? 0, probed: last?.probed ?? 0, found: last?.found ?? 0 });
  if (rp && !rp.pass) for (const x of rp.remaining) console.log(`  still: [${x.kind}] ${x.detail.slice(0, 240)}`);
}
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(); } catch { return "?"; } })();
mkdirSync(memoryDir, { recursive: true });
const hf = path.join(memoryDir, "score-history.json");
const hist = existsSync(hf) ? (JSON.parse(readFileSync(hf, "utf8")) as unknown[]) : [];
hist.push({ at: new Date().toISOString(), commit, results });
writeFileSync(hf, JSON.stringify(hist, null, 2) + "\n");
console.log("\nDIRECTOR SCORE  (✓ footage confirmed in the sources, ★ real named subject, ▣ data graphic, · unconfirmed)");
for (const r of results) console.log(`  ${r.job.padEnd(20)} ${r.pass ? "accepted" : `NOT accepted (${r.remaining.join(", ")})`} | ${r.measurements} measurement(s), ${r.seconds} s, $${r.usd} | ${r.shots} shots, ${r.cutsPerMin} cuts/min, footage confirmed ${r.found}/${r.probed} probed`);
