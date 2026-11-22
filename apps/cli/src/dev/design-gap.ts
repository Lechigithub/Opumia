// Design fundamentals of a job's thumbnail renders (or any pictures) against the reference band (no model call).
//   npx tsx apps/cli/src/dev/design-gap.ts out/<job> [channel]
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { ensureQualityBand } from "@opumia/agents";
import { designIssues, measureDesign } from "@opumia/senses";
const [job, channel = "magnates-media"] = process.argv.slice(2);
if (!job) throw new Error("usage: design-gap.ts out/<job> [channel]");
const b = (await ensureQualityBand({ data: path.resolve("data"), channel, log: console.log }))?.design;
if (!b) throw new Error("no design band");
const td = path.join(job, "thumbs");
const files = existsSync(td) ? readdirSync(td).filter((f) => /^r\d+\.jpg$/.test(f)).map((f) => path.join(td, f)) : [];
const kinds: Record<string, number> = {};
let bad = 0;
for (const f of files) {
  const is = designIssues(await measureDesign(f), b.thumbs, "thumbnail");
  if (is.length) bad++;
  for (const i of is) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  console.log(`  ${path.basename(f).padEnd(8)} ${is.map((i) => i.kind).join(", ") || "inside the band"}`);
}
console.log(`${bad} of ${files.length} outside the channel's design band`, kinds);
