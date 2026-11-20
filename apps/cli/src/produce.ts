import { copyFile, readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { ChannelId, FilmDesignSystem, LicenseOverrides, FactSheet, LibraryIndex, RenderManifest, ResolutionReport, ScriptDraft, Storyboard, TimedScript, type Aspect } from "@opumia/contracts";
import { artDirect, blockAsset, blockedRefs, badQueries, buildStylePack, chapterCount, directStoryboard, gateReview, loadMemory, recentBlueprints, recordBlueprint, researchTopic, thumbnailBrief, thumbnailStyle, updateMemory, usageLedger, writeScript } from "@opumia/agents";
import { calibrationKey, narrate, readCalibration, resolveChannelVoice, tempoFit, writeCalibration } from "@opumia/narration";
import { repairShots, resolveAssets } from "@opumia/resolver";
import { youtubeDescription, buildManifest, captionGroups, higgsfieldConfig, higgsfieldImage, lookFromProfile, masterAudio, muxFinal, pickGateFrames, renderGateStills, renderLocalThumbnail, renderThumbnailStill, renderVideo, runQA, toSrt } from "@opumia/motion-engine";

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
  const facts = await cachedJson(path.join(jobDir, "facts.json"), FactSheet, redo("research"), () => researchTopic({ topic: o.topic, format: short ? `${o.durationS}-second vertical short` : "long-form documentary", minClaims: short ? 10 : Math.min(40, Math.round(12 + o.durationS / 12)), log }), log);
  // Art direction: a unique FilmDesignSystem for this film (palette, type, texture, per-act grades, scene grammar).
  log("\n[A1b] art direction");
  const design = await cachedJson(path.join(jobDir, "design.json"), FilmDesignSystem, redo("research"), () => artDirect({ facts, pack, acts: short ? 1 : chapterCount(o.durationS), log }), log);
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
    return (await narrate({ draft, facts, outDir: jobDir, libraryRoot: o.library, voice, modelId: ttsModel, log })).script;
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
  let resolution = await cachedJson(path.join(jobDir, "resolution.json"), ResolutionReport, redo("resolve"), () => resolveAssets({ storyboard: board, index, libraryRoot: o.library, jobDir, narration: timed.segments.map((sg) => sg.text).join(" "), words: timed.segments.flatMap((sg) => sg.words), blocked: blockedRefs(memory), log }), log);
  if (stop("resolve")) return { jobDir };

  // ---- Stage C: manifest → render → master → mux
  log("\n[C1] render manifest");
  const finalName = `${slug(draft.title) || jobId}_${o.aspect.replace(":", "x")}.mp4`;
  const finalPath = path.join(jobDir, finalName);
  let manifest = await cachedJson(path.join(jobDir, "manifest.json"), RenderManifest, redo("manifest") || redo("resolve") || redo("storyboard"), () => buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: finalPath, narrationPath: timed.voice.audioPath, log, minRepeatGapS: design.sceneGrammar.minRepeatGapS }), log);
  const srtPath = path.join(jobDir, "captions.srt");
  await writeFile(srtPath, toSrt(captionGroups(timed)));
  if (!short) await writeFile(path.join(jobDir, "youtube-description.txt"), youtubeDescription(timed, facts));
  log(`  ${manifest.video.length} video layers, ${manifest.audio.length} audio layers, ${manifest.durationFrames} frames @ ${manifest.fps} fps; captions.srt written`);
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
        if (b.fix === "drop_graphic" && sh.source.kind === "designed") {
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
      manifest = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: o.library, outputPath: finalPath, narrationPath: timed.voice.audioPath, log, minRepeatGapS: design.sceneGrammar.minRepeatGapS });
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
    const m2 = await buildManifest({ storyboard: board, script: timed, resolution: repaired, libraryRoot: o.library, outputPath: finalPath, narrationPath: timed.voice.audioPath, log, minRepeatGapS: design.sceneGrammar.minRepeatGapS });
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
    const m2 = await buildManifest({ storyboard: board, script: timed, resolution: repaired, libraryRoot: o.library, outputPath: finalPath, narrationPath: timed.voice.audioPath, log, minRepeatGapS: design.sceneGrammar.minRepeatGapS });
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
