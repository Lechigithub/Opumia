import { copyFile, readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { type QAReport, ChannelId, FilmDesignSystem, LicenseOverrides, ScenePlan, FactSheet, LibraryIndex, RenderManifest, ResolutionReport, ScriptDraft, Storyboard, TimedScript, type Aspect } from "@opumia/contracts";
import { judgeLessons, recordFilm, editFilmAgent, filmScoreText, scoreFilm, showrunnerAgent, ensureQualityBand, directStoryboardAgent, type DirectorReport, designScenesAgent, ensureVisualBand, type ReferenceShot, type SceneReport, researchAgent, ensureReferenceFilms, ensureStoryBand, type StoryReport, setBudget, closest, fingerprintOf, habitsOf, loadFingerprints, saveFingerprint, critiqueScenes, judgeClips, loadTaste, scoreTaste, producedJobs, markProduced, soundAgent, sourcingAgent, colouristAgent, qaAgent, type CoverageRow, isUsable, blockedRefs, badQueries, buildStylePack, chapterCount, loadMemory, recentBlueprints, recordBlueprint, researchTopic, updateMemory, usageLedger, writeScript, type FilmKitMeta } from "@opumia/agents";
import { ensureVoiceMeasured, recordNarrationPace, storedVoiceMeasure, ttsModel as currentTtsModel, calibrationKey, narrateDirected, readCalibration, resolveChannelVoice, writeCalibration } from "@opumia/narration";
import { compositeScenes, makeFootageProbe, makeSceneTools, youtubeTranscript, pageTextViaBrowser, repairShots, type StockCandidate, resolveAssets, resolveAudio } from "@opumia/resolver";
import { buildAudioProfile } from "./audio-profile.js";
import { cooldownRefs, eraOfFacts, recordUsage } from "./asset-usage.js";
import { buildPublishingPackage } from "./publish.js";
import { inspectStretch } from "./inspect.js";
import { runFilmDesigner } from "./film-kit.js";
import { run } from "@opumia/senses";
import { loadExemplars } from "./exemplars.js";
import { dropPictures, preflightChecks, referenceHueDominance, type PreflightCheck } from "./preflight.js";
import { listen, listeningText, watchClip, watchFile, type BuildManifestOptions, youtubeDescription, buildManifest, captionGroups, lookFromProfile, masterAudio, muxFinal, renderShotPreviews, renderVideo, runQA, toSrt } from "@opumia/motion-engine";

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
  /** Editor overrides: shotId → why the current picture must be replaced. */
  repair?: Map<string, string>;
  /** The showrunner sent the script back (second pass of a film): what the writer must change. */
  writerBrief?: string;
  /** 1 for a film's first planning pass, 2 after the showrunner sent the script back (no further rewrites). */
  pass?: number;
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
const STAGE_BUDGET_USD: Record<string, number> = { A1: 0.6, A2: 0.4, A3: 0.9, B1: 0.6, B2: 0.2, B2s: 0.15, B3: 0.45, B4: 0.3, B4e: 0.12, B4c: 0.1, B5: 0.15, B5s: 0.45, B6: 0.35, C1: 0.02, C2: 0.05, C3: 0.9, C4: 0.2, C4v: 0.15 };

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
    const code = /^\[([A-Z]\d+[a-z]?)\]/.exec(cur.stage)?.[1] ?? "";
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

async function produceStages(o: ProduceOptions): Promise<{ jobDir: string; finalPath?: string; report?: QAReport }> {
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
  const facts = await cachedJson(path.join(jobDir, "facts.json"), FactSheet, redo("research"), () => researchTopic({ topic: o.topic, format: short ? `${o.durationS}-second ${o.aspect === "9:16" ? "vertical short" : "16:9 mini-documentary"}` : "long-form documentary", minClaims: short ? 10 : Math.min(40, Math.round(12 + o.durationS / 12)), memoryDir: path.join(o.data, "agents", "research"), browserRead: pageTextViaBrowser, videoTranscript: youtubeTranscript, log }), log);
  // Uniqueness: what the recent films did, so every planning stage can do something else. (The film's look is
  // designed later, by its art director with its own kit, once its pictures are known — stage B2d.)
  const producedSet = await producedJobs(o.data);
  const recentFps = (await loadFingerprints(o.data)).filter((f) => f.job !== jobId).slice(-6);
  const habits = habitsOf(recentFps);
  const memory = await loadMemory(o.data);
  if (stop("research")) return { jobDir };

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
  // The channel's story band (what each line of its real films does), measured once and stored.
  const storyBand = await ensureStoryBand({ reference: o.reference, data: o.data, channelId: channel, log }).catch(() => null);
  const films = await ensureReferenceFilms({ reference: o.reference, data: o.data, channelId: channel }).catch(() => []);
  const memoryDir = path.join(o.data, "agents", "writer");
  // The writer's line to the researcher: verified claims are added to the fact sheet (and saved with it).
  const claimsBefore = facts.claims.length;
  const askResearcher = (questions: string[]) => researchAgent({ topic: o.topic, format: "", want: 0, questions, idStart: facts.claims.length, browserRead: pageTextViaBrowser, videoTranscript: youtubeTranscript, log }).then((r) => r.claims);
  const storyFile = path.join(jobDir, "script.story.json");
  const onStory = (r: StoryReport) => void writeFile(storyFile, JSON.stringify(r, null, 2) + "\n");
  let draft = await cachedJson(path.join(jobDir, "script.draft.json"), ScriptDraft, redo("script"), () => writeScript({ ...(o.writerBrief ? { brief: o.writerBrief } : {}), pack, facts, recentOpenings: habits.openings, aspect: o.aspect, durationS: narrationTargetS, narrationWpm, recent: recentBlueprints(memory, channel, 4, producedSet), storyBand, films, memoryDir, askResearcher, onStory, log }), log);
  log(`  "${draft.title}" — ${draft.wordCount} words at ${narrationWpm} wpm (${cal[calKey] ? "calibrated" : "default"}), hook: ${draft.hookFormula.slice(0, 80)}`);
  if (draft.blueprint) await updateMemory(o.data, (m) => recordBlueprint(m, channel, { job: jobId, hook: draft.blueprint!.hook, ending: draft.blueprint!.ending, spine: draft.blueprint!.spine, ...(draft.blueprint!.beats?.length ? { beats: draft.blueprint!.beats } : {}) }));
  {
    // A script that still misses the channel's story band is not narrated.
    const st = await readFile(storyFile, "utf8").then((t) => JSON.parse(t) as StoryReport, () => null);
    if (st && !st.pass && !(await exists(path.join(jobDir, "timed-script.json")))) throw new Error(`story test: the script still misses the channel's story band (${st.remaining.map((x) => x.kind).join(", ")}) — see script.story.json; nothing was narrated`);
  }
  if (facts.claims.length > claimsBefore) {
    await writeFile(path.join(jobDir, "facts.json"), JSON.stringify(facts, null, 2) + "\n");
    log(`  writer: asked the researcher — ${facts.claims.length - claimsBefore} verified fact(s) added to the fact sheet`);
  }
  if (stop("script")) return { jobDir };

  log("\n[A3] narration (ElevenLabs)");
  const timedPath = path.join(jobDir, "timed-script.json");
  let fresh = false;
  const doNarrate = async () => {
    fresh = true;
    // Directed narration: voice director → line takes → listen-back (Whisper + sound check) → retakes.
    const nar = await readFile(path.join(o.data, "exemplars", channel, "index.json"), "utf8").then((t) => (JSON.parse(t) as { narrator?: { wpm: { p25: number; p50: number }; prosody?: { f0RangeSt?: { p50: number }; melodySt?: { p50: number } } } }).narrator, () => undefined);
    const res = await narrateDirected({ draft, facts, outDir: jobDir, dataDir: o.data, channel, voice, modelId: ttsModel, ...(nar ? { narrator: { wpm: nar.wpm.p50, wpmLow: nar.wpm.p25, ...(nar.prosody?.f0RangeSt ? { f0RangeSt: nar.prosody.f0RangeSt.p50 } : {}), ...(nar.prosody?.melodySt ? { melodySt: nar.prosody.melodySt.p50 } : {}) } } : {}), log });
    if (res.report.unresolved.length) log(`  ! narration has ${res.report.unresolved.length} unresolved line(s): ${res.report.unresolved.slice(0, 3).join("; ")}`);
    // L12: the voice's real pace on this narration teaches the next script its length
    {
      const ws = res.script.segments.flatMap((sg) => sg.words);
      const span = (ws.at(-1)?.endS ?? 0) - (ws[0]?.startS ?? 0);
      if (span > 10) await recordNarrationPace(o.data, voice.voiceId, ttsModel, (ws.length / span) * 60);
    }
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
    draft = await cachedJson(path.join(jobDir, "script.draft.json"), ScriptDraft, true, () => writeScript({ pack, facts, recentOpenings: habits.openings, aspect: o.aspect, durationS: narrationTargetS, narrationWpm: Math.floor(measured * 0.98), storyBand, films, memoryDir, askResearcher, onStory, log }), log);
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
  // The director is an agent: it reads how the channel shows lines like these, checks that the footage it asks
  // for exists (probe_footage), measures its own plan and revises. What its probes found goes to sourcing
  // (probes.json).
  const probesFile = path.join(jobDir, "probes.json");
  let board = await cachedJson(path.join(jobDir, "storyboard.json"), Storyboard, redo("storyboard"), async () => {
    const eraD = eraOfFacts(facts);
    let dirReport: DirectorReport | null = null;
    const refDir = path.join(o.data, "exemplars", channel);
    const refShots = await readFile(path.join(refDir, "index.json"), "utf8").then((t) => (JSON.parse(t) as { shots: Array<{ kind: string; layout: string; motion: string; line: string; frames: string[] }> }).shots.filter((x) => x.frames.length).map((x) => ({ kind: x.kind, layout: x.layout, motion: x.motion, line: x.line, frame: path.join(refDir, x.frames.at(-1)!) })), () => []);
    const res = await directStoryboardAgent({ pack, script: timed, facts, index, referenceShots: refShots, probe: makeFootageProbe({ jobDir, aspect: o.aspect, era: eraD ? `${eraD.min}–${eraD.max}` : "unspecified" }), memoryDir: path.join(o.data, "agents", "director"), avoidQueries: badQueries(memory), onReport: (r) => (dirReport = r), log });
    await writeFile(probesFile, JSON.stringify({ report: dirReport, probes: Object.fromEntries(res.probes) }, null, 1) + "\n");
    return res.storyboard;
  }, log);
  // The film's signature transition is its kit's ("film"): every non-cut transition becomes it, and a new thought
  // (the first shot of a narration segment) gets it when the director cut straight — roughly one shot in six.
  {
    let lastSeg = "";
    let since = 0;
    let n = 0;
    for (const [i, sh] of board.shots.entries()) {
      since++;
      const newThought = sh.scriptSegmentId !== lastSeg;
      lastSeg = sh.scriptSegmentId;
      if (i === 0) continue;
      if (sh.transitionIn !== "cut") sh.transitionIn = "film";
      else if (newThought && since >= 4) sh.transitionIn = "film";
      if (sh.transitionIn === "film") (n++, (since = 0));
    }
    log(`  transitions: ${n} bridged by the film's own transition, the rest straight cuts`);
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
    return resolveAssets({ storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: timed.segments.flatMap((sg) => sg.words), blocked, era: eraOfFacts(facts), factText: facts.claims.map((c) => c.text).join(" "), sources: new Map(timed.segments.map((sg) => [sg.id, sg.claims ?? []])), cacheDir: path.join(o.data, ".cache"), probes: new Map(Object.entries(await readFile(probesFile, "utf8").then((t) => (JSON.parse(t) as { probes: Record<string, StockCandidate[]> }).probes, () => ({}) as Record<string, StockCandidate[]>))), log });
  }, log);
  // [B2d] The art director from a blank slate: the film's own motion-design kit, written as code (design/film/),
  // rendered on the film's own shots, measured and revised. It owns the film's look: its tokens (design.json:
  // palette from the film's pictures, texture, act grades), its stage, every word on screen and the data graphics.
  const kitMetaFile = path.join(jobDir, "design", "film", "meta.json");
  const designFile = path.join(jobDir, "design.json");
  if (redo("resolve") || !(await exists(kitMetaFile)) || !(await exists(designFile))) {
    log("\n[B2d] art director (the film's own kit, from a blank slate)");
    const kr = await runFilmDesigner({ root: o.root, data: o.data, library: o.library, jobDir, job: jobId, channel, title: draft.title, topic: o.topic, acts: short ? 1 : chapterCount(o.durationS), brief: `${draft.title}\nNARRATION:\n${timed.segments.map((sg) => sg.text).join("\n")}`, board, scenes: null, resolution, timed, look: (d) => lookFromProfile(pack.profile.look, d.palette.primarySoft), log });
    await writeFile(path.join(jobDir, "film-kit.report.json"), JSON.stringify(kr.report, null, 2) + "\n");
    if (!kr.report.pass) throw new Error(`art director: the film's kit was not accepted (${kr.report.note.slice(0, 200)}) — see film-kit.report.json`);
  }
  let design = FilmDesignSystem.parse(JSON.parse(await readFile(designFile, "utf8")));
  const filmKit = JSON.parse(await readFile(kitMetaFile, "utf8")) as FilmKitMeta;
  log(`  the film's look: "${design.concept.slice(0, 90)}" — ${design.palette.primary} / ${design.palette.accent} on ${design.palette.surface}; ${Object.keys(filmKit.components).length} kit components`);
  // [B2s] Picture researcher (B8): looks at what the pooled search placed, beside each line, and fixes what a viewer
  // would catch (contradicting pictures, stand-ins for named subjects, wrong period) — or gives the shot to the
  // scene designer.
  const srcAgentFile = path.join(jobDir, "sourcing.agent.json");
  if (redo("resolve") || !(await exists(srcAgentFile))) {
    const cov = await readFile(path.join(jobDir, "sourcing.json"), "utf8").then((t) => JSON.parse(t) as { rows: CoverageRow[] }, () => null);
    if (cov?.rows.length) {
      log("\n[B2s] picture researcher");
      const coolR = await cooldownRefs(o.data, jobId);
      const eraR = eraOfFacts(facts);
      const whenR = new Map(cov.rows.filter((r) => r.when).map((r) => [r.shotId, r.when!] as [string, string]));
      const tools = makeSceneTools({ jobDir, dataDir: o.data, libraryRoot: o.library, index, storyboard: board, resolution, words: timed.segments.flatMap((sg) => sg.words), era: eraR ? `${eraR.min}–${eraR.max}` : "unspecified", blocked: new Set([...blockedRefs(memory), ...coolR.pictures]), iconColor: design.palette.text, whenOf: (id) => whenR.get(id) });
      const sa = await sourcingAgent({ channel, data: o.data, jobDir, title: draft.title, rows: cov.rows, resolution, subjects: (facts.story?.characters ?? []).map((c) => c.name), findPicture: (i) => tools.findPicture(i), memoryDir: path.join(o.data, "agents", "sourcing"), log });
      resolution = ResolutionReport.parse(sa.resolution);
      await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
      await writeFile(srcAgentFile, JSON.stringify(sa.report, null, 2) + "\n");
      await recordUsage(o.data, jobId, resolution, board);
    }
  }
  if (stop("resolve")) return { jobDir };

  // Composed scenes: designed per shot after the resolver, so only pictures that really exist are placed.
  log("\n[B3] scene designer (composed scenes)");
  const sceneFile = path.join(jobDir, "scenes.json");
  const freshScenes = redo("resolve") || redo("storyboard") || redo("manifest") || !(await exists(sceneFile));
  // The scene designer is an agent with eyes: it looks at the channel's real shots, designs every shot from the
  // film's kit, renders its own previews, measures the film against the channel's mix of shot kinds, and revises.
  const visualBand = await ensureVisualBand({ data: o.data, channelId: channel, log });
  const referenceShots: ReferenceShot[] = await readFile(path.join(o.data, "exemplars", channel, "index.json"), "utf8").then((t) => (JSON.parse(t) as { shots: Array<{ kind: string; layout: string; motion: string; line: string; frames: string[] }> }).shots.filter((x) => x.frames.length).map((x) => ({ kind: x.kind, layout: x.layout, motion: x.motion, line: x.line, frame: path.join(o.data, "exemplars", channel, x.frames.at(-1)!) })), () => []);
  if (!visualBand || referenceShots.length < 40) throw new Error(`scene designer: the channel's visual band and reference shots are needed (run \`opumia build-exemplars --channel ${channel}\`)`);
  const people = (facts.story?.characters ?? []).map((c) => c.name);
  // The scene designer agent, callable again (the showrunner sends shots back to it).
  let sceneReport: SceneReport | null = null;
  const tasteModel = await loadTaste(o.data, channel, "shot").catch(() => null);
  const runSceneAgent = async (extra: { previous?: ScenePlan; revise?: Array<{ shotId: string; note: string }> } = {}) => {
    const lookA = lookFromProfile(pack.profile.look, design.palette.primarySoft);
    const burn = o.aspect === "9:16" || pack.captions.burnLongForm;
    const render = async (plan: ScenePlan, shotIds: string[]) => {
      const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: path.join(jobDir, "_preview.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: burn, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
      const prev = await renderShotPreviews({ manifest: m, look: lookA, design, publicDir: pub, outDir: path.join(jobDir, "previews"), shotIds });
      return prev.map((pv) => ({ shotId: pv.shotId, sheet: pv.sheet, mid: pv.frames[1]!.path }));
    };
    const play = async (plan: ScenePlan, shotId: string) => {
      const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: path.join(jobDir, "_preview.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: burn, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
      return (await renderShotPreviews({ manifest: m, look: lookA, design, publicDir: pub, outDir: path.join(jobDir, "previews", "play"), shotIds: [shotId], moments: [0.04, 0.2, 0.35, 0.5, 0.65, 0.8, 0.96] }))[0]?.sheet ?? null;
    };
    const whenByShot = new Map<string, string>(await readFile(path.join(jobDir, "sourcing.json"), "utf8").then((t) => (JSON.parse(t) as { rows: Array<{ shotId: string; when?: string }> }).rows.filter((r) => r.when).map((r) => [r.shotId, r.when!] as [string, string]), () => []));
    const coolS = await cooldownRefs(o.data, jobId);
    const eraS = eraOfFacts(facts);
    const pictures = makeSceneTools({ jobDir, dataDir: o.data, libraryRoot: o.library, index, storyboard: board, resolution, words: timed.segments.flatMap((sg) => sg.words), era: eraS ? `${eraS.min}–${eraS.max}` : "unspecified", blocked: new Set([...blockedRefs(memory), ...coolS.pictures]), iconColor: design.palette.text, whenOf: (id) => whenByShot.get(id) });
    return designScenesAgent({ storyboard: board, script: timed, resolution, design, channel, visualBand, referenceShots, render, play, pictures, kit: filmKit, ...(tasteModel ? { taste: { score: async (files: string[]) => (await scoreTaste({ root: o.root, data: o.data, channel, kind: "shot", items: files.map((file) => ({ file })) })).map((x) => x?.score ?? null), realP10: tasteModel.calibration.real.p10, realMedian: tasteModel.calibration.real.median } } : {}), watch: async (plan: ScenePlan, a: number, b: number) => {
      // built from the scene stage's own parts (watchPlan reads the final scene plan, which does not exist yet here)
      const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: path.join(jobDir, "_preview.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: burn, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
      const c = await watchClip({ manifest: m, look: lookA, design, publicDir: pub, jobDir, fromS: a, toS: b });
      const l = await listen({ manifest: m, jobDir, fromS: a, toS: b, cutsS: m.video.map((v) => v.startFrame / m.fps) });
      const ins = await inspectStretch({ clip: c, scenes: plan.scenes as never, shots: board.shots, narration: timed.voice.audioPath, root: o.root, data: o.data, channel, aspect: o.aspect as "16:9" | "9:16" }).catch((e: Error) => ({ text: `(measuring failed: ${e.message.slice(0, 120)})` }));
      return { strip: c.strip, text: `${c.fromS.toFixed(1)}–${c.toS.toFixed(1)} s, frames left to right, top to bottom: ${c.frames.join(", ")}\n${listeningText(l)}\n${ins.text}` };
    }, memoryDir: path.join(o.data, "agents", "scenes"), people, ...(habits.layouts ? { avoidLayouts: habits.layouts } : {}), onReport: (r) => (sceneReport = r), ...extra, log });
  };
  let scenePlan = await cachedJson(sceneFile, ScenePlan, freshScenes, async () => {
    const plan = await runSceneAgent();
    await writeFile(path.join(jobDir, "scenes.review.json"), JSON.stringify({ previewed: plan.scenes.length, flagged: {}, agent: sceneReport }, null, 2) + "\n");
    // Pictures the designer fetched are part of the film: saved with their licences, counted for the cooldown.
    await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
    await recordUsage(o.data, jobId, resolution, board);
    return plan;
  }, log);
  const burnCaptions = o.aspect === "9:16" || pack.captions.burnLongForm;
  log(`  captions: ${burnCaptions ? "burned in" : `not burned in (the channel shows captions on ${Math.round(pack.captions.bottomTextShare * 100)} % of long-form shots); SRT keeps every word`}`);

  // ---- Stage C: manifest → render → master → mux
  log("\n[C1] render manifest");
  const finalName = `${slug(draft.title) || jobId}_${o.aspect.replace(":", "x")}.mp4`;
  const finalPath = path.join(jobDir, finalName);
  const mopts = (): Omit<BuildManifestOptions, "storyboard" | "script" | "resolution"> => ({ libraryRoot: o.library, outputPath: finalPath, narrationPath: timed.voice.audioPath, log, burnCaptions, scenes: new Map<string, unknown>(scenePlan.scenes.map((x) => [x.shotId, x])) });
  let manifest = await cachedJson(path.join(jobDir, "manifest.json"), RenderManifest, redo("manifest") || redo("resolve") || redo("storyboard"), () => buildManifest({ storyboard: board, script: timed, resolution, ...mopts() }), log);
  const srtPath = path.join(jobDir, "captions.srt");
  await writeFile(srtPath, toSrt(captionGroups(timed)));
  if (!(await exists(path.join(jobDir, "publish.json")))) await writeFile(path.join(jobDir, "youtube-description.txt"), youtubeDescription(timed, facts)); // replaced by the publishing package (C3)
  log(`  ${manifest.video.length} video layers, ${manifest.audio.length} audio layers, ${manifest.durationFrames} frames @ ${manifest.fps} fps; captions.srt written`);

  // [B4e] Editor: the rhythm of the cut (where cuts fall against the voice, holds, splits, joins, transitions), set
  // after the scenes and before sound, studied against the channel's real passages and measured with its function.
  const editFile = path.join(jobDir, "edit.json");
  const lookE = lookFromProfile(pack.profile.look, design.palette.primarySoft);
  const watchPlan = async (st: { storyboard: Storyboard; scenes: ScenePlan; resolution: ResolutionReport; design?: FilmDesignSystem }, fromS: number, toS: number) => {
    const m = await buildManifest({ storyboard: st.storyboard, script: timed, resolution: st.resolution, ...mopts(), outputPath: path.join(jobDir, "_edit.mp4"), scenes: new Map<string, unknown>(st.scenes.scenes.map((x) => [x.shotId, x])) });
    const c = await watchClip({ manifest: m, look: lookE, design: st.design ?? design, publicDir: pub, jobDir, fromS, toS });
    const l = await listen({ manifest: m, jobDir, fromS, toS, cutsS: m.video.map((v) => v.startFrame / m.fps) });
    // step 2: the step-1 detectors on the rendered stretch (jumps, legibility, voice seams, trained taste)
    const ins = await inspectStretch({ clip: c, scenes: st.scenes.scenes as never, shots: st.storyboard.shots, narration: timed.voice.audioPath, root: o.root, data: o.data, channel, aspect: o.aspect as "16:9" | "9:16" }).catch((e: Error) => ({ text: `(measuring failed: ${e.message.slice(0, 120)})` }));
    return { strip: c.strip, text: `${c.fromS.toFixed(1)}–${c.toS.toFixed(1)} s, frames left to right, top to bottom: ${c.frames.join(", ")}; measured motion ${JSON.stringify(c.motion)}\n${listeningText(l)}\n${ins.text}` };
  };
  const runEditor = async (brief?: string) => {
    // step 6: the music's beat grid in film time, so cuts can land on the music
    const apE = await buildAudioProfile({ data: o.data, library: o.library, index }).catch(() => null);
    const beats = apE ? board.music.flatMap((c) => { const p = apE.music[c.assetId]; if (!p || p.beat.periodS < 0.2) return []; const out: number[] = []; const in0 = c.inS ?? 0; for (let b = p.beat.offsetS + Math.ceil((in0 - p.beat.offsetS) / p.beat.periodS) * p.beat.periodS; b < in0 + (c.endS - c.startS); b += p.beat.periodS) out.push(Math.round((c.startS + b - in0) * 1000) / 1000); return out; }) : [];
    const ed = await editFilmAgent({ channel, data: o.data, storyboard: board, scenes: scenePlan, resolution, script: timed, watch: watchPlan, beats, filmTransition: Boolean(filmKit), memoryDir: path.join(o.data, "agents", "editor"), ...(brief ? { brief } : {}), log });
    board = Storyboard.parse(ed.storyboard);
    scenePlan = ScenePlan.parse(ed.scenes);
    resolution = ed.resolution;
    await writeFile(path.join(jobDir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
    await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
    await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
    manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
    await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(editFile, JSON.stringify(ed.report, null, 2) + "\n");
    return ed.report;
  };
  if (freshScenes || !(await exists(editFile))) {
    log("\n[B4e] editor (rhythm of the cut)");
    await runEditor();
  }
  // [B4k] Compositor (G23): cut-outs over footage take its colour, its light direction, clean edges and a contact
  // shadow — in code, deterministic.
  if (freshScenes) {
    const cp = await compositeScenes({ plan: scenePlan, resolution, jobDir, design, log });
    if (cp.touched) {
      scenePlan = ScenePlan.parse(cp.plan);
      await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
      await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
  }
  // [B4c] Colourist (B9): the film's colour as one thing — act grades, washes and dimming, measured on the final
  // previews against the channel's real frames.
  const colourFile = path.join(jobDir, "colour.json");
  const runColourist = async (brief?: string) => {
    const prevDir = path.join(jobDir, "previews");
    const frames = new Map(scenePlan.scenes.map((x) => [x.shotId, path.join(prevDir, `${x.shotId}_1.jpg`)] as [string, string]).filter(([, f]) => existsSync(f)));
    const actStarts = [0, ...manifest.video.filter((l) => l.ref === "chapter").map((l) => l.startFrame / manifest.fps).sort((a, b) => a - b)];
    const startOf = new Map(board.shots.map((x) => [x.id, x.startS]));
    const lookC = lookFromProfile(pack.profile.look, design.palette.primarySoft);
    const col = await colouristAgent({
      channel, title: draft.title, data: o.data, design, scenes: scenePlan, frames,
      actOf: (id) => Math.max(0, actStarts.filter((t) => t <= (startOf.get(id) ?? 0) + 0.01).length - 1),
      lineOf: (id) => { const sh = board.shots.find((x) => x.id === id); return sh ? timed.segments.flatMap((sg) => sg.words).filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : ""; },
      render: async (d, plan, ids) => {
        const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: path.join(jobDir, "_preview.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: board.aspect === "9:16" || pack.captions.burnLongForm, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
        const prev = await renderShotPreviews({ manifest: m, look: lookC, design: d, publicDir: pub, outDir: prevDir, shotIds: ids });
        return new Map(prev.map((pv) => [pv.shotId, pv.frames[1]!.path] as [string, string]));
      },
      watch: (d, plan, a, b) => watchPlan({ storyboard: board, scenes: plan, resolution, design: d }, a, b),
      ...(brief ? { brief } : {}), memoryDir: path.join(o.data, "agents", "colourist"), log,
    });
    design = FilmDesignSystem.parse(col.design);
    scenePlan = ScenePlan.parse(col.scenes);
    await writeFile(path.join(jobDir, "design.json"), JSON.stringify(design, null, 2) + "\n");
    await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
    manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
    await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(colourFile, JSON.stringify(col.report, null, 2) + "\n");
  };
  if (freshScenes || !(await exists(colourFile))) {
    log("\n[B4c] colourist");
    await runColourist();
  }

  // [B5] Timeline sound design: sound goes on what the viewer sees, once the scenes are final.
  const soundFile = path.join(jobDir, "sound.json");
  const designSound = async (seed: string, brief?: string) => {
    const ap = await buildAudioProfile({ data: o.data, library: o.library, index, log });
    const cool = await cooldownRefs(o.data, jobId);
    const usable = index.assets.filter(isUsable);
    const sopts = { storyboard: board, script: timed, scenes: scenePlan, sfxAssets: usable.filter((a) => a.category === "sfx" && a.kind === "audio"), musicAssets: usable.filter((a) => a.category === "music" && a.kind === "audio"), sfxProfile: ap.sfx, musicProfile: ap.music, profile: pack.profile, cooldown: { sfx: cool.sfx, music: cool.music }, seed, drops: board.music.flatMap((m) => m.drops ?? []), log };
    // The sound designer starts from the timeline's pass, measures against the channel, listens, revises.
    const listenSound = async (st: { shots: Storyboard["shots"]; music: Storyboard["music"] }, a: number, b: number) => {
      const sb = Storyboard.parse({ ...board, shots: st.shots, music: st.music });
      const res = await resolveAudio({ storyboard: sb, index, libraryRoot: o.library, jobDir, resolution });
      return watchPlan({ storyboard: sb, scenes: scenePlan, resolution: res }, a, b);
    };
    const sd = await soundAgent({ ...sopts, kitRoles: Object.fromEntries(Object.entries(filmKit.roles ?? {}).map(([r, c]) => [c, r])), channel, data: o.data, resolution, listen: listenSound, ...(brief ? { brief } : {}), memoryDir: path.join(o.data, "agents", "sound") });
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
  // [B5s] Showrunner: one agent owns the whole planned film — reads the whole-film score and every report, watches
  // the stretches that matter with sound, sends problems back to their owner (scenes, edit, sound, or once the
  // writer, which re-runs the film from the script), then approves or names what is still below the channel.
  const showFile = path.join(jobDir, "showrunner.json");
  if (freshScenes || !(await exists(showFile))) {
    log("\n[B5s] showrunner (the whole film)");
    const treatment = await readFile(path.join(jobDir, "treatment.md"), "utf8").catch(() => `${draft.title}`);
    const report = async () => {
      await writeFile(path.join(jobDir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
      await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
      await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
      await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      const fs = await scoreFilm({ root: o.root, data: o.data, jobDir, channel, taste: true, log: () => {} });
      const ed = await readFile(editFile, "utf8").then((t) => JSON.parse(t) as { note?: string; after?: { structure: number } }, () => null);
      const sr = sceneReport as SceneReport | null;
      const snd = await readFile(soundFile, "utf8").then((t) => t.slice(0, 600), () => "");
      // A2: lines no picture could carry (the picture researcher gave them to the scene designer) — a writing
      // problem the showrunner may send back to the writer.
      const src = await readFile(srcAgentFile, "utf8").then((t) => JSON.parse(t) as { ops?: string[]; note?: string }, () => null);
      const dropped = (src?.ops ?? []).filter((x) => x.startsWith("drop ")).map((x) => { const id = x.split(" ")[1]!; const sh = board.shots.find((y) => y.id === id); const line = sh ? timed.segments.flatMap((sg) => sg.words).filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : ""; return `${x} — line: "${line.slice(0, 120)}"`; });
      return `${filmScoreText(fs)}\n\nEDITOR: ${ed?.note ?? "(no editor report)"}\nSCENE DESIGNER: ${sr ? `${sr.pass ? "accepted" : "not accepted"}; remaining: ${sr.remaining.map((x) => x.kind).join(", ") || "none"}` : "(report from an earlier run)"}\nSOUND: ${snd}${dropped.length ? `\nPICTURE RESEARCHER — no honest picture found for these lines (now designed shots; if a line is abstract, the writer can make it showable): ${dropped.join("; ")}` : ""}${src?.note ? `\nPICTURE RESEARCHER NOTE: ${src.note.slice(0, 300)}` : ""}`;
    };
    const decision = await showrunnerAgent({
      channel, title: draft.title, treatment, segments: timed.segments.map((sg) => ({ id: sg.id, role: sg.role, text: sg.text })), canRewrite: (o.pass ?? 1) === 1, durationS: timed.durationS,
      report, watch: (a, b) => watchPlan({ storyboard: board, scenes: scenePlan, resolution }, a, b),
      redesign: async (shots) => {
        const known = new Set(scenePlan.scenes.map((x) => x.shotId));
        const ok = shots.filter((x) => known.has(x.shotId));
        if (!ok.length) return "none of those shots has a scene";
        scenePlan = ScenePlan.parse(await runSceneAgent({ previous: scenePlan, revise: ok }));
        await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
        await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
        manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
        const sr = sceneReport as SceneReport | null;
        return `redesigned ${ok.map((x) => x.shotId).join(", ")}; scene designer ${sr?.pass ? "accepted its work" : "did not get every check to pass"}${sr?.remaining.length ? ` (remaining: ${sr.remaining.map((x) => x.kind).join(", ")})` : ""}`;
      },
      reEdit: async (note) => {
        const r = await runEditor(note);
        return `editor: structure ${r.before.structure} → ${r.after.structure}; ${r.ops.length} edits. ${r.note}`;
      },
      redoSound: async (note) => {
        await designSound(`${jobId}-${Date.now() % 100000}`, note);
        const rp = await readFile(soundFile, "utf8").then((t) => JSON.parse(t) as { before?: { score: number }; after?: { score: number }; note?: string }, () => null);
        return `sound designer: ${rp?.after ? `score ${rp.before?.score} → ${rp.after.score}; ${rp.note ?? ""}` : "designed again (fresh selection)"} — for: ${note.slice(0, 120)}`;
      },
      memoryDir: path.join(o.data, "agents", "showrunner"), log,
    });
    await writeFile(showFile, JSON.stringify(decision, null, 2) + "\n");
    if (decision.rewrite && (o.pass ?? 1) === 1) {
      log("  showrunner sent the script back: planning the film again from the script (once)");
      return produceStages({ ...o, redo: [...new Set([...o.redo, "script", "narration", "storyboard", "resolve", "manifest"] as Stage[])], writerBrief: decision.rewrite.brief, pass: 2 });
    }
    // Shared film memory and the lesson filter: this film's score is a trial for every lesson the agents were shown.
    const fs = await scoreFilm({ root: o.root, data: o.data, jobDir, channel, taste: true, log: () => {} });
    await recordFilm(o.data, channel, { job: jobId, title: draft.title, at: new Date().toISOString(), idea: treatment.replace(/\s+/g, " ").slice(0, 400), score: fs.score, summary: decision.summary, belowChannel: fs.gaps.slice(0, 6).map((g) => `${g.what} (${g.owner})`) });
    const judged = await judgeLessons({ data: o.data, channel, film: jobId, score: fs.score, profileVersion: fs.profileVersion });
    log(`  film score ${fs.score}/100; lessons: ${judged.map((j) => `${j.agent} ${j.kept} kept/${j.probation} on probation/${j.dropped} dropped`).join(", ")}`);
  }
  // Fingerprint of this film against the earlier ones — the plan is checked before the render is paid for.
  const writeFingerprint = async () => {
    const kitTransition = (filmKit as { transition?: string | null }).transition ?? "";
    const fp = fingerprintOf({ job: jobId, channel, design, transition: kitTransition, draft, board, scenes: scenePlan });
    const near = closest(fp, recentFps);
    await saveFingerprint(o.data, fp);
    await writeFile(path.join(jobDir, "fingerprint.json"), JSON.stringify({ fingerprint: fp, closest: near }, null, 2) + "\n");
    if (near) log(`  uniqueness: closest earlier film ${near.to} — overall ${near.sim.overall} (colour ${near.sim.colour}, treatment ${near.sim.treatment}, layout ${near.sim.layout}, story ${near.sim.story}, words ${near.sim.words}, sound ${near.sim.sound})${near.over.length ? ` — TOO CLOSE in: ${near.over.join("; ")}` : " — within every limit"}`);
    else log("  uniqueness: first film on record");
    await writeFile(path.join(jobDir, "treatment.md"), [
      `# Treatment — ${draft.title}`,
      ``,
      `**Concept:** ${design.concept}`,
      `**Colours:** primary ${design.palette.primary}, accent ${design.palette.accent}, surface ${design.palette.surface}, paper ${design.palette.paper}`,
      `**Type:** ${design.fonts.display} display, ${design.fonts.body} body`,
      `**Kit:** ${Object.entries(filmKit.roles ?? {}).map(([r, c]) => `${r} = ${c}`).join(", ")}`,
      `**Signature transition:** ${kitTransition || "none"}`,
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
    // The scene designer's own previews are still right; only missing ones are rendered.
    let stale = new Set(scenePlan.scenes.map((x) => x.shotId).filter((id) => !existsSync(path.join(prevDir, `${id}_sheet.jpg`))));
    let look2 = new Set(scenePlan.scenes.map((x) => x.shotId)); // scenes whose final preview the critic has not seen yet
    const defects = new Map<string, string[]>();
    // Refill: a shot that lost its footage (too modern for its line) or sits on a bare stage gets a new picture
    // through the same tool the scene designer uses — searched, rated by eye and dated against the line's year.
    const srcRows = new Map<string, { must?: string; when?: string }>(await readFile(path.join(jobDir, "sourcing.json"), "utf8").then((t) => (JSON.parse(t) as { rows: Array<{ shotId: string; must?: string; when?: string }> }).rows.map((r) => [r.shotId, r] as [string, { must?: string; when?: string }]), () => []));
    const eraG = eraOfFacts(facts);
    const gateTools = makeSceneTools({ jobDir, dataDir: o.data, libraryRoot: o.library, index, storyboard: board, resolution, words: allW, era: eraG ? `${eraG.min}–${eraG.max}` : "unspecified", blocked: new Set([...blockedRefs(memory), ...recent.pictures]), iconColor: design.palette.text, whenOf: (id) => srcRows.get(id)?.when });
    const refill = async (ids: string[]) => {
      const got: string[] = [];
      for (const id of ids) {
        const want = (srcRows.get(id)?.must ?? board.shots.find((x) => x.id === id)?.intent ?? "").replace(/^(the|a|an)\s+/i, "");
        // Two tries: what the shot asked for, then a timeless close-up of it.
        for (const w of [want, `${want.split(/\s+/).slice(0, 3).join(" ")} close up hands`]) {
          const r = await gateTools.findPicture({ shotId: id, want: w, as: "footage", kind: "video" }).catch(() => ({ ok: false as const, why: "" }));
          if (r.ok) {
            got.push(id);
            break;
          }
        }
      }
      return got;
    };
    const qualityBand = await ensureQualityBand({ data: o.data, channel, log }).catch(() => null);
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
        const found = await critiqueScenes({ channel, previews: ids.map((id) => ({ shotId: id, sheet: path.join(prevDir, `${id}_sheet.jpg`), line: lineOf(id), idea: scenePlan.scenes.find((x) => x.shotId === id)?.idea ?? "" })), reference: referenceShots.slice(0, 4).map((r) => r.frame), maxShare: 1 });
        for (const id of ids) defects.delete(id);
        for (const [k2, v] of found) defects.set(k2, v);
        look2 = new Set();
      }
      const pfFrames = scenePlan.scenes.map((x) => ({ id: x.shotId, f: path.join(prevDir, `${x.shotId}_1.jpg`) })).filter((x) => existsSync(x.f));
      const pfTaste = tasteModel && pfFrames.length ? (await scoreTaste({ root: o.root, data: o.data, channel, kind: "shot", items: pfFrames.map((x) => ({ file: x.f })) }).catch(() => [])).map((x, k) => ({ id: pfFrames[k]!.id, v: x?.score ?? null })).filter((x): x is { id: string; v: number } => x.v !== null) : [];
      const pfSorted = [...pfTaste].sort((a2, b2) => a2.v - b2.v);
      const tasteIn = tasteModel && pfSorted.length ? { taste: { median: pfSorted[Math.floor(pfSorted.length / 2)]!.v, realP10: tasteModel.calibration.real.p10, realMedian: tasteModel.calibration.real.median, low: pfSorted.filter((x) => x.v < tasteModel.calibration.real.p10).map((x) => `${x.id} ${x.v}`) } } : {};
      checks = await preflightChecks({ ...tasteIn, people: (facts.story?.characters ?? []).map((c) => c.name), jobDir, board, scenes: scenePlan, resolution, manifest, timed, exemplars: ex, ...((await storedVoiceMeasure(o.data, timed.voice.voiceId, timed.voice.modelId))?.wpm ? { naturalWpm: (await storedVoiceMeasure(o.data, timed.voice.voiceId, timed.voice.modelId))!.wpm } : {}), sceneDefects: defects, hueRef, previewFrames: scenePlan.scenes.map((x) => path.join(prevDir, `${x.shotId}_1.jpg`)).filter((f) => existsSync(f)), recent, quality: qualityBand });
      const failing = checks.filter((c) => !c.pass && c.level === "blocker");
      const fixable = failing.filter((c) => c.repair);
      const done: string[] = [];
      // build list 3 (L8): every failing check goes to its OWNER, which replaces or redesigns — nothing is reduced.
      if (fixable.length && round < 3) {
        const revise = new Map<string, string>(); // shot → what its scene designer must fix
        const toScene = (id: string, note: string) => { if (scenePlan.scenes.some((x) => x.shotId === id)) revise.set(id, [revise.get(id), note].filter(Boolean).join("; ").slice(0, 400)); };
        // replace_picture: the offending picture leaves its shot; lost footage is replaced through the picture tools
        // (searched, rated by eye, dated against the line), then the scene is designed again for what it now has.
        const drop = dropPictures(resolution, fixable, recent.pictures);
        if (drop.shots.size) {
          resolution.media.splice(0, resolution.media.length, ...drop.media); // in place: the picture tools hold this object
          const lost = [...drop.shots].filter((id) => !resolution.media.some((m) => m.shotId === id && m.role === "primary"));
          const refilled = new Set(lost.length ? await refill(lost) : []);
          for (const id of drop.shots) toScene(id, refilled.has(id) ? "this shot's footage was replaced (the old one broke a sourcing rule): design the scene for the new footage — let it play clean if it carries the line" : "a picture was taken out of this shot (it repeated, was used by a recent film, broke a fair-use rule or was too soft or too modern): get another with find_picture and design the scene around it");
          done.push(`replace_picture: ${[...drop.shots].join(", ")}${refilled.size ? ` (${refilled.size} given new footage)` : ""}`);
        }
        // An editor half ("sh003_2") that is a frozen frame goes back into the shot before it: the split is undone.
        {
          const deadHalves = fixable.filter((c) => c.id === "dead_frames").flatMap((c) => c.shots ?? []).filter((id) => /_\d+$/.test(id));
          const merged: string[] = [];
          for (const id of deadHalves) {
            const k = board.shots.findIndex((x) => x.id === id);
            if (k <= 0) continue;
            const prev = board.shots[k - 1]!, half = board.shots[k]!;
            board = Storyboard.parse({ ...board, shots: [...board.shots.slice(0, k - 1), { ...prev, endS: half.endS, sfx: [...prev.sfx, ...half.sfx] }, ...board.shots.slice(k + 1)] });
            scenePlan = ScenePlan.parse({ ...scenePlan, scenes: scenePlan.scenes.filter((x) => x.shotId !== id) });
            resolution = { ...resolution, media: resolution.media.filter((m) => m.shotId !== id) };
            stale.add(prev.id);
            merged.push(`${id}→${prev.id}`);
          }
          if (merged.length) {
            await writeFile(path.join(jobDir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
            await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
            done.push(`undo_split: ${merged.join(", ")}`);
          }
        }
        // redesign_scene: the scene designer fixes the scene with the defect named.
        for (const c of fixable.filter((x) => x.repair === "redesign_scene")) for (const id of c.shots ?? []) if (!/_\d+$/.test(id) || scenePlan.scenes.some((x) => x.shotId === id)) toScene(id, `${c.label}${c.note ? ` — ${c.note}` : ""}${defects.get(id)?.length ? ` — the critic saw: ${defects.get(id)!.join("; ")}` : ""}`);
        // Too many picture-less stage shots (or a one-colour film carried by them): those get real footage first.
        {
          const named = fixable.filter((c) => c.id === "bare_backdrop_run" || c.id === "picture_less_scenes").flatMap((c) => c.shots ?? []);
          const bare = fixable.some((c) => c.id === "one_colour_film") ? scenePlan.scenes.filter((sc) => sc.backdrop !== "footage" && !sc.elements.some((e) => e.type === "photo" || e.type === "cutout" || e.type === "card3d")).map((sc) => sc.shotId) : [...new Set(named)];
          const filled = bare.length ? await refill(bare) : [];
          for (const id of filled) toScene(id, "this shot now has real footage: design the scene for it — let it play clean if it carries the line");
          if (filled.length) done.push(`refill_stage: ${filled.join(", ")}`);
        }
        if (revise.size) {
          log(`  preflight → scene designer: ${[...revise.keys()].join(", ")}`);
          scenePlan = ScenePlan.parse(await runSceneAgent({ previous: scenePlan, revise: [...revise.entries()].map(([shotId, note]) => ({ shotId, note })) }));
          for (const id of revise.keys()) (stale.add(id), look2.add(id));
          done.push(`redesign_scene: ${[...revise.keys()].join(", ")}`);
        }
        // regrade: the colourist, told what the previews measured.
        const colour = fixable.filter((c) => c.repair === "regrade");
        if (colour.length) {
          manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
          await runColourist(colour.map((c) => `${c.label}: ${c.value} (target ${c.target})`).join("; "));
          for (const sc of scenePlan.scenes) stale.add(sc.shotId);
          done.push(`regrade: ${colour.map((c) => c.id).join(", ")}`);
        }
        // reseed_sound: the sound designer picks the effects and music again.
        if (fixable.some((c) => c.repair === "reseed_sound")) {
          soundRound++;
          await designSound(`${jobId}#${soundRound}`, fixable.filter((c) => c.repair === "reseed_sound").map((c) => `${c.label}: ${c.value} (target ${c.target})`).join("; "));
          done.push("reseed_sound: effects and music picked again");
        }
        // Sound follows what is on screen: when scenes changed, the sound timeline is laid again on the final scenes.
        if (done.some((d) => /^(replace_picture|redesign_scene|undo_split|refill_stage)/.test(d)) && !done.some((d) => d.startsWith("reseed_sound"))) await designSound(soundRound ? `${jobId}#${soundRound}` : jobId);
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
    // Only a plan that passed is rendered.
    const pre = await readFile(preFile, "utf8").then((t) => JSON.parse(t) as { pass: boolean; blockers: string[] }, () => null);
    if (pre && !pre.pass && (redo("render") || !(await exists(finalPath)))) throw new Error(`preflight gate: the plan would not pass the release gate (${pre.blockers.join(", ")}) — see preflight.json; nothing was rendered`);
  }

  // H33: the publishing package needs only the final plan (facts, narration, design, pictures), not the rendered
  // film — it starts now and runs beside the render (its thumbnail renders in its own folder, thumb-public/).
  let thumbnailPath: string | null = path.join(jobDir, "thumbnail.jpg");
  const needPackage = redo("thumbnail") || !(await exists(thumbnailPath)) || !(await exists(path.join(jobDir, "publish.json")));
  const startPackage = () => buildPublishingPackage({ jobDir, data: o.data, library: o.library, channel, job: jobId, facts, script: timed, design, resolution, board, index, publicDir: pub, log: (x: string) => log(`  [package] ${x.trimStart()}`) }).catch((err: Error) => {
    log(`  ! publishing package failed: ${err.message.slice(0, 160)}`);
    return { thumbnailPath: null as string | null, usd: 0 };
  });
  const packageP = needPackage && !stop("render") ? (log("\n[C3] publishing package — started beside the render"), startPackage()) : null;
  log("\n[C2] Remotion render + FFmpeg mastering");
  const silent = path.join(jobDir, "video_silent.mp4");
  const master = path.join(jobDir, "master.wav");
  const look = lookFromProfile(pack.profile.look, design.palette.primarySoft);
  if (redo("render") || !(await exists(finalPath))) {
    await renderVideo({ manifest, look, design, publicDir: pub, out: silent, log });
    const loud = await masterAudio(manifest, master);
    log(`  master: ${loud.integratedLufs} LUFS, TP ${loud.truePeakDb} dBTP`);
    await muxFinal(silent, master, finalPath);
  } else log(`  ✓ ${finalName} (cached)`);
  // The job is a film now: its usage, look and fingerprint count for later films' cooldown and sameness checks.
  if (existsSync(finalPath)) {
    await markProduced(o.data, jobId, path.basename(finalPath));
    await recordUsage(o.data, jobId, resolution, board);
  }
  if (stop("render")) return { jobDir };

  log("\n[C3] publishing package (thumbnail, title, description, tags, hashtags, pinned comment)");
  // The thumbnail is composed from real pictures only (no generated imagery anywhere in a film's package).
  if (packageP) thumbnailPath = (await packageP).thumbnailPath;
  else if (needPackage) thumbnailPath = (await startPackage()).thumbnailPath;
  else log("  ✓ thumbnail.jpg (cached)");
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
  let qa = await runQA({ finalPath, srtPath, thumbnailPath, manifest, resolution, script: timed, facts, profile: pack.profile, index, jobDir, log });
  // [C4v] Viewer QA (B10): an agent watches the finished file start to end like a viewer and notes what a viewer
  // would notice. Its verdict can only make the film's verdict stricter.
  if (existsSync(finalPath)) {
    log("\n[C4v] viewer QA");
    const qaText = qa.report.checks.map((c) => `${c.passed ? "✓" : "✗"} [${c.severity}] ${c.id}: ${c.message}`).join("\n");
    const v = await qaAgent({ channel, title: draft.title, durationS: timed.durationS, qaText, shots: board.shots.map((x) => ({ id: x.id, startS: x.startS, endS: x.endS })), words: timed.segments.flatMap((sg) => sg.words), watch: async (a, b) => {
      const w = await watchFile({ video: finalPath, fromS: a, toS: b, outDir: path.join(jobDir, "watch") });
      // step 2: the detectors on the finished file's stretch (cut out once, measured like any other stretch)
      const seg = path.join(jobDir, "watch", `final_${a.toFixed(1)}_${b.toFixed(1)}.mp4`);
      if (!existsSync(seg)) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", a.toFixed(2), "-t", (b - a).toFixed(2), "-i", finalPath, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-an", seg]).catch(() => null);
      const ins = existsSync(seg) ? await inspectStretch({ clip: { file: seg, fromS: a, toS: b }, scenes: scenePlan.scenes as never, shots: board.shots, narration: timed.voice.audioPath, root: o.root, data: o.data, channel, aspect: o.aspect as "16:9" | "9:16" }).catch(() => null) : null;
      return { strip: w.strip, text: `${w.text}${ins ? `\n${ins.text}` : ""}` };
    }, memoryDir: path.join(o.data, "agents", "qa"), log });
    await writeFile(path.join(jobDir, "qa.viewer.json"), JSON.stringify(v, null, 2) + "\n");
    const rank = { pass: 0, review: 1, fail: 2 } as const;
    const worst = (rank[v.verdict] > rank[qa.report.verdict] ? v.verdict : qa.report.verdict);
    qa.report.checks.push({ id: "viewer", severity: v.verdict === "fail" ? "blocker" : "major", passed: v.verdict === "pass", message: `${v.summary.slice(0, 300)}${v.issues.length ? ` — ${v.issues.length} issue(s): ${v.issues.slice(0, 4).map((x) => `${x.atS.toFixed(1)} s ${x.what.slice(0, 60)} (${x.owner})`).join("; ")}` : ""}`, measured: v.watchedShare, atFrames: v.issues.map((x) => Math.round(x.atS * manifest.fps)) });
    qa.report.verdict = worst;
  }
  // [C4j] Final-cut judge (build list 2, step 7): independent of every agent that made the film — the finished film in
  // 8-second stretches, each blind beside two real channel stretches close in meaning. A film the judge picks out
  // clearly more often than it picks out real stretches is not released.
  if (existsSync(finalPath)) {
    log("\n[C4j] final-cut judge");
    const allW = timed.segments.flatMap((sg) => sg.words);
    const clips: Array<{ fromS: number; toS: number; said: string }> = [];
    for (let t = 0; t + 6 < timed.durationS; t += 8) clips.push({ fromS: t, toS: Math.min(timed.durationS, t + 8), said: allW.filter((w) => w.startS >= t && w.startS < t + 8).map((w) => w.word).join(" ") });
    const fj = await judgeClips({ data: o.data, reference: o.reference, root: o.root, channel, video: finalPath, clips, workDir: path.join(jobDir, "final-judge"), log: () => {} }).catch(() => null);
    if (fj && fj.clips.length) {
      const picked = fj.clips.filter((c) => c.picked).length / fj.clips.length;
      const fair = fj.calibration?.realPickedAsImitation ?? 1 / 3;
      const pass = picked <= fair + 0.2;
      await writeFile(path.join(jobDir, "final-judge.json"), JSON.stringify(fj, null, 2) + "\n");
      qa.report.checks.push({ id: "final_cut", severity: "major", passed: pass, message: `picked out as the imitation in ${fj.clips.filter((c) => c.picked).length} of ${fj.clips.length} stretches (a real stretch: ${Math.round(fair * 100)} %); realness ${fj.realness}, trained taste ${fj.taste ?? "?"}${pass ? "" : ` — tells: ${[...new Set(fj.clips.flatMap((c) => c.tells))].slice(0, 4).join("; ")}`}`, measured: Math.round(picked * 100) / 100, atFrames: fj.clips.filter((c) => c.picked).map((c) => Math.round(c.fromS * manifest.fps)) });
      if (!pass && qa.report.verdict === "pass") qa.report.verdict = "review";
      log(`  final-cut judge: ${pass ? "PASS" : "VETO"} — picked out in ${Math.round(picked * 100)} % of stretches (real: ${Math.round(fair * 100)} %)`);
    }
  }
  // Step 7: every defect the finished film still has is logged — each becomes a regression case (dev/regressions.ts).
  {
    const failedChecks = qa.report.checks.filter((c) => !c.passed && (c.severity === "blocker" || c.severity === "major"));
    if (failedChecks.length) {
      const { appendFile: af, mkdir: md } = await import("node:fs/promises");
      await md(o.data, { recursive: true });
      await af(path.join(o.data, "defects.jsonl"), failedChecks.map((c) => JSON.stringify({ job: jobId, at: new Date().toISOString(), check: c.id, message: c.message.slice(0, 400) })).join("\n") + "\n");
    }
  }
  const { report, licenseMarkdown } = qa;
  await writeFile(path.join(jobDir, "qa.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(jobDir, "LICENSES.md"), licenseMarkdown);
  for (const c of report.checks) log(`  ${c.passed ? "✓" : "✗"} [${c.severity}] ${c.id}: ${c.message}`);
  log(`  verdict: ${report.verdict.toUpperCase()}`);

  const spent = usageLedger().reduce((t, r) => t + r.usd, 0);
  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s — Claude spend this run $${spent.toFixed(4)}`);
  return { jobDir, finalPath, report };
}
