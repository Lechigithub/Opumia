// Publishing-package test on an existing job (no film render).
//   npx tsx apps/cli/src/dev/package-test.ts out/<job>
import { readFileSync } from "node:fs";
import path from "node:path";
import { usageLedger } from "@opumia/agents";
import { FactSheet, FilmDesignSystem, LibraryIndex, ResolutionReport, Storyboard, TimedScript } from "@opumia/contracts";
import { loadKeys } from "../keys.js";
import { buildPublishingPackage } from "../publish.js";

loadKeys(process.cwd());
const job = path.resolve(process.argv[2]!);
const J = (f: string) => JSON.parse(readFileSync(path.join(job, f), "utf8"));
const script = TimedScript.parse(J("timed-script.json"));
const t0 = Date.now();
const r = await buildPublishingPackage({ jobDir: job, data: path.resolve("data"), library: path.resolve("Library"), channel: script.styleProfileId, job: path.basename(job), facts: FactSheet.parse(J("facts.json")), script, design: FilmDesignSystem.parse(J("design.json")), resolution: ResolutionReport.parse(J("resolution.json")), board: Storyboard.parse(J("storyboard.json")), index: LibraryIndex.parse(JSON.parse(readFileSync("data/library-index.json", "utf8"))), publicDir: path.join(job, "public"), log: console.log });
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s — $${usageLedger().reduce((t, c) => t + c.usd, 0).toFixed(2)} — thumbnail ${r.thumbnailPath ?? "none"}`);
const p = J("publish.json");
console.log("\nTITLE:", p.title, "\nCANDIDATES:", p.titleCandidates.map((c: { title: string }) => c.title).join(" | "), "\nTAGS:", p.tags.join(", "), "\nHASHTAGS:", p.hashtags.join(" "), "\nPINNED:", p.pinnedComment, "\nCHECKS:", p.checks.join(" | "));
console.log("\n--- description ---\n" + readFileSync(path.join(job, "youtube-description.txt"), "utf8"));
process.exitCode = 0;
