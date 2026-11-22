/**
 * The unified, versioned channel profile (build list D35–D43): one file that holds the channel's style — every band
 * learned from the reference — measured from the full reference index (every shot of every analysed film, not a sample)
 * and read by every agent. data/channel-profile/<channel>.json; each new version is recorded in
 * data/channel-profile/<channel>.history.json with what changed.
 *
 *  films        per-film measures (pace, picture mix, text, transitions, cut-on-voice, sound, music)
 *  band         the channel's range for each measure across its films (p10 / median / p90)
 *  byPosition   the same measures by where in the film: cold open, chapter opening, middle, ending
 *  relations    line → picture (numbers, names, questions, silence), cut → voice, hit → what is on screen,
 *               music → story (cue changes and drop-outs at chapter turns)
 *  variety      how far the channel's films differ from each other (spread across films, and how different the
 *               look of two films is, from the picture embeddings)
 *  techniques   real frequencies of picture kind × text and of transitions, counted on every shot
 *  views        which measures go with more views (rank correlation) and the top-quartile films' band
 *  shortForm    whether the reference holds real shorts to learn the 9:16 style from
 *  bands        the other learned bands (story, visual, thumbnail, quality, voice), joined in one place
 * Everything is measured with one method for ours and theirs where it applies (senses, reference-index).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import type { ReferenceAudio, ReferenceFilm, ReferenceIndexManifest, ReferenceShot } from "@opumia/ingest";
import { DIM, loadReferenceIndex, row } from "./reference-index.js";

export const SEGMENTS = ["cold_open", "chapter_open", "middle", "ending"] as const;
export type Segment = (typeof SEGMENTS)[number];

export interface Measures {
  seconds: number;
  shots: number;
  cutsPerMin: number;
  shotMedianS: number;
  shotCv: number;
  /** share of shots by picture kind (stock_actor, designed, stock_broll, real_footage, real_photo, other) */
  picture: Record<string, number>;
  textSlam: number;
  /** share of shots entered by something other than a hard cut */
  softTransitions: number;
  faceShare: number;
  sat: number;
  luma: number;
  contrast: number;
  motion: number;
  wordsPerShot: number;
  cutInPause: number;
  cutToWordMedianS: number;
  hitsPerMin: number;
  hitOnCutShare: number;
  bedDb: number;
}

export interface Band { p10: number; median: number; p90: number }

export interface ChannelProfile {
  schemaVersion: 2;
  channel: ChannelId;
  version: string;
  corpus: { films: number; shots: number; minutes: number };
  films: Array<{ id: string; title: string; views: number; durS: number; m: Measures }>;
  band: Record<string, Band>;
  byPosition: Record<Segment, { band: Record<string, Band>; pooled: Measures }>;
  relations: {
    lineToPicture: Record<string, { shots: number; picture: Record<string, number>; textSlam: number; liftTextSlam: number }>;
    hitOnScreen: { picture: Record<string, number>; textSlam: number; liftTextSlam: number; classes: Record<string, number> };
    music: { cueNearChapterStart: number; dropBeforeChapter: number; cuesPer10Min: Band; dropsPer10Min: Band; bedArc: number[] };
    voice: { cutInPause: Band; cutToWordMedianS: Band };
  };
  variety: { acrossFilms: Record<string, number>; lookDistance: { betweenFilms: Band; withinFilm: Band } | null };
  techniques: { pictureText: Record<string, number>; transitions: Record<string, number>; perFilmRange: Record<string, Band> };
  views: { rankCorrelation: Record<string, number>; topQuartile: Record<string, number>; note: string };
  shortForm: { available: boolean; films: number; note: string };
  bands: Record<string, unknown>;
  directives: string[];
  generatedAt: string;
}

const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]! : 0;
};
const band = (xs: number[]): Band => ({ p10: r(pct(xs, 0.1)), median: r(pct(xs, 0.5)), p90: r(pct(xs, 0.9)) });
const share = (xs: string[]) => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  for (const k of Object.keys(out)) out[k] = r(out[k]! / Math.max(1, xs.length));
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

