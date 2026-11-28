/**
 * Build list 5, items 10–14: how the channel designs its frames, measured on its real frames and on our previews with
 * the SAME functions:
 *  - the world a designed frame is built in (treated picture, duotone, burst, collage, flat field, paper, terminal);
 *  - the treatment on the picture (grain, texture, light leak, vignette, cut-out, grade) and whether stock is shown raw;
 *  - how words sit (in the picture, in a box, as a caption), and how much of the frame they cover (OCR boxes,
 *    macOS Vision — the same quantity as the reference index's textArea);
 *  - the kind of data shot (one big number, a drawn line, an annotated picture, an icon share, a bar chart…);
 *  - backdrop variety inside a film (SigLIP distance between designed frames).
 * The band is data/design-profile/<channel>.json. `designProblems` is the pure check the scene designer's
 * measure_film and the preflight gate both run.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import type { SceneSpec } from "@opumia/contracts";
import * as z from "zod/v4";
import { lengthPlan } from "./film-length.js";
import { ocrBinary } from "@opumia/senses";
import { MODELS, plain, structured } from "./llm.js";
import { loadReferenceIndex, row } from "./reference-index.js";

const pexec = promisify(execFile);

export const DESIGN_WORLDS = ["footage", "mono_accent", "duotone", "burst", "collage", "flat_field", "paper", "terminal", "plain_stage", "other_designed"] as const;
export const TREATMENTS = ["grain", "texture", "light_leak", "vignette", "cutout", "grade"] as const;
export const DATA_KINDS = ["none", "big_number", "drawn_line", "annotated_picture", "icon_share", "bar_chart", "other_chart", "table", "map"] as const;
export const TEXT_STYLES = ["none", "integrated", "boxed_label", "caption"] as const;
export interface DesignLabel { world: (typeof DESIGN_WORLDS)[number]; treatments: Array<(typeof TREATMENTS)[number]>; rawStock: boolean; data: (typeof DATA_KINDS)[number]; text: (typeof TEXT_STYLES)[number]; textTilted: boolean }

const SYSTEM = `You label frames of documentary videos, one label set per numbered image. Judge only what is visible.
world — what the frame is built on:
- footage: filmed or archive footage (or a photo) filling the frame.
- mono_accent: a real picture in black and white with one strong colour element (a bar, a shape, one coloured object).
- duotone: a real picture rendered in two colours.
- burst: rays / a sunburst behind a subject (usually a cut-out).
- collage: several real pictures arranged as prints or cut-outs.
- flat_field: a bold flat or gradient colour field, no picture behind.
- paper: paper, newsprint, a document or print texture as the ground.
- terminal: a terminal, code window, app or web UI as the ground.
- plain_stage: a dark or plain designed background with a faint pattern (grid, glow, particles) — a generic template look.
- other_designed: any other designed ground.
treatments — every one visibly applied to the picture: grain (film grain/noise), texture (paper, dust, scratches), light_leak, vignette (darkened edges), cutout (a subject cut out of its photo), grade (a strong deliberate colour grade or black and white).
rawStock: true if the frame is stock or generic footage shown exactly as filmed, with no grade, grain, texture, vignette or design at all.
data — what data is shown: none, big_number (one figure as the subject), drawn_line (a line or arrow drawn across a ground or picture), annotated_picture (a picture with labels/arrows/figures on it), icon_share (icons or pictograms showing a share or count), bar_chart, other_chart (pie, area, timeline), table, map.
text — how words sit: none; integrated (big words set into the picture, part of the composition); boxed_label (words inside a small box or tag); caption (a small line naming who or what).
textTilted: true if the words are set at an angle.`;
const Labels = z.object({ frames: z.array(z.object({ i: z.number(), world: z.enum(DESIGN_WORLDS), treatments: z.array(z.enum(TREATMENTS)), rawStock: z.boolean(), data: z.enum(DATA_KINDS), text: z.enum(TEXT_STYLES), textTilted: z.boolean() })) });

/** Haiku vision, eight frames a call. Labels are memoised per file (path + size + mtime) in data/.cache/design-labels.json. */
export async function labelDesign(files: string[], o: { data?: string } = {}): Promise<Array<DesignLabel | null>> {
  const memoF = o.data ? path.join(o.data, ".cache", "design-labels.json") : null;
  const memo: Record<string, DesignLabel> = memoF ? await readFile(memoF, "utf8").then((t) => JSON.parse(t), () => ({})) : {};
  const { stat } = await import("node:fs/promises");
  const keys = await Promise.all(files.map(async (f) => stat(f).then((s) => `${f}|${s.size}|${Math.round(s.mtimeMs)}`, () => f)));
  const out = files.map((_, k) => memo[keys[k]!] ?? null);
  const todo = files.map((f, k) => ({ f, k })).filter((x) => !out[x.k]);
  const parts: Array<typeof todo> = [];
  for (let i = 0; i < todo.length; i += 8) parts.push(todo.slice(i, i + 8));
  for (let p = 0; p < parts.length; p += 6)
    await Promise.all(parts.slice(p, p + 6).map(async (part) => {
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const [j, x] of part.entries()) {
        const data = await readFile(x.f).then((b) => b.toString("base64"), () => null);
        if (data) blocks.push({ type: "text", text: `[${j}]` }, { type: "image", source: { type: "base64", media_type: /\.png$/i.test(x.f) ? "image/png" : "image/jpeg", data } });
      }
      if (!blocks.length) return;
      const r = await structured({ stage: "design.label", model: MODELS.haiku, system: [plain(SYSTEM)], user: blocks, schema: Labels, effort: "low", maxTokens: 2000 }).catch(() => null);
      for (const l of r?.data.frames ?? []) {
        const x = part[l.i];
        if (!x) continue;
        const lab: DesignLabel = { world: l.world, treatments: [...new Set(l.treatments)], rawStock: l.rawStock, data: l.data, text: l.text, textTilted: l.textTilted };
        out[x.k] = lab;
        memo[keys[x.k]!] = lab;
      }
    }));
  if (memoF && todo.length) {
    await mkdir(path.dirname(memoF), { recursive: true });
    await writeFile(memoF + ".tmp", JSON.stringify(memo));
    await rename(memoF + ".tmp", memoF);
  }
  return out;
}

