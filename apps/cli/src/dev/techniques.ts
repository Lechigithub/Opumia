// The craft inventory: discover the channel's techniques, rate them on real stretches, map them to our tools, and
// (with a job) measure a film's coverage.
//   npx tsx apps/cli/src/dev/techniques.ts [--channel magnates-media] [out/<job> …] [--fresh]
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { manifestEvents, discoverTechniques, ensureTechniqueBand, mapTechniquesToTools, techniqueCoverage, usageLedger } from "@opumia/agents";
import { loadKeys } from "../keys.js";

const root = process.cwd();
loadKeys(root);
const data = path.join(root, "data");
const reference = process.env.OPUMIA_REFERENCE_DIR ?? path.join(root, "Reference");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const channel = (arg("--channel") ?? "magnates-media") as never;
const fresh = process.argv.includes("--fresh");
const tax = await discoverTechniques({ data, reference, channel, fresh, log: console.log });
console.log(`taxonomy: ${tax.length} techniques`);
const band = await ensureTechniqueBand({ data, reference, channel, taxonomy: tax, fresh, log: console.log });
const tools = await mapTechniquesToTools({ data, channel, taxonomy: tax, fresh });
console.log(`\nTHE CHANNEL'S TECHNIQUES (${band.stretches} real stretches) — per minute, share of stretches, can we make it:`);
for (const b of band.techniques) {
  const t = tax.find((x) => x.id === b.id)!;
  const m = tools.find((x) => x.id === b.id);
  console.log(`${b.perMin.toFixed(2).padStart(6)}/min ${String(Math.round(b.share * 100)).padStart(3)}%  ${(m?.status ?? "?").padEnd(9)} ${t.category.padEnd(9)} ${t.name}${m?.gap ? `  — ${m.gap.slice(0, 110)}` : ""}`);
}
for (const job of process.argv.slice(2).filter((a) => a.startsWith("out/"))) {
  const video = readdirSync(job).find((f) => /_(16x9|9x16)\.mp4$/.test(f));
  if (!video) continue;
  const ts = existsSync(path.join(job, "timed-script.json")) ? (JSON.parse(await readFile(path.join(job, "timed-script.json"), "utf8")) as { segments: Array<{ words: Array<{ word: string; startS: number }> }> }) : null;
  const words = ts?.segments.flatMap((s) => s.words) ?? [];
  const cov = await techniqueCoverage({ data, reference, channel, video: path.join(job, video), workDir: path.join(job, "techniques"), taxonomy: tax, band, tools, said: (a, b) => words.filter((w) => w.startS >= a && w.startS < b).map((w) => w.word).join(" "), ...(existsSync(path.join(job, "manifest.json")) ? { events: manifestEvents(JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"))) } : {}) });
  await writeFile(path.join(job, "techniques.json"), JSON.stringify({ at: new Date().toISOString(), rows: cov }, null, 1) + "\n");
  console.log(`\n${path.basename(job)}: ${cov.filter((r) => r.verdict === "missing_tool").length} missing tools, ${cov.filter((r) => r.verdict === "unused").length} unused, ${cov.filter((r) => r.verdict === "overused").length} overused`);
  for (const r of cov.filter((x) => x.verdict !== "ok" && x.verdict !== "rare").slice(0, 40)) console.log(`  ${r.verdict.padEnd(12)} ${r.name} — channel ${r.channelPerMin}/min, ours ${r.oursPerMin}/min (${r.owner})`);
}
console.log(`\n$${usageLedger().reduce((a, x) => a + x.usd, 0).toFixed(3)}`);
