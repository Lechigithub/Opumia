import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { producedJobs } from "./produced.js";
import path from "node:path";
import type { FilmDesignSystem, ScenePlan, ScriptDraft, Storyboard } from "@opumia/contracts";

/**
 * Film fingerprint: what makes one film look, read and sound like itself — its colour world, its kit's type, idea and transition,
 * where things sit on screen, its story shape, its opening and closing words, its sounds. Every film's
 * fingerprint is stored (data/fingerprints.json); a new film is compared with the recent ones at each planning
 * stage, before money is spent, and steered away from anything it would share. The only thing two films may
 * share is the channel's style.
 */
export interface FilmFingerprint {
  job: string;
  channel: string;
  at: string;
  colour: { primary: string; accent: string; surface: string };
  type: { display: string; body: string; casing: string };
  /** The film's own kit: its visual idea and the transition that bridges its cuts. */
  treatment: { transition: string; concept: string };
  /** Owner 2026-11-23 (no template look): the mix of engine styles the film used — worlds, picture frames and grades,
   *  atmospheres, effects, 3D elements, entrances and transitions — compared across films like the layout. */
  styles?: Record<string, number>;
  /** Where designed elements sit: element type × 3×3 screen cell → share of all elements. */
  layout: Record<string, number>;
  /** Share of scenes per backdrop and of shots per designed kind. */
  mix: Record<string, number>;
  story: { hook: string; spine: string; ending: string };
  opening: string;
  closing: string;
  title: string;
  sound: { sfx: string[]; music: string[] };
}

const file = (dataDir: string) => path.join(dataDir, "fingerprints.json");
export async function loadFingerprints(dataDir: string, o: { all?: boolean } = {}): Promise<FilmFingerprint[]> {
  try {
    const fps = JSON.parse(await readFile(file(dataDir), "utf8")) as FilmFingerprint[];
    if (o.all) return fps;
    const made = await producedJobs(dataDir);
    return fps.filter((f) => made.has(f.job));
  } catch {
    return [];
  }
}
export async function saveFingerprint(dataDir: string, fp: FilmFingerprint): Promise<void> {
  const all = [...(await loadFingerprints(dataDir, { all: true })).filter((x) => x.job !== fp.job), fp].slice(-80);
  await mkdir(dataDir, { recursive: true });
  await writeFile(`${file(dataDir)}.tmp`, JSON.stringify(all, null, 1) + "\n");
  await rename(`${file(dataDir)}.tmp`, file(dataDir));
}

const cell = (x: number, y: number, w: number) => `${Math.min(2, Math.floor(Math.max(0, Math.min(0.999, x + w / 2)) * 3))}${Math.min(2, Math.floor(Math.max(0, Math.min(0.999, y + 0.08)) * 3))}`;

