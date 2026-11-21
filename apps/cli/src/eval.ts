/**
 * Platform evaluation: the blind reference test.
 *
 *   opumia eval calibrate --channel magnates-media      check the judge on degraded reference windows
 *   opumia eval score out/<job> [out/<job> …]            score finished films against the reference
 *   opumia eval run --set core [--only a,b] [--concurrency 2] [--no-produce]
 *                                                        produce every film of eval/sets/<set>.json, score, report
 *
 * Every film is cut into short windows (picture track: frames + narration + edit stats; story track: narration
 * passages). Each is paired with a real reference window of the same position and shown blind, A/B, to the judge.
 * realness = the judge's probability that OUR window is the real channel film (0.5 = indistinguishable).
 * Reference/ and Library/ are only read (ffmpeg input). Everything generated goes to data/eval/.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { blandRewrite, JUDGE_VERSION, RefusalError, judgePictureBlind, judgeSameness, judgeStoryBlind, type BlindResult, type EvalWindow } from "@opumia/agents";
import { contactSheet, grabFrames, measureLook } from "@opumia/senses";
import { buildExemplars, loadExemplars } from "./exemplars.js";
import { filmFacts, filmMetrics, type FilmFacts } from "./slop.js";
import { Calibration, EvalReport, EvalSet, TimedScript, type EvalPair, type FilmScore } from "@opumia/contracts";
import { CHANNELS, discoverVideos } from "@opumia/ingest";

const run = promisify(execFile);
const WINDOW_S = 20;
const STORY_S = 45;
const SPONSOR = /\b(sponsor|sponsored|link in the description|patreon|skillshare|brilliant\.org|nordvpn|audible|squarespace|surfshark|brought to you by|use code|promo code|subscribe)\b/i;

interface Ctx {
  root: string;
  library: string;
  reference: string;
  data: string;
  log: (s: string) => void;
}
interface Word { word: string; start: number; end: number }
interface Source { id: string; video: string; words: Word[]; durationS: number; label: string }

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const r3 = (n: number) => Math.round(n * 1000) / 1000;
async function atomicJson(file: string, v: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(v, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
}
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
const probeDur = async (f: string) => Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout.trim());

// ---------------------------------------------------------------------------------------------------------
// Windows

/**
 * One window of a video as the judge sees it: two motion sheets (16 evenly spaced frames), three detail frames,
 * the narration, and same-method measurements (cuts, brightness, colourfulness, movement). Cached by size/mtime.
 */
async function extractWindow(ctx: Ctx, src: Source, t0: number, dur: number): Promise<EvalWindow> {
  const st = await stat(src.video);
  const key = sha(`v3|${src.video}|${st.size}|${st.mtimeMs}|${t0.toFixed(2)}|${dur}`);
  const dir = path.join(ctx.data, "eval", ".cache", "windows", key);
  const cached = await readJson<EvalWindow>(path.join(dir, "window.json"));
  if (cached && cached.frames.every((f) => existsSync(f.path)) && (cached.sheets ?? []).every((f) => existsSync(f))) return cached;
  await mkdir(dir, { recursive: true });
  const small = await grabFrames(src.video, dir, { ss: t0, t: dur, n: 16, width: 480, prefix: "s" });
  const sheets = [await contactSheet(small.slice(0, 8), path.join(dir, "sheet0.jpg"), { cols: 4, cellW: 480 }), await contactSheet(small.slice(8), path.join(dir, "sheet1.jpg"), { cols: 4, cellW: 480 })];
  const detail = await grabFrames(src.video, dir, { ss: t0, t: dur, n: 3, width: 960, prefix: "d" });
  const look = await measureLook(src.video, { ss: t0, t: dur, fps: 5 });
  const words = src.words.filter((w) => w.start >= t0 && w.start < t0 + dur);
  const w: EvalWindow = { frames: detail.map((p, k) => ({ path: p, t: r3((dur / 3) * (k + 0.5)) })), sheets, look: { luma: look.luma, colourfulness: look.colourfulness, motion: look.motion, stillShare: look.stillShare }, text: words.map((x) => x.word).join(" ").trim(), stats: { seconds: dur, cuts: Math.round((look.cutsPerMin * dur) / 60), wpm: (words.length / dur) * 60 } };
  await atomicJson(path.join(dir, "window.json"), w);
  return w;
}

const textAt = (src: Source, t0: number, dur: number) => src.words.filter((w) => w.start >= t0 && w.start < t0 + dur).map((w) => w.word).join(" ").trim();

/** Start a reference window at a relative position, skipping sponsor reads and the end screen. */
function refStart(src: Source, frac: number, dur: number): number | null {
  if (frac === 0) return SPONSOR.test(textAt(src, 0, dur)) ? null : 0;
  for (let k = 0; k < 8; k++) {
    const t0 = Math.min(src.durationS - 45 - dur, src.durationS * frac + k * 25);
    if (t0 < 30) return null;
    // Snap to the next word start after a sentence end so the window opens on a sentence.
    const i = src.words.findIndex((w, j) => w.start >= t0 && j > 0 && /[.!?]$/.test(src.words[j - 1]!.word));
    const s = i >= 0 ? src.words[i]!.start : t0;
    if (!SPONSOR.test(textAt(src, s, dur))) return s;
  }
  return null;
}

