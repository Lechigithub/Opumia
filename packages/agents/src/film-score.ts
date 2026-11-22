/**
 * Whole-film score (build list A3): how close one of our films is to the reference channel, measured with the same
 * function as the channel's own films (channel-profile.ts:measure) — so a change to any agent is kept only if the film
 * measures closer. Works on the plan (no render needed): our shots are turned into the reference index's shot rows
 * (picture kind, text on screen, words said over it, cut against the voice, hits on the cut, music) from the
 * storyboard, scenes, resolution, timed script and manifest.
 *
 * Score 0–100: 100 − the weighted mean distance outside the channel's per-film range (p10–p90, in band-widths, capped),
 * overall and by position in the film, plus the trained taste of the scene previews when the taste model exists.
 * Every gap is listed with the channel's range and ours, so the showrunner can send it to the agent that owns it.
 */
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import type { ReferenceShot } from "@opumia/ingest";
import { flat, loadChannelProfile, measure, segmentOfShot, SEGMENTS, type Band, type ChannelProfile, type Measures, type Segment } from "./channel-profile.js";
import { scoreTaste } from "./taste.js";
import { DIM, embedPictures } from "./reference-index.js";

/** D38: a film's look as the mean SigLIP vector of its scene previews (the channel's films: of their shots). */
async function lookOf(o: { root: string; data: string; files: string[]; log?: (s: string) => void }): Promise<{ all: Float32Array; a: Float32Array; b: Float32Array } | null> {
  const vs = (await embedPictures({ root: o.root, data: o.data, items: o.files.map((file) => ({ file })), ...(o.log ? { log: o.log } : {}) }).catch(() => [] as Array<Float32Array | null>)).flatMap((v) => (v ? [v] : []));
  if (vs.length < 4) return null;
  const c = (xs: Float32Array[]) => { const m = new Float32Array(DIM); for (const v of xs) for (let d = 0; d < DIM; d++) m[d]! += v[d]!; let n = 0; for (let d = 0; d < DIM; d++) n += m[d]! ** 2; n = Math.sqrt(n) || 1; for (let d = 0; d < DIM; d++) m[d]! /= n; return m; };
  const h = Math.floor(vs.length / 2);
  return { all: c(vs), a: c(vs.slice(0, h)), b: c(vs.slice(h)) };
}
const cosDist = (a: Float32Array | number[], b: Float32Array | number[]) => { let s = 0; for (let d = 0; d < DIM; d++) s += a[d]! * b[d]!; return 1 - s; };

/** Looks of our earlier films (data/looks/<channel>.json: job → rounded centroid). */
async function ourLooks(data: string, channel: string): Promise<Record<string, number[]>> {
  return readFile(path.join(data, "looks", `${channel}.json`), "utf8").then((t) => JSON.parse(t) as Record<string, number[]>, () => ({}));
}
async function saveLook(data: string, channel: string, job: string, v: Float32Array) {
  const all = await ourLooks(data, channel);
  all[job] = Array.from(v, (x) => Math.round(x * 1e4) / 1e4);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(data, "looks"), { recursive: true });
  const f = path.join(data, "looks", `${channel}.json`);
  await writeFile(`${f}.tmp`, JSON.stringify(all) + "\n");
  await rename(`${f}.tmp`, f);
}

interface PlanShot { id: string; startS: number; endS: number; source: { kind: string } }
interface PlanScene { shotId: string; backdrop: string; elements: Array<{ type: string }> }
interface Media { shotId: string; role: string; origin: string; kind: string }
interface Word { word?: string; text?: string; startS?: number; endS?: number; start?: number; end?: number }

