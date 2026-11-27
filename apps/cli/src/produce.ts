import { rm, appendFile, copyFile, readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { type QAReport, ChannelId, FilmDesignSystem, LicenseOverrides, ScenePlan, FactSheet, LibraryIndex, RenderManifest, ResolutionReport, ScriptDraft, Storyboard, TimedScript, type Aspect } from "@opumia/contracts";
import { judgeLessons, recordFilm, editFilmAgent, filmScoreText, scoreFilm, showrunnerAgent, ensureQualityBand, directStoryboardAgent, type DirectorReport, designScenesAgent, ensureVisualBand, type ReferenceShot, type SceneReport, researchAgent, ensureReferenceFilms, ensureStoryBand, type StoryReport, setBudget, setStageCap, setFinishing, filmSpent, setLaterGuarantee, setCurrentStage, inFilmStage, stageSpent, lengthPlan, setFilmLength, allotments, resetAllotments, rewordForSpeech, techniqueBrief, grammarBrief, ensureTechniquePresets, seeTechniqueTool, stapleGaps, stretchSheet, manifestEvents, loadInventory, techniqueCoverage, recordCoverage, ensureDesignBand, ensurePictureBand, craftBand, emphasisOf, buildCutTimeline, BudgetError, closest, fingerprintOf, habitsOf, loadFingerprints, saveFingerprint, critiqueScenes, judgeClips, loadTaste, scoreTaste, producedJobs, markProduced, soundAgent, sourcingAgent, colouristAgent, qaAgent, type CoverageRow, isUsable, blockedRefs, badQueries, buildStylePack, chapterCount, loadMemory, recentBlueprints, recordBlueprint, researchTopic, updateMemory, usageLedger, writeScript, type FilmKitMeta, Ladders, type Problem, type Rung, resetClient, recordEscalations, analyseEscalations, levelBeds } from "@opumia/agents";
import { ensureVoiceMeasured, recordNarrationPace, storedVoiceMeasure, ttsModel as currentTtsModel, calibrationKey, narrateDirected, readCalibration, resolveChannelVoice, writeCalibration, refitPauses, shapeColdOpen } from "@opumia/narration";
import { resolvePaperTextures, findProp3d, materializeProp3d, resolveAtmosphere, closeBrowser, compositeScenes, makeFootageProbe, makeSceneTools, youtubeTranscript, pageTextViaBrowser, repairShots, type StockCandidate, resolveAssets, resolveAudio, replanShots } from "@opumia/resolver";
import { buildAudioProfile } from "./audio-profile.js";
import { loadKeys } from "./keys.js";
import { cooldownRefs, eraOfFacts, recordUsage } from "./asset-usage.js";
import { buildPublishingPackage } from "./publish.js";
import { inspectStretch } from "./inspect.js";
import { googleFonts, makeLikeness, runFilmDesigner } from "./film-kit.js";
import { bedChecks, filmFlow, filmWorld, flowChecks, paperChecks, runTypeCheck, templateShareCheck, typeChecks, typeItems, worldChecks } from "./flow-checks.js";
import { compareWithReference } from "./compare-ref.js";
import { ensurePlucks, trackPoint, run, PausedError, setPauseHooks } from "@opumia/senses";
import { loadExemplars } from "./exemplars.js";
import { dropPictures, preflightChecks, referenceHueDominance, type PreflightCheck } from "./preflight.js";
import { designChecks, mixTasteCheck, pictureChecks, previewTells, techniqueUseChecks } from "./bl5-checks.js";
import { craftReport } from "./craft-report.js";
import { FINISHED_LADDERS, PREFLIGHT_LADDERS, type Act } from "./ladders.js";
import { listen, listeningText, watchClip, watchFile, type BuildManifestOptions, youtubeDescription, buildManifest, captionGroups, lookFromProfile, masterAudio, muxFinal, renderShotPreviews, renderVideo, runQA, toSrt, renderStretches, premixStems } from "@opumia/motion-engine";

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

// Build list 5, items 2 and 31: every stage's budget, cap and time share comes from ONE length table
// (`@opumia/agents` film-length.ts), set per minute of film — a 90 s film ≤ $3 and ≤ 30 min, longer films by the same
// per-minute figures. A stage over its share is a failure in timing.json (`overShare`), not a note.
export async function produce(o: ProduceOptions) {
  const jobId = o.job ?? `${slug(o.topic)}-${ChannelId.parse(o.channel)}-${o.aspect.replace(":", "x")}`;
  const jobDir = path.join(o.root, "out", jobId);
  const before = usageLedger().length;
  // Stage clock: every "[XX] name" header in the log opens a stage; its seconds and Claude spend are recorded,
  // compared with the stage's share (length table) and written to timing.json. A film-level limit stops model calls.
  const plan = lengthPlan(o.durationS);
  const filmLimit = plan.limitUsd;
  const reserveUsd = plan.reserveUsd;
  const spentBefore = await readFile(path.join(jobDir, "usage.json"), "utf8").then((t) => (JSON.parse(t) as { runs: Array<{ usd: number }> }).runs.reduce((a, r) => a + r.usd, 0), () => 0);
  const repairBefore = await readFile(path.join(jobDir, "usage.json"), "utf8").then((t) => (JSON.parse(t) as { runs: Array<{ calls: Array<{ usd: number; repair?: boolean }> }> }).runs.flatMap((r) => r.calls).filter((c) => c.repair).reduce((a, c) => a + c.usd, 0), () => 0);
  setBudget(filmLimit, { spentBefore, reserveUsd, repairUsd: plan.repairUsd, repairBefore });
  setFilmLength(plan.agentScale);
  resetAllotments();
  if (spentBefore > 0) o.log(`  this film has already spent $${spentBefore.toFixed(2)} of its $${filmLimit.toFixed(2)} limit (target $${plan.targetUsd.toFixed(2)})`);
  const stages: Array<{ stage: string; seconds: number; usd: number; budgetUsd: number | null; shareSeconds: number | null; over: boolean; overShare: boolean }> = [];
  let open: { stage: string; t: number; n: number } | null = null;
  const closeStage = () => {
    if (!open) return;
    const cur = open;
    open = null;
    setStageCap(null);
    const code = /^\[([A-Z]\d+[a-z]?)\]/.exec(cur.stage)?.[1] ?? "";
    // item 32: a stage's spend is what was tagged with it — work running beside it (the package beside the render) is
    // charged to its own stage, not to whichever stage's header was printed last
    const usd = Math.round((code ? stageSpent(code) : usageLedger().slice(cur.n).reduce((t, r) => t + r.usd, 0)) * 1e4) / 1e4;
    const sh = plan.stage(code);
    const budgetUsd = sh ? sh.usd : null;
    const seconds = Math.round((Date.now() - cur.t) / 100) / 10;
    // a cent and a few seconds of slack, so a stage at exactly its share is not a failure
    const over = budgetUsd !== null && usd > budgetUsd + 0.01;
    const overTime = sh !== null && seconds > sh.seconds + 5;
    stages.push({ stage: cur.stage, seconds, usd, budgetUsd, shareSeconds: sh?.seconds ?? null, over, overShare: over || overTime });
    if (over) o.log(`  ! ${cur.stage.split("]")[0]}] spent $${usd.toFixed(2)}, over its share of $${budgetUsd!.toFixed(2)}`);
    if (overTime) o.log(`  ! ${cur.stage.split("]")[0]}] took ${seconds.toFixed(0)} s, over its share of ${sh!.seconds} s`);
  };
  const baseLog = o.log;
  const log = (line: string) => {
    if (line.startsWith("\n[")) {
      closeStage();
      open = { stage: line.trim(), t: Date.now(), n: usageLedger().length };
      setCurrentStage(/^\[([A-Z]\d+[a-z]?)\]/.exec(line.trim())?.[1] ?? null);
      // the first-pass shares of the stages still to come are kept from this one (the finish has its own reserve)
      {
        const ORDER = ["A1", "A2", "A3", "B1", "B2", "B2d", "B2s", "B3", "B4e", "B4c", "B5", "B5s", "B6"];
        const at = ORDER.indexOf(/^\[([A-Z]\d+[a-z]?)\]/.exec(line.trim())?.[1] ?? "");
        setLaterGuarantee(at < 0 ? 0 : ORDER.slice(at + 1).reduce((t, c) => t + (plan.stage(c)?.usd ?? 0), 0));
      }
      const sh = plan.stage(/^\[([A-Z]\d+[a-z]?)\]/.exec(line.trim())?.[1] ?? "");
      setStageCap(sh === null || sh.capUsd <= 0 ? null : sh.capUsd);
    }
    baseLog(line);
  };
  // Build list 3, part D: failures outside the platform (usage limits, expired keys, rate limits, outages) pause the run
  // where it is and resume on their own; the pause is written to paused.json and every pause to pauses.jsonl.
  await mkdir(jobDir, { recursive: true });
  const pausedFile = path.join(jobDir, "paused.json");
  const openStage = () => (open as { stage: string } | null)?.stage ?? null;
  setPauseHooks({
    onPause: async (f, until) => {
      log(`  ⏸ PAUSED — ${f.provider}: ${f.kind}${f.status ? ` (HTTP ${f.status})` : ""}; trying again at ${until.replace("T", " ").slice(0, 16)} UTC (${f.message.slice(0, 120)})`);
      await writeFile(pausedFile, JSON.stringify({ at: new Date().toISOString(), stage: openStage(), provider: f.provider, kind: f.kind, status: f.status ?? null, until, message: f.message }, null, 2) + "\n");
    },
    onResume: async (f, waitedS) => {
      log(`  ▶ RESUMED — ${f.provider} answers again after ${Math.round(waitedS / 60)} min`);
      await appendFile(path.join(jobDir, "pauses.jsonl"), JSON.stringify({ at: new Date().toISOString(), stage: openStage(), provider: f.provider, kind: f.kind, waitedS: Math.round(waitedS) }) + "\n");
      await rm(pausedFile, { force: true });
    },
    // a key rotated in Keychain during the pause reaches this process
    reloadCredentials: () => (loadKeys(o.root), resetClient()),
  });
  try {
    const out = await produceStages({ ...o, job: jobId, log });
    await rm(pausedFile, { force: true });
    return out;
  } catch (err) {
    if (err instanceof PausedError) {
      await writeFile(pausedFile, JSON.stringify({ at: new Date().toISOString(), stage: openStage(), provider: err.failure.provider, kind: err.failure.kind, resumeAt: err.resumeAt, gaveUpAfterS: Math.round(err.waitedS), message: err.failure.message, resume: `pnpm opumia resume ${jobId}` }, null, 2) + "\n");
      log(`\n⏸ The run is paused (${err.failure.provider}: ${err.failure.kind}); access is expected back at ${err.resumeAt}. Resume with: pnpm opumia resume ${jobId}`);
    }
    throw err;
  } finally {
    setPauseHooks({});
    await closeBrowser().catch(() => {});
    // item 30: this film's escalations join the platform's log; a check escalating in two films becomes a fix to make
    await recordEscalations({ data: o.data, jobDir, job: jobId, channel: o.channel }).then(() => analyseEscalations({ data: o.data, channel: o.channel, log: o.log })).catch(() => null);
    closeStage();
    const filmTotal = filmSpent();
    setBudget(null);
    setFilmLength(null);
    setLaterGuarantee(0);
    // item 1: what every agent was given and used; a starved first pass is a failure of the run
    const al = allotments();
    if (al.length) {
      await writeFile(path.join(jobDir, "allotments.json"), JSON.stringify({ at: new Date().toISOString(), starved: al.filter((a) => a.starved).length, agents: al }, null, 2) + "\n").catch(() => {});
      const st = al.filter((a) => a.starved);
      if (st.length) baseLog(`\n! ${st.length} agent run(s) were STARVED (given less than a first pass needs): ${st.map((a) => `${a.stage} $${a.givenUsd?.toFixed(2)}/$${a.needUsd.toFixed(2)}`).join(", ")}`);
    }
    if (stages.length) {
      const tf = path.join(jobDir, "timing.json");
      const prevT = (await exists(tf)) ? (JSON.parse(await readFile(tf, "utf8")) as { runs: unknown[] }) : { runs: [] };
      prevT.runs.push({ at: new Date().toISOString(), durationS: o.durationS, targetUsd: plan.targetUsd, targetMinutes: plan.targetMinutes, overShare: stages.filter((x) => x.overShare).map((x) => x.stage.split("]")[0] + "]"), filmLimitUsd: filmLimit, spentBeforeUsd: Math.round(spentBefore * 100) / 100, filmUsd: Math.round(filmTotal * 100) / 100, seconds: Math.round(stages.reduce((t, x) => t + x.seconds, 0)), usd: Math.round(stages.reduce((t, x) => t + x.usd, 0) * 1e4) / 1e4, stages });
      await writeFile(tf, JSON.stringify(prevT, null, 2) + "\n").catch(() => {});
      baseLog(`\nThe whole film so far: $${filmTotal.toFixed(2)} (target $${plan.targetUsd.toFixed(2)} and ${plan.targetMinutes} min, limit $${filmLimit.toFixed(2)})\nWhere the time and money went:\n${stages.filter((x) => x.seconds >= 1 || x.usd > 0).map((x) => `  ${x.stage.slice(0, 44).padEnd(44)} ${x.seconds.toFixed(0).padStart(5)} s  $${x.usd.toFixed(3)}${x.overShare ? "  OVER ITS SHARE" : ""}`).join("\n")}`);
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
  // build list 5, item 2: one continuous film or chapters, research depth and the fit window all come from the length table
  const lp = lengthPlan(o.durationS);
  const short = lp.chapters === 0;

  // ---- Stage A: research → script → narration
  log("\n[A1] research & fact-check");
  const facts = await cachedJson(path.join(jobDir, "facts.json"), FactSheet, redo("research"), () => researchTopic({ topic: o.topic, format: o.durationS <= 120 ? `${o.durationS}-second ${o.aspect === "9:16" ? "vertical short" : "16:9 mini-documentary"}` : "long-form documentary", minClaims: lp.minClaims, memoryDir: path.join(o.data, "agents", "research"), browserRead: pageTextViaBrowser, videoTranscript: youtubeTranscript, log }), log);
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
  const narrationTargetS = o.durationS <= 120 ? o.durationS - 3 : o.durationS;
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
    // Build list 4: a script that still misses the channel's story band is narrated anyway (never a stop). Length is
    // fitted by the narration's own ladder below; any other miss is logged here and carried into QA (`story_band`).
    const st = await readFile(storyFile, "utf8").then((t) => JSON.parse(t) as StoryReport, () => null);
    if (st && !st.pass) log(`  ! the script misses the channel's story band (${st.remaining.map((x) => x.kind).join(", ")}) — narrated anyway${st.remaining.some((x) => x.kind === "length") ? "; the length is fitted in narration" : ""} (script.story.json)`);
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
    // build list 5, items 23 and 25: names are solved before the first take (the library's IPA lexicon, read only), and
    // a line whose delivery cannot be fixed by retakes is reworded for speech by the writer (same facts)
    const reword = async (x: { text: string; why: string; context: string }) => rewordForSpeech({ text: x.text, why: x.why, context: x.context, facts: facts.claims.filter((c) => c.verdict === "supported" || c.verdict === "partially_supported").map((c) => c.text) }).catch(() => null);
    const res = await narrateDirected({ draft, facts, outDir: jobDir, dataDir: o.data, channel, voice, modelId: ttsModel, libraryDir: o.library, reword, ears: { root: o.root }, ...(nar ? { narrator: { wpm: nar.wpm.p50, wpmLow: nar.wpm.p25, ...(nar.prosody?.f0RangeSt ? { f0RangeSt: nar.prosody.f0RangeSt.p50 } : {}), ...(nar.prosody?.melodySt ? { melodySt: nar.prosody.melodySt.p50 } : {}) } } : {}), log });
    if (res.report.unresolved.length) log(`  ! narration has ${res.report.unresolved.length} unresolved line(s): ${res.report.unresolved.slice(0, 3).join("; ")}`);
    // the script as spoken (punctuation re-set or a line reworded for speech) is the script from here on
    if (res.draft && JSON.stringify(res.draft.segments.map((sg) => sg.text)) !== JSON.stringify(draft.segments.map((sg) => sg.text))) {
      draft = ScriptDraft.parse(res.draft);
      await writeFile(path.join(jobDir, "script.draft.json"), JSON.stringify(draft, null, 2) + "\n");
      log("  narration: the script as spoken was saved (lines re-set or reworded for speech)");
    }
    if (res.report.names?.unsolved.length) log(`  ! names not yet said right: ${res.report.names.unsolved.join(", ")}`);
    if (res.report.deliveryUnresolved?.length) log(`  ! delivery still open: ${res.report.deliveryUnresolved.slice(0, 3).join("; ")}`);
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
  const maxS = o.durationS <= 120 ? o.durationS - 1 : o.durationS * 1.08;
  const minS = o.durationS - Math.max(3, o.durationS * 0.09);
  if (fresh) await recordCalibration(timed);
  // The voice ladder (build list 3, item 15): length is fitted first inside the pauses (no new take, no model), then
  // by the writer trimming or extending a sentence (takes are cached per passage, so only changed ones are recorded
  // again); lines the listen-back still could not resolve after their retakes and respellings are reworded by the
  // writer. The voice's speed is never touched.
  {
    type VoiceAct = { note: string[] };
    const readReport = async () => await readFile(path.join(jobDir, "narration.report.json"), "utf8").then((t) => JSON.parse(t) as { unresolved?: string[]; deliveryUnresolved?: string[]; names?: { unsolved: string[] } }, () => ({}) as { unresolved?: string[]; deliveryUnresolved?: string[]; names?: { unsolved: string[] } });
    const readUnresolved = async () => (await readReport()).unresolved ?? [];
    const paceOf = (t: TimedScript) => {
      const words = t.segments.reduce((n, sg) => n + sg.words.length, 0);
      const span = (t.segments.at(-1)?.endS ?? t.durationS) - (t.segments[0]?.startS ?? 0);
      return (words / Math.max(1, span)) * 60;
    };
    const mid = (minS + maxS) / 2;
    const rewriteFor = async (brief: string) => {
      const measured = paceOf(timed);
      draft = await cachedJson(path.join(jobDir, "script.draft.json"), ScriptDraft, true, () => writeScript({ brief, pack, facts, recentOpenings: habits.openings, aspect: o.aspect, durationS: narrationTargetS, narrationWpm: Math.floor(measured * 0.98), storyBand, films, memoryDir, askResearcher, onStory, log }), log);
      timed = await cachedJson(timedPath, TimedScript, true, doNarrate, log);
      await recordCalibration(timed);
      return `${draft.wordCount} words → ${timed.durationS.toFixed(1)} s`;
    };
    const wordsOff = () => Math.round(((timed.durationS - mid) * paceOf(timed)) / 60);
    const lengthLadder: Array<Rung<VoiceAct>> = [
      { name: "pauses adjusted inside the silence", owner: "voice director", maxUsd: 0, run: async () => {
        const pauseTotal = timed.segments.flatMap((sg) => sg.words).reduce((t, w, k, ws) => (k + 1 < ws.length && /[.?!]["”')\]]*$/.test(w.word) ? t + Math.max(0, ws[k + 1]!.startS - w.endS) : t), 0);
        if (pauseTotal < 0.5) return null;
        const scale = Math.max(0.5, Math.min(2.2, 1 + (mid - timed.durationS) / pauseTotal));
        const r = await refitPauses(timed, scale, path.join(jobDir, "narration.mp3"));
        timed = r.script;
        await writeFile(timedPath, JSON.stringify(timed, null, 2) + "\n");
        return `${r.pauses} pause(s) ×${scale.toFixed(2)}: ${r.before.toFixed(1)} → ${r.after.toFixed(1)} s`;
      } },
      { name: "the writer trims or extends a sentence", owner: "writer", maxUsd: 0.6, run: async () => rewriteFor(`The narration runs ${timed.durationS.toFixed(1)} s; it must land between ${minS} and ${maxS} s. ${wordsOff() > 0 ? `Cut about ${wordsOff()} words` : `Add about ${-wordsOff()} words`} — trim or extend sentences, keep the story and every verified fact.`) },
      { name: "the writer again, with the exact word count", owner: "writer", maxUsd: 0.6, run: async () => rewriteFor(`Still ${timed.durationS.toFixed(1)} s against ${minS}–${maxS} s at the voice's measured ${paceOf(timed).toFixed(0)} wpm: the script must be ${Math.round((mid * paceOf(timed)) / 60)} words (it is ${timed.segments.reduce((n, sg) => n + sg.words.length, 0)}).`) },
    ];
    const wordsLadder: Array<Rung<VoiceAct>> = [1, 2].map((k) => ({ name: k === 1 ? "the writer rewords the lines the voice could not say" : "the writer rewords them again, more plainly", owner: "writer", maxUsd: 0.6, run: async () => { const un = await readUnresolved(); return un.length ? rewriteFor(`After retakes and respellings these lines still were not said cleanly: ${un.slice(0, 8).map((x) => `"${x}"`).join("; ")}. Reword them ${k === 2 ? "in the plainest words, avoiding the names or terms that fail" : ""} (same facts).`) : null; } }));
    // build list 5, items 23 and 25: delivery problems the voice director could not fix with retakes, and names not yet
    // said right, are blocking: the writer rewords those lines for speech (never a change of pace)
    const deliveryLadder: Array<Rung<VoiceAct>> = [{ name: "the writer rewords the lines whose delivery stayed wrong", owner: "writer", maxUsd: 0.6, run: async () => {
      const rp = await readReport();
      const open = [...(rp.deliveryUnresolved ?? []), ...(rp.names?.unsolved ?? []).map((n) => `the name "${n}" is not said right`)];
      return open.length ? rewriteFor(`The narration's delivery is still wrong after the voice director's retakes: ${open.slice(0, 8).join("; ")}. Reword those lines so a narrator says them naturally — statements that end falling, the stressed word where the sentence lands, no break where a speaker would run on${rp.names?.unsolved.length ? "; where a name keeps failing, say it once in full and then use the person's role" : ""} (same facts, same length).`) : null;
    } }];
    const voiceLadders = new Ladders<VoiceAct>({ jobDir, stage: "narration", table: { narration_length: lengthLadder, voice_unresolved: wordsLadder, voice_delivery: deliveryLadder }, log });
    let problems: Problem[] = [];
    for (let round = 0; round < 5; round++) {
      const un = await readUnresolved();
      problems = [
        ...(timed.durationS > maxS || timed.durationS < minS ? [{ check: "narration_length", shots: [], what: "narration outside the length window", measured: `${timed.durationS.toFixed(1)} s`, band: `${minS}–${maxS} s` }] : []),
        // build list 4: one word the recogniser still hears wrong after its retakes is logged, not rewritten — on the
        // Nokia proof film one name ("Elop") cost a full rewrite and a second narration ($0.90)
        ...(un.length >= 2 ? [{ check: "voice_unresolved", shots: [], what: `${un.length} line(s) not said cleanly after retakes`, measured: String(un.length), band: "0" }] : []),
        ...(await readReport().then((rp) => { const n = (rp.deliveryUnresolved?.length ?? 0) + (rp.names?.unsolved.length ?? 0); return n ? [{ check: "voice_delivery", shots: [], what: `${n} delivery problem(s) or name(s) still wrong after retakes`, measured: String(n), band: "0" }] : []; })),
      ];
      if (!problems.length) break;
      if (!(await voiceLadders.step(problems, { note: [] })).length) break;
    }
    await voiceLadders.close(problems);
  }
  // A miss left after the ladder is kept (the voice is never touched) and logged; it never stops the film (build list 4).
  if (timed.durationS > maxS || timed.durationS < minS) log(`  ! narration runs ${timed.durationS.toFixed(1)} s against ${minS}–${maxS} s after the voice ladder — kept at its natural pace (ladders.jsonl)`);
  // The channel's cold open (hand film v34, measured on its stems): no dead air between lines (pauses capped at 0.6 s;
  // speech fills ≈ 97 % of its cold open), and a film long enough for chapters gets a 2 s breath after the hook for its
  // title card (TimedScript.titleCard, drawn by the kit's chapter role). Done once per narration.
  if (!/narration-shaped\.mp3$/.test(timed.voice.audioPath)) {
    const hook = [...timed.segments].reverse().find((sg) => sg.role === "hook");
    const longForm = lengthPlan(timed.durationS).chapters > 0;
    const sh = await shapeColdOpen(timed, { capS: 0.6, ...(longForm && hook && hook !== timed.segments.at(-1) ? { breathAfterSeg: hook.id, breathS: 2 } : {}) }, path.join(jobDir, "narration-shaped.mp3"));
    timed = TimedScript.parse({ ...sh.script, ...(sh.breath ? { titleCard: sh.breath } : {}) });
    await writeFile(timedPath, JSON.stringify(timed, null, 2) + "\n");
    log(`  cold open: ${sh.pauses} pause(s) reshaped${sh.breath ? `; title breath ${sh.breath.startS}–${sh.breath.endS} s` : ""}`);
  }
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
    const res = await directStoryboardAgent({ techniques: [await techniqueBrief({ data: o.data, channel, owner: "director", durationS: o.durationS }).catch(() => ""), await grammarBrief({ data: o.data, channel, owner: "director" }).catch(() => "")].filter(Boolean).join("\n\n"), extraTools: [seeTechniqueTool({ data: o.data, channel })],  pack, script: timed, facts, index, referenceShots: refShots, probe: makeFootageProbe({ jobDir, aspect: o.aspect, era: eraD ? `${eraD.min}–${eraD.max}` : "unspecified" }), memoryDir: path.join(o.data, "agents", "director"), avoidQueries: badQueries(memory), onReport: (r) => (dirReport = r), log });
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
  // The gate's own measures run where the work is done (build list 3, part C): footage softer than the channel's
  // softest tenth of frames is never placed.
  const softBelow = (await ensureQualityBand({ data: o.data, channel, log }).catch(() => null))?.frames.sharpTop.p10;
  let resolution = await cachedJson(path.join(jobDir, "resolution.json"), ResolutionReport, redo("resolve"), async () => {
    // Blocked = pictures earlier films rejected + everything the last films used (cross-film cooldown).
    const cool = await cooldownRefs(o.data, jobId);
    const blocked = new Set([...blockedRefs(memory), ...cool.pictures]);
    log(`  cooldown: ${cool.pictures.size} picture ref(s) used by recent films are off limits`);
    // build list 5, item 16: stock people doing nothing in particular are capped at the channel's own share
    const picBandR = await ensurePictureBand({ data: o.data, channelId: channel, log }).catch(() => null);
    return resolveAssets({ ...(picBandR ? { idleCap: picBandR.idleCap } : {}), ...(softBelow ? { softBelow } : {}), storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: timed.segments.flatMap((sg) => sg.words), blocked, era: eraOfFacts(facts), factText: facts.claims.map((c) => c.text).join(" "), sources: new Map(timed.segments.map((sg) => [sg.id, sg.claims ?? []])), cacheDir: path.join(o.data, ".cache"), probes: new Map(Object.entries(await readFile(probesFile, "utf8").then((t) => (JSON.parse(t) as { probes: Record<string, StockCandidate[]> }).probes, () => ({}) as Record<string, StockCandidate[]>))), log });
  }, log);
  // [B2d] The art director from a blank slate: the film's own motion-design kit, written as code (design/film/),
  // rendered on the film's own shots, measured and revised. It owns the film's look: its tokens (design.json:
  // palette from the film's pictures, texture, act grades), its stage, every word on screen and the data graphics.
  const kitMetaFile = path.join(jobDir, "design", "film", "meta.json");
  const designFile = path.join(jobDir, "design.json");
  if (redo("resolve") || !(await exists(kitMetaFile)) || !(await exists(designFile))) {
    log("\n[B2d] art director (the film's own kit, from a blank slate)");
    const kr = await runFilmDesigner({ root: o.root, data: o.data, library: o.library, jobDir, job: jobId, channel, title: draft.title, topic: o.topic, acts: Math.max(1, lp.chapters), brief: `${draft.title}\nNARRATION:\n${timed.segments.map((sg) => sg.text).join("\n")}`, board, scenes: null, resolution, timed, look: (d) => lookFromProfile(pack.profile.look, d.palette.primarySoft), log });
    await writeFile(path.join(jobDir, "film-kit.report.json"), JSON.stringify(kr.report, null, 2) + "\n");
    if (!kr.report.pass) {
      // Build list 4, item 3: never a stop. The art director gets one more, shorter go to finish what it started and submit.
      log(`  art director: kit not accepted (${kr.report.note.slice(0, 120)}) — one more go to finish and submit it`);
      setStageCap(0.6); // the second go has a small allowance of its own (the film's reserve still stands)
      const k2 = await runFilmDesigner({ root: o.root, data: o.data, library: o.library, jobDir, job: jobId, channel, title: draft.title, topic: o.topic, acts: Math.max(1, lp.chapters), brief: `${draft.title}\nNARRATION:\n${timed.segments.map((sg) => sg.text).join("\n")}`, board, scenes: null, resolution, timed, look: (d) => lookFromProfile(pack.profile.look, d.palette.primarySoft), change: { request: "Finish the kit you started (design/film/index.tsx) and SUBMIT it: fix only what submit_kit names as missing.", fresh: false }, log });
      await writeFile(path.join(jobDir, "film-kit.report.json"), JSON.stringify(k2.report, null, 2) + "\n");
      if (!k2.report.pass || !(await exists(kitMetaFile)) || !(await exists(designFile))) throw new Error(`art director: no kit could be made for this film (${k2.report.note.slice(0, 200)}) — see film-kit.report.json`);
    }
  }
  let design = FilmDesignSystem.parse(JSON.parse(await readFile(designFile, "utf8")));
  let filmKit = JSON.parse(await readFile(kitMetaFile, "utf8")) as FilmKitMeta;
  // the scene designer's per-scene composites (write_composite) are components of this film too
  const compMeta = JSON.parse(await readFile(path.join(jobDir, "design", "film", "composites.json"), "utf8").catch(() => "{}")) as Record<string, { use: string; props: string }>;
  for (const [n, c] of Object.entries(compMeta)) filmKit.components[n] ??= { use: c.use, props: c.props };
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
      const tools = makeSceneTools({ ...(softBelow ? { softBelow } : {}), jobDir, dataDir: o.data, libraryRoot: o.library, index, storyboard: board, resolution, words: timed.segments.flatMap((sg) => sg.words), era: eraR ? `${eraR.min}–${eraR.max}` : "unspecified", blocked: new Set([...blockedRefs(memory), ...coolR.pictures]), iconColor: design.palette.text, whenOf: (id) => whenR.get(id) });
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
  const likeness = await makeLikeness({ root: o.root, data: o.data, job: jobId });
  // item 31: the scene designer is run at most this many times per film (first design + revisions sent back by the
  // showrunner, the gate's ladders and the finished film); past it, a revision keeps the scenes as they are.
  // build list 4, item 10: first design + the showrunner's one send-back + two batched rounds from the gates
  const MAX_SCENE_RUNS = 4;
  let sceneRuns = 0;
  const runSceneAgent = async (extra: { previous?: ScenePlan; revise?: Array<{ shotId: string; note: string }>; onlyShots?: string[] } = {}) => {
    if (extra.previous && sceneRuns >= MAX_SCENE_RUNS) {
      log(`  scene designer: run cap reached (${MAX_SCENE_RUNS} runs this film) — ${extra.revise?.length ?? 0} revision(s) not made`);
      return extra.previous;
    }
    sceneRuns++;
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
    const pictures = makeSceneTools({ ...(softBelow ? { softBelow } : {}), jobDir, dataDir: o.data, libraryRoot: o.library, index, storyboard: board, resolution, words: timed.segments.flatMap((sg) => sg.words), era: eraS ? `${eraS.min}–${eraS.max}` : "unspecified", blocked: new Set([...blockedRefs(memory), ...coolS.pictures]), iconColor: design.palette.text, whenOf: (id) => whenByShot.get(id) });
    // build list 5, items 10–14: the scene designer measures worlds, treatment, type scale, data and repeats as the gate does
    const designBandB = await ensureDesignBand({ root: o.root, data: o.data, channelId: channel, log }).catch(() => null);
    const presetsB = await ensureTechniquePresets({ data: o.data, channel }).catch(() => ({}));
    return designScenesAgent({ presets: presetsB, techniques: [await techniqueBrief({ data: o.data, channel, owner: "scene designer", durationS: o.durationS }).catch(() => ""), await grammarBrief({ data: o.data, channel, owner: "scene designer" }).catch(() => "")].filter(Boolean).join("\n\n"), extraTools: [seeTechniqueTool({ data: o.data, channel })],  ...(designBandB ? { designBand: { band: designBandB, root: o.root, data: o.data } } : {}), typeCheck: (frames: string[]) => runTypeCheck({ root: o.root, channel, frames }), storyboard: board, script: timed, resolution, design, channel, visualBand, referenceShots, render, play, pictures, kit: filmKit, composites: { kitDir: path.join(jobDir, "design", "film"), fonts: new Set(googleFonts()) }, compare: async (plan: ScenePlan, a: number, b: number) => {
      const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: path.join(jobDir, "_preview.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: burn, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
      const c = await watchClip({ manifest: m, look: lookA, design, publicDir: pub, jobDir, fromS: a, toS: b });
      return compareWithReference({ root: o.root, data: o.data, channel, ours: c.file, fromS: a, toS: b, filmS: timed.durationS, outDir: path.join(jobDir, "compare") });
    }, ...(likeness.films ? { likeness: { near: likeness.near, limit: 0.9 } } : {}), ...(tasteModel ? { taste: { score: async (files: string[]) => (await scoreTaste({ root: o.root, data: o.data, channel, kind: "shot", items: files.map((file) => ({ file })) })).map((x) => x?.score ?? null), realP10: tasteModel.calibration.real.p10, realMedian: tasteModel.calibration.real.median } } : {}), watch: async (plan: ScenePlan, a: number, b: number) => {
      // built from the scene stage's own parts (watchPlan reads the final scene plan, which does not exist yet here)
      const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: path.join(jobDir, "_preview.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: burn, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
      const c = await watchClip({ manifest: m, look: lookA, design, publicDir: pub, jobDir, fromS: a, toS: b });
      const l = await listen({ manifest: m, jobDir, fromS: a, toS: b, cutsS: m.video.map((v) => v.startFrame / m.fps) });
      const ins = await inspectStretch({ clip: c, scenes: plan.scenes as never, shots: board.shots, narration: timed.voice.audioPath, root: o.root, data: o.data, channel, aspect: o.aspect as "16:9" | "9:16" }).catch((e: Error) => ({ text: `(measuring failed: ${e.message.slice(0, 120)})` }));
      return { strip: c.strip, text: `${c.fromS.toFixed(1)}–${c.toS.toFixed(1)} s, frames left to right, top to bottom: ${c.frames.join(", ")}\n${listeningText(l)}\n${ins.text}` };
    }, memoryDir: path.join(o.data, "agents", "scenes"), people, ...(habits.layouts ? { avoidLayouts: habits.layouts } : {}), onReport: (r) => (sceneReport = r), ...extra, log });
  };
  // build list 5, item 32: a long film's chapters are designed in parallel (three at a time), each by its own scene
  // designer run that sees the whole film; their scenes are merged in film order
  const runScenesByChapter = async (): Promise<ScenePlan> => {
    const starts = [0, ...timed.segments.filter((sg, k) => k > 0 && sg.chapter && sg.chapter !== timed.segments[k - 1]!.chapter).map((sg) => sg.startS)];
    if (lp.chapters < 2 || starts.length < 2) return runSceneAgent();
    const groups = starts.map((t, k) => board.shots.filter((sh) => sh.startS >= t - 0.01 && sh.startS < (starts[k + 1] ?? Infinity)).map((sh) => sh.id)).filter((g) => g.length);
    log(`  scene designer: ${groups.length} chapters designed in parallel`);
    const plans: ScenePlan[] = new Array(groups.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, groups.length) }, async () => {
      while (next < groups.length) {
        const k = next++;
        plans[k] = await runSceneAgent({ onlyShots: groups[k]! });
      }
    }));
    const order = new Map(board.shots.map((sh, i) => [sh.id, i]));
    return ScenePlan.parse({ ...plans[0]!, scenes: plans.flatMap((p) => p.scenes).sort((a, b) => (order.get(a.shotId) ?? 0) - (order.get(b.shotId) ?? 0)), generatedAt: new Date().toISOString() });
  };
  let scenePlan = await cachedJson(sceneFile, ScenePlan, freshScenes, async () => {
    const plan = await runScenesByChapter();
    await writeFile(path.join(jobDir, "scenes.review.json"), JSON.stringify({ previewed: plan.scenes.length, flagged: {}, agent: sceneReport }, null, 2) + "\n");
    // Pictures the designer fetched are part of the film: saved with their licences, counted for the cooldown.
    await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
    await recordUsage(o.data, jobId, resolution, board);
    return plan;
  }, log);
  // craft inventory: the scene designer's atmospheres become real filmed overlays from the Library (smoke, embers,
  // dust, scratches, film burn, sprocket gate, light leak) on their shots
  const placeAtmosphere = async () => {
    // craft inventory: real 3D props — each prop3d element gets a licensed CC0 model (Poly Haven), credited in props.json
    {
      const used = new Set<string>();
      const credits: Array<{ shotId: string; query: string; model: string; credit: string }> = [];
      let changed = false;
      for (const sc of scenePlan.scenes) {
        const els = sc.elements as Array<Record<string, unknown>>;
        for (let k = els.length - 1; k >= 0; k--) {
          const el = els[k]!;
          if (el.type !== "prop3d") continue;
          if (typeof el.model === "string" && el.model) { used.add(String(el.model).split("/")[1] ?? ""); credits.push({ shotId: sc.shotId, query: String(el.query), model: String(el.model), credit: "" }); continue; }
          const hit = await findProp3d({ dataDir: o.data, query: String(el.query), avoid: used }).catch(() => null);
          const got = hit ? await materializeProp3d({ dataDir: o.data, publicDir: pub, id: hit.id }).catch((e: Error) => (log(`  ! 3D prop ${hit.id}: ${e.message.slice(0, 100)}`), null)) : null;
          changed = true;
          if (!got || !hit) { els.splice(k, 1); log(`  3D prop: nothing licensed fits "${String(el.query)}" — element removed from ${sc.shotId}`); continue; }
          el.model = got.publicPath;
          used.add(hit.id);
          credits.push({ shotId: sc.shotId, query: String(el.query), model: got.publicPath, credit: got.credit });
        }
      }
      if (changed) {
        scenePlan = ScenePlan.parse(scenePlan);
        await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
      }
      if (credits.length) {
        await writeFile(path.join(jobDir, "props.json"), JSON.stringify({ at: new Date().toISOString(), props: credits }, null, 2) + "\n");
        log(`  3D props: ${credits.length} real model(s) placed (CC0, credited in props.json)`);
      }
    }
    // craft inventory: paper worlds on real paper scans from the library
    {
      const pt = await resolvePaperTextures({ scenes: scenePlan.scenes as never, index, libraryRoot: o.library, jobDir, resolution, seed: jobId }).catch(() => null);
      if (pt?.placed) {
        resolution = pt.resolution;
        scenePlan = ScenePlan.parse(scenePlan);
        await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
        await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
      }
    }
    // craft inventory: captions pinned to a moving subject follow it (deterministic point tracking on the footage)
    {
      let tracked = 0;
      for (const sc of scenePlan.scenes) {
        const prim = resolution.media.find((m) => m.shotId === sc.shotId && m.role === "primary" && m.kind === "video");
        const sh = board.shots.find((x) => x.id === sc.shotId);
        if (!prim || !sh) continue;
        for (const el of sc.elements as Array<{ track?: { x: number; y: number; path?: unknown[] } }>) {
          if (!el.track || el.track.path) continue;
          el.track.path = await trackPoint(prim.localPath, { ss: sh.trimInS ?? 0, t: Math.max(0.5, sh.endS - sh.startS), x: el.track.x, y: el.track.y }).catch(() => undefined);
          if (el.track.path) tracked++;
        }
      }
      if (tracked) {
        scenePlan = ScenePlan.parse(scenePlan);
        await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
        log(`  tracking: ${tracked} caption(s) follow their subject`);
      }
    }
    if (!scenePlan.scenes.some((x) => (x as { atmos?: unknown }).atmos) && !board.shots.some((x) => x.transitionIn === "smoke_cover" || x.transitionIn === "fire_cover")) return;
    const at = await resolveAtmosphere({ storyboard: board, scenes: scenePlan.scenes as never, index, libraryRoot: o.library, jobDir, resolution, seed: jobId }).catch((e: Error) => (log(`  ! atmosphere: ${e.message.slice(0, 120)}`), null));
    if (!at) return;
    board = Storyboard.parse(at.storyboard);
    resolution = at.resolution;
    await writeFile(path.join(jobDir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
    await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
    if (at.placed) log(`  atmosphere: ${at.placed} shot(s) carry a real filmed atmosphere`);
  };
  await placeAtmosphere();
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
    const emphasisE = await emphasisOf(jobDir).catch(() => undefined);
    const ed = await editFilmAgent({ techniques: [await techniqueBrief({ data: o.data, channel, owner: "editor", durationS: o.durationS }).catch(() => ""), await grammarBrief({ data: o.data, channel, owner: "editor" }).catch(() => "")].filter(Boolean).join("\n\n"), extraTools: [seeTechniqueTool({ data: o.data, channel })],  ...(emphasisE ? { emphasis: emphasisE } : {}), channel, data: o.data, storyboard: board, scenes: scenePlan, resolution, script: timed, watch: watchPlan, beats, filmTransition: Boolean(filmKit), memoryDir: path.join(o.data, "agents", "editor"), ...(brief ? { brief } : {}), log });
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
    // craft inventory: tonal plucks for small reveals — synthesised (the library has none), offered with the library's
    const plucks = await ensurePlucks(o.data).catch(() => []);
    for (const pk of plucks) {
      if (!index.assets.some((a) => a.id === pk.id)) index.assets.push({ schemaVersion: 1, id: pk.id, category: "sfx", relPath: pk.file, kind: "audio", ext: "mp3", sizeBytes: 0, mtimeMs: 0, tags: ["pluck", "tonal"], provenance: { license: "own (deterministic synthesis)", attributionRequired: false, basis: "synthesised with FFmpeg" }, facets: { class: "pluck", intendedUse: "a light tonal accent under a label or small reveal" } } as never);
      ap.sfx[pk.id] = { seconds: pk.seconds, peakDb: -6, centroidHz: 900, lowShare: 0.15, attackS: 0.004, energyCentre: 0.12, family: "pluck" } as never;
    }
    for (const pk of plucks) if (!usable.some((a) => a.id === pk.id)) usable.push(index.assets.find((a) => a.id === pk.id)!);
    const sopts = { storyboard: board, script: timed, scenes: scenePlan, sfxAssets: usable.filter((a) => a.category === "sfx" && a.kind === "audio"), musicAssets: usable.filter((a) => a.category === "music" && a.kind === "audio"), sfxProfile: ap.sfx, musicProfile: ap.music, profile: pack.profile, cooldown: { sfx: cool.sfx, music: cool.music }, seed, drops: board.music.flatMap((m) => m.drops ?? []), log };
    // The sound designer starts from the timeline's pass, measures against the channel, listens, revises.
    const listenSound = async (st: { shots: Storyboard["shots"]; music: Storyboard["music"] }, a: number, b: number) => {
      const sb = Storyboard.parse({ ...board, shots: st.shots, music: st.music });
      const res = await resolveAudio({ storyboard: sb, index, libraryRoot: o.library, jobDir, resolution });
      return watchPlan({ storyboard: sb, scenes: scenePlan, resolution: res }, a, b);
    };
    // build list 5, items 22 and 26–27: one timeline of cuts, stressed words and turns, shared with the editor
    const emphasis = await emphasisOf(jobDir).catch(() => undefined);
    const sd = await soundAgent({ techniques: [await techniqueBrief({ data: o.data, channel, owner: "sound designer", durationS: o.durationS }).catch(() => ""), await grammarBrief({ data: o.data, channel, owner: "sound designer" }).catch(() => "")].filter(Boolean).join("\n\n"), extraTools: [seeTechniqueTool({ data: o.data, channel })],  ...sopts, ...(emphasis ? { emphasis } : {}), kitRoles: Object.fromEntries(Object.entries(filmKit.roles ?? {}).map(([r, c]) => [c, r])), channel, data: o.data, resolution, listen: listenSound, ...(brief ? { brief } : {}), memoryDir: path.join(o.data, "agents", "sound") });
    // beds at the channel's distance under the voice; the cold open's bed ducks less (hand film v34, bed-level.ts)
    const lvl = await levelBeds({ music: sd.music as never, fileOf: (id) => { const a = index.assets.find((x) => x.id === id); return a ? path.join(o.library, a.relPath) : null; }, ...(timed.titleCard ? { titleCardEndS: timed.titleCard.endS } : {}), cacheDir: path.join(o.data, ".cache") }).catch((e: Error) => (log(`  ! bed levels: ${e.message.slice(0, 100)}`), null));
    if (lvl) log(`  beds: ${lvl.notes.join("; ")}`);
    board = Storyboard.parse({ ...board, shots: sd.shots, music: lvl ? lvl.music : sd.music });
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

  // ---- The ladders' tools (build list 3, part B), shared by the preflight gate (B6) and the finished film (C5): what
  // each rung can ask for, and the queued work done once per round.
  const allW = timed.segments.flatMap((sg) => sg.words);
  const lineOf = (id: string) => {
    const sh = board.shots.find((x) => x.id === id);
    return sh ? allW.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : "";
  };
  const recent = await cooldownRefs(o.data, jobId);
  const srcRows = new Map<string, { must?: string; when?: string; need?: string }>(await readFile(path.join(jobDir, "sourcing.json"), "utf8").then((t) => (JSON.parse(t) as { rows: Array<{ shotId: string; must?: string; when?: string; need?: string }> }).rows.map((r) => [r.shotId, r] as [string, { must?: string; when?: string; need?: string }]), () => []));
  const eraG = eraOfFacts(facts);
  const gateTools = makeSceneTools({ ...(softBelow ? { softBelow } : {}), jobDir, dataDir: o.data, libraryRoot: o.library, index, storyboard: board, resolution, words: allW, era: eraG ? `${eraG.min}–${eraG.max}` : "unspecified", blocked: new Set([...blockedRefs(memory), ...recent.pictures]), iconColor: design.palette.text, whenOf: (id) => srcRows.get(id)?.when });
  // New footage through the same tool the scene designer uses — searched, rated by eye, dated against the line's year.
  const refill = async (ids: string[], wantOf?: (id: string) => string) => {
    const got: string[] = [];
    for (const id of ids) {
      const want = (wantOf?.(id) ?? srcRows.get(id)?.must ?? board.shots.find((x) => x.id === id)?.intent ?? "").replace(/^(the|a|an)\s+/i, "");
      // Build list 4, item 11: widening tries (film 3's two tries found 0 of 4) — what was asked for, a timeless
      // close-up of it, the words of the line itself, then a still photograph of it (moved by the camera).
      const said = lineOf(id).split(/\s+/).filter((x) => x.length > 3 && !/^(that|this|with|from|they|their|were|which|would|could|about)$/i.test(x)).slice(0, 5).join(" ");
      const tries: Array<{ w: string; kind: "video" | "image" }> = [{ w: want, kind: "video" }, { w: `${want.split(/\s+/).slice(0, 3).join(" ")} close up hands`, kind: "video" }, ...(said ? [{ w: said, kind: "video" as const }] : []), { w: want, kind: "image" }];
      for (const t of tries) {
        const r = await gateTools.findPicture({ shotId: id, want: t.w, as: "footage", kind: t.kind }).catch(() => ({ ok: false as const, why: "" }));
        if (r.ok) {
          got.push(id);
          break;
        }
      }
    }
    return got;
  };
  // The undo of an editor's split (the half goes back into the shot before it).
  const mergeSplit = (ids: string[], touched: Set<string>) => {
    const merged: string[] = [];
    for (const id of ids) {
      const k = board.shots.findIndex((x) => x.id === id);
      if (k <= 0) continue;
      const prev = board.shots[k - 1]!, half = board.shots[k]!;
      board = Storyboard.parse({ ...board, shots: [...board.shots.slice(0, k - 1), { ...prev, endS: half.endS, sfx: [...prev.sfx, ...half.sfx] }, ...board.shots.slice(k + 1)] });
      scenePlan = ScenePlan.parse({ ...scenePlan, scenes: scenePlan.scenes.filter((x) => x.shotId !== id) });
      resolution.media.splice(0, resolution.media.length, ...resolution.media.filter((m) => m.shotId !== id)); // in place: the picture tools hold this object
      touched.add(prev.id);
      merged.push(`${id}→${prev.id}`);
    }
    return merged;
  };
  let soundRound = 0;
  let rewriteBrief: string | null = null;
  interface Queue { revise: Map<string, string>; all: string | null; colour: string[]; sound: string[]; edit: string[]; soundFresh: boolean; kitChanged: boolean; touched: Set<string> }
  const newQueue = (): Queue => ({ revise: new Map(), all: null, colour: [], sound: [], edit: [], soundFresh: false, kitChanged: false, touched: new Set() });
  const makeAct = (q: Queue, checksNow: () => PreflightCheck[], defects: Map<string, string[]>): Act => ({
    dropOffending: async (p) => {
      const c = checksNow().find((x) => x.id === p.check || (p.check === "unique_plan_sound" && x.id === "unique_plan"));
      // a check of the finished film (QA, viewer) names a shot, not a rule: its footage is the offending picture
      const drop = c ? dropPictures(resolution, [{ ...c, pass: false, repair: "replace_picture", shots: p.shots }], recent.pictures) : { media: resolution.media.filter((m) => !(p.shots.includes(m.shotId) && m.role === "primary")), shots: new Set(p.shots.filter((id) => resolution.media.some((m) => m.shotId === id && m.role === "primary"))) };
      if (drop.shots.size) resolution.media.splice(0, resolution.media.length, ...drop.media);
      for (const id of drop.shots) q.touched.add(id);
      return [...drop.shots];
    },
    refill: async (ids, want) => { const got = await refill(ids, want); for (const id of got) q.touched.add(id); return got; },
    replan: async (ids) => {
      const plans = await replanShots({ shots: ids.map((id) => ({ id, line: `${lineOf(id)}${srcRows.get(id)?.when ? ` [set in ${srcRows.get(id)!.when}]` : ""}`, need: (srcRows.get(id)?.need ?? "staged") as never, must: srcRows.get(id)?.must ?? "", seen: [] })), spares: [], placed: resolution.media.filter((m) => m.role === "primary").map((m) => m.depicts ?? m.query).slice(0, 40), subjects: people, era: eraG ? `${eraG.min}–${eraG.max}` : "unspecified" });
      return new Map(plans.map((pl) => [pl.shot, { action: pl.action, must: pl.must }] as [string, { action: "search" | "spare" | "design"; must: string }]));
    },
    stripFootage: (ids) => { const set = new Set(ids); resolution.media.splice(0, resolution.media.length, ...resolution.media.filter((m) => !(set.has(m.shotId) && m.role === "primary"))); for (const id of ids) q.touched.add(id); },
    scene: (id, note) => { if (board.shots.some((x) => x.id === id && x.source.kind === "designed" && x.source.designed === "scene")) q.revise.set(id, [q.revise.get(id), note].filter(Boolean).join("; ").slice(0, 500)); },
    allScenes: (note) => { q.all = note; },
    mergeSplit: (ids) => mergeSplit(ids, q.touched),
    bridge: (ids) => { const out: string[] = []; board = Storyboard.parse({ ...board, shots: board.shots.map((x) => (ids.includes(x.id) && x.transitionIn === "cut" ? (out.push(x.id), { ...x, transitionIn: "film" as const }) : x)) }); for (const id of out) q.touched.add(id); return out; },
    colour: (b) => void q.colour.push(b),
    sound: (b, fresh) => { q.sound.push(b); q.soundFresh ||= fresh; },
    editor: (b) => void q.edit.push(b),
    kit: async (request, fresh) => {
      const kr = await runFilmDesigner({ root: o.root, data: o.data, library: o.library, jobDir, job: jobId, channel, title: draft.title, topic: o.topic, acts: design.acts.length, brief: `${draft.title}\nNARRATION:\n${timed.segments.map((sg) => sg.text).join("\n")}`, board, scenes: scenePlan, resolution, timed, look: (d) => lookFromProfile(pack.profile.look, d.palette.primarySoft), change: { request, fresh, tokens: { palette: design.palette, texture: design.texture, acts: design.acts } }, log });
      await writeFile(path.join(jobDir, "film-kit.report.json"), JSON.stringify(kr.report, null, 2) + "\n");
      if (!kr.report.pass) return `the art director did not get the change accepted (${kr.report.note.slice(0, 120)})`;
      design = FilmDesignSystem.parse(JSON.parse(await readFile(designFile, "utf8")));
      filmKit = JSON.parse(await readFile(kitMetaFile, "utf8")) as FilmKitMeta;
      q.kitChanged = true;
      return `kit ${fresh ? "redesigned from a new concept" : "changed"}: ${kr.report.note.slice(0, 160)}`;
    },
    rewrite: (b) => { if ((o.pass ?? 1) !== 1) return false; rewriteBrief = b; return true; },
    touch: (ids) => { for (const id of ids) q.touched.add(id); },
    line: lineOf,
    defects: (id) => defects.get(id) ?? [],
  });
  /** Do the round's queued work once; returns the shots whose picture changed (every shot when the kit, the grade or the edit changed). */
  const flush = async (q: Queue, done: string[]): Promise<{ shots: Set<string>; all: boolean }> => {
    const shots = new Set(q.touched);
    let all = q.kitChanged;
    // Build list 4 (proof film): a scene whose footage a rung took away and nothing replaced would render black
    // (bl4b-theranos sh026, 83.8–86.1 s). Every such scene goes to the scene designer in the same round, to be built
    // on the kit's stage around a real picture.
    for (const sc of scenePlan.scenes) {
      if (sc.backdrop === "footage" && !resolution.media.some((m) => m.shotId === sc.shotId && m.role === "primary") && !q.revise.has(sc.shotId)) {
        q.revise.set(sc.shotId, "its footage was removed and nothing replaced it: design this shot on the kit's stage around a real picture (find_picture as a slot), never an empty or black frame");
        log(`  ${sc.shotId}: footage gone with no replacement — sent to the scene designer`);
      }
    }
    if (q.all || q.revise.size) {
      const list = q.all ? scenePlan.scenes.map((sc) => ({ shotId: sc.shotId, note: [q.revise.get(sc.shotId), q.all].filter(Boolean).join("; ") })) : [...q.revise.entries()].map(([shotId, note]) => ({ shotId, note }));
      log(`  ladder → scene designer: ${list.map((u) => u.shotId).join(", ")}`);
      scenePlan = ScenePlan.parse(await runSceneAgent({ previous: scenePlan, revise: list }));
      for (const u of list) shots.add(u.shotId);
    }
    if (q.edit.length) (await runEditor(q.edit.join("; ")), (all = true));
    if (q.colour.length) {
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
      await runColourist(q.colour.join("; "));
      all = true;
    }
    // Sound follows what is on screen: when anything on screen changed, the sound timeline is laid again.
    if (q.sound.length || q.soundFresh) soundRound++;
    if (q.sound.length || shots.size || all) await designSound(soundRound ? `${jobId}#${soundRound}` : jobId, q.sound.length ? q.sound.join("; ") : undefined);
    if (done.length) {
      await writeFile(path.join(jobDir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
      await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
      await writeFile(path.join(jobDir, "resolution.json"), JSON.stringify(resolution, null, 2) + "\n");
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
      await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      await writeFingerprint();
    }
    return { shots, all };
  };
  const toWriter = () => {
    log("  ladder → the writer: planning the film again from the script (once)");
    return produceStages({ ...o, redo: [...new Set([...o.redo, "script", "narration", "storyboard", "resolve", "manifest", "render"] as Stage[])], writerBrief: rewriteBrief!, pass: 2 });
  };

  // [B6] Preflight gate: every release-gate check that can be computed before the render runs here, on the plan,
  // the final scene previews and the narration. Every failing check climbs its own escalation ladder (ladders.ts):
  // its owner's cheapest fix first, a stronger one each round it still fails; every attempt is logged.
  const preFile = path.join(jobDir, "preflight.json");
  if (scenePlan.scenes.length && (freshScenes || redo("render") || !(await exists(preFile)))) {
    log("\n[B6] preflight gate (checked before any render)");
    const ex = await loadExemplars(o.data, channel);
    const hueRef = ex ? await referenceHueDominance(o.data, ex) : null;
    const lookP = lookFromProfile(pack.profile.look, design.palette.primarySoft);
    const prevDir = path.join(jobDir, "previews");
    // The scene designer's own previews are still right; only missing ones are rendered.
    let stale = new Set(scenePlan.scenes.map((x) => x.shotId).filter((id) => !existsSync(path.join(prevDir, `${id}_sheet.jpg`))));
    let look2 = new Set(scenePlan.scenes.map((x) => x.shotId)); // scenes whose final preview the critic has not seen yet
    const defects = new Map<string, string[]>();
    const qualityBand = await ensureQualityBand({ data: o.data, channel, log }).catch(() => null);
    const rounds: Array<{ round: number; failing: string[]; repairs: string[] }> = [];
    let checks: PreflightCheck[] = [];
    const ladders = new Ladders<Act>({ jobDir, stage: "preflight", table: PREFLIGHT_LADDERS, log });
    const problemsOf = (cs: PreflightCheck[]): Problem[] => cs.filter((c) => !c.pass && c.level === "blocker").map((c) => {
      let shots = c.shots ?? [];
      if (c.id === "picture_coverage") shots = scenePlan.scenes.filter((sc) => !resolution.media.some((m) => m.shotId === sc.shotId && m.role === "primary") && !sc.elements.some((e) => e.type === "photo" || e.type === "cutout" || e.type === "card3d")).map((sc) => sc.shotId);
      if (c.id === "designed_share") shots = board.shots.filter((sh) => sh.source.kind === "designed" && sh.source.designed === "scene" && !scenePlan.scenes.some((x) => x.shotId === sh.id)).map((sh) => sh.id);
      return { check: c.id === "unique_plan" && c.repair === "reseed_sound" ? "unique_plan_sound" : c.id, shots, what: `${c.label}${c.note ? ` — ${c.note}` : ""}`, measured: String(c.value), band: c.target, evidence: shots.map((id) => path.join(prevDir, `${id}_1.jpg`)).filter((f) => existsSync(f)) };
    });
    let problems: Problem[] = [];
    // build list 5: the gate checks the same measures the owners work to — the edit at this film's length, the design
    // and picture measures on the final previews, and the final-cut judge's tells on cheap preview stretches (item 15)
    const editBand = await craftBand({ data: o.data, channel, craft: "edit", lengthS: board.durationS }).catch(() => null);
    const designBandP = await ensureDesignBand({ root: o.root, data: o.data, channelId: channel, log }).catch(() => null);
    const pictureBandP = await ensurePictureBand({ data: o.data, channelId: channel, log }).catch(() => null);
    const subjects = [o.topic, ...(facts.story?.characters ?? []).map((c) => c.name)].join(", ");
    let tells: PreflightCheck[] = [];
    let tellRuns = 0;
    let touchedSinceTells = new Set<string>();
    const judgeRender = async (fromS: number, toS: number) => {
      const m = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts(), outputPath: path.join(jobDir, "_edit.mp4"), scenes: new Map<string, unknown>(scenePlan.scenes.map((x) => [x.shotId, x])) });
      return (await watchClip({ manifest: m, look: lookP, design, publicDir: pub, jobDir, fromS, toS })).file;
    };
    for (let round = 0; round < 8; round++) {
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
      const tellShots = new Set(tells.flatMap((c) => c.shots ?? []));
      if (tellRuns === 0 || (tells.length && tellRuns < 2 && [...touchedSinceTells].some((id) => tellShots.has(id)))) {
        const pt = await previewTells({ data: o.data, reference: o.reference, root: o.root, channel, board, timed, workDir: path.join(jobDir, "judge-previews"), render: judgeRender, log }).catch((e: Error) => (log(`  ! judge on previews failed: ${e.message.slice(0, 120)}`), null));
        tells = pt?.checks ?? [];
        // ears: the mix of the preview stretches against the channel's (the trained mix taste)
        if (pt?.clips.length) tells.push(...(await mixTasteCheck({ root: o.root, data: o.data, channel, clips: pt.clips }).catch(() => [])));
        // the hand film's measures on the preview stretches: moving not cutting, never still, words held until read
        if (pt?.clips.length) tells.push(...(await flowChecks({ root: o.root, data: o.data, channel, board, clips: pt.clips, log }).catch((e: Error) => (log(`  ! flow checks failed: ${e.message.slice(0, 120)}`), []))));
        // build list 6: do the pictures show what each line says (words blurred out), and is the film's world too close
        // to an earlier film of ours (word look, pictures)? Local SigLIP + OCR, no API.
        if (pt?.clips.length) tells.push(...(await typeChecks({ root: o.root, channel, clips: pt.clips }).catch((e: Error) => (log(`  ! type checks failed: ${e.message.slice(0, 120)}`), []))));
        if (pt?.clips.length) tells.push(...(await worldChecks({ root: o.root, jobId, board, timedPath: path.join(jobDir, "timed-script.json"), clips: pt.clips, log }).catch((e: Error) => (log(`  ! world checks failed: ${e.message.slice(0, 120)}`), []))));
        // craft inventory: the channel's staples (in ≥ 40 % of its stretches) that a tool can make and none of the
        // preview stretches shows — each to its owner, before any frame is rendered
        if (pt?.clips.length) {
          const sheets = (await Promise.all(pt.clips.map(async (c) => ({ sheet: await stretchSheet(c.file, 0, c.len, path.join(jobDir, "judge-previews", `tech_${c.fromS.toFixed(0)}.jpg`)), text: `Words spoken: "${c.said}"\n${manifestEvents(manifest as never)(c.fromS, c.fromS + c.len).replace(/Cuts at: ([^\n]*)/, (_m, x) => `Cuts at: ${x}`)}`, seconds: c.len })))).filter((x): x is { sheet: string; text: string; seconds: number } => !!x.sheet);
          const gaps = await stapleGaps({ data: o.data, channel, sheets }).catch(() => []);
          const shotsAll = scenePlan.scenes.map((x) => x.shotId);
          const byOwner = new Map<string, typeof gaps>();
          for (const g of gaps) byOwner.set(g.owner, [...(byOwner.get(g.owner) ?? []), g]);
          for (const [owner, gs] of byOwner) tells.push({ id: owner === "editor" ? "staple_edit" : owner === "sound designer" ? "staple_sound" : "staple_picture", label: `The channel's staple techniques missing from our film (${owner})`, value: gs.length, target: "the channel's staples used", pass: false, level: "blocker", shots: owner === "scene designer" ? shotsAll.slice(0, 6) : [], note: gs.map((g) => (g.over ? `${g.name} — ours ${g.over.ours}/min, the channel ${g.over.channel}/min` : `${g.name} (the channel: ${Math.round(g.channelShare * 100)} % of stretches; tool: ${g.tool})`)).join("; ") });
          if (gaps.length) log(`  craft inventory: ${gaps.length} staple technique(s) missing from the previews — ${gaps.map((g) => g.name).slice(0, 6).join("; ")}`);
        }
        tellRuns++;
        touchedSinceTells = new Set();
        if (pt) await writeFile(path.join(jobDir, "judge-previews.json"), JSON.stringify({ at: new Date().toISOString(), run: tellRuns, realness: pt.realness, usd: pt.usd, stretches: pt.stretches }, null, 2) + "\n");
      }
      const extra = [
        ...(await designChecks({ root: o.root, data: o.data, prevDir, board, scenes: scenePlan, resolution, timed, band: designBandP }).catch((e: Error) => (log(`  ! design checks failed: ${e.message.slice(0, 120)}`), []))),
        ...(await pictureChecks({ prevDir, board, scenes: scenePlan, resolution, timed, subjects, band: pictureBandP }).catch((e: Error) => (log(`  ! picture checks failed: ${e.message.slice(0, 120)}`), []))),
        ...tells,
        ...(await (async () => { const st = await premixStems(manifest, path.join(jobDir, "watch", "preflight-stems")); return bedChecks({ stems: st, coldOpenEndS: timed.titleCard?.endS ?? Math.min(45, timed.durationS), durationS: timed.durationS, board }); })().catch((e: Error) => (log(`  ! bed checks failed: ${e.message.slice(0, 120)}`), []))),
        ...(await templateShareCheck({ root: o.root, data: o.data, jobId, board, scenes: scenePlan, resolution }).catch((e: Error) => (log(`  ! template share failed: ${e.message.slice(0, 120)}`), []))),
        ...(await paperChecks({ data: o.data, channel, scenes: scenePlan }).catch((e: Error) => (log(`  ! paper checks failed: ${e.message.slice(0, 120)}`), []))),
        ...(await techniqueUseChecks({ data: o.data, channel, prevDir, board, scenes: scenePlan, timed }).catch((e: Error) => (log(`  ! technique checks failed: ${e.message.slice(0, 120)}`), []))),
      ];
      checks = await preflightChecks({ ...tasteIn, editBand, extra, era: eraG ? { min: eraG.min, max: eraG.max } : null, cutBand: { lo: (pack.profile.pacing.cutsPerMin?.p25 ?? 12) * 0.85, hi: (pack.profile.pacing.cutsPerMin?.p75 ?? 21) * 1.15 }, people: (facts.story?.characters ?? []).map((c) => c.name), jobDir, board, scenes: scenePlan, resolution, manifest, timed, exemplars: ex, ...((await storedVoiceMeasure(o.data, timed.voice.voiceId, timed.voice.modelId))?.wpm ? { naturalWpm: (await storedVoiceMeasure(o.data, timed.voice.voiceId, timed.voice.modelId))!.wpm } : {}), sceneDefects: defects, hueRef, previewFrames: scenePlan.scenes.map((x) => path.join(prevDir, `${x.shotId}_1.jpg`)).filter((f) => existsSync(f)), recent, quality: qualityBand });
      problems = problemsOf(checks);
      const q = newQueue();
      // Build list 4, item 3: the film's limit ends the optional repair work, never the film
      let done: string[] = [];
      let changed: { shots: Set<string>; all: boolean } = { shots: new Set(), all: false };
      try {
        done = problems.length ? await ladders.step(problems, makeAct(q, () => checks, defects)) : [];
        if (rewriteBrief) break;
        if (q.kitChanged) for (const sc of scenePlan.scenes) stale.add(sc.shotId);
        changed = await flush(q, done);
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
        log(`  preflight: ${err.message} — no more repairs; the film goes on with what is left logged`);
        break;
      }
      for (const id of changed.all ? scenePlan.scenes.map((x) => x.shotId) : changed.shots) (stale.add(id), look2.add(id), touchedSinceTells.add(id));
      const failing = checks.filter((c) => !c.pass && c.level === "blocker");
      rounds.push({ round, failing: failing.map((c) => c.id), repairs: done });
      log(`  preflight round ${round + 1}: ${checks.filter((c) => c.pass).length}/${checks.length} checks pass${failing.length ? ` — failing: ${failing.map((c) => c.id).join(", ")}` : ""}${done.length ? ` → ${done.join(", ")}` : ""}`);
      if (!done.length) break;
    }
    await ladders.close(problems);
    if (rewriteBrief) return toWriter();
    const blockers = checks.filter((c) => !c.pass && c.level === "blocker");
    const advisory = checks.filter((c) => !c.pass && c.level === "advisory");
    await writeFile(preFile, JSON.stringify({ at: new Date().toISOString(), pass: blockers.length === 0, rounds, blockers: blockers.map((c) => c.id), advisory: advisory.map((c) => c.id), checks }, null, 2) + "\n");
    for (const c of blockers) log(`  ✗ ${c.label}: ${c.value} (target ${c.target})${c.note ? ` — ${c.note}` : ""}`);
    for (const c of advisory) log(`  ~ ${c.label}: ${c.value} (target ${c.target}) — reported, no automatic repair`);
    log(blockers.length ? `  preflight: ${blockers.length} check(s) still fail after every repair the ladders had — rendering with them logged (preflight.json, and the QA verdict)` : `  preflight: ready to render${advisory.length ? ` (${advisory.length} advisory note(s))` : ""}`);
  }
  if (stop("manifest")) return { jobDir };
  // Build list 4, item 3: a film always renders. Problems the ladders could not fix are logged in preflight.json and
  // carried into QA (check `preflight_unresolved`, which keeps the verdict from "pass"); they never stop the film.
  const preUnresolved = await readFile(preFile, "utf8").then((t) => JSON.parse(t) as { pass: boolean; blockers: string[] }, () => null);
  // atmospheres the gate's redesigns added or changed
  await placeAtmosphere();
  manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
  await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // the reserve is for the finish: render, QA, packaging
  setFinishing(true);

  // H33: the publishing package needs only the final plan (facts, narration, design, pictures), not the rendered
  // film — it starts now and runs beside the render (its thumbnail renders in its own folder, thumb-public/).
  let thumbnailPath: string | null = path.join(jobDir, "thumbnail.jpg");
  const needPackage = redo("thumbnail") || !(await exists(thumbnailPath)) || !(await exists(path.join(jobDir, "publish.json")));
  const startPackage = () => buildPublishingPackage({ jobDir, data: o.data, library: o.library, channel, job: jobId, facts, script: timed, design, resolution, board, index, publicDir: pub, log: (x: string) => log(`  [package] ${x.trimStart()}`) }).catch((err: Error) => {
    log(`  ! publishing package failed: ${err.message.slice(0, 160)}`);
    return { thumbnailPath: null as string | null, usd: 0 };
  });
  const packageP = needPackage && !stop("render") ? (log("\n[C3] publishing package — started beside the render"), inFilmStage("C3", () => startPackage())) : null;
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

  // The finished film is reviewed (C4 QA, C4v viewer, C4j final-cut judge); what they find climbs the finished film's
  // ladders (C5): its owner fixes it and only the stretches that changed are rendered again, then it is reviewed again.
  const review = async () => {
    let viewer: Awaited<ReturnType<typeof qaAgent>> | null = null;
    let fj: Awaited<ReturnType<typeof judgeClips>> | null = null;
    log("\n[C4] QA");
    const qa = await runQA({ finalPath, srtPath, thumbnailPath, manifest, resolution, script: timed, facts, profile: pack.profile, index, jobDir, log });
    {
      const st = await readFile(storyFile, "utf8").then((t) => JSON.parse(t) as StoryReport, () => null);
      if (st && !st.pass) {
        qa.report.checks.push({ id: "story_band", severity: "major", passed: false, message: `the script missed the channel's story band: ${st.remaining.map((x) => `${x.kind} (${x.detail.slice(0, 80)})`).join("; ")}`, measured: st.remaining.length, atFrames: [] });
        if (qa.report.verdict === "pass") qa.report.verdict = "review";
      }
    }
    // the hand film's measures on the whole finished film: moving not cutting, never still, words held until read
    const flow = await filmFlow({ root: o.root, data: o.data, channel, film: finalPath, durationS: timed.durationS }).catch(() => null);
    if (flow?.band) {
      qa.report.checks.push({ id: "flow", severity: "major", passed: flow.issues.length === 0, message: `${flow.summary.replace(/\n/g, "; ")}${flow.issues.length ? ` — OUTSIDE the channel's band: ${flow.issues.map((x) => x.detail).join(" | ").slice(0, 400)}` : ""}`, measured: flow.motion?.softShare ?? 0, atFrames: (flow.text?.rushed ?? []).map((x) => Math.round(x.atS * manifest.fps)) });
      if (flow.issues.length && qa.report.verdict === "pass") qa.report.verdict = "review";
    }
    // build list 6 (Wirecard v6 → v7): how the finished film sets its words — boxed labels, one size, words everywhere
    const typed = existsSync(finalPath) ? await runTypeCheck({ root: o.root, channel, film: finalPath }).catch(() => null) : null;
    if (typed) {
      for (const c of typeItems(typed)) qa.report.checks.push({ id: c.id, severity: c.level === "blocker" ? "major" : "minor", passed: c.pass, message: `${c.label}: ${c.value} (${c.target})${c.note ? ` — ${c.note}` : ""}`.slice(0, 600) } as never);
      if (typeItems(typed).some((c) => !c.pass && c.level === "blocker") && qa.report.verdict === "pass") qa.report.verdict = "review";
    }
    // build list 6: the finished film's world against the channel's bands and every earlier film (it then joins that memory)
    const world = await filmWorld({ root: o.root, jobId, film: finalPath, timedPath: path.join(jobDir, "timed-script.json"), durationS: timed.durationS, board }).catch(() => null);
    if (world) {
      for (const c of world.checks) qa.report.checks.push({ id: c.id, severity: "major", passed: c.pass, message: `${c.label}: ${c.value} (${c.target})${c.note ? ` — ${c.note}` : ""}`.slice(0, 900) } as never);
      if (world.checks.some((c) => !c.pass) && qa.report.verdict === "pass") qa.report.verdict = "review";
    }
    if (preUnresolved && !preUnresolved.pass) {
      qa.report.checks.push({ id: "preflight_unresolved", severity: "major", passed: false, message: `rendered with ${preUnresolved.blockers.length} preflight check(s) the ladders could not fix: ${preUnresolved.blockers.join(", ")} (see preflight.json, ladders.jsonl)`, measured: preUnresolved.blockers.length, atFrames: [] });
      if (qa.report.verdict === "pass") qa.report.verdict = "review";
    }
    // [C4v] Viewer QA (B10): an agent watches the finished file start to end like a viewer and notes what a viewer
    // would notice. Its verdict can only make the film's verdict stricter.
    if (existsSync(finalPath)) try {
      log("\n[C4v] viewer QA");
      const qaText = qa.report.checks.map((c) => `${c.passed ? "✓" : "✗"} [${c.severity}] ${c.id}: ${c.message}`).join("\n");
      viewer = await qaAgent({ channel, title: draft.title, durationS: timed.durationS, qaText, shots: board.shots.map((x) => ({ id: x.id, startS: x.startS, endS: x.endS })), words: timed.segments.flatMap((sg) => sg.words), watch: async (a, b) => {
        const w = await watchFile({ video: finalPath, fromS: a, toS: b, outDir: path.join(jobDir, "watch") });
        // step 2: the detectors on the finished file's stretch (cut out once, measured like any other stretch)
        const seg = path.join(jobDir, "watch", `final_${a.toFixed(1)}_${b.toFixed(1)}.mp4`);
        if (!existsSync(seg)) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", a.toFixed(2), "-t", (b - a).toFixed(2), "-i", finalPath, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-an", seg]).catch(() => null);
        const ins = existsSync(seg) ? await inspectStretch({ clip: { file: seg, fromS: a, toS: b }, scenes: scenePlan.scenes as never, shots: board.shots, narration: timed.voice.audioPath, root: o.root, data: o.data, channel, aspect: o.aspect as "16:9" | "9:16" }).catch(() => null) : null;
        return { strip: w.strip, text: `${w.text}${ins ? `\n${ins.text}` : ""}` };
      }, memoryDir: path.join(o.data, "agents", "qa"), log });
      await writeFile(path.join(jobDir, "qa.viewer.json"), JSON.stringify(viewer, null, 2) + "\n");
      const rank = { pass: 0, review: 1, fail: 2 } as const;
      const v = viewer;
      const worst = (rank[v.verdict] > rank[qa.report.verdict] ? v.verdict : qa.report.verdict);
      qa.report.checks.push({ id: "viewer", severity: v.verdict === "fail" ? "blocker" : "major", passed: v.verdict === "pass", message: `${v.summary.slice(0, 300)}${v.issues.length ? ` — ${v.issues.length} issue(s): ${v.issues.slice(0, 4).map((x) => `${x.atS.toFixed(1)} s ${x.what.slice(0, 60)} (${x.owner})`).join("; ")}` : ""}`, measured: v.watchedShare, atFrames: v.issues.map((x) => Math.round(x.atS * manifest.fps)) });
      qa.report.verdict = worst;
    } catch (err) {
      if (!(err instanceof BudgetError)) throw err;
      log(`  viewer QA skipped: ${err.message}`);
      qa.report.checks.push({ id: "viewer", severity: "major", passed: false, message: `not watched: ${err.message}`, measured: 0, atFrames: [] });
      if (qa.report.verdict === "pass") qa.report.verdict = "review";
    }
    // [C4j] Final-cut judge (build list 2, step 7): independent of every agent that made the film — the finished film in
    // 8-second stretches, each blind beside two real channel stretches close in meaning. A film the judge picks out
    // clearly more often than it picks out real stretches is not released.
    if (existsSync(finalPath)) {
      log("\n[C4j] final-cut judge");
      const allW = timed.segments.flatMap((sg) => sg.words);
      const clips: Array<{ fromS: number; toS: number; said: string }> = [];
      for (let t = 0; t + 6 < timed.durationS; t += 8) clips.push({ fromS: t, toS: Math.min(timed.durationS, t + 8), said: allW.filter((w) => w.startS >= t && w.startS < t + 8).map((w) => w.word).join(" ") });
      fj = await judgeClips({ data: o.data, reference: o.reference, root: o.root, channel, video: finalPath, clips, workDir: path.join(jobDir, "final-judge"), log: () => {} }).catch(() => null);
      if (fj && fj.clips.length) {
        const picked = fj.clips.filter((c) => c.picked).length / fj.clips.length;
        const fair = fj.calibration?.realPickedAsImitation ?? 1 / 3;
        const pass = picked <= fair + 0.2;
        await writeFile(path.join(jobDir, "final-judge.json"), JSON.stringify(fj, null, 2) + "\n");
        qa.report.checks.push({ id: "final_cut", severity: "minor", passed: true, message: `picked out as the imitation in ${fj.clips.filter((c) => c.picked).length} of ${fj.clips.length} stretches (a real stretch: ${Math.round(fair * 100)} %); realness ${fj.realness}, trained taste ${fj.taste ?? "?"}${pass ? "" : ` — tells: ${[...new Set(fj.clips.flatMap((c) => c.tells))].slice(0, 4).join("; ")}`}`, measured: Math.round(picked * 100) / 100, atFrames: fj.clips.filter((c) => c.picked).map((c) => Math.round(c.fromS * manifest.fps)) });
        // advisory only: on held-back channel films the blind judge was no better than chance (referee, 2026-11-26)
        log(`  final-cut judge (advisory): ${pass ? "PASS" : "VETO"} — picked out in ${Math.round(picked * 100)} % of stretches (real: ${Math.round(fair * 100)} %)`);
      }
    }
    return { qa, viewer, fj };
  };
  let rv = await review();
  {
    const post = new Ladders<Act>({ jobDir, stage: "finished film", table: FINISHED_LADDERS, log });
    const fps = manifest.fps;
    const shotAt = (sec: number) => board.shots.find((x) => sec >= x.startS && sec < x.endS)?.id ?? board.shots.at(-1)!.id;
    const problemsOf = (r: typeof rv): Problem[] => {
      const out: Problem[] = [];
      for (const c of r.qa.report.checks.filter((x) => !x.passed && (x.severity === "blocker" || x.severity === "major") && ["black_frames", "frozen_frames", "blank_frames"].includes(x.id))) out.push({ check: "qa_picture", shots: [...new Set(c.atFrames.map((f) => shotAt(f / fps)))], what: c.message.slice(0, 200), measured: String(c.measured ?? ""), band: c.expected ?? "" });
      const byOwner = new Map<string, Array<{ atS: number; what: string; shotId: string | null }>>();
      for (const i of (r.viewer?.issues ?? []).filter((x) => x.severity >= 5 && x.fix !== "none")) (byOwner.get(i.owner) ?? byOwner.set(i.owner, []).get(i.owner)!).push(i);
      for (const [owner, is] of byOwner) out.push({ check: `viewer_${owner.replace(/\s+/g, "_")}`, shots: [...new Set(is.map((i) => i.shotId ?? shotAt(i.atS)))], what: is.map((i) => `${i.atS.toFixed(1)} s: ${i.what}`).join("; ").slice(0, 400), measured: `${is.length} issue(s)`, band: "0" });
      const fjc = r.qa.report.checks.find((x) => x.id === "final_cut" && !x.passed);
      if (fjc && r.fj) out.push({ check: "final_cut", shots: [...new Set(r.fj.clips.filter((c) => c.picked).flatMap((c) => board.shots.filter((x) => x.endS > c.fromS && x.startS < c.toS).map((x) => x.id)))].slice(0, 3), what: `picked out as the imitation — tells: ${[...new Set(r.fj.clips.flatMap((c) => c.tells))].slice(0, 4).join("; ")}`, measured: String(fjc.measured ?? ""), band: "≤ a real stretch + 0.2" });
      return out.filter((p) => p.shots.length);
    };
    let problems = problemsOf(rv);
    // Build list 4: ONE round on the finished film (three rounds took 25 of the proof film's 56 minutes, each with a
    // 2.5-minute final-cut judge); what it leaves is logged in the verdict.
    for (let round = 0; round < 1 && problems.length && existsSync(finalPath); round++) {
      log(`\n[C5] the finished film's ladders, round ${round + 1}: ${problems.map((p) => `${p.check} (${p.shots.join(", ")})`).join("; ")}`);
      const q = newQueue();
      const viewerNotes = new Map<string, string[]>();
      for (const i of rv.viewer?.issues ?? []) { const id = i.shotId ?? shotAt(i.atS); viewerNotes.set(id, [...(viewerNotes.get(id) ?? []), i.what]); }
      const sig = (m: RenderManifest) => new Map(board.shots.map((x) => [x.id, JSON.stringify(m.video.filter((l) => l.shotId === x.id))] as [string, string]));
      const before = sig(manifest);
      const beforeFrames = manifest.durationFrames;
      let done: string[] = [];
      let ch: { shots: Set<string>; all: boolean };
      try {
        done = await post.step(problems, makeAct(q, () => [], viewerNotes));
        if (rewriteBrief) return toWriter();
        if (!done.length) break;
        ch = await flush(q, done);
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
        log(`  finished film: ${err.message} — no more repairs; the film is delivered with what is left logged`);
        break;
      }
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
      await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      const after = sig(manifest);
      const changed = board.shots.filter((x) => before.get(x.id) !== after.get(x.id) || ch.shots.has(x.id));
      const lookR = lookFromProfile(pack.profile.look, design.palette.primarySoft);
      if (ch.all || manifest.durationFrames !== beforeFrames || changed.length > board.shots.length * 0.6) await renderVideo({ manifest, look: lookR, design, publicDir: pub, out: silent, log });
      else if (changed.length) await renderStretches({ manifest, look: lookR, design, publicDir: pub, previous: silent, out: silent, ranges: changed.map((x) => [Math.round(x.startS * fps) - 12, Math.round(x.endS * fps) + 12] as [number, number]), log });
      const loud = await masterAudio(manifest, master);
      log(`  master: ${loud.integratedLufs} LUFS, TP ${loud.truePeakDb} dBTP`);
      await muxFinal(silent, master, finalPath);
      rv = await review();
      problems = problemsOf(rv);
    }
    await post.close(problems);
  }
  const qa = rv.qa;
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

  // Build list 5, item 4: every agent's craft score against real stretches as long as this film (craft.json)
  log("\n[C6] craft scores against the reference");
  {
    const jp = await readFile(path.join(jobDir, "judge-previews.json"), "utf8").then((t) => JSON.parse(t) as { realness?: number | null }, () => null);
    // craft inventory: the film's coverage of the channel's techniques joins the platform's open list
    if (finalPath) {
      const inv = await loadInventory(o.data, channel).catch(() => null);
      if (inv) {
        const allW = timed.segments.flatMap((sg) => sg.words);
        const cov = await techniqueCoverage({ data: o.data, reference: o.reference, channel, video: finalPath, workDir: path.join(jobDir, "techniques"), taxonomy: inv.taxonomy, band: inv.band, tools: inv.tools, said: (a, b) => allW.filter((w) => w.startS >= a && w.startS < b).map((w) => w.word).join(" "), events: manifestEvents(manifest as never) }).catch(() => null);
        if (cov) {
          await writeFile(path.join(jobDir, "techniques.json"), JSON.stringify({ at: new Date().toISOString(), rows: cov }, null, 1) + "\n");
          const open = await recordCoverage({ data: o.data, channel, job: jobId, rows: cov });
          log(`  craft inventory: ${cov.filter((r) => r.verdict === "ok").length} of ${cov.filter((r) => r.verdict !== "rare").length} channel techniques used at the channel's rate; open: ${open.slice(0, 8).map((x) => `${x.name} (${x.verdict === "missing_tool" ? "no tool" : "unused"})`).join("; ")}`);
        }
      }
    }
    await craftReport({ root: o.root, data: o.data, reference: o.reference, jobDir, channel, draft, timed, board, scenes: scenePlan, resolution, judge: true, pictureRealness: jp?.realness ?? null, log }).catch((e: Error) => log(`  ! craft scores failed: ${e.message.slice(0, 160)}`));
  }

  const spent = usageLedger().reduce((t, r) => t + r.usd, 0);
  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s — Claude spend this run $${spent.toFixed(4)}`);
  return { jobDir, finalPath, report };
}