// ---- text area: OCR boxes (macOS Vision, tools/ocr/ocr.swift, compiled once into data/.cache/ocr/)

/** Share of each frame its words cover (sum of OCR box areas, 0..1); null where OCR is not available. */
export async function textAreas(files: string[], o: { root: string; data: string }): Promise<Array<number | null>> {
  const bin = await ocrBinary(o.root, o.data);
  if (!bin || !files.length) return files.map(() => null);
  const out: Array<number | null> = files.map(() => null);
  for (let i = 0; i < files.length; i += 40) {
    const part = files.slice(i, i + 40);
    const r = await pexec(bin, part, { maxBuffer: 64 << 20, timeout: 300_000 }).catch(() => null);
    const rows = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { file: string; boxes: Array<{ x0: number; y0: number; x1: number; y1: number; text: string }> });
    for (const rw of rows) {
      const k = part.indexOf(rw.file);
      // ignore one- and two-character boxes (watermarks, noise)
      if (k >= 0) out[i + k] = Math.min(1, rw.boxes.filter((b) => b.text.replace(/\s/g, "").length >= 3).reduce((a, b) => a + Math.max(0, (b.x1 - b.x0) * (b.y1 - b.y0)), 0));
    }
  }
  return out;
}

// ---- variety inside a film (SigLIP)

/** Mean pairwise cosine distance between frames (L2-normalised vectors): how different a film's designed frames are. */
export function withinFilmVariety(vecs: Float32Array[]): number | null {
  if (vecs.length < 3) return null;
  let s = 0;
  let n = 0;
  for (let i = 0; i < vecs.length; i++)
    for (let j = 0; j < i; j++) {
      let d = 0;
      const a = vecs[i]!, b = vecs[j]!;
      for (let k = 0; k < a.length; k++) d += a[k]! * b[k]!;
      s += 1 - d;
      n++;
    }
  return Math.round((s / n) * 1000) / 1000;
}