/** Which measures are compared and how much each counts. */
const WEIGHTS: Record<string, { w: number; owner: string; what: string }> = {
  cutsPerMin: { w: 3, owner: "director/editor", what: "cuts a minute" },
  shotMedianS: { w: 2, owner: "director/editor", what: "median shot length" },
  shotCv: { w: 1, owner: "editor", what: "variety of shot lengths" },
  textSlam: { w: 3, owner: "scene designer", what: "share of shots with text on screen" },
  "picture.designed": { w: 2, owner: "scene designer", what: "share of designed (graphic) shots" },
  "picture.stock": { w: 2, owner: "director/sourcing", what: "share of stock footage" },
  "picture.real": { w: 2, owner: "sourcing", what: "share of real footage/photos of the subjects" },
  cutInPause: { w: 1, owner: "editor", what: "share of cuts in a pause of the voice" },
  cutToWordMedianS: { w: 1, owner: "editor", what: "distance of cuts from word boundaries" },
  hitsPerMin: { w: 2, owner: "sound designer", what: "strong hits a minute" },
  hitOnCutShare: { w: 1, owner: "sound designer", what: "share of hits on a cut" },
  wordsPerShot: { w: 1, owner: "director/editor", what: "words spoken per shot" },
};

export interface FilmGap { key: string; what: string; owner: string; segment: Segment | "film"; ours: number; band: Band; outside: number }
export interface FilmScore { job: string; channel: ChannelId; profileVersion: string; score: number; structure: number; taste: { median: number; realMedian: number; n: number } | null; look: { nearestOurs: { job: string; distance: number } | null; withinFilm: number; minBetween: number; minWithin: number } | null; measures: Measures; byPosition: Partial<Record<Segment, Measures>>; gaps: FilmGap[]; scoredAt: string }

/** Merge picture kinds into the comparable families (stock actor + stock b-roll are one family for us: we cannot tell them apart). */
function family(m: Measures): Record<string, number> {
  const f = flat(m);
  f["picture.stock"] = (f["picture.stock_actor"] ?? 0) + (f["picture.stock_broll"] ?? 0);
  f["picture.real"] = (f["picture.real_footage"] ?? 0) + (f["picture.real_photo"] ?? 0);
  f["picture.designed"] = f["picture.designed"] ?? 0;
  return f;
}
function familyBand(b: Record<string, Band>, films?: ChannelProfile["films"]): Record<string, Band> {
  const out = { ...b };
  if (films?.length) {
    const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, c) => a - c); return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))] ?? 0; };
    for (const k of ["picture.stock", "picture.real"]) {
      const xs = films.map((f) => family(f.m)[k] ?? 0);
      out[k] = { p10: pct(xs, 0.1), median: pct(xs, 0.5), p90: pct(xs, 0.9) };
    }
  }
  return out;
}

const outside = (x: number, b: Band) => {
  const w = Math.max(1e-6, b.p90 - b.p10);
  return x < b.p10 ? (b.p10 - x) / w : x > b.p90 ? (x - b.p90) / w : 0;
};

export interface PlanState {
  storyboard: { shots: PlanShot[]; durationS: number };
  scenes: PlanScene[];
  media: Media[];
  words: Word[];
  manifest?: { fps: number; audio: Array<{ role: string; startFrame: number; endFrame: number; dips?: Array<{ fromFrame: number; toFrame: number }> }> } | null;
}

/** Our film's shots as reference-index rows, read from a job folder. */
export async function ourShots(jobDir: string): Promise<{ shots: ReferenceShot[]; hits: Array<{ t: number }>; durS: number }> {
  const j = async <T>(f: string): Promise<T | null> => readFile(path.join(jobDir, f), "utf8").then((t) => JSON.parse(t) as T, () => null);
  const sb = await j<{ shots: PlanShot[]; durationS: number }>("storyboard.json");
  if (!sb) throw new Error(`no storyboard in ${jobDir}`);
  const ts = await j<{ segments: Array<{ words: Word[] }> }>("timed-script.json");
  return ourShotsFrom({ storyboard: sb, scenes: (await j<{ scenes: PlanScene[] }>("scenes.json"))?.scenes ?? [], media: (await j<{ media: Media[] }>("resolution.json"))?.media ?? [], words: (ts?.segments ?? []).flatMap((s) => s.words), manifest: await j("manifest.json") }, path.basename(jobDir));
}