async function referencePool(ctx: Ctx, channel: string): Promise<Source[]> {
  const ch = CHANNELS.find((c) => c.id === channel);
  if (!ch) throw new Error(`unknown channel ${channel}`);
  const vids = (await discoverVideos(ctx.reference, ch)).filter((v) => v.videoFile && v.transcriptFile).sort((a, b) => a.relDir.localeCompare(b.relDir));
  const out: Source[] = [];
  for (const v of vids) {
    const p = await readJson<{ words?: Word[] }>(v.transcriptFile!);
    if (!p?.words?.length) continue;
    out.push({ id: v.ytId, video: v.videoFile!, words: p.words, durationS: v.durationS ?? (await probeDur(v.videoFile!)), label: v.title });
  }
  if (out.length < 4) throw new Error(`${channel}: only ${out.length} reference films with video + transcript`);
  return out;
}

async function filmSource(jobDir: string): Promise<Source & { job: { topic: string; channel: string; aspect: string; durationS: number } }> {
  const job = await readJson<{ topic: string; channel: string; aspect: string; durationS: number }>(path.join(jobDir, "job.json"));
  if (!job) throw new Error(`${jobDir}: no job.json`);
  const files = await readdir(jobDir);
  const final = files.filter((f) => /_(16x9|9x16)\.mp4$/.test(f)).sort((a, b) => a.localeCompare(b));
  // Newest final render wins (a job can hold stale renders under an old title).
  let best: string | null = null;
  let bestT = -1;
  for (const f of final) {
    const t = (await stat(path.join(jobDir, f))).mtimeMs;
    if (t > bestT) [best, bestT] = [f, t];
  }
  if (!best) throw new Error(`${jobDir}: no final mp4`);
  const timed = TimedScript.parse(JSON.parse(await readFile(path.join(jobDir, "timed-script.json"), "utf8")));
  const words = timed.segments.flatMap((s) => s.words.map((w) => ({ word: w.word, start: w.startS, end: w.endS })));
  const video = path.join(jobDir, best);
  return { id: path.basename(jobDir), video, words, durationS: await probeDur(video), label: job.topic, job };
}

// ---------------------------------------------------------------------------------------------------------
// Pairs (cached by judge version + exact content, so re-runs are free and identical)

const pick = <T>(list: T[], seed: string, avoid: Set<T> = new Set()): T => {
  const pool = list.filter((x) => !avoid.has(x));
  const from = pool.length ? pool : list;
  return from[parseInt(sha(seed).slice(0, 8), 16) % from.length]!;
};
const side = (seed: string): "A" | "B" => (parseInt(sha(`ab|${seed}`).slice(0, 2), 16) % 2 ? "A" : "B");

async function cachedVerdict(ctx: Ctx, key: string, make: () => Promise<BlindResult>): Promise<BlindResult | null> {
  const file = path.join(ctx.data, "eval", ".cache", "pairs", `${sha(`${JUDGE_VERSION}|${key}`)}.json`);
  const hit = await readJson<BlindResult>(file);
  if (hit) return { ...hit, usd: 0 };
  let v: BlindResult | null = null;
  for (let attempt = 0; attempt < 2 && !v; attempt++) {
    try {
      v = await make();
    } catch (e) {
      if (!(e instanceof RefusalError)) throw e;
      ctx.log(`    judge declined a pair (${e.category ?? "unspecified"})${attempt ? ", skipped" : ", retrying"}`);
    }
  }
  if (!v) return null;
  await atomicJson(file, v);
  return v;
}

const windowKey = (w: EvalWindow) => `${w.frames.map((f) => path.basename(path.dirname(f.path))).join(",")}|${w.text}|${w.stats.cuts}`;

async function picturePair(ctx: Ctx, channel: string, o: { id: string; position: string; control: EvalPair["control"]; candidate: EvalWindow; candLabel: string; reference: EvalWindow; refLabel: string }): Promise<EvalPair | null> {
  const as = side(o.id);
  const [a, b] = as === "A" ? [o.candidate, o.reference] : [o.reference, o.candidate];
  const v = await cachedVerdict(ctx, `picture|${channel}|${windowKey(a)}|${windowKey(b)}`, () => judgePictureBlind({ channel, a, b }));
  return v && toPair(o.id, "picture", o.position, o.control, o.candLabel, o.refLabel, as, v);
}