// ---- the band

export interface Range { p10: number; p50: number; p90: number }
const rangeOf = (xs: number[]): Range => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * p)))] ?? 0;
  return { p10: Math.round(q(0.1) * 1000) / 1000, p50: Math.round(q(0.5) * 1000) / 1000, p90: Math.round(q(0.9) * 1000) / 1000 };
};
const share = <T extends string>(xs: T[]) => {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  for (const k of Object.keys(o)) o[k] = Math.round((o[k]! / Math.max(1, xs.length)) * 1000) / 1000;
  return o;
};

export interface DesignBand {
  schemaVersion: 1;
  channel: string;
  films: number;
  frames: number;
  /** Among designed frames: the share of each world, and per film the share of its most used one. */
  worldShare: Record<string, number>;
  maxOneWorld: Range;
  /** SigLIP mean pairwise distance between a film's designed shots (reference index). */
  variety: Range | null;
  /** Per film: frames with at least one treatment; stock shown raw. */
  treated: Range;
  rawStock: Range;
  treatmentShare: Record<string, number>;
  /** Among frames with words: how much of the frame they cover (OCR); boxed labels and integrated words per film. */
  textArea: Range | null;
  boxed: Range;
  integrated: Range;
  tilted: number;
  /** Data shots: share of frames, the kinds, per minute (share × the channel's cut rate), bar charts among them. */
  dataShare: Range;
  dataKinds: Record<string, number>;
  dataPerMin: number;
  barShareOfData: number;
  /** How long the channel holds a designed shot (its 75th percentile, reference index) — a data shot's cap. */
  dataHoldS: number;
  builtAt: string;
}

