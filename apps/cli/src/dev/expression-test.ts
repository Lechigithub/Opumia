// Test the thumbnail expression finder on one job and subject (press video frames, rated by eye).
//   npx tsx apps/cli/src/dev/expression-test.ts out/<job> "Person Name" [mood]
import { readFileSync } from "node:fs";
import path from "node:path";
import { usageLedger } from "@opumia/agents";
import { FactSheet, LibraryIndex, ResolutionReport, Storyboard } from "@opumia/contracts";
import { makeThumbnailTools } from "@opumia/resolver";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const [jobArg, subject, mood] = process.argv.slice(2);
if (!jobArg || !subject) throw new Error('usage: expression-test.ts out/<job> "Person Name" [mood]');
const job = path.resolve(jobArg);
const J = (f: string) => JSON.parse(readFileSync(path.join(job, f), "utf8"));
const tools = makeThumbnailTools({ jobDir: job, dataDir: path.resolve("data"), libraryRoot: path.resolve("Library"), index: LibraryIndex.parse(JSON.parse(readFileSync("data/library-index.json", "utf8"))), resolution: ResolutionReport.parse(J("resolution.json")), facts: FactSheet.parse(J("facts.json")), board: Storyboard.parse(J("storyboard.json")) });
const t0 = Date.now();
const r = await tools.findExpression({ subject, ...(mood ? { mood } : {}) });
console.log(JSON.stringify(r, null, 1));
console.log(`${Math.round((Date.now() - t0) / 1000)} s, $${usageLedger().reduce((t, x) => t + x.usd, 0).toFixed(3)}`);