async function storyPair(ctx: Ctx, channel: string, o: { id: string; position: string; control: EvalPair["control"]; candidate: string; candLabel: string; reference: string; refLabel: string }): Promise<EvalPair | null> {
  const as = side(o.id);
  const [a, b] = as === "A" ? [o.candidate, o.reference] : [o.reference, o.candidate];
  const v = await cachedVerdict(ctx, `story|${channel}|${o.position}|${a}|${b}`, () => judgeStoryBlind({ channel, position: o.position, a, b }));
  return v && toPair(o.id, "story", o.position, o.control, o.candLabel, o.refLabel, as, v);
}

function toPair(id: string, track: EvalPair["track"], position: string, control: EvalPair["control"], ours: string, reference: string, candidateAs: "A" | "B", v: BlindResult): EvalPair {
  return { id, track, position, control, ours, reference, candidateAs, pick: v.pick, confidence: v.confidence, realness: r3(v.pick === candidateAs ? v.confidence : 1 - v.confidence), tells: v.tells, usd: v.usd };
}

// ---------------------------------------------------------------------------------------------------------
// Calibration

const calFile = (ctx: Ctx, channel: string) => path.join(ctx.data, "eval", `calibration.${channel}.json`);

export async function calibrate(ctx: Ctx, channel: string, n = 4, fresh = false): Promise<Calibration> {
  const prev = await readJson<unknown>(calFile(ctx, channel));
  const parsed = prev ? Calibration.safeParse(prev) : null;
  if (!fresh && parsed?.success && parsed.data.judgeVersion === JUDGE_VERSION && parsed.data.pairs.length >= n * 4) return parsed.data;
  ctx.log(`  calibrating the blind judge for ${channel} (${n} samples per control)…`);
  const pool = await referencePool(ctx, channel);
  const modern = path.join(ctx.library, "cinematic", "modern");
  const foreign = (await readdir(modern).catch(() => [] as string[])).filter((f) => f.endsWith(".mp4")).sort();
  const pairs: EvalPair[] = [];
  const add = (p: EvalPair | null) => void (p && pairs.push(p));
  let usd = 0;
  const win = async (s: Source, frac: number, seed: string) => {
    const t0 = refStart(s, frac, WINDOW_S);
    return t0 === null ? null : { w: await extractWindow(ctx, s, t0, WINDOW_S), label: `${s.label} @ ${Math.round(t0)} s` };
  };
  for (let i = 0; i < n; i++) {
    const frac = [0, 0.3, 0.55, 0.8][i % 4]!;
    const used = new Set<Source>();
    const take = (tag: string) => {
      const s = pick(pool, `cal|${channel}|${i}|${tag}`, used);
      used.add(s);
      return s;
    };
    const real = await win(take("real"), frac, "real");
    const x = await win(take("x"), frac, "x");
    const y = await win(take("y"), frac, "y");
    if (!real || !x || !y) continue;
    const position = frac === 0 ? "cold_open" : `at ${Math.round(frac * 100)} %`;
    // 1. wrong_picture: real channel frames under narration from another film.
    add(await picturePair(ctx, channel, { id: `cal-wrong-${i}`, position, control: "wrong_picture", candidate: { ...x.w, text: y.w.text, stats: { ...x.w.stats, wpm: y.w.stats.wpm } }, candLabel: `frames of ${x.label} + narration of ${y.label}`, reference: real.w, refLabel: real.label }));
    // 2. foreign_picture: generic licensed stock under real narration.
    const fclip = foreign.length ? path.join(modern, pick(foreign, `cal|foreign|${i}`)) : null;
    if (fclip) {
      const fs: Source = { id: path.basename(fclip), video: fclip, words: [], durationS: await probeDur(fclip), label: path.basename(fclip) };
      const fw = await extractWindow(ctx, fs, 0, Math.min(WINDOW_S, Math.max(4, fs.durationS - 0.5)));
      add(await picturePair(ctx, channel, { id: `cal-foreign-${i}`, position, control: "foreign_picture", candidate: { ...fw, text: y.w.text, stats: { ...fw.stats, wpm: y.w.stats.wpm } }, candLabel: `stock ${fs.label} + narration of ${y.label}`, reference: real.w, refLabel: real.label }));
    }
    // 3. bland_script on the picture track: real frames, narration rewritten as template prose.
    const bland = await blandRewrite(x.w.text);
    usd += bland.usd;
    add(await picturePair(ctx, channel, { id: `cal-bland-pic-${i}`, position, control: "bland_script", candidate: { ...x.w, text: bland.text }, candLabel: `${x.label} with bland narration`, reference: real.w, refLabel: real.label }));
    // 4. real_vs_real: position bias and over-confidence check.
    add(await picturePair(ctx, channel, { id: `cal-rvr-pic-${i}`, position, control: "real_vs_real", candidate: x.w, candLabel: x.label, reference: real.w, refLabel: real.label }));
    // Story track controls.
    const sx = take("sx");
    const sr = take("sr");
    const sxT = refStart(sx, frac, STORY_S);
    const srT = refStart(sr, frac, STORY_S);
    if (sxT !== null && srT !== null) {
      const px = textAt(sx, sxT, STORY_S);
      const pr = textAt(sr, srT, STORY_S);
      const b2 = await blandRewrite(px);
      usd += b2.usd;
      add(await storyPair(ctx, channel, { id: `cal-bland-story-${i}`, position: frac === 0 ? "cold open" : "middle", control: "bland_script", candidate: b2.text, candLabel: `${sx.label} rewritten bland`, reference: pr, refLabel: sr.label }));
      add(await storyPair(ctx, channel, { id: `cal-rvr-story-${i}`, position: frac === 0 ? "cold open" : "middle", control: "real_vs_real", candidate: px, candLabel: sx.label, reference: pr, refLabel: sr.label }));
    }
    ctx.log(`    sample ${i + 1}/${n} judged`);
  }
  // Known-bad anchor: films a person already judged as clearly not reference quality (eval/known-bad.json).
  // A judge that lets them through is not measuring what a viewer sees.
  const kb = (await readJson<{ jobs: string[] }>(path.join(ctx.root, "eval", "known-bad.json")))?.jobs ?? [];
  const kbPairs: EvalPair[] = [];
  const kbJobs: string[] = [];
  for (const j of kb) {
    const dir = path.resolve(ctx.root, j);
    const job = await readJson<{ channel: string }>(path.join(dir, "job.json"));
    if (!job || job.channel !== channel || !(await finished(dir))) continue;
    kbJobs.push(path.basename(dir));
    kbPairs.push(...(await scoreFilm(ctx, dir, { metrics: false })).pairs);
    ctx.log(`    known-bad ${path.basename(dir)} judged`);
  }
  usd += kbPairs.reduce((t, p) => t + p.usd, 0);
  usd += pairs.reduce((t, p) => t + p.usd, 0);
  const detection: Record<string, number> = {};
  for (const c of ["wrong_picture", "foreign_picture", "bland_script"] as const) {
    const ps = pairs.filter((p) => p.control === c);
    if (ps.length) detection[c] = r3(ps.filter((p) => p.pick !== p.candidateAs).length / ps.length);
  }
  const degraded = pairs.filter((p) => p.control !== "real_vs_real" && p.control !== "film");
  const overall = degraded.length ? degraded.filter((p) => p.pick !== p.candidateAs).length / degraded.length : 0;
  detection.overall = r3(overall);
  const rvr = pairs.filter((p) => p.control === "real_vs_real");
  const aRate = rvr.length ? rvr.filter((p) => p.pick === "A").length / rvr.length : 0.5;
  const meanConfidence = rvr.length ? rvr.reduce((t, p) => t + p.confidence, 0) / rvr.length : 0.5;
  const reasons: string[] = [];
  if (overall < 0.8) reasons.push(`detects only ${Math.round(overall * 100)} % of degraded windows (needs ≥ 80 %)`);
  for (const [c, v] of Object.entries(detection)) if (c !== "overall" && v < 0.5) reasons.push(`misses most ${c} controls (${Math.round(v * 100)} %)`);
  if (aRate < 0.2 || aRate > 0.8) reasons.push(`position bias: picks A in ${Math.round(aRate * 100)} % of real-vs-real pairs`);
  if (meanConfidence > 0.85) reasons.push(`over-confident on real-vs-real (mean ${meanConfidence.toFixed(2)})`);
  const kbCaught = kbPairs.filter((p) => p.pick !== p.candidateAs).length;
  // The picture track must catch known-bad films; the story track is judged on text alone and is weaker, so the
  // release gate (blind test + objective checks + sameness) is what finally accepts or rejects a film.
  const kbPic = kbPairs.filter((p) => p.track === "picture");
  const kbPicCaught = kbPic.filter((p) => p.pick !== p.candidateAs).length;
  if (kbPic.length >= 4 && kbPicCaught / kbPic.length < 0.85) reasons.push(`lets known-bad films through on picture (${kbPicCaught}/${kbPic.length} caught, needs ≥ 85 %)`);
  const cal = Calibration.parse({ schemaVersion: 1, judgeVersion: JUDGE_VERSION, channel, pairs, detection, positionBias: { aRate: r3(aRate), meanConfidence: r3(meanConfidence) }, ...(kbPairs.length ? { knownBad: { caught: kbCaught, total: kbPairs.length, jobs: kbJobs } } : {}), trusted: reasons.length === 0, reasons, usd: r3(usd), generatedAt: new Date().toISOString() });
  await atomicJson(calFile(ctx, channel), cal);
  ctx.log(`  judge ${cal.trusted ? "TRUSTED" : "NOT TRUSTED"}: detection ${JSON.stringify(detection)}, real-vs-real A-rate ${aRate.toFixed(2)}, confidence ${meanConfidence.toFixed(2)}${kbPairs.length ? `, known-bad caught ${kbCaught}/${kbPairs.length}` : ""}${reasons.length ? ` — ${reasons.join("; ")}` : ""} ($${usd.toFixed(2)})`);
  return cal;
}