export async function ensureDesignBand(o: { root: string; data: string; channelId: string; fresh?: boolean; log?: (s: string) => void }): Promise<DesignBand | null> {
  const file = path.join(o.data, "design-profile", `${o.channelId}.json`);
  if (!o.fresh) {
    const hit = await readFile(file, "utf8").then((t) => JSON.parse(t) as DesignBand, () => null);
    if (hit) return hit;
  }
  const dir = path.join(o.data, "exemplars", o.channelId);
  const idx = await readFile(path.join(dir, "index.json"), "utf8").then((t) => JSON.parse(t) as { shots: Array<{ film: string; frames: string[]; designed: boolean }> }, () => null);
  const shots = (idx?.shots ?? []).filter((s) => s.frames.length);
  if (shots.length < 40) return null;
  o.log?.(`  design band: labelling ${shots.length} real frames of the channel (once)…`);
  const files = shots.map((s) => path.join(dir, s.frames.at(-1)!));
  const labels = await labelDesign(files, { data: o.data });
  const areas = await textAreas(files, o);
  const byFilm = new Map<string, number[]>();
  shots.forEach((s, i) => labels[i] && byFilm.set(s.film, [...(byFilm.get(s.film) ?? []), i]));
  const films = [...byFilm.values()].filter((v) => v.length >= 12);
  if (films.length < 4) return null;
  const L = (i: number) => labels[i]!;
  const designedIdx = (v: number[]) => v.filter((i) => L(i).world !== "footage");
  const perFilm = films.map((v) => {
    const d = designedIdx(v);
    const ws = share(d.map((i) => L(i).world));
    const txt = v.filter((i) => L(i).text !== "none");
    return {
      maxOne: d.length >= 3 ? Math.max(...Object.values(ws)) : NaN,
      treated: v.filter((i) => L(i).treatments.length > 0 || L(i).world !== "footage").length / v.length,
      raw: v.filter((i) => L(i).rawStock).length / v.length,
      boxed: txt.length ? txt.filter((i) => L(i).text === "boxed_label").length / txt.length : NaN,
      integrated: txt.length ? txt.filter((i) => L(i).text === "integrated").length / txt.length : NaN,
      data: v.filter((i) => L(i).data !== "none").length / v.length,
    };
  });
  const all = labels.map((l, i) => ({ l, i })).filter((x) => x.l) as Array<{ l: DesignLabel; i: number }>;
  const designed = all.filter((x) => x.l.world !== "footage");
  const withText = all.filter((x) => x.l.text !== "none");
  const data = all.filter((x) => x.l.data !== "none");
  const txtAreas = withText.map((x) => areas[x.i]).filter((a): a is number => typeof a === "number" && a > 0);
  // reference index: the channel's cut rate, designed shot lengths and SigLIP variety of designed shots per film
  const ix = await loadReferenceIndex(o.data);
  let cutsPerMin = 17;
  let dataHoldS = 6;
  let variety: Range | null = null;
  if (ix) {
    const mine = ix.shots.map((s, k) => ({ s, k })).filter((x) => x.s.channel === o.channelId);
    const mins = ix.manifest.films.filter((f) => f.channel === o.channelId).reduce((a, f) => a + f.durS / 60, 0);
    if (mins > 0) cutsPerMin = mine.length / mins;
    const dl = mine.filter((x) => x.s.picture === "designed").map((x) => x.s.t1 - x.s.t0);
    if (dl.length) dataHoldS = Math.round([...dl].sort((x, y) => x - y)[Math.floor(dl.length * 0.75)]! * 10) / 10;
    const byF = new Map<string, number[]>();
    for (const x of mine) if (x.s.picture === "designed" && ix.shotOk[x.k]) byF.set(x.s.film, [...(byF.get(x.s.film) ?? []), x.k]);
    const vs: number[] = [];
    for (const ks of byF.values()) {
      if (ks.length < 6) continue;
      // at most 40 shots per film, evenly spread
      const step = Math.max(1, Math.floor(ks.length / 40));
      const v = withinFilmVariety(ks.filter((_, j) => j % step === 0).slice(0, 40).map((k) => row(ix.shotVec, k)));
      if (v !== null) vs.push(v);
    }
    if (vs.length >= 4) variety = rangeOf(vs);
  }
  const dataShareAll = data.length / Math.max(1, all.length);
  const band: DesignBand = {
    schemaVersion: 1, channel: o.channelId, films: films.length, frames: all.length,
    worldShare: share(designed.map((x) => x.l.world)), maxOneWorld: rangeOf(perFilm.map((f) => f.maxOne)), variety,
    treated: rangeOf(perFilm.map((f) => f.treated)), rawStock: rangeOf(perFilm.map((f) => f.raw)),
    treatmentShare: Object.fromEntries(TREATMENTS.map((t) => [t, Math.round((all.filter((x) => x.l.treatments.includes(t)).length / Math.max(1, all.length)) * 1000) / 1000])),
    textArea: txtAreas.length >= 10 ? rangeOf(txtAreas) : null, boxed: rangeOf(perFilm.map((f) => f.boxed)), integrated: rangeOf(perFilm.map((f) => f.integrated)),
    tilted: Math.round((withText.filter((x) => x.l.textTilted).length / Math.max(1, withText.length)) * 1000) / 1000,
    dataShare: rangeOf(perFilm.map((f) => f.data)), dataKinds: share(data.map((x) => x.l.data)),
    dataPerMin: Math.round(dataShareAll * cutsPerMin * 100) / 100,
    barShareOfData: Math.round((data.filter((x) => x.l.data === "bar_chart").length / Math.max(1, data.length)) * 1000) / 1000,
    dataHoldS, builtAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(band, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
  return band;
}

// ---- the pure check: the scene designer's measure_film and the preflight gate

export interface DesignProblem { check: string; shots: string[]; what: string; measured: string; band: string }
export interface DesignCheckInput {
  scenes: SceneSpec[];
  /** Every shot of the film in order (id, times). */
  shots: Array<{ id: string; startS: number; endS: number }>;
  durationS: number;
  band: DesignBand;
  /** Labels of each shot's rendered preview (labelDesign), by shot id — scenes, and data-graphic shots for the data checks. */
  labels: Record<string, DesignLabel | null>;
  /** OCR text area of each shot's preview, by shot id. */
  textArea?: Record<string, number | null>;
  /** SigLIP variety of our designed previews (withinFilmVariety), when measured. */
  variety?: number | null;
  /** The asset ref of a picture slot of a shot (for repetition). */
  refOf?: (shotId: string, slot: number) => string | undefined;
}
const pc = (x: number) => `${Math.round(x * 100)}%`;
const textOf = (sc: SceneSpec) => sc.elements.map((e) => (e.type === "text3d" ? e.text : e.type === "component" ? Object.entries(e.props).filter(([k, v]) => typeof v === "string" && !/^(slot|color|colour|align|variant|style|kind|mode|side|tone|edge|code|unit|prefix|suffix)$/i.test(k)).map(([, v]) => String(v)).join(" ") : "")).join(" ").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

export function designProblems(i: DesignCheckInput): DesignProblem[] {
  const out: DesignProblem[] = [];
  const b = i.band;
  const order = new Map(i.shots.map((s, k) => [s.id, k] as [string, number]));
  const len = new Map(i.shots.map((s) => [s.id, s.endS - s.startS] as [string, number]));
  const scenes = [...i.scenes].sort((a, c) => (order.get(a.shotId) ?? 0) - (order.get(c.shotId) ?? 0));
  const ids = scenes.map((s) => s.shotId);
  const lab = (id: string) => i.labels[id] ?? null;
  const labelled = ids.filter((id) => lab(id));
  // 10: one backdrop carrying the film — by what the frames look like (labels), and by the plan's worlds
  const designed = labelled.filter((id) => lab(id)!.world !== "footage");
  const worldOf = (id: string) => { const sc = scenes.find((s) => s.shotId === id)!; return sc.backdrop === "world" && sc.world ? sc.world.kind : sc.backdrop === "stage" ? "plain_stage" : lab(id)!.world; };
  if (designed.length >= 4) {
    const counts = new Map<string, string[]>();
    for (const id of designed) counts.set(worldOf(id), [...(counts.get(worldOf(id)) ?? []), id]);
    const [top, list] = [...counts.entries()].sort((a, c) => c[1].length - a[1].length)[0]!;
    const sh = list.length / designed.length;
    const cap = Math.max(b.maxOneWorld.p90, 0.34);
    if (sh > cap && list.length >= 3) out.push({ check: "one_world", shots: list.slice(Math.ceil(cap * designed.length)), what: `one backdrop ("${top}") carries ${list.length} of ${designed.length} designed shots`, measured: pc(sh), band: `≤ ${pc(cap)} (channel's films: ${pc(b.maxOneWorld.p10)}–${pc(b.maxOneWorld.p90)})` });
    const plain = designed.filter((id) => lab(id)!.world === "plain_stage");
    const plainCap = Math.max(1, Math.round((b.worldShare.plain_stage ?? 0) * designed.length));
    if (plain.length > plainCap) out.push({ check: "template_stage", shots: plain.slice(plainCap), what: "designed shots on a generic template backdrop (dark grid, glow, particles)", measured: `${plain.length}`, band: `≤ ${plainCap}` });
  }
  const b2b: string[] = [];
  for (let k = 1; k < scenes.length; k++) {
    const [a, c] = [scenes[k - 1]!, scenes[k]!];
    if (a.backdrop !== "footage" && c.backdrop !== "footage" && (a.world?.kind ?? a.backdrop) === (c.world?.kind ?? c.backdrop)) b2b.push(c.shotId);
  }
  if (b2b.length) out.push({ check: "backdrop_back_to_back", shots: b2b, what: "the same backdrop in two shots in a row", measured: `${b2b.length}`, band: "0" });
  if (b.variety && typeof i.variety === "number" && i.variety < b.variety.p10) out.push({ check: "world_variety", shots: designed, what: "designed frames look alike (SigLIP distance between them)", measured: i.variety.toFixed(3), band: `${b.variety.p10}–${b.variety.p90}` });
  // 11: treatment on every picture; stock never raw
  if (labelled.length >= 4) {
    const treated = labelled.filter((id) => lab(id)!.treatments.length > 0 || lab(id)!.world !== "footage").length / labelled.length;
    if (treated < b.treated.p10) out.push({ check: "untreated", shots: labelled.filter((id) => !lab(id)!.treatments.length && lab(id)!.world === "footage"), what: "pictures shown without any treatment (grain, texture, leak, vignette, cut-out, grade)", measured: pc(treated), band: `≥ ${pc(b.treated.p10)}` });
    const raw = labelled.filter((id) => lab(id)!.rawStock);
    const rawCap = Math.floor(b.rawStock.p50 * labelled.length);
    if (raw.length > rawCap) out.push({ check: "raw_stock", shots: raw.slice(rawCap), what: "stock shown raw, exactly as filmed", measured: `${raw.length} (${pc(raw.length / labelled.length)})`, band: `≤ ${rawCap} (channel median ${pc(b.rawStock.p50)})` });
  }
  // 12: type at the reference's scale; boxed labels capped; a card never repeats in the next shot
  const withText = labelled.filter((id) => lab(id)!.text !== "none");
  if (b.textArea && i.textArea && withText.length >= 3) {
    const ar = withText.map((id) => ({ id, a: i.textArea![id] })).filter((x): x is { id: string; a: number } => typeof x.a === "number" && x.a > 0);
    const med = rangeOf(ar.map((x) => x.a)).p50;
    if (ar.length >= 3 && med < b.textArea.p50 * 0.5) out.push({ check: "small_text", shots: ar.filter((x) => x.a < b.textArea!.p50 * 0.5).map((x) => x.id), what: "words on screen are small against the channel's", measured: `median ${pc(med)} of the frame`, band: `channel ${pc(b.textArea.p10)}–${pc(b.textArea.p90)} (median ${pc(b.textArea.p50)})` });
  }
  if (withText.length >= 3) {
    const boxed = withText.filter((id) => lab(id)!.text === "boxed_label");
    const cap = Math.max(1, Math.round(Math.max(b.boxed.p90, 0.15) * withText.length));
    if (boxed.length > cap) out.push({ check: "boxed_labels", shots: boxed.slice(cap), what: "words in small boxed labels instead of set into the picture", measured: `${boxed.length} of ${withText.length}`, band: `≤ ${cap} (channel ≤ ${pc(b.boxed.p90)})` });
  }
  const rep: string[] = [];
  for (let k = 1; k < scenes.length; k++) {
    const [a, c] = [textOf(scenes[k - 1]!), textOf(scenes[k]!)];
    if (a.length > 3 && a === c) rep.push(scenes[k]!.shotId);
  }
  if (rep.length) out.push({ check: "repeat_card", shots: rep, what: "the same card shown again in the next shot (a split repeated)", measured: `${rep.length}`, band: "0" });
  // 13: data the channel's way — how many, which kinds, how long held
  // data shots are judged on every labelled shot (data graphics are not scenes)
  const everyLabelled = Object.keys(i.labels).filter((id) => i.labels[id]).sort((a, c) => (order.get(a) ?? 0) - (order.get(c) ?? 0));
  const dataIds = everyLabelled.filter((id) => lab(id)!.data !== "none");
  const allowed = lengthPlan(i.durationS).dataShots(b.dataPerMin);
  if (dataIds.length > allowed) out.push({ check: "data_rate", shots: dataIds.slice(allowed), what: "more data shots than the channel uses at this length", measured: `${dataIds.length}`, band: `≤ ${allowed} (${b.dataPerMin.toFixed(1)} a minute)` });
  const bars = dataIds.filter((id) => lab(id)!.data === "bar_chart" || lab(id)!.data === "other_chart");
  const barCap = Math.max(1, Math.round((b.barShareOfData + (b.dataKinds.other_chart ?? 0)) * Math.max(dataIds.length, allowed)));
  if (bars.length > barCap) out.push({ check: "chart_slides", shots: bars.slice(barCap), what: "charts where the channel shows one number, a drawn line, an annotated picture or icons", measured: `${bars.length} charts`, band: `≤ ${barCap}` });
  const held = dataIds.filter((id) => (len.get(id) ?? 0) > b.dataHoldS);
  if (held.length) out.push({ check: "data_hold", shots: held, what: "a data shot held longer than the channel holds one", measured: held.map((id) => `${id} ${(len.get(id) ?? 0).toFixed(1)} s`).join(", "), band: `≤ ${b.dataHoldS} s` });
  // 14: each picture once (a second use needs another crop and treatment); judged from the plan
  if (i.refOf) {
    const uses = new Map<string, Array<{ id: string; crop: number; treat: string }>>();
    for (const sc of scenes) {
      const add = (slot: number, crop: number, treat: string) => {
        const r = i.refOf!(sc.shotId, slot);
        if (r) uses.set(r, [...(uses.get(r) ?? []), { id: sc.shotId.replace(/(_\d+)+$/, ""), crop, treat }]);
      };
      if (sc.world?.slot !== undefined) add(sc.world.slot, 1, `world:${sc.world.kind}`);
      for (const e of sc.elements) if (e.type === "photo" || e.type === "cutout" || e.type === "card3d") add(e.slot, e.w, e.type === "photo" ? e.grade : e.type);
    }
    const bad: string[] = [];
    for (const u of uses.values()) {
      const films = [...new Map(u.map((x) => [x.id, x])).values()];
      if (films.length < 2) continue;
      const [a, c] = [films[0]!, films[1]!];
      const okSecond = Math.abs(a.crop - c.crop) / Math.max(a.crop, c.crop) >= 0.3 && a.treat !== c.treat;
      bad.push(...films.slice(okSecond ? 2 : 1).map((x) => x.id));
    }
    if (bad.length) out.push({ check: "repeat_picture", shots: [...new Set(bad)], what: "a picture shown again (a second use needs a different crop and treatment, never a third)", measured: `${bad.length}`, band: "0" });
  }
  return out;
}

/**
 * Build list 5, item 13 (scene side): the figure on screen equals what the voice says at that moment, totals included.
 * `shown` are the figures a shot puts on screen (as displayed), `spoken` the figures said within ±1.5 s of it (value and
 * unit). A shown figure nobody says is a problem; parts on screen whose total is said must add up to it at the spoken
 * precision, or the total must be on screen too.
 */
export function figureParity(shots: Array<{ id: string; shown: Array<{ value: number; unit: string; text: string }>; spoken: Array<{ value: number; unit: string; text: string; step: number }> }>): DesignProblem[] {
  const bad: Array<{ id: string; why: string }> = [];
  const same = (a: { value: number; unit: string }, s: { value: number; unit: string; step: number }) => (a.unit === s.unit || !a.unit || !s.unit) && Math.abs(a.value - s.value) <= s.step / 2 + 1e-9 * Math.abs(s.value);
  for (const sh of shots) {
    if (!sh.shown.length) continue;
    const unsaid = sh.shown.filter((x) => !sh.spoken.some((s) => same(x, s)));
    for (const s of sh.spoken) {
      if (sh.shown.some((x) => same(x, s))) continue;
      const parts = sh.shown.filter((x) => (x.unit || s.unit) === (s.unit || x.unit));
      if (parts.length >= 2) {
        const sum = parts.reduce((a, x) => a + x.value, 0);
        if (Math.abs(sum - s.value) > s.step / 2 + 1e-9 * Math.abs(s.value)) bad.push({ id: sh.id, why: `the voice says ${s.text}; the screen shows ${parts.map((x) => x.text).join(" + ")} = ${+sum.toPrecision(4)}, which does not add up to it — show the total, or parts that sum to it` });
      }
    }
    // a shown part is fine when the parts add up to a spoken total
    const totalSaid = sh.spoken.some((s) => Math.abs(sh.shown.reduce((a, x) => a + x.value, 0) - s.value) <= s.step / 2 + 1e-9 * Math.abs(s.value));
    if (unsaid.length && !totalSaid) bad.push({ id: sh.id, why: `on screen but never said here: ${unsaid.map((x) => x.text).join(", ")}` });
  }
  return bad.length ? [{ check: "figure_parity", shots: [...new Set(bad.map((x) => x.id))], what: bad.map((x) => `${x.id}: ${x.why}`).join("; "), measured: `${bad.length}`, band: "0" }] : [];
}