/** Our film's shots as reference-index rows, from a plan held in memory (the editor's working state). */
export function ourShotsFrom(st: PlanState, film = "ours"): { shots: ReferenceShot[]; hits: Array<{ t: number }>; durS: number } {
  const sb = st.storyboard;
  const scenes = new Map(st.scenes.map((s) => [s.shotId, s]));
  const media = st.media;
  const man = st.manifest ?? null;
  const words = st.words.map((w) => ({ w: (w.word ?? w.text ?? "").trim(), s: w.startS ?? w.start ?? 0, e: w.endS ?? w.end ?? 0 }));
  const fps = man?.fps ?? 30;
  const hits = (man?.audio ?? []).filter((a) => a.role === "sfx").map((a) => ({ t: a.startFrame / fps }));
  const music = (man?.audio ?? []).filter((a) => a.role === "music");
  const dips = music.flatMap((m) => (m.dips ?? []).map((d) => [d.fromFrame / fps, d.toFrame / fps] as [number, number]));
  const cues = music.map((m) => m.startFrame / fps).filter((t) => t > 0.5);
  const bounds = words.flatMap((w) => [w.s, w.e]).sort((a, b) => a - b);
  const pauses: Array<[number, number]> = [];
  words.forEach((w, k) => { const nx = words[k + 1]; if (nx && nx.s - w.e >= 0.15) pauses.push([w.e, nx.s]); });
  const dur = sb.durationS;
  const shots: ReferenceShot[] = sb.shots.map((sh, i) => {
    const sc = scenes.get(sh.id);
    const prim = media.find((m) => m.shotId === sh.id && m.role === "primary");
    const els = sc?.elements ?? [];
    const textOn = els.some((e) => e.type === "text" || e.type === "phrase" || e.type === "text3d" || e.type === "steps" || e.type === "icongrid" || e.type === "newspaper" || (e.type === "counter" && "label" in e));
    const pictureEls = els.filter((e) => e.type === "photo" || e.type === "cutout" || e.type === "card3d" || e.type === "counter" || e.type === "steps" || e.type === "icongrid" || e.type === "newspaper" || e.type === "screen").length;
    const footage = sc ? sc.backdrop === "footage" && !!prim : !!prim;
    const picture = sh.source.kind === "designed" && !sc ? "designed"
      : !footage || pictureEls >= 2 ? "designed"
      : prim!.origin === "press" ? (prim!.kind === "video" ? "real_footage" : "real_photo")
      : "stock_broll";
    const said = words.filter((w) => (w.s + w.e) / 2 >= sh.startS && (w.s + w.e) / 2 < sh.endS).map((w) => w.w);
    const near = bounds.reduce((best, b) => Math.min(best, Math.abs(b - sh.startS)), 9);
    return {
      id: `${sh.id}`, channel: "magnates-media", film, i, t0: sh.startS, t1: sh.endS, pos: sh.startS / dur,
      chapter: 0, chapterPos: sh.startS / dur, sinceChapter: sh.startS, line: said.join(" "), words: said.length, picture, overlay: textOn ? "text_slam" : "none",
      transitionIn: i === 0 ? "start" : "cut", faces: 0, faceH: 0, sat: 0, grey: 0, luma: 0, contrast: 0, motion: 0, text: "", textArea: 0,
      cutToWord: Math.round(near * 1000) / 1000, cutInPause: pauses.some(([a, b]) => sh.startS >= a - 0.03 && sh.startS <= b + 0.03),
      hitOnCut: hits.some((h) => Math.abs(h.t - sh.startS) <= 0.2) ? "hit" : "", hitInShot: "", bedDb: 0, voiceDb: 0,
      musicDrop: dips.some(([a, b]) => a < sh.endS && b > sh.startS), cueChange: cues.some((c) => c >= sh.startS && c < sh.endS),
    } satisfies ReferenceShot;
  });
  return { shots, hits, durS: dur };
}