export function fingerprintOf(o: { job: string; channel: string; design: FilmDesignSystem; transition?: string; draft?: ScriptDraft; board?: Storyboard; scenes?: ScenePlan; title?: string }): FilmFingerprint {
  const layout: Record<string, number> = {};
  const mix: Record<string, number> = {};
  let n = 0;
  for (const s of o.scenes?.scenes ?? []) {
    mix[`backdrop:${s.backdrop}`] = (mix[`backdrop:${s.backdrop}`] ?? 0) + 1;
    for (const e of s.elements) {
      const k = `${e.type}@${cell(e.x, e.y, e.w)}`;
      layout[k] = (layout[k] ?? 0) + 1;
      n++;
    }
  }
  for (const k of Object.keys(layout)) layout[k] = Math.round((layout[k]! / Math.max(1, n)) * 1000) / 1000;
  const shots = o.board?.shots ?? [];
  for (const s of shots) {
    const k = `kind:${s.source.kind === "designed" ? s.source.designed : "footage"}`;
    mix[k] = (mix[k] ?? 0) + 1;
  }
  const total = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(mix)) mix[k] = Math.round((mix[k]! / total) * 1000) / 1000;
  const styles: Record<string, number> = {};
  const addS = (k: string) => (styles[k] = (styles[k] ?? 0) + 1);
  for (const sc of (o.scenes?.scenes ?? []) as Array<Record<string, unknown> & { elements: Array<Record<string, unknown>> }>) {
    const w = sc.world as { kind?: string } | undefined;
    if (w?.kind) addS(`world:${w.kind}`);
    const at = sc.atmos as { kind?: string } | undefined;
    if (at?.kind) addS(`atmos:${at.kind}`);
    for (const [k, v] of Object.entries((sc.fx as Record<string, unknown>) ?? {})) if (v) addS(`fx:${k}`);
    if (sc.drift) addS("drift");
    for (const e of sc.elements) {
      if (e.type === "text3d" || e.type === "card3d" || e.type === "prop3d") addS(`el:${e.type}`);
      if (e.frame && e.frame !== "none") addS(`frame:${String(e.frame)}`);
      if (e.grade && e.grade !== "natural") addS(`grade:${String(e.grade)}`);
      if (e.enter && e.enter !== "fade") addS(`enter:${String(e.enter)}`);
      if (e.silhouette) addS("cutout:silhouette");
      if (e.outline) addS("cutout:outline");
      if (e.glow) addS("cutout:glow");
    }
  }
  for (const sh of shots) if (sh.transitionIn && sh.transitionIn !== "cut") addS(`transition:${sh.transitionIn}`);
  const sTot = Object.values(styles).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(styles)) styles[k] = Math.round((styles[k]! / sTot) * 1000) / 1000;
  const text = (o.draft?.segments ?? []).map((s) => s.text).join(" ");
  const words = text.split(/\s+/).filter(Boolean);
  return {
    job: o.job,
    channel: o.channel,
    at: new Date().toISOString(),
    colour: { primary: o.design.palette.primary, accent: o.design.palette.accent, surface: o.design.palette.surface },
    type: { display: o.design.fonts.display, body: o.design.fonts.body, casing: "" },
    treatment: { transition: o.transition ?? "", concept: o.design.concept },
    styles,
    layout,
    mix,
    story: { hook: o.draft?.blueprint?.hook ?? "", spine: o.draft?.blueprint?.spine ?? "", ending: o.draft?.blueprint?.ending ?? "" },
    opening: words.slice(0, 45).join(" "),
    closing: words.slice(-30).join(" "),
    title: o.title ?? o.draft?.title ?? "",
    sound: { sfx: [...new Set(shots.flatMap((s) => s.sfx.map((x) => x.assetId)))].sort(), music: [...new Set((o.board?.music ?? []).map((m) => m.assetId))].sort() },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Similarity (0 = nothing shared, 1 = the same film in this respect)

const hue = (hex: string) => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (d < 0.08) return -1; // near-neutral: no hue
  return ((mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
};
const hueGap = (a: string, b: string) => {
  const x = hue(a);
  const y = hue(b);
  if (x < 0 || y < 0) return 90;
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};
const STOP = new Set("the a an of and to in on for by with was is it its his her their this that as at from had has have were be been but not or so than then they he she you we i".split(" "));
const content = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / Math.max(1, a.size + b.size - inter);
};
const cosine = (a: Record<string, number>, b: Record<string, number>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    dot += (a[k] ?? 0) * (b[k] ?? 0);
    na += (a[k] ?? 0) ** 2;
    nb += (b[k] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export interface Similarity { overall: number; colour: number; treatment: number; layout: number; story: number; words: number; sound: number }

export function similarity(a: FilmFingerprint, b: FilmFingerprint): Similarity {
  const colour = Math.max(0, 1 - Math.min(hueGap(a.colour.primary, b.colour.primary), 90) / 90) * 0.65 + Math.max(0, 1 - Math.min(hueGap(a.colour.accent, b.colour.accent), 90) / 90) * 0.35;
  // the kit: same typefaces, the same transition, the same visual idea in other words
  const tf: Array<[string, string]> = [[a.type.display, b.type.display], [a.type.body, b.type.body], [a.treatment.transition ?? "", b.treatment.transition ?? ""]];
  const idea = jaccard(content(a.treatment.concept ?? ""), content(b.treatment.concept ?? ""));
  // the engine styles the two films lean on (owner: no template look) count with the typefaces and the transition
  const hasSt = Boolean(a.styles && b.styles && Object.keys(a.styles).length && Object.keys(b.styles).length);
  const st = hasSt ? cosine(a.styles!, b.styles!) : 0;
  const base = tf.filter(([x, y]) => x && x === y).length + Math.min(1, idea * 2);
  const treatment = hasSt ? (base + st * 1.5) / (tf.length + 2.5) : base / (tf.length + 1);
  const layout = Object.keys(a.layout).length && Object.keys(b.layout).length ? cosine(a.layout, b.layout) : 0;
  const story = (Number(a.story.hook && a.story.hook === b.story.hook) + Number(a.story.ending && a.story.ending === b.story.ending) + Number(a.story.spine && a.story.spine === b.story.spine)) / 3;
  const firstWords = (s: string) => s.toLowerCase().split(/\s+/).slice(0, 3).join(" ");
  const words = Math.max(jaccard(content(a.opening), content(b.opening)), a.opening && firstWords(a.opening) === firstWords(b.opening) ? 0.8 : 0, jaccard(content(a.closing), content(b.closing)));
  const sfx = jaccard(new Set(a.sound.sfx), new Set(b.sound.sfx));
  const sound = Math.max(sfx, a.sound.music.some((m) => b.sound.music.includes(m)) ? 0.8 : 0);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { overall: r(colour * 0.2 + treatment * 0.2 + layout * 0.2 + story * 0.15 + words * 0.15 + sound * 0.1), colour: r(colour), treatment: r(treatment), layout: r(layout), story: r(story), words: r(words), sound: r(sound) };
}

/** Limits per respect: above this a new film is too close to an earlier one. */
export const UNIQUE_LIMITS: Record<Exclude<keyof Similarity, "overall">, number> = { colour: 0.7, treatment: 0.56, layout: 0.9, story: 0.67, words: 0.4, sound: 0.34 };

export function closest(fp: FilmFingerprint, others: FilmFingerprint[]): { to: string; sim: Similarity; over: string[] } | null {
  let best: { to: string; sim: Similarity; over: string[] } | null = null;
  for (const o of others) {
    if (o.job === fp.job) continue;
    const sim = similarity(fp, o);
    const over = (Object.keys(UNIQUE_LIMITS) as Array<keyof typeof UNIQUE_LIMITS>).filter((k) => sim[k] > UNIQUE_LIMITS[k]).map((k) => `${k} ${sim[k]} (limit ${UNIQUE_LIMITS[k]})`);
    if (!best || over.length > best.over.length || (over.length === best.over.length && sim.overall > best.sim.overall)) best = { to: o.job, sim, over };
  }
  return best;
}

/** What recent films did, as plain notes for the planning agents ("do something else"). */
export function habitsOf(recent: FilmFingerprint[]): { openings: string[]; layouts: string } {
  const openings = recent.map((r) => r.opening.split(/\s+/).slice(0, 22).join(" ")).filter(Boolean);
  const agg: Record<string, number> = {};
  for (const r of recent) for (const [k, v] of Object.entries(r.layout)) agg[k] = (agg[k] ?? 0) + v / recent.length;
  const POS: Record<string, string> = { "00": "top-left", "10": "top-centre", "20": "top-right", "01": "middle-left", "11": "centre", "21": "middle-right", "02": "bottom-left", "12": "bottom-centre", "22": "bottom-right" };
  const layouts = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k.split("@")[0]} at ${POS[k.split("@")[1] ?? ""] ?? "?"} (${Math.round(v * 100)} %)`).join("; ");
  return { openings, layouts };
}