export function measure(shots: ReferenceShot[], hits: Array<{ t: number }>, seconds: number): Measures {
  const len = shots.map((s) => s.t1 - s.t0);
  const mean = len.reduce((a, b) => a + b, 0) / Math.max(1, len.length);
  const sd = Math.sqrt(len.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, len.length));
  const cuts = shots.map((s) => s.t0);
  const onCut = hits.filter((h) => cuts.some((c) => Math.abs(c - h.t) <= 0.2)).length;
  const avg = (f: (s: ReferenceShot) => number) => r(shots.reduce((a, s) => a + f(s), 0) / Math.max(1, shots.length));
  return {
    seconds: r(seconds, 1), shots: shots.length,
    cutsPerMin: r(shots.length / Math.max(1e-6, seconds / 60), 2), shotMedianS: r(pct(len, 0.5)), shotCv: r(sd / Math.max(1e-6, mean)),
    picture: share(shots.map((s) => s.picture)), textSlam: avg((s) => (s.overlay === "text_slam" ? 1 : 0)),
    softTransitions: (() => {
      const m = shots.filter((s) => s.transitionIn && s.transitionIn !== "start");
      return r(m.filter((s) => s.transitionIn !== "cut" && s.transitionIn !== "none").length / Math.max(1, m.length));
    })(),
    faceShare: avg((s) => (s.faces > 0 ? 1 : 0)), sat: avg((s) => s.sat), luma: avg((s) => s.luma), contrast: avg((s) => s.contrast), motion: avg((s) => s.motion),
    wordsPerShot: avg((s) => s.words), cutInPause: avg((s) => (s.cutInPause ? 1 : 0)), cutToWordMedianS: r(pct(shots.map((s) => s.cutToWord), 0.5)),
    hitsPerMin: r(hits.length / Math.max(1e-6, seconds / 60), 2), hitOnCutShare: r(onCut / Math.max(1, hits.length)), bedDb: r(pct(shots.map((s) => s.bedDb), 0.5), 1),
  };
}

/** Flatten a Measures into named numbers (picture shares as picture.<kind>). */
export function flat(m: Measures): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "number") out[k] = v;
    else for (const [pk, pv] of Object.entries(v as Record<string, number>)) out[`${k}.${pk}`] = pv;
  }
  return out;
}

function segmentOf(s: ReferenceShot, film: { durS: number; chapters: Array<[number, string]> }): Segment {
  const first = film.chapters.find((c) => c[0] > 5)?.[0] ?? 60;
  if (s.t0 < Math.min(75, Math.max(25, first))) return "cold_open";
  if (s.pos >= 0.92) return "ending";
  if (s.chapter >= 1 && s.sinceChapter < 20) return "chapter_open";
  return "middle";
}

const NUM = /(\d|\b(million|billion|trillion|percent|hundred|thousand)\b)/i;
const NAME = /(^|\s)(?!I\b|I'm\b|I've\b)[A-Z][a-z]+/;

function spearman(x: number[], y: number[]): number {
  const rank = (a: number[]) => {
    const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const out = new Array<number>(a.length);
    idx.forEach(([, i], k) => (out[i] = k));
    return out;
  };
  const rx = rank(x), ry = rank(y);
  const n = x.length;
  const mx = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - mx);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - mx) ** 2;
  }
  return dx && dy ? r(num / Math.sqrt(dx * dy), 2) : 0;
}

async function readBand(file: string): Promise<unknown> {
  return readFile(file, "utf8").then((t) => JSON.parse(t), () => null);
}