// ---------------------------------------------------------------------------------------------------------
// Film scoring

const PICTURE_POS: Array<[string, number]> = [["cold_open", 0], ["early", 0.3], ["middle", 0.55], ["late", 0.8]];
const STORY_POS: Array<[string, string, number]> = [["opening", "cold open", 0], ["body", "middle", 0.5]];

function groupTells(pairs: EvalPair[]) {
  const by = new Map<string, string[]>();
  // Only tells about OUR window: the judge caught it (picked the reference) and said what gave it away.
  for (const p of pairs) if (p.pick !== p.candidateAs) for (const t of p.tells.filter((x) => x.side === "fake")) by.set(t.area, [...(by.get(t.area) ?? []), t.what]);
  return [...by.entries()].map(([area, ex]) => ({ area, count: ex.length, examples: ex.slice(0, 4) })).sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
}
const mean = (xs: number[]) => (xs.length ? r3(xs.reduce((t, x) => t + x, 0) / xs.length) : 0);

export async function scoreFilm(ctx: Ctx, jobDir: string, o: { metrics?: boolean; others?: FilmFacts[] } = {}): Promise<FilmScore> {
  const film = await filmSource(jobDir);
  const channel = film.job.channel;
  const pool = await referencePool(ctx, channel);
  const pairs: EvalPair[] = [];
  const add = (p: EvalPair | null) => void (p && pairs.push(p));
  const used = new Set<Source>();
  for (const [pos, frac] of PICTURE_POS) {
    const t0 = frac === 0 ? 0 : Math.max(0, Math.min(film.durationS - WINDOW_S - 1, film.durationS * frac));
    if (t0 + WINDOW_S > film.durationS) continue;
    let ref: Source | null = null;
    let rt: number | null = null;
    for (let k = 0; k < 6 && rt === null; k++) {
      ref = pick(pool, `${film.id}|${pos}|${k}`, used);
      rt = refStart(ref, frac, WINDOW_S);
    }
    if (!ref || rt === null) continue;
    used.add(ref);
    const cand = await extractWindow(ctx, film, t0, WINDOW_S);
    const rw = await extractWindow(ctx, ref, rt, WINDOW_S);
    add(await picturePair(ctx, channel, { id: `${film.id}-pic-${pos}`, position: pos, control: "film", candidate: cand, candLabel: `${film.id} @ ${Math.round(t0)} s`, reference: rw, refLabel: `${ref.label} @ ${Math.round(rt)} s` }));
  }
  for (const [pos, label, frac] of STORY_POS) {
    const dur = Math.min(STORY_S, film.durationS * 0.4);
    const t0 = frac === 0 ? 0 : film.durationS * frac - dur / 2;
    const cand = textAt(film, t0, dur);
    let ref: Source | null = null;
    let rt: number | null = null;
    for (let k = 0; k < 6 && rt === null; k++) {
      ref = pick(pool, `${film.id}|story|${pos}|${k}`, used);
      rt = refStart(ref, frac, dur);
    }
    if (!ref || rt === null || !cand) continue;
    used.add(ref);
    add(await storyPair(ctx, channel, { id: `${film.id}-story-${pos}`, position: label, control: "film", candidate: cand, candLabel: `${film.id} @ ${Math.round(t0)} s`, reference: textAt(ref, rt, dur), refLabel: `${ref.label} @ ${Math.round(rt)} s` }));
  }
  const pic = mean(pairs.filter((p) => p.track === "picture").map((p) => p.realness));
  const sto = mean(pairs.filter((p) => p.track === "story").map((p) => p.realness));
  const usage = await readJson<{ runs: Array<{ usd: number }> }>(path.join(jobDir, "usage.json"));
  const logTxt = await readFile(path.join(jobDir, "run.log"), "utf8").catch(() => "");
  const done = [...logTxt.matchAll(/Done in (\d+) s/g)].at(-1);
  return {
    job: film.id,
    channel,
    durationS: r3(film.durationS),
    realness: { picture: pic, story: sto, overall: r3((pic + sto) / 2) },
    pairs,
    topTells: groupTells(pairs),
    production: { claudeUsd: usage ? r3(usage.runs.reduce((t, r) => t + r.usd, 0)) : null, wallS: done ? Number(done[1]) : null },
    metrics: o.metrics === false ? [] : await filmMetrics(jobDir, film.video, (await loadExemplars(ctx.data, channel)) ?? (await buildExemplars(ctx, channel)), o.others ?? []),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Sameness (do two films look like one template?)

/** A whole film as one sheet: 12 evenly spaced frames. */
async function filmSheet(ctx: Ctx, video: string, durationS: number): Promise<string> {
  const st = await stat(video);
  const dir = path.join(ctx.data, "eval", ".cache", "films", sha(`${video}|${st.size}|${st.mtimeMs}`));
  const sheet = path.join(dir, "sheet.jpg");
  if (existsSync(sheet)) return sheet;
  const frames = await grabFrames(video, dir, { ss: durationS * 0.04, t: durationS * 0.92, n: 12, width: 480 });
  return contactSheet(frames, sheet, { cols: 4, cellW: 480 });
}

/** The same test on pairs of real reference films: the channel's own film-to-film similarity (cached). */
async function referenceSameness(ctx: Ctx, channel: string): Promise<number> {
  const file = path.join(ctx.data, "eval", `sameness.${channel}.json`);
  const hit = await readJson<{ judgeVersion: string; scores: number[] }>(file);
  if (hit?.judgeVersion === JUDGE_VERSION && hit.scores.length >= 3) return r3(hit.scores.reduce((t, x) => t + x, 0) / hit.scores.length);
  const pool = await referencePool(ctx, channel);
  const scores: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = pick(pool, `same|${channel}|${k}|a`);
    const b = pick(pool, `same|${channel}|${k}|b`, new Set([a]));
    // A 2-minute slice of each (same length as our test films), away from intros and sponsor reads.
    const sa = await filmSheet(ctx, await sliceOf(ctx, a), 120);
    const sb = await filmSheet(ctx, await sliceOf(ctx, b), 120);
    const r = await judgeSameness({ channel, a: sa, b: sb });
    scores.push(r.score);
  }
  await atomicJson(file, { judgeVersion: JUDGE_VERSION, scores });
  return r3(scores.reduce((t, x) => t + x, 0) / scores.length);
}

/** A 120 s slice of a reference film as its own small file, so film sheets cover a comparable stretch. */
async function sliceOf(ctx: Ctx, src: Source): Promise<string> {
  const out = path.join(ctx.data, "eval", ".cache", "slices", `${src.id}.mp4`);
  if (existsSync(out)) return out;
  await mkdir(path.dirname(out), { recursive: true });
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.max(60, src.durationS * 0.3)), "-t", "120", "-i", src.video, "-an", "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", out]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Reports

