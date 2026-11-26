#!/usr/bin/env node
import { availableParallelism } from "node:os";
import path from "node:path";
import { analyzeStyles, buildReferenceIndex, indexLibrary, writeReferenceStatus } from "@opumia/ingest";
import { KEYCHAIN_SERVICE, loadKeys } from "./keys.js";
import { cmdEval } from "./eval.js";
import { buildExemplars } from "./exemplars.js";
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

  film-agent           One agent makes the whole film in out/<job>/ (paid; --topic, --duration, --max-usd, --dry-run)
  index-library        Index Library/ → data/library-index.json (incremental ffprobe, read-only)
      --no-probe         skip ffprobe (stats + metadata only)
      --concurrency N    parallel ffprobe processes (default: min(8, cores))
  inspect-reference    Check done*.txt vs disk per channel → data/reference-status.json
  analyze-styles       Draft StyleProfiles → data/style-profiles/<channel>.json
  all                  index-library + inspect-reference + analyze-styles
  escalations          Recurring escalations (a check that needed a stronger fix in 2+ films): platform fixes to make
      --fixed 'stage|check'  mark one fixed (after its platform fix and regression case are in)
  resume <job>         Continue a paused or stopped job from its cached stages (same topic, channel, aspect, duration)
  keys                 Show which API keys are available and from where (names only, never values)
  produce             Topic → researched, narrated, rendered, QA'd film (stage outputs cached in out/<job>/)
      --topic "…"        required
      --channel ID       magnates-media | logically-answered | big-company | modern-mba | how-money-works | moon
      --aspect 9:16|16:9 (default 9:16)
      --duration S       target seconds (default 60)
      --job NAME         job folder name under out/
      --redo a,b         re-run stages: ${STAGES.join(",")}
      --until STAGE      stop after a stage
      --repair 'sh001=why;sh015=why'  editor override: re-pick those shots' pictures, then re-render + QA
  profile-audio        Measure every usable sound effect and music bed → data/audio-profile.json (incremental)
  build-exemplars      Reference exemplar library the agents look at → data/exemplars/<channel>/
  build-channel-profile  Unified, versioned channel profile from the reference index → data/channel-profile/<channel>.json
  build-reference-index  Every reference shot + thumbnail with labels and SigLIP 2 embeddings → data/reference-index/ (--no-embed)
      --channel ID       frames of labelled shots, thumbnails, per-film looks, narrator voice profile, technique clips
  eval                 Blind reference test of the platform → data/eval/
      calibrate --channel ID   check the judge on degraded reference windows (cached per judge version)
      score out/<job> …        score finished films against the real channel
      run --set core           produce every film in eval/sets/<set>.json, then score and report
          --only a,b  --concurrency N  --no-produce

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
        ...(opt("repair") ? { repair: new Map(opt("repair")!.split(";").map((kv) => kv.split("=")).filter((kv) => kv[0]).map(([k, ...v]) => [k!.trim(), v.join("=").trim() || "editor rejected this picture"] as [string, string])) } : {}),
        log,
      });
      if (report && report.verdict === "fail") process.exitCode = 2;
      return;
    }
    case "resume": {
      // build list 3, part D: continue a paused (or stopped) job from its cached stages, with the options it was started with
      const job = (rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined) ?? opt("job");
      if (!job) throw new Error("usage: opumia resume <job>");
      const { readFile } = await import("node:fs/promises");
      const j = JSON.parse(await readFile(path.join(ROOT, "out", job, "job.json"), "utf8")) as { topic: string; channel: string; aspect: "9:16" | "16:9"; durationS: number };
      const p = await readFile(path.join(ROOT, "out", job, "paused.json"), "utf8").then((t) => JSON.parse(t) as { stage?: string; provider?: string; kind?: string }, () => null);
      log(`Resuming ${job}${p ? ` (paused at ${p.stage ?? "?"}: ${p.provider} ${p.kind})` : ""}`);
      const { report } = await produce({ root: ROOT, library: LIBRARY, reference: REFERENCE, data: DATA, topic: j.topic, channel: j.channel, aspect: j.aspect, durationS: j.durationS, job, redo: [], log });
      if (report && report.verdict === "fail") process.exitCode = 2;
      return;
    }
    case "film-agent": {
      // one agent with a workspace makes the whole film (apps/cli/src/film-agent/): a paid run — start only with the owner's approval
      const { runFilmAgent } = await import("./film-agent/run.js");
      const topic = opt("topic");
      const name = opt("job") ?? (topic ? `agent-${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}` : undefined);
      if (!name) throw new Error("usage: opumia film-agent --topic \"…\" [--job NAME] [--duration 70] [--max-usd 9] [--dry-run]");
      const r = await runFilmAgent({ root: ROOT, ...(topic ? { topic } : {}), job: path.join(ROOT, "out", name), channel: opt("channel") ?? "magnates-media", durationS: Number(opt("duration") ?? 70), maxUsd: Number(opt("max-usd") ?? process.env.OPUMIA_MAX_USD ?? 9), model: opt("model") ?? "claude-sonnet-5-5", dryRun: flag("dry-run"), log });
      if (!r.pass && !flag("dry-run")) process.exitCode = 2;
      return;
    }
    case "escalations": {
      // item 30: recurring escalations (a check that needed a stronger fix in two or more films) — the platform fixes to make
      const { analyseEscalations, markEscalationFixed } = await import("@opumia/agents");
      const fixed = opt("fixed");
      if (fixed) return log((await markEscalationFixed(DATA, fixed)) ? `marked fixed: ${fixed}` : `no recurring escalation ${fixed}`);
      const list = await analyseEscalations({ data: DATA, channel: opt("channel") ?? "magnates-media" });
      if (!list.length) return log("no recurring escalations");
      for (const r of list) log(`  ${r.status === "open" ? "✗" : "✓"} ${r.key.padEnd(34)} ${r.films.length} films, rungs: ${r.rungs.join(" → ")}, $${r.usd}${r.status === "fixed" ? ` (fixed ${r.fixedAt?.slice(0, 10)})` : ""}`);
      return log("Mark one fixed once its platform fix and regression case are in: pnpm opumia escalations --fixed '<stage|check>'");
    }
    case "keys": {
      const entries = Object.entries(KEY_SOURCES);
      for (const [name, src] of entries) log(`  ${src === "missing" ? "✗" : "✓"} ${name.padEnd(24)} ${src}`);
      const n = (s: string) => entries.filter(([, v]) => v === s).length;
      log(`${entries.length} keys: keychain=${n("keychain")} file=${n("file")} env=${n("env")} missing=${n("missing")}`);
      if (n("missing")) log(`Add one in macOS Terminal: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a NAME -w`);
      return;
    }
    case "profile-audio": {
      const { LibraryIndex } = await import("@opumia/contracts");
      const { readFile } = await import("node:fs/promises");
      const { buildAudioProfile } = await import("./audio-profile.js");
      await buildAudioProfile({ data: DATA, library: LIBRARY, index: LibraryIndex.parse(JSON.parse(await readFile(path.join(DATA, "library-index.json"), "utf8"))), log });
      return;
    }
    case "build-reference-index": {
      const m = await buildReferenceIndex({ root: ROOT, reference: REFERENCE, data: DATA, embed: !flag("no-embed"), log });
      log(`${m.films.length} films · ${m.shots} shots (${m.embedded.shots} embedded) · ${m.thumbs} thumbnails (${m.embedded.thumbs} embedded) → ${rel(path.join(DATA, "reference-index"))}/`);
      return;
    }
    case "build-channel-profile": {
      const { buildChannelProfile } = await import("@opumia/agents");
      await buildChannelProfile({ data: DATA, channel: (opt("channel") ?? "magnates-media") as never, log });
      return;
    }
    case "build-exemplars":
      await buildExemplars({ root: ROOT, library: LIBRARY, reference: REFERENCE, data: DATA, log }, opt("channel") ?? "magnates-media", Number(opt("films") ?? 99));
      return;
    case "eval":
      return cmdEval({ root: ROOT, library: LIBRARY, reference: REFERENCE, data: DATA, log }, rest);
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
  // 3 = paused by a failure outside the platform (resumable with `opumia resume <job>`), 1 = an error
  process.exitCode = (err as { name?: string; resumeAt?: string })?.resumeAt ? 3 : 1;
}).finally(() => {
  // Build list 4: a run always ends. A headless browser or socket left open (bl4-theranos sat 1 h 24 min after its
  // error) must not keep the process alive: once the command is done, exit with its code after a short grace.
  setTimeout(() => process.exit(), 5000).unref();
});