export async function buildChannelProfile(o: { data: string; channel: ChannelId; log?: (s: string) => void }): Promise<ChannelProfile> {
  const ix = await loadReferenceIndex(o.data);
  const dir = path.join(o.data, "reference-index");
  const manifest: ReferenceIndexManifest = ix?.manifest ?? JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const shotsAll: ReferenceShot[] = ix?.shots ?? (await readFile(path.join(dir, "shots.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const audioAll: ReferenceAudio[] = (await readFile(path.join(dir, "audio.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const films = (manifest.films as ReferenceFilm[]).filter((f) => f.channel === o.channel);
  if (!films.length) throw new Error(`no reference films for ${o.channel} in the reference index`);
  const byFilm = new Map<string, number[]>();
  shotsAll.forEach((s, i) => {
    if (s.channel === o.channel) (byFilm.get(s.film) ?? byFilm.set(s.film, []).get(s.film)!).push(i);
  });
  const audio = new Map(audioAll.map((a) => [a.film, a]));
  const filmRows: ChannelProfile["films"] = [];
  const segPool: Record<Segment, { shots: ReferenceShot[]; hits: Array<{ t: number }>; seconds: number; perFilm: Measures[] }> = Object.fromEntries(SEGMENTS.map((s) => [s, { shots: [], hits: [], seconds: 0, perFilm: [] }])) as never;
  const lineCls: Record<string, ReferenceShot[]> = { number: [], name: [], question: [], silent: [], other: [] };
  const hitShots: ReferenceShot[] = [];
  const hitClasses: string[] = [];
  let cueNear = 0, cueN = 0, dropBefore = 0, chapN = 0;
  const cues10: number[] = [], drops10: number[] = [];
  const arc = Array.from({ length: 10 }, () => [] as number[]);
  for (const f of films) {
    const shots = (byFilm.get(f.id) ?? []).map((i) => shotsAll[i]!);
    if (!shots.length) continue;
    const a = audio.get(f.id);
    const strong = (a?.hits ?? []).filter((h) => h.peak >= 10);
    filmRows.push({ id: f.id, title: f.title, views: f.views, durS: f.durS, m: measure(shots, strong, f.durS) });
    // by position
    const seg = new Map<Segment, ReferenceShot[]>();
    for (const s of shots) (seg.get(segmentOf(s, f)) ?? seg.set(segmentOf(s, f), []).get(segmentOf(s, f))!).push(s);
    for (const [k, ss] of seg) {
      const secs = ss.reduce((x, s) => x + (s.t1 - s.t0), 0);
      const hs = strong.filter((h) => ss.some((s) => h.t >= s.t0 && h.t < s.t1));
      segPool[k].shots.push(...ss);
      segPool[k].hits.push(...hs);
      segPool[k].seconds += secs;
      if (ss.length >= 5) segPool[k].perFilm.push(measure(ss, hs, secs));
    }
    // line → picture
    for (const s of shots) {
      const c = !s.words ? "silent" : NUM.test(s.line) ? "number" : /\?/.test(s.line) ? "question" : NAME.test(s.line.replace(/^\S+/, "")) ? "name" : "other";
      lineCls[c]!.push(s);
      if (s.hitOnCut) { hitShots.push(s); hitClasses.push(s.hitOnCut); }
      arc[Math.min(9, Math.floor(s.pos * 10))]!.push(s.bedDb);
    }
    // music → story
    if (a) {
      cues10.push((a.cues.length / f.durS) * 600);
      drops10.push((a.drops.length / f.durS) * 600);
      for (const [t] of f.chapters.filter((c) => c[0] > 5)) {
        chapN++;
        if (a.cues.some((c) => Math.abs(c - t) <= 6)) cueNear++;
        if (a.drops.some(([d0, d1]) => d1 <= t + 1 && d0 >= t - 12)) dropBefore++;
      }
      cueN++;
    }
  }
  const keys = Object.keys(flat(filmRows[0]!.m));
  const bandOf = (ms: Measures[]) => Object.fromEntries(keys.map((k) => [k, band(ms.map((m) => flat(m)[k] ?? 0))]));
  const allBand = bandOf(filmRows.map((f) => f.m));
  const base = measure(filmRows.flatMap((f) => (byFilm.get(f.id) ?? []).map((i) => shotsAll[i]!)), [], filmRows.reduce((a, f) => a + f.durS, 0));
  const lift = (x: number) => r(x / Math.max(1e-6, base.textSlam), 2);
  const lineToPicture = Object.fromEntries(Object.entries(lineCls).map(([k, ss]) => {
    const m = measure(ss, [], ss.reduce((a, s) => a + (s.t1 - s.t0), 0));
    return [k, { shots: ss.length, picture: m.picture, textSlam: m.textSlam, liftTextSlam: lift(m.textSlam) }];
  }));
  const hm = measure(hitShots, [], 1);

  // variety: spread across films (coefficient of variation per measure) and how different two films look (embeddings)
  const acrossFilms = Object.fromEntries(keys.map((k) => {
    const xs = filmRows.map((f) => flat(f.m)[k] ?? 0);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    return [k, r(Math.abs(mean) > 1e-9 ? sd / Math.abs(mean) : 0)];
  }));
  let lookDistance: ChannelProfile["variety"]["lookDistance"] = null;
  if (ix && ix.manifest.embedded.shots > 0) {
    const centroid = (idx: number[]) => {
      const c = new Float32Array(DIM);
      let n = 0;
      for (const i of idx) if (ix.shotOk[i]) { const v = row(ix.shotVec, i); for (let d = 0; d < DIM; d++) c[d]! += v[d]!; n++; }
      let norm = 0;
      for (let d = 0; d < DIM; d++) norm += c[d]! ** 2;
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < DIM; d++) c[d]! /= norm;
      return n ? c : null;
    };
    const cs = filmRows.map((f) => centroid(byFilm.get(f.id) ?? [])).filter((c) => c !== null) as Float32Array[];
    const between: number[] = [];
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { let s = 0; for (let d = 0; d < DIM; d++) s += cs[i]![d]! * cs[j]![d]!; between.push(1 - s); }
    const within: number[] = [];
    for (const f of filmRows) {
      const idx = byFilm.get(f.id) ?? [];
      const h = Math.floor(idx.length / 2);
      const a = centroid(idx.slice(0, h)), b = centroid(idx.slice(h));
      if (a && b) { let s = 0; for (let d = 0; d < DIM; d++) s += a[d]! * b[d]!; within.push(1 - s); }
    }
    lookDistance = { betweenFilms: band(between), withinFilm: band(within) };
  }

  // techniques, counted on every shot
  const chShots = filmRows.flatMap((f) => (byFilm.get(f.id) ?? []).map((i) => shotsAll[i]!));
  const combo = (s: ReferenceShot) => `${s.picture}${s.overlay === "text_slam" ? "+text" : ""}`;
  const perFilmCombo = filmRows.map((f) => share((byFilm.get(f.id) ?? []).map((i) => combo(shotsAll[i]!))));
  const comboKeys = [...new Set(chShots.map(combo))];
  const techniques = {
    pictureText: share(chShots.map(combo)),
    transitions: share(chShots.filter((s) => s.transitionIn && s.transitionIn !== "start").map((s) => s.transitionIn)),
    perFilmRange: Object.fromEntries(comboKeys.map((k) => [k, band(perFilmCombo.map((p) => p[k] ?? 0))])),
  };

  // views
  const lv = filmRows.map((f) => Math.log10(Math.max(1, f.views)));
  const rankCorrelation = Object.fromEntries(keys.map((k) => [k, spearman(filmRows.map((f) => flat(f.m)[k] ?? 0), lv)]).filter(([, v]) => Math.abs(v as number) >= 0.2).sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number)));
  const q = pct(filmRows.map((f) => f.views), 0.75);
  const top = filmRows.filter((f) => f.views >= q);
  const topQuartile = Object.fromEntries(keys.map((k) => [k, r(pct(top.map((f) => flat(f.m)[k] ?? 0), 0.5))]));

  const shorts = films.filter((f) => f.durS < 180);
  const bands = {
    story: await readBand(path.join(o.data, "story-profile", `${o.channel}.json`)),
    visual: await readBand(path.join(o.data, "visual-profile", `${o.channel}.json`)),
    thumbnail: await readBand(path.join(o.data, "thumbnail-profile", `${o.channel}.json`)).then((b) => (b && typeof b === "object" && "band" in b ? (b as { band: unknown }).band : b)),
    quality: await readBand(path.join(o.data, "quality-profile", `${o.channel}.json`)),
    voice: await readBand(path.join(o.data, "voice-calibration.json")).then((v) => (v && typeof v === "object" ? (v as Record<string, unknown>)._natural ?? null : null)),
  };
  const byPosition = Object.fromEntries(SEGMENTS.map((k) => [k, { band: bandOf(segPool[k].perFilm), pooled: measure(segPool[k].shots, segPool[k].hits, segPool[k].seconds) }])) as ChannelProfile["byPosition"];
  const body: Omit<ChannelProfile, "version" | "generatedAt" | "directives"> = {
    schemaVersion: 2, channel: o.channel,
    corpus: { films: filmRows.length, shots: chShots.length, minutes: r(filmRows.reduce((a, f) => a + f.durS, 0) / 60, 1) },
    films: filmRows, band: allBand, byPosition,
    relations: {
      lineToPicture,
      hitOnScreen: { picture: hm.picture, textSlam: hm.textSlam, liftTextSlam: lift(hm.textSlam), classes: share(hitClasses) },
      music: { cueNearChapterStart: r(cueNear / Math.max(1, chapN)), dropBeforeChapter: r(dropBefore / Math.max(1, chapN)), cuesPer10Min: band(cues10), dropsPer10Min: band(drops10), bedArc: arc.map((xs) => r(pct(xs, 0.5), 1)) },
      voice: { cutInPause: allBand.cutInPause!, cutToWordMedianS: allBand.cutToWordMedianS! },
    },
    variety: { acrossFilms, lookDistance },
    techniques,
    views: { rankCorrelation, topQuartile, note: `${filmRows.length} films; rank correlation of each measure with log views (|ρ| ≥ 0.2 shown) — a weak, observational signal, not a cause; top quartile = ${top.length} films with ≥ ${q} views` },
    shortForm: { available: shorts.length >= 5, films: shorts.length, note: shorts.length >= 5 ? "real shorts present" : `the reference holds ${shorts.length} film(s) under 3 minutes and no real 9:16 shorts — the short-form style cannot be learned from it; shorts follow the long-form profile's cold-open segment until real shorts are added to Reference/` },
    bands,
  };
  const version = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12);
  const profile: ChannelProfile = { ...body, version, directives: directivesOf(body as ChannelProfile), generatedAt: new Date().toISOString() };
  const outDir = path.join(o.data, "channel-profile");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${o.channel}.json`);
  const prev = await readFile(file, "utf8").then((t) => JSON.parse(t) as ChannelProfile, () => null);
  await writeFile(`${file}.tmp`, JSON.stringify(profile, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  if (prev?.version !== version) {
    const hf = path.join(outDir, `${o.channel}.history.json`);
    const hist: Array<{ version: string; at: string; changed: string[] }> = await readFile(hf, "utf8").then((t) => JSON.parse(t), () => []);
    const changed = prev ? keys.filter((k) => JSON.stringify(prev.band[k]) !== JSON.stringify(allBand[k])) : ["first version"];
    hist.push({ version, at: profile.generatedAt, changed });
    await writeFile(`${hf}.tmp`, JSON.stringify(hist, null, 1) + "\n");
    await rename(`${hf}.tmp`, hf);
  }
  o.log?.(`  channel profile ${o.channel} v${version}: ${profile.corpus.films} films, ${profile.corpus.shots} shots, ${profile.corpus.minutes} min`);
  return profile;
}

const pc = (x: number) => `${Math.round(x * 100)}%`;

/** Plain directives for prompts, all from measured numbers. */
export function directivesOf(p: ChannelProfile): string[] {
  const b = p.band;
  const seg = (k: Segment) => p.byPosition[k].pooled;
  const out = [
    `Pace: ${b.cutsPerMin!.p10}–${b.cutsPerMin!.p90} cuts a minute across the channel's films (median ${b.cutsPerMin!.median}); median shot ${b.shotMedianS!.median} s; shot lengths vary a lot (CV ${b.shotCv!.median}).`,
    `By position: cold open ${seg("cold_open").cutsPerMin} cuts/min with text on ${pc(seg("cold_open").textSlam)} of shots; chapter openings ${seg("chapter_open").cutsPerMin}; middle ${seg("middle").cutsPerMin}; ending ${seg("ending").cutsPerMin}.`,
    `Pictures (every shot counted): ${Object.entries(p.techniques.pictureText).slice(0, 6).map(([k, v]) => `${k} ${pc(v)}`).join(", ")}.`,
    `Transitions (on the sampled cuts): ${Object.entries(p.techniques.transitions).map(([k, v]) => `${k} ${pc(v)}`).join(", ")}.`,
    `Cuts and the voice: ${pc(b.cutInPause!.median)} of cuts fall in a pause; the median cut sits ${b.cutToWordMedianS!.median} s from a word boundary.`,
    `Lines with a number get text on screen ${p.relations.lineToPicture.number?.liftTextSlam ?? 1}× as often as average; lines naming someone show real footage/photos ${pc((p.relations.lineToPicture.name?.picture.real_footage ?? 0) + (p.relations.lineToPicture.name?.picture.real_photo ?? 0))} of the time.`,
    `Sound: ${b.hitsPerMin!.median} strong hits a minute, ${pc(b.hitOnCutShare!.median)} of them on a cut; hit classes ${Object.entries(p.relations.hitOnScreen.classes).slice(0, 3).map(([k, v]) => `${k} ${pc(v)}`).join(", ")}.`,
    `Music: a cue change within 6 s of ${pc(p.relations.music.cueNearChapterStart)} of chapter starts; a drop-out just before ${pc(p.relations.music.dropBeforeChapter)} of them; ${p.relations.music.cuesPer10Min.median} cue changes per 10 min.`,
    `Variety: the channel's films differ — e.g. text share varies by ${Math.round((p.variety.acrossFilms.textSlam ?? 0) * 100)}% across films${p.variety.lookDistance ? `; two films' looks differ by ${p.variety.lookDistance.betweenFilms.median} (within one film ${p.variety.lookDistance.withinFilm.median})` : ""}. Land each film somewhere different inside the band, not on the average.`,
  ];
  if (!p.shortForm.available) out.push(`Short-form: ${p.shortForm.note}.`);
  return out;
}

export async function loadChannelProfile(data: string, channel: ChannelId): Promise<ChannelProfile | null> {
  return readFile(path.join(data, "channel-profile", `${channel}.json`), "utf8").then((t) => JSON.parse(t) as ChannelProfile, () => null);
}
