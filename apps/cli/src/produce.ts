import { copyFile, readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { ChannelId, FilmDesignSystem, LicenseOverrides, ScenePlan, FactSheet, LibraryIndex, RenderManifest, ResolutionReport, ScriptDraft, Storyboard, TimedScript, type Aspect } from "@opumia/contracts";
import { artDirect, critiqueScenes, designScenes, recentTreatments, recordTreatment, type SceneExemplar, blockAsset, blockedRefs, badQueries, buildStylePack, chapterCount, directStoryboard, gateReview, loadMemory, recentBlueprints, recordBlueprint, researchTopic, thumbnailBrief, thumbnailStyle, updateMemory, usageLedger, writeScript } from "@opumia/agents";
import { calibrationKey, narrate, narrateDirected, readCalibration, resolveChannelVoice, tempoFit, writeCalibration } from "@opumia/narration";
import { repairShots, resolveAssets } from "@opumia/resolver";
import { cooldownRefs, eraOfFacts, recordUsage } from "./asset-usage.js";
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

export async function produce(o: ProduceOptions) {
  const jobId = o.job ?? `${slug(o.topic)}-${ChannelId.parse(o.channel)}-${o.aspect.replace(":", "x")}`;
  const jobDir = path.join(o.root, "out", jobId);
  const before = usageLedger().length;
  try {
    return await produceStages({ ...o, job: jobId });
  } finally {
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
  log("\n[A1b] art direction");
  const design = await cachedJson(path.join(jobDir, "design.json"), FilmDesignSystem, redo("research"), async () => artDirect({ facts, pack, acts: short ? 1 : chapterCount(o.durationS), recent: (await recentTreatments(o.data)).filter((r) => r.job !== jobId), log }), log);
  if (design.treatment) await recordTreatment(o.data, { job: jobId, channel, headline: design.treatment.headline, phrase: design.treatment.phrase, world: design.treatment.world, particles: design.treatment.particles, photo: design.treatment.photo, label: design.treatment.label, display: design.typography.display, primary: design.palette.primary, accent: design.palette.accent });
  log(`  "${design.concept}" — ${design.palette.primary} / ${design.palette.accent} on ${design.palette.surface}, ${design.typography.display}`);
  const memory = await loadMemory(o.data);
  if (stop("research")) return { jobDir };

  log("\n[A2] script");
  const voice = await resolveChannelVoice(channel, o.data, log);
  const ttsModel = process.env.OPUMIA_TTS_MODEL ?? "eleven_multilingual_v2";
  const calKey = calibrationKey(voice, ttsModel);
  const calFile = await readCalibration(o.data);
  const cal = calFile as Record<string, { wpm: number; samples: number } | undefined>;
  // Words per minute this voice actually speaks (measured on earlier narrations); conservative default until calibrated.
  const ovPath = path.join(o.data, "license-overrides.json");
  const overrides = (await exists(ovPath)) ? LicenseOverrides.parse(JSON.parse(await readFile(ovPath, "utf8"))) : null;
  const maxWpm = overrides?.channels[channel]?.maxWpm ?? Infinity;
  const narrationWpm = Math.round(Math.min(cal[calKey]?.wpm ?? 145, maxWpm));
  const narrationTargetS = short ? o.durationS - 3 : o.durationS;
  let draft = await cachedJson(path.join(jobDir, "script.draft.json"), ScriptDraft, redo("script"), () => writeScript({ pack, facts, aspect: o.aspect, durationS: narrationTargetS, narrationWpm, recent: recentBlueprints(memory, channel), log }), log);
  log(`  "${draft.title}" — ${draft.wordCount} words at ${narrationWpm} wpm (${cal[calKey] ? "calibrated" : "default"}), hook: ${draft.hookFormula.slice(0, 80)}`);
  if (draft.blueprint) await updateMemory(o.data, (m) => recordBlueprint(m, channel, { job: jobId, hook: draft.blueprint!.hook, ending: draft.blueprint!.ending, spine: draft.blueprint!.spine }));
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
  // Small overshoot (≤ 6 %) is tempo-fitted below instead of re-writing (saves a TTS call).
  if (timed.durationS > maxS * 1.06 || timed.durationS < minS) {
    const words = timed.segments.reduce((n, sg) => n + sg.words.length, 0);
    const span = (timed.segments.at(-1)?.endS ?? timed.durationS) - (timed.segments[0]?.startS ?? 0);
    const measured = (words / Math.max(1, span)) * 60; // this script's own pace is the best predictor for its re-write
    log(`  ! narration ${timed.durationS.toFixed(1)} s outside ${minS}–${maxS} s; voice spoke ${measured.toFixed(1)} wpm → re-writing to fit and re-narrating once`);
    draft = await cachedJson(path.join(jobDir, "script.draft.json"), ScriptDraft, true, () => writeScript({ pack, facts, aspect: o.aspect, durationS: narrationTargetS, narrationWpm: Math.floor(measured * 0.98), ...(draft.blueprint ? { blueprint: draft.blueprint } : {}), log }), log);
    log(`  "${draft.title}" — ${draft.wordCount} words`);
    timed = await cachedJson(timedPath, TimedScript, true, doNarrate, log);
    await recordCalibration(timed);
  }
  if (timed.durationS > maxS && timed.durationS <= maxS * 1.06) {
    timed = await tempoFit(timed, maxS - 0.5, log);
    await writeFile(timedPath, JSON.stringify(timed, null, 2) + "\n");
  }
  {
    if (timed.durationS > maxS) throw new Error(`narration still ${timed.durationS.toFixed(1)} s after one re-fit; shorten the script or raise voice speed`);
  }
  log(`  narration ${timed.durationS.toFixed(2)} s, ${timed.segments.length} segments`);
  if (stop("narration")) return { jobDir };

  // ---- Stage B: director → resolver
  log("\n[B1] storyboard director");
  let board = await cachedJson(path.join(jobDir, "storyboard.json"), Storyboard, redo("storyboard"), () => directStoryboard({ pack, script: timed, facts, index, avoidQueries: badQueries(memory), log }), log);
  const designed = board.shots.filter((s) => s.source.kind === "designed").length;
  log(`  ${board.shots.length} shots (${designed} designed), ${board.shots.reduce((n, s) => n + s.sfx.length, 0)} sfx cues`);
  if (stop("storyboard")) return { jobDir };

  log("\n[B2] asset resolver (library first → stock/archival)");
  let resolution = await cachedJson(path.join(jobDir, "resolution.json"), ResolutionReport, redo("resolve"), async () => {
    // Blocked = pictures earlier films rejected + everything the last films used (cross-film cooldown).
    const cool = await cooldownRefs(o.data, jobId);
    const blocked = new Set([...blockedRefs(memory), ...cool.pictures]);
    log(`  cooldown: ${cool.pictures.size} picture ref(s) used by recent films are off limits`);
    return resolveAssets({ storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: timed.segments.flatMap((sg) => sg.words), blocked, era: eraOfFacts(facts), factText: facts.claims.map((c) => c.text).join(" "), sources: new Map(timed.segments.map((sg) => [sg.id, sg.claims ?? []])), log });
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
  let scenePlan = await cachedJson(sceneFile, ScenePlan, freshScenes, () => designScenes({ storyboard: board, script: timed, resolution, design, channel, exemplars, people: (facts.story?.characters ?? []).map((c) => c.name), log }), log);
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
  if (!short) await writeFile(path.join(jobDir, "youtube-description.txt"), youtubeDescription(timed, facts));
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
      scenePlan = await designScenes({ storyboard: board, script: timed, resolution, design, channel, exemplars, people: (facts.story?.characters ?? []).map((c) => c.name), issues, previous: scenePlan, log });
      await writeFile(sceneFile, JSON.stringify(scenePlan, null, 2) + "\n");
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, ...mopts() });
      await writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    await writeFile(reviewFile, JSON.stringify({ previewed: prev.length, flagged: Object.fromEntries(issues) }, null, 2) + "\n");
  }
  if (stop("manifest")) return { jobDir };

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

  log("\n[C3] thumbnail (Higgsfield)");
  let thumbnailPath: string | null = path.join(jobDir, "thumbnail.jpg");
  if (redo("thumbnail") || !(await exists(thumbnailPath))) {
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
