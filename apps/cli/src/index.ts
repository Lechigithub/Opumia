#!/usr/bin/env node
import { availableParallelism } from "node:os";
import path from "node:path";
import { analyzeStyles, indexLibrary, writeReferenceStatus } from "@opumia/ingest";

const ROOT = path.resolve(process.env.OPUMIA_ROOT ?? process.cwd());
const env = (k: string, d: string) => path.resolve(ROOT, process.env[k] ?? d);
const LIBRARY = env("OPUMIA_LIBRARY_DIR", "Library");
const REFERENCE = env("OPUMIA_REFERENCE_DIR", "Reference");
const DATA = env("OPUMIA_DATA_DIR", "data");

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const log = (s: string) => console.log(s);
const rel = (p: string) => path.relative(ROOT, p);
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

const HELP = `opumia <command>

  index-library        Index Library/ → data/library-index.json (incremental ffprobe, read-only)
      --no-probe         skip ffprobe (stats + metadata only)
      --concurrency N    parallel ffprobe processes (default: min(8, cores))
  inspect-reference    Check done*.txt vs disk per channel → data/reference-status.json
  analyze-styles       Draft StyleProfiles → data/style-profiles/<channel>.json
  all                  index-library + inspect-reference + analyze-styles

Library/ and Reference/ are never written to.`;

async function cmdIndex() {
  const t0 = Date.now();
  log(`Indexing ${rel(LIBRARY)}/ (read-only)…`);
  const { index, outPath, write, run } = await indexLibrary({
    libraryRoot: LIBRARY,
    dataDir: DATA,
    probe: !flag("no-probe"),
    concurrency: Number(opt("concurrency") ?? Math.min(8, availableParallelism())),
    log,
  });
  const s = index.stats;
  log(`\n${s.assets} assets, ${gb(s.totalBytes)} → ${rel(outPath)} (${write})`);
  log(`  by category: ${Object.entries(s.byCategory).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  log(`  probed=${s.probed} (fresh ${run.freshProbes}, cached ${run.cacheHits}) errors=${s.probeErrors} licensed=${s.withLicense} generatedAudio=${s.generatedAudio}`);
  for (const rc of index.remoteCatalogs) log(`  remote ${rc.relPath}: ${rc.items} items, ${rc.cachedThumbs} thumbs${rc.readError ? ` (${rc.readError})` : ""}`);
  if (index.caches.bugspot) log(`  bugspot cache: ${index.caches.bugspot.matched}/${index.caches.bugspot.entries} matched`);
  if (index.caches.wikiIpa) log(`  ipa lexicon: ${index.caches.wikiIpa.withIpa}/${index.caches.wikiIpa.entries} with IPA`);
  log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

async function cmdInspect() {
  const { status, outPath, write } = await writeReferenceStatus(REFERENCE, DATA);
  log(`Reference corpus → ${rel(outPath)} (${write})`);
  log(`  ${"channel".padEnd(20)} ${"done-file".padEnd(30)} listed  disk  both  missing  undone  foreign  complete`);
  for (const [id, c] of Object.entries(status.channels)) {
    log(
      `  ${id.padEnd(20)} ${(c.doneFile ?? "-").padEnd(30)} ${String(c.doneIds).padStart(6)} ${String(c.onDisk).padStart(5)} ${String(c.doneAndOnDisk).padStart(5)} ${String(c.missingOnDisk.length).padStart(8)} ${String(c.notInDoneFile.length).padStart(7)} ${String(c.foreignIds.length).padStart(8)}  ${c.complete ? "yes" : "NO"}`,
    );
  }
  for (const d of status.doneFiles) log(`  ${d.file}: ${d.ids} ids → ${Object.entries(d.channels).map(([k, v]) => `${k}:${v}`).join(", ")}`);
}

async function cmdAnalyze() {
  log(`Analyzing reference styles…`);
  const { results } = await analyzeStyles({ referenceRoot: REFERENCE, libraryRoot: LIBRARY, dataDir: DATA, log });
  log(`${results.length} draft profiles → ${rel(path.join(DATA, "style-profiles"))}/`);
}

async function main() {
  switch (cmd) {
    case "index-library":
      return cmdIndex();
    case "inspect-reference":
      return cmdInspect();
    case "analyze-styles":
      return cmdAnalyze();
    case "all":
      await cmdIndex();
      await cmdInspect();
      return cmdAnalyze();
    default:
      log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
