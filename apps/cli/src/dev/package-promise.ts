// Build list 5, items 29–30: the title-promise band of a channel's real titles, and a film's title against it.
//   npx tsx apps/cli/src/dev/package-promise.ts [channel] [out/<job>] [--fresh]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensureTitlePromiseBand, labelTitlePromises, usageLedger } from "@opumia/agents";
import { loadKeys } from "../keys.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
loadKeys(ROOT);
const channel = process.argv[2] ?? "magnates-media";
const job = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
const data = path.join(ROOT, "data");
const ex = JSON.parse(await readFile(path.join(data, "exemplars", channel, "index.json"), "utf8")) as { packaging?: Array<{ title: string; views: number | null }> };
const band = await ensureTitlePromiseBand({ data, channel, references: ex.packaging ?? [], fresh: process.argv.includes("--fresh") });
if (!band) throw new Error("no band: too few real titles");
console.log(`${band.n} real titles: ${JSON.stringify(band.share)}; promising ${band.promising}; topic titles allowed: ${band.topicAllowed}`);
for (const p of ["person", "turn", "person_and_turn", "topic"] as const) console.log(`  ${p}: ${band.items.filter((x) => x.promise === p).slice(0, 5).map((x) => x.title).join(" | ")}`);
if (job) {
  const pub = JSON.parse(await readFile(path.join(ROOT, job, "publish.json"), "utf8")) as { title: string };
  const { labels } = await labelTitlePromises([pub.title]);
  console.log(`ours "${pub.title}": ${labels[0]}`);
}
console.log(`spent $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
