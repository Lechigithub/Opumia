// Build list 5, items 16–17: the gate's picture reading on a finished plan (default: the Nokia proof film), against
// the channel's band (data/picture-profile/<channel>.json, built by dev/picture-band.ts).
//   npx tsx apps/cli/src/dev/picture-gate-test.ts [job] [channel]
import { readFileSync } from "node:fs";
import path from "node:path";
import { usageLedger } from "../../../../packages/agents/src/llm.js";
import { ensurePictureBand, measureFilmPictures, pictureIssues, pictureShares } from "../../../../packages/agents/src/picture-measure.js";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const job = path.join(process.cwd(), "out", process.argv[2] ?? "bl4c-nokia");
const channel = process.argv[3] ?? "magnates-media";
const band = await ensurePictureBand({ data: path.join(process.cwd(), "data"), channelId: channel });
if (!band) throw new Error("no picture band");
const topic = (JSON.parse(readFileSync(path.join(job, "job.json"), "utf8")) as { topic: string }).topic;
const rows = await measureFilmPictures({ jobDir: job, subjects: topic });
console.log(JSON.stringify(pictureShares(rows)));
const issues = pictureIssues(rows, band);
for (const i of issues) console.log(`${i.check}: ${i.measured} (band ${i.band}) — ${i.shots.join(", ")}`);
console.log(`$${usageLedger().reduce((t, x) => t + x.usd, 0).toFixed(4)}`);
// the Nokia film's idle stock (hands on a phone, a person signing at a desk) is over the channel's share
const fails = process.argv[2] ? [] : issues.some((i) => i.check === "idle_stock" || i.check === "weak_meaning") ? [] : ["the Nokia film's generic stock must be flagged (idle_stock or weak_meaning)"];
console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "PASS picture gate");
process.exit(fails.length ? 1 : 0);
