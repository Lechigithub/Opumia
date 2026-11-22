// The packaging agent's own score: package jobs that already have a plan (no film render) and record whether the
// package was accepted, whether the thumbnail passed the blind test among real thumbnails, what was still outside
// the channel's band, how many renders it took, time and cost.
//   npx tsx apps/cli/src/dev/package-score.ts out/<job> [out/<job> …]
// History: data/agents/packaging/score-history.json. Output per job: thumbnail.jpg, publish.json, thumbs/
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { usageLedger } from "@opumia/agents";
import { FactSheet, FilmDesignSystem, LibraryIndex, ResolutionReport, Storyboard, TimedScript } from "@opumia/contracts";
import { loadKeys } from "../keys.js";
import { buildPublishingPackage } from "../publish.js";

loadKeys(process.cwd());
const data = path.resolve(process.env.OPUMIA_DATA_DIR ?? "data");
const index = LibraryIndex.parse(JSON.parse(readFileSync(path.join(data, "library-index.json"), "utf8")));
const results: Array<{ job: string; accepted: boolean; passedBlind: boolean | null; spotted: number | null; outsideBand: string[]; renders: number; title: string; seconds: number; usd: number }> = [];
for (const arg of process.argv.slice(2)) {
  const job = path.resolve(arg);
  const J = (f: string) => JSON.parse(readFileSync(path.join(job, f), "utf8"));
  const script = TimedScript.parse(J("timed-script.json"));
  const before = usageLedger().reduce((t, r) => t + r.usd, 0);
  const t0 = Date.now();
  console.log(`\n### ${path.basename(job)}`);
  await buildPublishingPackage({ jobDir: job, data, library: path.resolve(process.env.OPUMIA_LIBRARY_DIR ?? "Library"), channel: script.styleProfileId, job: path.basename(job), facts: FactSheet.parse(J("facts.json")), script, design: FilmDesignSystem.parse(J("design.json")), resolution: ResolutionReport.parse(J("resolution.json")), board: Storyboard.parse(J("storyboard.json")), index, publicDir: path.join(job, "public"), log: console.log });
  const p = J("publish.json") as { title: string; agent?: { accepted: boolean }; thumbnail: { passedImposterTest: boolean | null; spottedConfidence: number | null; outsideBand: Array<{ kind: string }>; renders: number } | null };
  results.push({ job: path.basename(job), accepted: Boolean(p.agent?.accepted), passedBlind: p.thumbnail?.passedImposterTest ?? null, spotted: p.thumbnail?.spottedConfidence ?? null, outsideBand: p.thumbnail?.outsideBand.map((x) => x.kind) ?? [], renders: p.thumbnail?.renders ?? 0, title: p.title, seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round((usageLedger().reduce((t, r) => t + r.usd, 0) - before) * 1000) / 1000 });
}
const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  } catch {
    return "?";
  }
})();
const dir = path.join(data, "agents", "packaging");
mkdirSync(dir, { recursive: true });
const hf = path.join(dir, "score-history.json");
const hist = existsSync(hf) ? (JSON.parse(readFileSync(hf, "utf8")) as unknown[]) : [];
hist.push({ at: new Date().toISOString(), commit, profileVersion: (() => { try { return (JSON.parse(readFileSync(path.join(process.env.OPUMIA_DATA_DIR ?? "data", "channel-profile", "magnates-media.json"), "utf8")) as { version: string }).version; } catch { return null; } })(), results });
writeFileSync(hf, JSON.stringify(hist, null, 2) + "\n");
console.log("\nPACKAGING SCORE");
for (const r of results) console.log(`  ${r.job.padEnd(20)} ${r.accepted ? "accepted" : "NOT accepted"} | thumbnail ${r.passedBlind === null ? "not tested blind" : r.passedBlind ? "passed blind" : `picked out (${r.spotted?.toFixed(2)})`}${r.outsideBand.length ? `, outside band: ${r.outsideBand.join(", ")}` : ""} | ${r.renders} render(s), ${r.seconds} s, $${r.usd} | "${r.title}"`);
