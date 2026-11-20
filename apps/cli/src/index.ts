#!/usr/bin/env node
import { availableParallelism } from "node:os";
import path from "node:path";
import { analyzeStyles, indexLibrary, writeReferenceStatus } from "@opumia/ingest";
import { KEYCHAIN_SERVICE, loadKeys } from "./keys.js";
import { produce, STAGES } from "./produce.js";

const ROOT = path.resolve(process.env.OPUMIA_ROOT ?? process.cwd());
const KEY_SOURCES = loadKeys(ROOT);
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
  keys                 Show which API keys are available and from where (names only, never values)
  produce             Topic → researched, narrated, rendered, QA'd film (stage outputs cached in out/<job>/)
      --topic "…"        required
      --channel ID       magnates-media | logically-answered | big-company | modern-mba | how-money-works | moon
      --aspect 9:16|16:9 (default 9:16)
      --duration S       target seconds (default 60)
      --job NAME         job folder name under out/
      --redo a,b         re-run stages: ${STAGES.join(",")}
      --until STAGE      stop after a stage
      --no-judge         skip the Sonnet visual QA judge
      --repair 'sh001=why;sh015=why'  editor override: re-pick those shots' pictures, then re-render + QA

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
    case "produce": {
      const topic = opt("topic");
      if (!topic) throw new Error("--topic is required");
      const until = opt("until");
      const { report } = await produce({
        root: ROOT, library: LIBRARY, reference: REFERENCE, data: DATA, topic,
        channel: opt("channel") ?? "magnates-media",
        aspect: (opt("aspect") ?? "9:16") as "9:16" | "16:9",
        durationS: Number(opt("duration") ?? 60),
        ...(opt("job") ? { job: opt("job")! } : {}),
        redo: (opt("redo") ?? "").split(",").filter((x): x is (typeof STAGES)[number] => (STAGES as readonly string[]).includes(x)),
        ...(until && (STAGES as readonly string[]).includes(until) ? { until: until as (typeof STAGES)[number] } : {}),
        judge: !flag("no-judge"),
        ...(opt("repair") ? { repair: new Map(opt("repair")!.split(";").map((kv) => kv.split("=")).filter((kv) => kv[0]).map(([k, ...v]) => [k!.trim(), v.join("=").trim() || "editor rejected this picture"] as [string, string])) } : {}),
        log,
      });
      if (report && report.verdict === "fail") process.exitCode = 2;
      return;
    }
    case "keys": {
      const entries = Object.entries(KEY_SOURCES);
      for (const [name, src] of entries) log(`  ${src === "missing" ? "✗" : "✓"} ${name.padEnd(24)} ${src}`);
      const n = (s: string) => entries.filter(([, v]) => v === s).length;
      log(`${entries.length} keys: keychain=${n("keychain")} file=${n("file")} env=${n("env")} missing=${n("missing")}`);
      if (n("missing")) log(`Add one in macOS Terminal: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a NAME -w`);
      return;
    }
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