const indist = (x: number) => r3(Math.min(1, x * 2));
const pct = (x: number) => `${Math.round(x * 100)} %`;

async function writeReport(ctx: Ctx, setId: string, films: FilmScore[], trusted: boolean): Promise<EvalReport> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const all = films.flatMap((f) => f.pairs);
  // Sameness between our films (same channel), against the channel's own film-to-film similarity.
  let sameness: EvalReport["sameness"];
  let sameUsd = 0;
  {
    const ours: NonNullable<EvalReport["sameness"]>["ours"] = [];
    const pairsOf = films.flatMap((a, i) => films.slice(i + 1).filter((b) => b.channel === a.channel).map((b) => [a, b] as const)).slice(0, 3);
    for (const [a, b] of pairsOf) {
      const va = await filmSource(path.join(ctx.root, "out", a.job));
      const vb = await filmSource(path.join(ctx.root, "out", b.job));
      const r = await judgeSameness({ channel: a.channel, a: await filmSheet(ctx, va.video, va.durationS), b: await filmSheet(ctx, vb.video, vb.durationS) });
      sameUsd += r.usd;
      ours.push({ a: a.job, b: b.job, score: r.score, shared: r.shared });
    }
    if (ours.length) {
      const base = await referenceSameness(ctx, films[0]!.channel);
      sameness = { ours, referenceBaseline: base, pass: Math.max(...ours.map((x) => x.score)) <= base + 1 };
    }
  }
  for (const f of films) {
    const reasons: string[] = [];
    const caught = f.pairs.filter((p) => p.pick !== p.candidateAs).length;
    if (f.pairs.length && caught / f.pairs.length > 0.65) reasons.push(`blind test: caught in ${caught} of ${f.pairs.length} comparisons (needs ≤ 65 %)`);
    const miss = f.metrics.filter((m) => !m.pass);
    if (miss.length) reasons.push(`${miss.length} objective check(s) missed: ${miss.slice(0, 6).map((m) => m.label).join("; ")}${miss.length > 6 ? "; …" : ""}`);
    const same = (sameness?.ours ?? []).filter((x) => x.a === f.job || x.b === f.job).map((x) => x.score);
    if (sameness && same.length && Math.max(...same) > sameness.referenceBaseline + 1) reasons.push(`looks like a template of another film (${Math.max(...same).toFixed(1)} / 10 vs ${sameness.referenceBaseline.toFixed(1)} for real films)`);
    f.gate = { pass: reasons.length === 0, reasons };
  }
  const pic = mean(all.filter((p) => p.track === "picture").map((p) => p.realness));
  const sto = mean(all.filter((p) => p.track === "story").map((p) => p.realness));
  const report = EvalReport.parse({
    schemaVersion: 1,
    setId,
    runId,
    judgeVersion: JUDGE_VERSION,
    judgeTrusted: trusted,
    films,
    indistinguishability: { picture: indist(pic), story: indist(sto), overall: indist((pic + sto) / 2) },
    topTells: groupTells(all).slice(0, 12),
    ...(sameness ? { sameness } : {}),
    usd: r3(all.reduce((t, p) => t + p.usd, 0) + sameUsd),
    generatedAt: new Date().toISOString(),
  });
  const dir = path.join(ctx.data, "eval", setId);
  await atomicJson(path.join(dir, "runs", `${runId}.json`), report);
  const histFile = path.join(dir, "history.json");
  const hist = (await readJson<Array<{ runId: string; overall: number; picture: number; story: number; films: number; trusted: boolean }>>(histFile)) ?? [];
  const prev = hist.at(-1);
  hist.push({ runId, overall: report.indistinguishability.overall, picture: report.indistinguishability.picture, story: report.indistinguishability.story, films: films.length, trusted });
  await atomicJson(histFile, hist);
  const delta = (k: "overall" | "picture" | "story") => (prev ? ` (${report.indistinguishability[k] >= prev[k] ? "+" : ""}${Math.round((report.indistinguishability[k] - prev[k]) * 100)} vs last run)` : "");
  const md = [
    `# Eval ${setId} — ${runId}`,
    ``,
    `Judge ${JUDGE_VERSION}: ${trusted ? "trusted (passed calibration)" : "**NOT trusted — scores are indicative only**"}.`,
    `## Release gate: ${films.filter((f) => f.gate?.pass).length} of ${films.length} film(s) pass`,
    ``,
    ...films.flatMap((f) => [`- **${f.job}: ${f.gate?.pass ? "PASS" : "REJECTED"}**`, ...(f.gate?.reasons ?? []).map((r) => `  - ${r}`)]),
    ``,
    `**Caught: the judge picked the real channel film in ${all.filter((p) => p.pick !== p.candidateAs).length} of ${all.length} blind comparisons** (target: about half).`,
    ``,
    `Indistinguishability (100 % = the blind judge can no longer tell our films from the real channel; low-confidence wins count as partial credit, so read it with the caught count):`,
    ``,
    `| Track | Score |`,
    `|---|---|`,
    `| Overall | ${pct(report.indistinguishability.overall)}${delta("overall")} |`,
    `| Picture (frames + narration + edit) | ${pct(report.indistinguishability.picture)}${delta("picture")} |`,
    `| Story (narration passages) | ${pct(report.indistinguishability.story)}${delta("story")} |`,
    ``,
    `## Films`,
    ``,
    `| Film | Picture | Story | Claude $ | Wall |`,
    `|---|---|---|---|---|`,
    ...films.map((f) => `| ${f.job} | ${pct(indist(f.realness.picture))} | ${pct(indist(f.realness.story))} | ${f.production.claudeUsd ?? "–"} | ${f.production.wallS ? `${Math.round(f.production.wallS / 60)} min` : "–"} |`),
    ``,
    ...(sameness
      ? [
          `## Sameness (do our films look like one template?)`,
          ``,
          `Real ${films[0]!.channel} films score **${sameness.referenceBaseline.toFixed(1)} / 10** against each other on this test. ${sameness.pass ? "Our films are within that." : "**Our films are more alike than the real channel's films are.**"}`,
          ``,
          ...sameness.ours.flatMap((x) => [`- ${x.a} vs ${x.b}: **${x.score.toFixed(1)} / 10**`, ...x.shared.map((t) => `  - ${t}`)]),
          ``,
        ]
      : []),
    `## Objective checks (same measurement on the reference films)`,
    ``,
    ...films.flatMap((f) => [
      `### ${f.job} — ${f.metrics.filter((m) => m.pass).length}/${f.metrics.length} met`,
      ``,
      `| Check | Film | Target | |`,
      `|---|---|---|---|`,
      ...[...f.metrics].sort((a, b) => Number(a.pass) - Number(b.pass)).map((m) => `| ${m.label} | ${m.value} | ${m.target} | ${m.pass ? "ok" : "**MISS**"} |`),
      ``,
    ]),
    `## What gives our films away (judge tells, most frequent first)`,
    ``,
    ...report.topTells.flatMap((t) => [`- **${t.area}** (${t.count})`, ...t.examples.map((e) => `  - ${e}`)]),
    ``,
  ].join("\n");
  await writeFile(path.join(dir, "latest.md"), md);
  await writeFile(path.join(dir, "runs", `${runId}.md`), md);
  return report;
}