/** Structure score and gaps of a film (shots as reference rows) against the channel profile; `only` limits the measures. */
export function structureOf(prof: ChannelProfile, shots: ReferenceShot[], hits: Array<{ t: number }>, durS: number, only?: string[]): { structure: number; gaps: FilmGap[]; measures: Measures; byPosition: Partial<Record<Segment, Measures>> } {
  const WEIGHTS_ = only ? Object.fromEntries(Object.entries(WEIGHTS).filter(([k]) => only.includes(k))) : WEIGHTS;
  const m = measure(shots, hits, durS);
  const f = family(m);
  const band = familyBand(prof.band, prof.films);
  const gaps: FilmGap[] = [];
  let num = 0, den = 0;
  for (const [k, spec] of Object.entries(WEIGHTS_)) {
    const b = band[k];
    if (!b || f[k] === undefined) continue;
    const out = Math.min(2, outside(f[k]!, b));
    num += spec.w * out;
    den += spec.w;
    if (out > 0) gaps.push({ key: k, what: spec.what, owner: spec.owner, segment: "film", ours: Math.round(f[k]! * 1000) / 1000, band: b, outside: Math.round(out * 100) / 100 });
  }
  // by position (a short film has only a cold open, a middle and an ending)
  const film = { durS, chapters: [] as Array<[number, string]> };
  const byPosition: FilmScore["byPosition"] = {};
  for (const seg of SEGMENTS) {
    const ss = shots.filter((s) => segmentOfShot(s, film) === seg);
    if (ss.length < 4) continue;
    const secs = ss.reduce((a, s) => a + (s.t1 - s.t0), 0);
    const sm = measure(ss, hits.filter((h) => ss.some((s) => h.t >= s.t0 && h.t < s.t1)), secs);
    byPosition[seg] = sm;
    const sf = family(sm);
    const sb = familyBand(prof.byPosition[seg].band);
    for (const k of ["cutsPerMin", "textSlam", "picture.designed"].filter((k) => !only || only.includes(k))) {
      const b = sb[k];
      if (!b || sf[k] === undefined) continue;
      const out = Math.min(2, outside(sf[k]!, b));
      num += 1 * out;
      den += 1;
      if (out > 0) gaps.push({ key: k, what: WEIGHTS[k]!.what, owner: WEIGHTS[k]!.owner, segment: seg, ours: Math.round(sf[k]! * 1000) / 1000, band: b, outside: Math.round(out * 100) / 100 });
    }
  }
  const structure = Math.round(100 * (1 - num / Math.max(1, den * 2)));
  return { structure, gaps: gaps.sort((a, b) => b.outside - a.outside), measures: m, byPosition };
}

