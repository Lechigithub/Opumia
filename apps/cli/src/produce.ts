import { copyFile, readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { ChannelId, FilmDesignSystem, LicenseOverrides, ScenePlan, FactSheet, LibraryIndex, RenderManifest, ResolutionReport, ScriptDraft, Storyboard, TimedScript, type Aspect } from "@opumia/contracts";
import { setBudget, artDirect, closest, fingerprintOf, habitsOf, loadFingerprints, saveFingerprint, critiqueScenes, designScenes, designSoundTimeline, isUsable, recentTreatments, recordTreatment, type SceneExemplar, blockAsset, blockedRefs, badQueries, buildStylePack, chapterCount, directStoryboard, gateReview, loadMemory, recentBlueprints, recordBlueprint, researchTopic, thumbnailBrief, thumbnailStyle, updateMemory, usageLedger, writeScript } from "@opumia/agents";
import { ensureVoiceMeasured, storedVoiceMeasure, ttsModel as currentTtsModel, calibrationKey, narrate, narrateDirected, readCalibration, resolveChannelVoice, writeCalibration } from "@opumia/narration";
import { repairShots, resolveAssets, resolveAudio } from "@opumia/resolver";
import { buildAudioProfile } from "./audio-profile.js";
import { cooldownRefs, eraOfFacts, recordUsage } from "./asset-usage.js";
import { buildPublishingPackage } from "./publish.js";
import { loadExemplars } from "./exemplars.js";
import { dropPictures, preflightChecks, pruneEmptyFrames, referenceHueDominance, safeScene, type PreflightCheck } from "./preflight.js";
import { type BuildManifestOptions, youtubeDescription, buildManifest, captionGroups, higgsfieldConfig, higgsfieldImage, lookFromProfile, masterAudio, muxFinal, pickGateFrames, renderGateStills, renderShotPreviews, renderLocalThumbnail, renderThumbnailStill, renderVideo, runQA, toSrt } from "@opumia/motion-engine";

export const STAGES = ["research", "script", "narration", "storyboard", "resolve", "manifest", "render", "thumbnail", "qa"] as const;
type Stage = (typeof STAGES)[number];

export interface ProduceOptions {
  root: string;
  library: string;
  reference: string;
  data: string;
  topic: string;
  channel: string;
  aspect: Aspect;
  durationS: number;
  job?: string;
  redo: Stage[];
  until?: Stage;
  judge: boolean;
  /** Editor overrides: shotId → why the current picture must be replaced. */
  repair?: Map<string, string>;
  log: (s: string) => void;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const exists = async (p: string) => Boolean(await stat(p).catch(() => null));

async function cachedJson<T>(file: string, schema: ZodType<T, ZodTypeDef, unknown>, redo: boolean, make: () => Promise<T>, log: (s: string) => void): Promise<T> {
  if (!redo && (await exists(file))) {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (parsed.success) {
      log(`  ✓ ${path.basename(file)} (cached)`);
      return parsed.data;
    }
    log(`  ! ${path.basename(file)} failed validation; rebuilding`);
  }
  const v = schema.parse(await make());
  await writeFile(file, JSON.stringify(v, null, 2) + "\n");
  return v;
}

/** Claude spend each stage should stay within on a 90-second film (scaled up for longer films). Over it, the run says so. */
const STAGE_BUDGET_USD: Record<string, number> = { A1: 0.45, A2: 0.4, A3: 0.08, B1: 0.3, B2: 0.12, B3: 0.45, B4: 0.3, B5: 0.02, B6: 0.15, C1: 0.02, C2: 0.05, C3: 0.3, C4: 0.2 };

export async function produce(o: ProduceOptions) {
  const jobId = o.job ?? `${slug(o.topic)}-${ChannelId.parse(o.channel)}-${o.aspect.replace(":", "x")}`;
  const jobDir = path.join(o.root, "out", jobId);
  const before = usageLedger().length;
  // Stage clock: every "[XX] name" header in the log opens a stage; its seconds and Claude spend are recorded,
  // compared with the stage's budget and written to timing.json. A film-level limit stops further model calls.
  const k = Math.max(1, o.durationS / 90) ** 0.7;
  const filmLimit = Number(process.env.OPUMIA_MAX_USD) || (o.durationS <= 90 ? 3 : o.durationS <= 240 ? 6 : 15);
  setBudget(filmLimit);
  const stages: Array<{ stage: string; seconds: number; usd: number; budgetUsd: number | null; over: boolean }> = [];
  let open: { stage: string; t: number; n: number } | null = null;
  const closeStage = () => {
    if (!open) return;
    const cur = open;
    open = null;
    const usd = Math.round(usageLedger().slice(cur.n).reduce((t, r) => t + r.usd, 0) * 1e4) / 1e4;
    const code = /^\[([A-Z]\d)/.exec(cur.stage)?.[1] ?? "";
    const b = STAGE_BUDGET_USD[code];
    const budgetUsd = b === undefined ? null : Math.round(b * k * 100) / 100;
    const over = budgetUsd !== null && usd > budgetUsd;
    stages.push({ stage: cur.stage, seconds: Math.round((Date.now() - cur.t) / 100) / 10, usd, budgetUsd, over });
    if (over) o.log(`  ! ${cur.stage.split("]")[0]}] spent $${usd.toFixed(2)}, over its budget of $${budgetUsd!.toFixed(2)}`);
  };
  const baseLog = o.log;
  const log = (line: string) => {
    if (line.startsWith("\n[")) {
      closeStage();
      open = { stage: line.trim(), t: Date.now(), n: usageLedger().length };
    }
    baseLog(line);
  };
  try {
    return await produceStages({ ...o, job: jobId, log });
  } finally {
    closeStage();
    setBudget(null);
    if (stages.length) {
      const tf = path.join(jobDir, "timing.json");
      const prevT = (await exists(tf)) ? (JSON.parse(await readFile(tf, "utf8")) as { runs: unknown[] }) : { runs: [] };
      prevT.runs.push({ at: new Date().toISOString(), filmLimitUsd: filmLimit, seconds: Math.round(stages.reduce((t, x) => t + x.seconds, 0)), usd: Math.round(stages.reduce((t, x) => t + x.usd, 0) * 1e4) / 1e4, stages });
      await writeFile(tf, JSON.stringify(prevT, null, 2) + "\n").catch(() => {});
      baseLog(`\nWhere the time and money went:\n${stages.filter((x) => x.seconds >= 1 || x.usd > 0).map((x) => `  ${x.stage.slice(0, 44).padEnd(44)} ${x.seconds.toFixed(0).padStart(5)} s  $${x.usd.toFixed(3)}${x.over ? "  OVER BUDGET" : ""}`).join("\n")}`);
    }
    // Every run is logged, including runs stopped early with --until or by an error.
    const calls = usageLedger().slice(before);
    if (calls.length) {
      const file = path.join(jobDir, "usage.json");
      const prev = (await exists(file)) ? (JSON.parse(await readFile(file, "utf8")) as { runs: unknown[] }) : { runs: [] };
      prev.runs.push({ at: new Date().toISOString(), calls, usd: Math.round(calls.reduce((t, r) => t + r.usd, 0) * 1e4) / 1e4 });
      await writeFile(file, JSON.stringify(prev, null, 2) + "\n");
    }
  }
}

async function produceStages(o: ProduceOptions) {
  const channel = ChannelId.parse(o.channel);
  const jobId = o.job ?? `${slug(o.topic)}-${channel}-${o.aspect.replace(":", "x")}`;
  const jobDir = path.join(o.root, "out", jobId);
  const pub = path.join(jobDir, "public");
  await mkdir(pub, { recursive: true });
  const log = o.log;
  const redo = (s: Stage) => o.redo.includes(s);
  const stop = (s: Stage) => o.until === s;
  const t0 = Date.now();
  log(`Job ${jobId}\n  dir: ${path.relative(o.root, jobDir)}`);
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify({ topic: o.topic, channel, aspect: o.aspect, durationS: o.durationS }, null, 2) + "\n");

  const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(o.data, "library-index.json"), "utf8")));
  const pack = await buildStylePack(channel, { reference: o.reference, data: o.data });
  log(`  style pack: ${pack.text.length.toLocaleString()} chars from ${pack.sources.length} sources`);
  const short = o.durationS <= 90;

  // ---- Stage A: research → script → narration
  log("\n[A1] research & fact-check");
  const facts = await cachedJson(path.join(jobDir, "facts.json"), FactSheet, redo("research"), () => researchTopic({ topic: o.topic, format: short ? `${o.durationS}-second ${o.aspect === "9:16" ? "vertical short" : "16:9 mini-documentary"}` : "long-form documentary", minClaims: short ? 10 : Math.min(40, Math.round(12 + o.durationS / 12)), log }), log);
  // Art direction: a unique FilmDesignSystem for this film (palette, type, texture, per-act grades, scene grammar).
  log("\n[A1b] art direction (runs alongside the script)");
  // Uniqueness: what the recent films did, so every planning stage can do something else.
  const recentFps = (await loadFingerprints(o.data)).filter((f) => f.job !== jobId).slice(-6);
  const habits = habitsOf(recentFps);
  // Art direction and the script need only the facts, so they run side by side; the design is awaited after the script.
  const designP = cachedJson(path.join(jobDir, "design.json"), FilmDesignSystem, redo("research"), async () => artDirect({ facts, pack, acts: short ? 1 : chapterCount(o.durationS), recent: (await recentTreatments(o.data)).filter((r) => r.job !== jobId), log }), log).then(async (design) => {
  if (design.treatment) await recordTreatment(o.data, { job: jobId, channel, headline: design.treatment.headline, phrase: design.treatment.phrase, world: design.treatment.world, particles: design.treatment.particles, photo: design.treatment.photo, label: design.treatment.label, display: design.typography.display, primary: design.palette.primary, accent: design.palette.accent, transition: design.treatment.transition });
  log(`  art direction: "${design.concept}" — ${design.palette.primary} / ${design.palette.accent} on ${design.palette.surface}, ${design.typography.display}`);
    return design;
  });
  designP.catch(() => {}); // any failure surfaces where the design is awaited
  const memory = await loadMemory(o.data);
  if (stop("research")) {
    await designP;
    return { jobDir };
  }

  log("\n[A2] script");
  const voice = await resolveChannelVoice(channel, o.data, log);
  const ttsModel = currentTtsModel();
  const calKey = calibrationKey(voice, ttsModel);
  const calFile = await readCalibration(o.data);
  const cal = calFile as Record<string, { wpm: number; samples: number } | undefined>;
  // Words per minute this voice actually speaks (measured on earlier narrations); conservative default until calibrated.
  const ovPath = path.join(o.data, "license-overrides.json");
  const overrides = (await exists(ovPath)) ? LicenseOverrides.parse(JSON.parse(await readFile(ovPath, "utf8"))) : null;
  const maxWpm = overrides?.channels[channel]?.maxWpm ?? Infinity;
  // The script is cut to the pace this voice naturally speaks at, never the reference narrator's pace. A voice
  // the platform has not met is measured now, once (a short standard passage), before any script is written.
  const scriptCached = (await exists(path.join(jobDir, "script.draft.json"))) && !redo("script");
  const narratorRef = await readFile(path.join(o.data, "exemplars", channel, "index.json"), "utf8").then((t) => (JSON.parse(t) as { narrator?: { prosody?: { melodySt?: { p25: number }; f0RangeSt?: { p25: number } } } }).narrator?.prosody, () => undefined);
  const natural = (await storedVoiceMeasure(o.data, voice.voiceId, ttsModel)) ?? (scriptCached ? null : await ensureVoiceMeasured({ dataDir: o.data, voice, modelId: ttsModel, ...(narratorRef?.melodySt && narratorRef.f0RangeSt ? { reference: { melodySt: narratorRef.melodySt.p25, pitchTravelSt: narratorRef.f0RangeSt.p25 } } : {}), log }));
  const narrationWpm = Math.round(Math.min(cal[calKey]?.wpm ?? natural?.wpm ?? 145, maxWpm));
  const narrationTargetS = short ? o.durationS - 3 : o.durationS;
  let draft = await cachedJson(path.join(jobDir, "script.draft.json"), ScriptDraft, redo("script"), () => writeScript({ pack, facts, recentOpenings: habits.openings, aspect: o.aspect, durationS: narrationTargetS, narrationWpm, recent: recentBlueprints(memory, channel), log }), log);
  log(`  "${draft.title}" — ${draft.wordCount} words at ${narrationWpm} wpm (${cal[calKey] ? "calibrated" : "default"}), hook: ${draft.hookFormula.slice(0, 80)}`);
  if (draft.blueprint) await updateMemory(o.data, (m) => recordBlueprint(m, channel, { job: jobId, hook: draft.blueprint!.hook, ending: draft.blueprint!.ending, spine: draft.blueprint!.spine }));
  const design = await designP;
  if (stop("script")) return { jobDir };

  log("\n[A3] narration (ElevenLabs)");
  const timedPath = path.join(jobDir, "timed-script.json");
  let fresh = false;
  const doNarrate = async () => {
    fresh = true;
    if (process.env.OPUMIA_NARRATION === "legacy") return (await narrate({ draft, facts, outDir: jobDir, libraryRoot: o.library, voice, modelId: ttsModel, log })).script;
    // Directed narration: voice director → line takes → listen-back (Whisper + sound check) → retakes.
    const nar = await readFile(path.join(o.data, "exemplars", channel, "index.json"), "utf8").then((t) => (JSON.parse(t) as { narrator?: { wpm: { p25: number; p50: number } } }).narrator, () => undefined);
    const res = await narrateDirected({ draft, facts, outDir: jobDir, dataDir: o.data, channel, voice, modelId: ttsModel, ...(nar ? { narrator: { wpm: nar.wpm.p50, wpmLow: nar.wpm.p25 } } : {}), log });
    if (res.report.unresolved.length) log(`  ! narration has ${res.report.unresolved.length} unresolved line(s): ${res.report.unresolved.slice(0, 3).join("; ")}`);
    return res.script;
  };
  let timed = await cachedJson(timedPath, TimedScript, redo("narration") || redo("script"), doNarrate, log);
  const recordCalibration = async (t: TimedScript) => {
    const words = t.segments.reduce((n, sg) => n + sg.words.length, 0);
    const span = (t.segments.at(-1)?.endS ?? t.durationS) - (t.segments[0]?.startS ?? 0);
    const wpm = (words / Math.max(1, span)) * 60;
    const prev = cal[calKey];
    cal[calKey] = prev ? { wpm: Math.round(((prev.wpm * prev.samples + wpm) / (prev.samples + 1)) * 10) / 10, samples: prev.samples + 1 } : { wpm: Math.round(wpm * 10) / 10, samples: 1 };
    await writeCalibration(o.data, calFile);
    return { measured: Math.round(wpm * 10) / 10, avg: cal[calKey]!.wpm };
  };
  // Fit window: a short must land within [duration − 8 s, duration − 1 s]; long-form within ±10 %.
  const maxS = short ? o.durationS - 1 : o.durationS * 1.1;
  const minS = short ? o.durationS - 8 : o.durationS * 0.9;
  if (fresh) await recordCalibration(timed);
  // Length is fitted with words, never by stretching the voice: outside the window the script is re-written once
  // at this narration's own measured pace (takes are cached per line, so only changed lines are recorded again).
  if (timed.durationS > maxS || timed.durationS < minS) {
    const words = timed.segments.reduce((n, sg) => n + sg.words.length, 0);
    const span = (timed.segments.at(-1)?.endS ?? timed.durationS) - (timed.segments[0]?.startS ?? 0);
    const measured = (words / Math.max(1, span)) * 60; // this script's own pace is the best predictor for its re-write
    log(`  ! narration ${timed.durationS.toFixed(1)} s outside ${minS}–${maxS} s; voice spoke ${measured.toFixed(1)} wpm → re-writing to fit and re-narrating once`);
    draft = await cachedJson(path.join(jobDir, "script.draft.json"), ScriptDraft, true, () => writeScript({ pack, facts, recentOpenings: habits.openings, aspect: o.aspect, durationS: narrationTargetS, narrationWpm: Math.floor(measured * 0.98), ...(draft.blueprint ? { blueprint: draft.blueprint } : {}), log }), log);
    log(`  "${draft.title}" — ${draft.wordCount} words`);
    timed = await cachedJson(timedPath, TimedScript, true, doNarrate, log);
    await recordCalibration(timed);
  }
  // A small miss after the re-fit is accepted as it is (the voice is not touched); a large one stops the job.
  if (timed.durationS > maxS * 1.05) throw new Error(`narration still ${timed.durationS.toFixed(1)} s after one re-fit (limit ${maxS.toFixed(1)} s); the script needs cutting`);
  if (timed.durationS > maxS) log(`  narration runs ${(timed.durationS - maxS).toFixed(1)} s over the target and is kept at its natural pace`);
  log(`  narration ${timed.durationS.toFixed(2)} s, ${timed.segments.length} segments`);
  if (stop("narration")) return { jobDir };

  // ---- Stage B: director → resolver
  log("\n[B1] storyboard director");
  let board = await cachedJson(path.join(jobDir, "storyboard.json"), Storyboard, redo("storyboard"), () => directStoryboard({ pack, script: timed, facts, index, avoidQueries: badQueries(memory), log }), log);
  // The film's signature transition: every non-cut transition becomes it, and a new thought (the first shot
  // of a narration segment) gets it when the director cut straight — roughly one shot in six.
  if (design.treatment) {
    const sig = design.treatment.transition;
    let lastSeg = "";
    let since = 0;
    let n = 0;
    for (const [i, sh] of board.shots.entries()) {
      since++;
      const newThought = sh.scriptSegmentId !== lastSeg;
      lastSeg = sh.scriptSegmentId;
      if (i === 0) continue;
      if (sh.transitionIn !== "cut") sh.transitionIn = sig;
      else if (newThought && since >= 4) sh.transitionIn = sig;
      if (sh.transitionIn === sig) (n++, (since = 0));
    }
    log(`  transitions: ${n} "${sig}" (this film's signature), the rest straight cuts`);
  }
  const designed = board.shots.filter((s) => s.source.kind === "designed").length;
  log(`  ${board.shots.length} shots (${designed} designed), ${board.shots.reduce((n, s) => n + s.sfx.length, 0)} sfx cues`);
  if (stop("storyboard")) return { jobDir };

  log("\n[B2] asset resolver (library first → stock/archival)");
  let resolution = await cachedJson(path.join(jobDir, "resolution.json"), ResolutionReport, redo("resolve"), async () => {
    // Blocked = pictures earlier films rejected + everything the last films used (cross-film cooldown).
    const cool = await cooldownRefs(o.data, jobId);
    const blocked = new Set([...blockedRefs(memory), ...cool.pictures]);
    log(`  cooldown: ${cool.pictures.size} picture ref(s) used by recent films are off limits`);
    return resolveAssets({ storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: timed.segments.flatMap((sg) => sg.words), blocked, era: eraOfFacts(facts), factText: facts.claims.map((c) => c.text).join(" "), sources: new Map(timed.segments.map((sg) => [sg.id, sg.claims ?? []])), cacheDir: path.join(o.data, ".cache"), log });
  }, log);
  await recordUsage(o.data, jobId, resolution, board);
  if (stop("resolve")) return { jobDir };

  // Composed scenes: designed per shot after the resolver, so only pictures that really exist are placed.
  log("\n[B3] scene designer (composed scenes)");
  // The designer looks at real reference frames (data/exemplars, built by `opumia build-exemplars`).
  const exemplars: SceneExemplar[] = await (async () => {
    const dir = path.join(o.data, "exemplars", channel);
    const idx = await readFile(path.join(dir, "index.json"), "utf8").then((t) => JSON.parse(t) as { shots: Array<{ kind: string; designed: boolean; layout: string; motion: string; line: string; frames: string[] }> }, () => null);
    if (!idx) {
      log(`  ! no exemplar library for ${channel} (run \`opumia build-exemplars --channel ${channel}\`): designing without reference frames`);
      return [];
    }
    const seen = new Set<string>();
    const picks: SceneExemplar[] = [];
    for (const s of idx.shots.filter((x) => x.designed && x.frames.length)) {
      if (seen.has(s.kind)) continue;
      seen.add(s.kind);
      picks.push({ path: path.join(dir, s.frames.at(-1)!), caption: `${s.kind} — ${s.layout}; motion: ${s.motion}; over the line "${s.line.slice(0, 90)}"` });
      if (picks.length >= 12) break;
    }
    return picks;
  })();
  const sceneFile = path.join(jobDir, "scenes.json");
  const freshScenes = redo("resolve") || redo("storyboard") || redo("manifest") || !(await exists(sceneFile));
  let scenePlan = await cachedJson(sceneFile, ScenePlan, freshScenes, () => designScenes({ storyboard: board, script: timed, resolution, design, channel, exemplars, ...(habits.layouts ? { avoidLayouts: habits.layouts } : {}), people: (facts.story?.characters ?? []).map((c) => c.name), log }), log);
  const burnCaptions = o.aspect === "9:16" || pack.captions.burnLongForm;
  log(`  captions: ${burnCaptions ? "burned in" : `not burned in (the channel shows captions on ${Math.round(pack.captions.bottomTextShare * 100)} % of long-form shots); SRT keeps every word`}`);

  // ---- Stage C: manifest → render → master → mux
  log("\n[C1] render manifest");
  const finalName = `${slug(draft.title) || jobId}_${o.aspect.replace(":", "x")}.mp4`;
  const finalPath = path.join(jobDir, finalName);
  const mopts = (): Omit<BuildManifestOptions, "storyboard" | "script" | "resolution"> => ({ libraryRoot: o.library, outputPath: finalPath, narrationPath: timed.voice.audioPath, log, minRepeatGapS: design.sceneGrammar.minRepeatGapS, burnCaptions, scenes: new Map<string, unknown>(scenePlan.scenes.map((x) => [x.shotId, x])) });
  let manifest = await cachedJson(path.join(jobDir, "manifest.json"), RenderManifest, redo("manifest") || redo("resolve") || redo("storyboard"), () => buildManifest({ storyboard: board, script: timed, resolution, ...mopts() }), log);
  const srtPath = path.join(jobDir, "captions.srt");
  await writeFile(srtPath, toSrt(captionGroups(timed)));
  if (!(await exists(path.join(jobDir, "publish.json")))) await writeFile(path.join(jobDir, "youtube-description.txt"), youtubeDescription(timed, facts)); // replaced by the publishing package (C3)
  log(`  ${manifest.video.length} video layers, ${manifest.audio.length} audio layers, ${manifest.durationFrames} frames @ ${manifest.fps} fps; captions.srt written`);

  // [B4] Preview → critique → revise: the designer sees its own scenes rendered (three moments per shot), a
  // strict critic flags what would not ship, and the flagged scenes are redesigned once — before any film render.
  const reviewFile = path.join(jobDir, "scenes.review.json");
  if (scenePlan.scenes.length && (freshScenes || !(await exists(reviewFile)))) {
    log("\n[B4] scene previews → critique → revise");
    const lookP = lookFromProfile(pack.profile.look, design.palette.primarySoft);
    const allWp = timed.segments.flatMap((sg) => sg.words);
    const lineAt = (id: string) => {
      const sh = board.shots.find((x) => x.id === id);
      return sh ? allWp.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : "";
    };
    const t0p = Date.now();
    const prev = await renderShotPreviews({ manifest, look: lookP, design, publicDir: pub, outDir: path.join(jobDir, "previews"), shotIds: scenePlan.scenes.map((x) => x.shotId), log });
    const issues = await critiqueScenes({ channel, previews: prev.map((p) => ({ shotId: p.shotId, sheet: p.sheet, line: lineAt(p.shotId), idea: scenePlan.scenes.find((x) => x.shotId === p.shotId)?.idea ?? "" })), reference: exemplars.slice(0, 4).map((e) => e.path) });
    log(`  critic: ${prev.length} scene(s) previewed in ${Math.round((Date.now() - t0p) / 1000)} s, ${issues.size} flagged${issues.size ? ` — ${[...issues.entries()].slice(0, 8).map(([k, v]) => `${k} ${v[0]}`).join(", ")}` : ""}`);
    if (issues.size) {
      scenePlan = await designScenes({ storyboard: board, script: timed, resolution, design, channel, exemplars, ...(habits.layouts ? { avoidLayouts: habits.layouts } : {}), people: (facts.story?.characters ?? []).map((c) => c.name), issues, previous: scenePlan, log });
      await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
      await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    await writeFile(reviewFile, JSON.stringify({ previewed: prev.length, flagged: Object.fromEntries(issues) }, null, 2) + "\n");
  }
  // [B5] Timeline sound design: sound goes on what the viewer sees, once the scenes are final.
  const soundFile = path.join(jobDir, "sound.json");
  const designSound = async (seed: string) => {
    const ap = await buildAudioProfile({ data: o.data, library: o.library, index, log });
    const cool = await cooldownRefs(o.data, jobId);
    const usable = index.assets.filter(isUsable);
    const sd = designSoundTimeline({ storyboard: board, script: timed, scenes: scenePlan, sfxAssets: usable.filter((a) => a.category === "sfx" && a.kind === "audio"), musicAssets: usable.filter((a) => a.category === "music" && a.kind === "audio"), sfxProfile: ap.sfx, musicProfile: ap.music, profile: pack.profile, cooldown: { sfx: cool.sfx, music: cool.music }, seed, drops: board.music.flatMap((m) => m.drops ?? []), log });
    board = Storyboard.parse({ ...board, shots: sd.shots, music: sd.music });
    await writeFile(path.join(jobDir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
    resolution = await resolveAudio({ storyboard: board, index, libraryRoot: o.library, jobDir, resolution });
    await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
    manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
    await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(soundFile, JSON.stringify(sd.report, null, 2) + "\n");
    await recordUsage(o.data, jobId, resolution, board);
  };
  if (freshScenes || !(await exists(soundFile))) {
    log("\n[B5] timeline sound design");
    await designSound(jobId);
  }
  // Fingerprint of this film against the earlier ones — the plan is checked before the render is paid for.
  const writeFingerprint = async () => {
    const fp = fingerprintOf({ job: jobId, channel, design, draft, board, scenes: scenePlan });
    const near = closest(fp, recentFps);
    await saveFingerprint(o.data, fp);
    await writeFile(path.join(jobDir, "fingerprint.json"), JSON.stringify({ fingerprint: fp, closest: near }, null, 2) + "\n");
    if (near) log(`  uniqueness: closest earlier film ${near.to} — overall ${near.sim.overall} (colour ${near.sim.colour}, treatment ${near.sim.treatment}, layout ${near.sim.layout}, story ${near.sim.story}, words ${near.sim.words}, sound ${near.sim.sound})${near.over.length ? ` — TOO CLOSE in: ${near.over.join("; ")}` : " — within every limit"}`);
    else log("  uniqueness: first film on record");
    const t = design.treatment;
    await writeFile(path.join(jobDir, "treatment.md"), [
      `# Treatment — ${draft.title}`,
      ``,
      `**Concept:** ${design.concept}`,
      `**Colour world:** primary ${design.palette.primary}, accent ${design.palette.accent}, surface ${design.palette.surface}`,
      `**Type:** ${design.typography.display} display, ${design.typography.body} body, ${design.typography.casing} case`,
      ...(t ? [`**Headlines:** ${t.headline} · **narration phrases:** ${t.phrase} · **labels:** ${t.label} · **photos:** ${t.photo}`, `**Backdrop world:** ${t.world} · **particles:** ${t.particles} · **footage wash:** ${t.wash} (${t.washStrength})`, `**Signature transition:** ${t.transition}`, `**Motif:** ${t.motif}`] : []),
      `**Story shape:** opens ${draft.blueprint?.hook ?? "?"}, spine "${draft.blueprint?.spine ?? "?"}", ends ${draft.blueprint?.ending ?? "?"}`,
      ``,
      near ? `**Closest earlier film:** ${near.to} (overall similarity ${near.sim.overall}${near.over.length ? `; too close in ${near.over.join(", ")}` : "; within every limit"})` : `**Closest earlier film:** none on record`,
      ``,
    ].join("\n"));
  };
  await writeFingerprint();

  // [B6] Preflight gate: every release-gate check that can be computed before the render runs here, on the plan,
  // the final scene previews and the narration. A failing check with a repair is repaired and checked again
  // (two rounds); what still fails is written down and the render is refused.
  const preFile = path.join(jobDir, "preflight.json");
  if (scenePlan.scenes.length && (freshScenes || redo("render") || !(await exists(preFile)))) {
    log("\n[B6] preflight gate (checked before any render)");
    const ex = await loadExemplars(o.data, channel);
    const recent = await cooldownRefs(o.data, jobId);
    const hueRef = ex ? await referenceHueDominance(o.data, ex) : null;
    const lookP = lookFromProfile(pack.profile.look, design.palette.primarySoft);
    const allW = timed.segments.flatMap((sg) => sg.words);
    const lineOf = (id: string) => {
      const sh = board.shots.find((x) => x.id === id);
      return sh ? allW.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : "";
    };
    const prevDir = path.join(jobDir, "previews");
    const people = (facts.story?.characters ?? []).map((c) => c.name);
    // Previews from B4 are still right for scenes that were not revised; the rest are rendered again.
    const revised = await readFile(reviewFile, "utf8").then((t) => Object.keys((JSON.parse(t) as { flagged: Record<string, unknown> }).flagged), () => [] as string[]);
    let stale = new Set(scenePlan.scenes.map((x) => x.shotId).filter((id) => revised.includes(id) || !existsSync(path.join(prevDir, `${id}_sheet.jpg`))));
    let look2 = new Set(scenePlan.scenes.map((x) => x.shotId)); // scenes whose final preview the critic has not seen yet
    const defects = new Map<string, string[]>();
    const rounds: Array<{ round: number; failing: string[]; repairs: string[] }> = [];
    let checks: PreflightCheck[] = [];
    let soundRound = 0;
    for (let round = 0; ; round++) {
      if (stale.size) {
        await renderShotPreviews({ manifest, look: lookP, design, publicDir: pub, outDir: prevDir, shotIds: [...stale], log });
        for (const id of stale) look2.add(id);
        stale = new Set();
      }
      if (look2.size) {
        const ids = [...look2].filter((id) => existsSync(path.join(prevDir, `${id}_sheet.jpg`)));
        const found = await critiqueScenes({ channel, previews: ids.map((id) => ({ shotId: id, sheet: path.join(prevDir, `${id}_sheet.jpg`), line: lineOf(id), idea: scenePlan.scenes.find((x) => x.shotId === id)?.idea ?? "" })), reference: exemplars.slice(0, 4).map((e) => e.path), maxShare: 1 });
        for (const id of ids) defects.delete(id);
        for (const [k2, v] of found) defects.set(k2, v);
        look2 = new Set();
      }
      checks = await preflightChecks({ jobDir, board, scenes: scenePlan, resolution, manifest, timed, exemplars: ex, ...((await storedVoiceMeasure(o.data, timed.voice.voiceId, timed.voice.modelId))?.wpm ? { naturalWpm: (await storedVoiceMeasure(o.data, timed.voice.voiceId, timed.voice.modelId))!.wpm } : {}), sceneDefects: defects, hueRef, previewFrames: scenePlan.scenes.map((x) => path.join(prevDir, `${x.shotId}_1.jpg`)).filter((f) => existsSync(f)), recent });
      const failing = checks.filter((c) => !c.pass && c.level === "blocker");
      const fixable = failing.filter((c) => c.repair);
      const done: string[] = [];
      if (fixable.length && round < 2) {
        // drop_picture: remove the offending picture, then design those scenes again without it.
        const drop = dropPictures(resolution, fixable, recent.pictures);
        if (drop.shots.size) {
          resolution = ResolutionReport.parse({ ...resolution, media: drop.media });
          const ids = scenePlan.scenes.map((x) => x.shotId).filter((id) => drop.shots.has(id));
          if (ids.length) scenePlan = await designScenes({ storyboard: board, script: timed, resolution, design, channel, exemplars, ...(habits.layouts ? { avoidLayouts: habits.layouts } : {}), people, issues: new Map(ids.map((id) => [id, ["a picture was removed from this shot (it repeated another shot or broke a sourcing rule): design the scene again from what is left"]])), previous: scenePlan, log });
          for (const id of ids) stale.add(id);
          done.push(`drop_picture: ${[...drop.shots].join(", ")}`);
        }
        // safe_scene: a scene that is still visibly wrong after its revision is reduced to its clean core.
        const unsafe = new Set(fixable.filter((c) => c.repair === "safe_scene").flatMap((c) => c.shots ?? []));
        if (unsafe.size) {
          scenePlan = ScenePlan.parse({ ...scenePlan, scenes: scenePlan.scenes.map((sc) => (unsafe.has(sc.shotId) ? safeScene(sc) : sc)) });
          for (const id of unsafe) stale.add(id);
          done.push(`safe_scene: ${[...unsafe].join(", ")}`);
        }
        // prune_shapes: outlined boxes and circles that frame nothing are removed.
        const empties = new Set(fixable.filter((c) => c.repair === "prune_shapes").flatMap((c) => c.shots ?? []));
        if (empties.size) {
          scenePlan = ScenePlan.parse(pruneEmptyFrames(scenePlan));
          for (const id of empties) stale.add(id);
          done.push(`prune_shapes: ${[...empties].join(", ")}`);
        }
        // soften_wash: halve the colour wash over footage when the previews are too dark, dull or monochrome.
        if (fixable.some((c) => c.repair === "soften_wash") && scenePlan.scenes.some((sc) => sc.wash)) {
          scenePlan = ScenePlan.parse({ ...scenePlan, scenes: scenePlan.scenes.map((sc) => (sc.wash ? { ...sc, wash: { ...sc.wash, strength: Math.round(sc.wash.strength * 50) / 100 }, dim: Math.round(sc.dim * 80) / 100 } : sc)) });
          for (const sc of scenePlan.scenes) if (sc.wash) stale.add(sc.shotId);
          done.push("soften_wash: colour wash and dimming reduced on every washed scene");
        }
        // reseed_sound: pick the effects and music again.
        if (fixable.some((c) => c.repair === "reseed_sound")) {
          soundRound++;
          await designSound(`${jobId}#${soundRound}`);
          done.push("reseed_sound: effects and music picked again");
        }
        // Sound follows what is on screen: when scenes changed, the sound timeline is laid again on the final scenes.
        if (done.some((d) => /^(drop_picture|safe_scene|prune_shapes)/.test(d)) && !done.some((d) => d.startsWith("reseed_sound"))) await designSound(soundRound ? `${jobId}#${soundRound}` : jobId);
        if (done.length) {
          await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
          await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
          manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
          await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
          await writeFingerprint();
        }
      }
      rounds.push({ round, failing: failing.map((c) => c.id), repairs: done });
      log(`  preflight round ${round + 1}: ${checks.filter((c) => c.pass).length}/${checks.length} checks pass${failing.length ? ` — failing: ${failing.map((c) => c.id).join(", ")}` : ""}${done.length ? ` → repaired: ${done.map((d) => d.split(":")[0]).join(", ")}` : ""}`);
      if (!done.length) break;
    }
    const blockers = checks.filter((c) => !c.pass && c.level === "blocker");
    const advisory = checks.filter((c) => !c.pass && c.level === "advisory");
    await writeFile(preFile, JSON.stringify({ at: new Date().toISOString(), pass: blockers.length === 0, rounds, blockers: blockers.map((c) => c.id), advisory: advisory.map((c) => c.id), checks }, null, 2) + "\n");
    for (const c of blockers) log(`  ✗ ${c.label}: ${c.value} (target ${c.target})${c.note ? ` — ${c.note}` : ""}`);
    for (const c of advisory) log(`  ~ ${c.label}: ${c.value} (target ${c.target}) — reported, no automatic repair`);
    log(blockers.length ? `  preflight: NOT ready to render — ${blockers.length} check(s) still fail` : `  preflight: ready to render${advisory.length ? ` (${advisory.length} advisory note(s))` : ""}`);
  }
  if (stop("manifest")) return { jobDir };
  {
    // Only a plan that passed is rendered (OPUMIA_PREFLIGHT=warn renders anyway, for debugging).
    const pre = await readFile(preFile, "utf8").then((t) => JSON.parse(t) as { pass: boolean; blockers: string[] }, () => null);
    if (pre && !pre.pass && process.env.OPUMIA_PREFLIGHT !== "warn" && (redo("render") || !(await exists(finalPath)))) throw new Error(`preflight gate: the plan would not pass the release gate (${pre.blockers.join(", ")}) — see preflight.json; nothing was rendered`);
  }

  log("\n[C2] Remotion render + FFmpeg mastering");
  const silent = path.join(jobDir, "video_silent.mp4");
  const master = path.join(jobDir, "master.wav");
  const look = lookFromProfile(pack.profile.look, design.palette.primarySoft);
  if (redo("render") || !(await exists(finalPath))) {
    // Pre-render frame gate: ~10 key stills checked in seconds; bad footage re-picked, bad graphics dropped.
    log(`  gate: rendering key stills…`);
    const allW = timed.segments.flatMap((sg) => sg.words);
    const era = (() => {
      const ys = allW.map((w) => /^(19[5-9]\d|20[0-4]\d)\b/.exec(w.word.replace(/[^\d]/g, ""))?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
      return ys.length ? `${ys[0]}–${ys.at(-1)}` : "unknown";
    })();
    const stills = await renderGateStills({ manifest, look, design, publicDir: pub, outDir: path.join(jobDir, "gate"), frames: pickGateFrames(manifest, 10), log });
    const g = await gateReview({ channel, frames: stills.map((f) => ({ path: f.path, layout: f.layout, era, line: allW.filter((w) => w.startS >= f.frame / manifest.fps - 2.2 && w.startS <= f.frame / manifest.fps + 1).map((w) => w.word).join(" ") })) });
    await writeFile(path.join(jobDir, "gate.json"), JSON.stringify({ frames: stills.map((f, i) => ({ ...f, ...(g.frames.find((x) => x.index === i + 1) ?? {}) })) }, null, 2) + "\n");
    const bad = g.frames.filter((f) => !f.ok && f.fix !== "none").map((f) => ({ ...f, still: stills[f.index - 1] })).filter((f) => f.still);
    log(`  gate: ${stills.length} stills, ${bad.length} flagged${bad.length ? ` — ${bad.map((b) => `${b.still!.shotId} ${b.issue}`).join(", ")}` : ""}`);
    if (bad.length) {
      const repairs = new Map<string, string>();
      for (const b of bad) {
        const sh = board.shots.find((x) => x.id === b.still!.shotId);
        if (!sh) continue;
        if (b.fix === "drop_graphic" && sh.source.kind === "designed" && sh.source.designed === "scene") {
          // Composed scenes were already reviewed and revised on previews; never fall back to a bare stock clip.
          continue;
        } else if (b.fix === "drop_graphic" && sh.source.kind === "designed") {
          const q = (sh.source.props.background as { query?: string } | undefined)?.query ?? sh.intent;
          sh.source = { kind: "query", query: q, mustBe: "any" };
          delete sh.factIds;
        } else if (b.fix === "replace_footage") {
          repairs.set(sh.id, `${b.issue}: ${b.note}`.slice(0, 400));
          const pm = resolution.media.find((m) => m.shotId === sh.id && m.role === "primary");
          if (pm) await updateMemory(o.data, (m) => blockAsset(m, pm.ref, `${b.issue}: ${b.note}`, jobId, pm.query));
        }
      }
      await writeFile(path.join(jobDir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
      if (repairs.size) {
        resolution = await repairShots({ storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: allW, resolution, repairs, log });
        await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
      }
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
      await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    await renderVideo({ manifest, look, design, publicDir: pub, out: silent, log });
    const loud = await masterAudio(manifest, master);
    log(`  master: ${loud.integratedLufs} LUFS, TP ${loud.truePeakDb} dBTP`);
    await muxFinal(silent, master, finalPath);
  } else log(`  ✓ ${finalName} (cached)`);
  if (stop("render")) return { jobDir };

  log("\n[C3] publishing package (thumbnail, title, description, tags, hashtags, pinned comment)");
  let thumbnailPath: string | null = path.join(jobDir, "thumbnail.jpg");
  // The studio composes the thumbnail from real cut-out pictures; the generated-plate path is legacy
  // (OPUMIA_THUMBNAIL=higgsfield).
  const legacyThumb = process.env.OPUMIA_THUMBNAIL === "higgsfield";
  if (!legacyThumb && (redo("thumbnail") || !(await exists(thumbnailPath)) || !(await exists(path.join(jobDir, "publish.json"))))) {
    const pk = await buildPublishingPackage({ jobDir, data: o.data, library: o.library, channel, job: jobId, facts, script: timed, design, resolution, board, index, publicDir: pub, log }).catch((err: Error) => {
      log(`  ! publishing package failed: ${err.message.slice(0, 160)}`);
      return { thumbnailPath: null, usd: 0 };
    });
    thumbnailPath = pk.thumbnailPath;
  } else if (legacyThumb && (redo("thumbnail") || !(await exists(thumbnailPath)))) {
    const style = await thumbnailStyle(channel, { reference: o.reference, data: o.data }, log);
    const briefPath = path.join(jobDir, "thumbnail.brief.json");
    const brief = (await exists(briefPath)) && !redo("thumbnail") ? JSON.parse(await readFile(briefPath, "utf8")) : await thumbnailBrief(style, draft, o.aspect);
    await writeFile(briefPath, JSON.stringify({ ...brief, style: style.channelId, aspect: o.aspect }, null, 2) + "\n");
    const existingBg = (await readdir(pub)).find((f) => /^thumb_bg\.(png|jpe?g|webp)$/.test(f));
    let bg = existingBg;
    const cfg = higgsfieldConfig();
    if (!bg && cfg) {
      log(`  Higgsfield ${cfg.modelPath}: generating plate…`);
      try {
        const r = await higgsfieldImage(cfg, { prompt: brief.imagePrompt, aspect: o.aspect, out: path.join(pub, "thumb_bg.png") });
        bg = "thumb_bg.png";
        await writeFile(path.join(jobDir, "thumbnail.higgsfield.json"), JSON.stringify({ requestId: r.requestId, model: cfg.modelPath }, null, 2) + "\n");
      } catch (err) {
        // Non-fatal: the film is done; supply public/thumb_bg.* and re-run the thumbnail stage.
        log(`  ! Higgsfield failed: ${(err as Error).message.slice(0, 160)}`);
      }
    }
    if (bg) {
      const [w, h] = o.aspect === "9:16" ? [1080, 1920] : [1280, 720];
      await renderThumbnailStill({ publicDir: pub, bg, headline: brief.headline, accentWord: brief.accentWord, accent: style.palette.find((c) => /^#/.test(c) && !/^#(0|f){3,6}$/i.test(c)) ?? look.accent, placement: style.textRules.placement as "top" | "middle" | "bottom", width: w, height: h, out: thumbnailPath, log });
      log(`  thumbnail.jpg (${w}x${h}) headline "${brief.headline}"`);
    } else {
      // Local fallback: composite the top-10 pattern from licensed Library assets (no generated plate).
      try {
        const words = `${brief.focalObject ?? ""} ${brief.subject ?? ""}`.toLowerCase().split(/\W+/).filter((w: string) => w.length > 2);
        const objs = index.assets.filter((a) => a.category === "objects" && a.relPath.endsWith(".png") && a.provenance.license);
        const score = (a: (typeof objs)[number]) => [...a.tags, a.relPath].join(" ").toLowerCase().split(/\W+/).filter((t) => words.some((w: string) => t.startsWith(w) || w.startsWith(t))).length;
        const focalObj = [...objs].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
        const hook = resolution.media.find((m) => m.role === "primary" && m.kind === "image");
        const focalSrc = focalObj && score(focalObj) > 0 ? path.join(o.library, focalObj.relPath) : hook?.localPath;
        if (!focalSrc) throw new Error("no focal object or still");
        const focalName = `thumb_focal${path.extname(focalSrc)}`;
        await copyFile(focalSrc, path.join(pub, focalName));
        let flames: string | undefined;
        let cash: string | undefined;
        const fire = index.assets.find((a) => a.category === "overlays" && /flames|embers/.test(a.relPath) && a.provenance.license);
        if ((brief.motif === "fire" || brief.motif === "crisis") && fire) {
          await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "2", "-i", path.join(o.library, fire.relPath), "-frames:v", "1", path.join(pub, "thumb_flames.jpg")]);
          flames = "thumb_flames.jpg";
        }
        const money = objs.find((a) => /dollar_stack/.test(a.relPath));
        if ((brief.motif === "cash" || brief.motif === "crisis") && money) {
          await copyFile(path.join(o.library, money.relPath), path.join(pub, "thumb_cash.png"));
          cash = "thumb_cash.png";
        }
        const [w, h] = o.aspect === "9:16" ? [1080, 1920] : [1280, 720];
        await renderLocalThumbnail({ publicDir: pub, focal: focalName, ...(flames ? { flames } : {}), ...(cash ? { cash } : {}), headline: brief.headline, accentWord: brief.accentWord, tone: brief.tone ?? "crimson", width: w, height: h, out: thumbnailPath, log });
        await writeFile(path.join(jobDir, "thumbnail.local.json"), JSON.stringify({ focal: focalObj && score(focalObj) > 0 ? focalObj.relPath : hook?.ref, flames: fire?.relPath, cash: cash ? money?.relPath : undefined, headline: brief.headline, tone: brief.tone, motif: brief.motif }, null, 2) + "\n");
        log(`  thumbnail.jpg (${w}x${h}) composited locally from Library assets (no Higgsfield plate): "${brief.headline}"`);
      } catch (err) {
        thumbnailPath = null;
        log(`  ! local thumbnail failed (${(err as Error).message.slice(0, 120)}); brief saved to thumbnail.brief.json`);
      }
    }
  } else log("  ✓ thumbnail.jpg (cached)");
  if (stop("thumbnail")) return { jobDir };

  if (o.repair?.size) {
    log(`\n[C3.5] editor repair: ${[...o.repair.keys()].join(", ")}`);
    const repaired = await repairShots({ storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: timed.segments.flatMap((sg) => sg.words), resolution: JSON.parse(await readFile(path.join(jobDir, "resolution.json"), "utf8")), repairs: o.repair, log });
    await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(repaired, null, 2) + "\n");
    const m2 = await buildManifest({ storyboard: board, script: timed, resolution: repaired, ...mopts() });
    await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(m2, null, 2) + "\n");
    await renderVideo({ manifest: m2, look, design, publicDir: pub, out: silent, log });
    const loud = await masterAudio(m2, master);
    log(`  master: ${loud.integratedLufs} LUFS, TP ${loud.truePeakDb} dBTP`);
    await muxFinal(silent, master, finalPath);
    Object.assign(manifest, m2);
    Object.assign(resolution, repaired);
  }

  log("\n[C4] QA");
  let qa = await runQA({ finalPath, srtPath, thumbnailPath, manifest, resolution, script: timed, facts, profile: pack.profile, index, jobDir, judge: o.judge, log });
  let current = { manifest, resolution };
  // Autonomous repair: when the judge's only blockers are B-roll choices, re-pick those shots and re-render (≤ 2 rounds).
  for (let round = 1; round <= 2 && qa.report.verdict === "review"; round++) {
    const hardFails = qa.report.checks.filter((c) => !c.passed && c.id !== "judge" && (c.severity === "major" || c.severity === "blocker"));
    const brollMajors = qa.judgeIssues.filter((i) => i.severity === "major" && i.fix === "replace_broll" && i.atS !== null);
    // Black segments are a footage problem too: re-pick the shot under each one.
    const blackAt = qa.report.checks.find((c) => c.id === "black_frames" && !c.passed)?.atFrames ?? [];
    for (const f of blackAt) brollMajors.push({ severity: "major", atS: f / current.manifest.fps + 0.2, fix: "replace_broll", note: "clip goes black here" });
    if (hardFails.some((c) => c.id !== "black_frames") || !brollMajors.length) break;
    const repairs = new Map<string, string>();
    for (const i of brollMajors) {
      const shot = board.shots.find((sh) => i.atS! >= sh.startS && i.atS! < sh.endS) ?? board.shots.at(-1)!;
      repairs.set(shot.id, i.note.slice(0, 400));
    }
    log(`\n[C4.${round}] auto-repair: ${[...repairs.keys()].join(", ")}`);
    const repaired = await repairShots({ storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: timed.segments.flatMap((sg) => sg.words), resolution: current.resolution, repairs, log });
    await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(repaired, null, 2) + "\n");
    const m2 = await buildManifest({ storyboard: board, script: timed, resolution: repaired, ...mopts() });
    await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(m2, null, 2) + "\n");
    await renderVideo({ manifest: m2, look, design, publicDir: pub, out: silent, log });
    const loud = await masterAudio(m2, master);
    log(`  master: ${loud.integratedLufs} LUFS, TP ${loud.truePeakDb} dBTP`);
    await muxFinal(silent, master, finalPath);
    current = { manifest: m2, resolution: repaired };
    qa = await runQA({ finalPath, srtPath, thumbnailPath, manifest: m2, resolution: repaired, script: timed, facts, profile: pack.profile, index, jobDir, judge: o.judge, log });
  }
  const { report, licenseMarkdown } = qa;
  // Memory: footage the judge wanted replaced is blocked for future films.
  {
    const rej = qa.judgeIssues.filter((i) => i.fix === "replace_broll" && i.atS !== null);
    if (rej.length)
      await updateMemory(o.data, (m) => {
        for (const i of rej) {
          const sh = board.shots.find((x) => i.atS! >= x.startS && i.atS! < x.endS);
          const pm = sh ? current.resolution.media.find((x) => x.shotId === sh.id && x.role === "primary") : undefined;
          if (pm) blockAsset(m, pm.ref, i.note, jobId, pm.query);
        }
      });
  }
  await writeFile(path.join(jobDir, "qa.json"), JSON.stringify({ ...report, judgeIssues: qa.judgeIssues }, null, 2) + "\n");
  await writeFile(path.join(jobDir, "LICENSES.md"), licenseMarkdown);
  for (const c of report.checks) log(`  ${c.passed ? "✓" : "✗"} [${c.severity}] ${c.id}: ${c.message}`);
  log(`  verdict: ${report.verdict.toUpperCase()}`);

  const spent = usageLedger().reduce((t, r) => t + r.usd, 0);
  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s — Claude spend this run $${spent.toFixed(4)}`);
  return { jobDir, finalPath, report };
}