// ---------------------------------------------------------------------------------------------------------
// Production runs

function produceChild(ctx: Ctx, item: EvalSet["items"][number], job: string): Promise<number> {
  return new Promise((resolve) => {
    const dir = path.join(ctx.root, "out", job);
    void mkdir(dir, { recursive: true }).then(() => {
      const out = createWriteStream(path.join(dir, "eval-produce.log"));
      const p = spawn("pnpm", ["-s", "opumia", "produce", "--topic", item.topic, "--channel", item.channel, "--aspect", item.aspect, "--duration", String(item.durationS), "--job", job], { cwd: ctx.root, stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.pipe(out);
      p.stderr.pipe(out);
      p.on("close", (code) => resolve(code ?? 1));
    });
  });
}

async function finished(jobDir: string) {
  const files = await readdir(jobDir).catch(() => [] as string[]);
  return files.some((f) => /_(16x9|9x16)\.mp4$/.test(f)) && files.includes("qa.json");
}

export async function cmdEval(ctx: Ctx, args: string[]) {
  const [sub, ...rest] = args;
  const opt = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const flag = (n: string) => rest.includes(`--${n}`);
  if (sub === "calibrate") {
    await calibrate(ctx, opt("channel") ?? "magnates-media", Number(opt("n") ?? 4), flag("fresh"));
    return;
  }
  if (sub === "score") {
    const jobs = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--")).map((j) => path.resolve(ctx.root, j));
    if (!jobs.length) throw new Error("usage: opumia eval score out/<job> [out/<job> …]");
    const films: FilmScore[] = [];
    const trusted = new Map<string, boolean>();
    const others = (await Promise.all(jobs.map((j) => filmFacts(j)))).filter((x): x is FilmFacts => x !== null);
    for (const j of jobs) {
      const ch = (await readJson<{ channel: string }>(path.join(j, "job.json")))?.channel ?? "magnates-media";
      if (!trusted.has(ch)) trusted.set(ch, (await calibrate(ctx, ch)).trusted);
      ctx.log(`  scoring ${path.basename(j)}…`);
      const f = await scoreFilm(ctx, j, { others });
      ctx.log(`    picture ${pct(indist(f.realness.picture))} · story ${pct(indist(f.realness.story))}`);
      films.push(f);
    }
    const r = await writeReport(ctx, opt("set") ?? "adhoc", films, [...trusted.values()].every(Boolean));
    ctx.log(`Release gate: ${r.films.filter((f) => f.gate?.pass).length}/${r.films.length} pass · blind ${pct(r.indistinguishability.overall)} (picture ${pct(r.indistinguishability.picture)}, story ${pct(r.indistinguishability.story)})${r.sameness ? ` · sameness ${Math.max(...r.sameness.ours.map((x) => x.score)).toFixed(1)} vs ${r.sameness.referenceBaseline.toFixed(1)}` : ""} → data/eval/${r.setId}/latest.md ($${r.usd.toFixed(2)})`);
    return;
  }
  if (sub === "run") {
    const setId = opt("set") ?? "core";
    const set = EvalSet.parse(JSON.parse(await readFile(path.join(ctx.root, "eval", "sets", `${setId}.json`), "utf8")));
    const only = new Set((opt("only") ?? "").split(",").filter(Boolean));
    const items = set.items.filter((i) => !only.size || only.has(i.id));
    const conc = Math.max(1, Number(opt("concurrency") ?? 1));
    const jobOf = (id: string) => `eval-${setId}-${id}`;
    if (!flag("no-produce")) {
      const queue = [...items];
      const t0 = Date.now();
      ctx.log(`Producing ${items.length} film(s), ${conc} at a time (logs: out/eval-${setId}-*/eval-produce.log)…`);
      await Promise.all(
        Array.from({ length: conc }, async () => {
          for (let it = queue.shift(); it; it = queue.shift()) {
            const s = Date.now();
            const code = await produceChild(ctx, it, jobOf(it.id));
            ctx.log(`  ${code === 0 || code === 2 ? "✓" : "✗"} ${it.id} (${Math.round((Date.now() - s) / 1000)} s${code === 2 ? ", QA fail" : code ? `, exit ${code}` : ""})`);
          }
        }),
      );
      ctx.log(`  produced in ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    const films: FilmScore[] = [];
    const trusted = new Map<string, boolean>();
    const others = (await Promise.all(items.map((it) => filmFacts(path.join(ctx.root, "out", jobOf(it.id)))))).filter((x): x is FilmFacts => x !== null);
    for (const it of items) {
      const dir = path.join(ctx.root, "out", jobOf(it.id));
      if (!(await finished(dir))) {
        ctx.log(`  skip ${it.id}: no finished film`);
        continue;
      }
      if (!trusted.has(it.channel)) trusted.set(it.channel, (await calibrate(ctx, it.channel)).trusted);
      films.push(await scoreFilm(ctx, dir, { others }));
    }
    if (!films.length) throw new Error("no finished films to score");
    const r = await writeReport(ctx, setId, films, [...trusted.values()].every(Boolean));
    ctx.log(`Indistinguishability ${pct(r.indistinguishability.overall)} (picture ${pct(r.indistinguishability.picture)}, story ${pct(r.indistinguishability.story)}) over ${films.length} film(s) → data/eval/${setId}/latest.md`);
    return;
  }
  throw new Error("usage: opumia eval calibrate|score|run (see opumia help)");
}