export async function scoreFilm(o: { root: string; data: string; jobDir: string; channel: ChannelId; taste?: boolean; log?: (s: string) => void }): Promise<FilmScore> {
  const prof = await loadChannelProfile(o.data, o.channel);
  if (!prof) throw new Error(`no channel profile for ${o.channel} — run build-channel-profile`);
  const { shots, hits, durS } = await ourShots(o.jobDir);
  const { structure, gaps, measures: m, byPosition } = structureOf(prof, shots, hits, durS);

  let taste: FilmScore["taste"] = null;
  let look: FilmScore["look"] = null;
  const pdir = ["previews_final", "previews_agent", "previews"].map((d) => path.join(o.jobDir, d)).find((d) => existsSync(d));
  if (pdir && prof.variety.lookDistance) {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(pdir).filter((x) => /\.(jpg|png)$/.test(x) && !/sheet/.test(x)).sort().map((x) => path.join(pdir, x));
    const l = await lookOf({ root: o.root, data: o.data, files, ...(o.log ? { log: o.log } : {}) });
    if (l) {
      const job = path.basename(o.jobDir);
      const others = Object.entries(await ourLooks(o.data, o.channel)).filter(([j]) => j !== job).map(([j, v]) => ({ job: j, distance: Math.round(cosDist(l.all, v) * 1e3) / 1e3 })).sort((a, b) => a.distance - b.distance);
      look = { nearestOurs: others[0] ?? null, withinFilm: Math.round(cosDist(l.a, l.b) * 1e3) / 1e3, minBetween: prof.variety.lookDistance.betweenFilms.p10, minWithin: prof.variety.lookDistance.withinFilm.p10 };
      await saveLook(o.data, o.channel, job, l.all);
      const ld = prof.variety.lookDistance;
      const gapOf = (key: string, what: string, owner: string, ours: number, band: Band): FilmGap => ({ key, what, owner, segment: "film", ours, band, outside: Math.round(((band.p10 - ours) / Math.max(1e-6, band.p90 - band.p10)) * 100) / 100 });
      // Too close to an earlier film of ours: closer than two of the channel's films usually are.
      if (look.nearestOurs && look.nearestOurs.distance < ld.betweenFilms.p10) gaps.push(gapOf("look.nearestOurs", `look too close to our film "${look.nearestOurs.job}" (distance)`, "art director/scene designer", look.nearestOurs.distance, ld.betweenFilms));
      // A film whose two halves look the same: less variety within it than the channel's films have.
      if (look.withinFilm < ld.withinFilm.p10) gaps.push(gapOf("look.withinFilm", "look of the first and second half the same (distance)", "art director/scene designer", look.withinFilm, ld.withinFilm));
    }
  }
  if (o.taste !== false) {
    const dir = pdir;
    if (dir) {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(dir).filter((x) => /\.(jpg|png)$/.test(x) && !/sheet/.test(x)).sort().map((x) => path.join(dir, x));
      const sc = await scoreTaste({ root: o.root, data: o.data, channel: o.channel, kind: "shot", items: files.map((file) => ({ file })), ...(o.log ? { log: o.log } : {}) }).catch(() => [] as Array<null>);
      const vals = (sc as Array<{ score: number } | null>).flatMap((x) => (x ? [x.score] : [])).sort((a, b) => a - b);
      const model = vals.length ? (await import("./taste.js")).loadTaste(o.data, o.channel, "shot") : null;
      const realMedian = (await model)?.calibration.real.median ?? 0;
      if (vals.length) taste = { median: vals[Math.floor(vals.length / 2)]!, realMedian, n: vals.length };
    }
  }
  const tastePart = taste ? Math.min(100, (taste.median / Math.max(0.1, taste.realMedian)) * 100) : null;
  const score = Math.round(tastePart === null ? structure : 0.6 * structure + 0.4 * tastePart);
  const res: FilmScore = { job: path.basename(o.jobDir), channel: o.channel, profileVersion: prof.version, score, structure, taste, look, measures: m, byPosition, gaps, scoredAt: new Date().toISOString() };
  const file = path.join(o.jobDir, "film-score.json");
  await writeFile(`${file}.tmp`, JSON.stringify(res, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  return res;
}

export function filmScoreText(s: FilmScore): string {
  return [
    `Film score ${s.score}/100 (structure ${s.structure}${s.taste ? `, taste of previews ${s.taste.median}/10 vs the real channel's ${s.taste.realMedian}` : ""}${s.look ? `, look ${s.look.nearestOurs ? `${s.look.nearestOurs.distance} from our nearest film "${s.look.nearestOurs.job}"` : "first of ours"}, halves ${s.look.withinFilm} apart` : ""}) — channel profile v${s.profileVersion}`,
    ...s.gaps.map((g) => `- ${g.segment === "film" ? "whole film" : g.segment}: ${g.what} ${g.ours} — channel ${g.band.p10}–${g.band.p90} (median ${g.band.median}) → ${g.owner}`),
  ].join("\n");
}
