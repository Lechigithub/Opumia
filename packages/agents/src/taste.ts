/**
 * Trained taste: small classifiers learned from the reference on SigLIP 2 embeddings (reference-index.ts). No model
 * call at scoring time — a dot product — and the same answer every time.
 *
 * Two heads per kind (thumbnail, shot):
 *   pro      the reference's real work (all five channels) vs our renders and known-bad versions of real pictures
 *            (soft/upscaled, blurred, flat, one-colour tint, pasted on an empty stage, heavy JPEG). "Would this pass as
 *            professionally made?"
 *   channel  the target channel's real work vs the other channels' real work. "Is it this channel's look?"
 * score = 10 × √(pro × channel). Measured on held-out groups (whole films / whole jobs never seen in training):
 * AUC per head and where our own work sits — written with the weights to data/taste/<channel>-<kind>.json.
 *
 * Limits (honest): a head can learn subject matter instead of craft (our films are about few topics); the degraded
 * negatives and the grouped hold-out are there to limit that, and the report says how well it generalises. It
 * measures distance to the reference, not "better than" it.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import { DIM, embedPictures, loadReferenceIndex, nearest, row, type EmbedItem } from "./reference-index.js";

export type TasteKind = "thumb" | "shot";
export const DEGRADES = ["soft", "blur", "flat", "mono_tint", "pasted", "jpeg"] as const;

interface Head { w: number[]; b: number; auc: number; n: { pos: number; neg: number } }
export interface TasteModel {
  schemaVersion: 1;
  channel: ChannelId;
  kind: TasteKind;
  pro: Head;
  channelHead: Head;
  /** Held-out: our own work's scores and the real channel's scores (median, p10, p90 of the 0–10 score). */
  calibration: { ours: { median: number; p90: number; n: number }; real: { median: number; p10: number; n: number }; degraded: { median: number; n: number } };
  trainedAt: string;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** L2-regularised logistic regression, class-balanced, full-batch gradient descent with momentum. */
function fit(X: Float32Array[], y: number[], o: { lambda?: number; iters?: number } = {}): { w: Float64Array; b: number } {
  const lambda = o.lambda ?? 1e-3;
  const iters = o.iters ?? 400;
  const n = X.length;
  const pos = y.filter((v) => v === 1).length;
  const wPos = n / (2 * Math.max(1, pos));
  const wNeg = n / (2 * Math.max(1, n - pos));
  const w = new Float64Array(DIM);
  const vW = new Float64Array(DIM);
  let b = 0, vB = 0;
  const lr = 2.0;
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(DIM);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i]!;
      let z = b;
      for (let d = 0; d < DIM; d++) z += w[d]! * x[d]!;
      const e = (sigmoid(z) - y[i]!) * (y[i] ? wPos : wNeg);
      for (let d = 0; d < DIM; d++) g[d]! += e * x[d]!;
      gb += e;
    }
    for (let d = 0; d < DIM; d++) {
      vW[d] = 0.9 * vW[d]! - lr * (g[d]! / n + lambda * w[d]!);
      w[d]! += vW[d]!;
    }
    vB = 0.9 * vB - lr * (gb / n);
    b += vB;
  }
  return { w, b };
}

const predict = (m: { w: ArrayLike<number>; b: number }, x: Float32Array) => {
  let z = m.b;
  for (let d = 0; d < DIM; d++) z += m.w[d]! * x[d]!;
  return sigmoid(z);
};

function auc(scores: number[], y: number[]): number {
  const p = scores.map((s, i) => ({ s, y: y[i]! })).sort((a, b) => a.s - b.s);
  let rank = 0, sumPos = 0, nPos = 0;
  for (const it of p) {
    rank++;
    if (it.y) { sumPos += rank; nPos++; }
  }
  const nNeg = p.length - nPos;
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5;
}

interface Sample { x: Float32Array; y: number; group: string; tag: "real" | "ours" | "degraded" | "other" }

/** Grouped k-fold: held-out predictions for every sample (no group is ever in its own training fold). */
function heldOut(samples: Sample[], k = 5): number[] {
  const groups = [...new Set(samples.map((s) => s.group))].sort();
  const fold = new Map(groups.map((g, i) => [g, i % k]));
  const out = new Array<number>(samples.length).fill(0.5);
  for (let f = 0; f < k; f++) {
    const tr = samples.filter((s) => fold.get(s.group) !== f);
    if (!tr.some((s) => s.y) || !tr.some((s) => !s.y)) continue;
    const m = fit(tr.map((s) => s.x), tr.map((s) => s.y));
    samples.forEach((s, i) => {
      if (fold.get(s.group) === f) out[i] = predict(m, s.x);
    });
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]! * 10) / 10 : 0;
};

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Our own work found in out/: thumbnail renders, or scene preview stills and frames of rendered films. */
export function ourWork(root: string, kind: TasteKind, excludeJobs: string[] = []): Array<{ file: string; t?: number; group: string }> {
  const outDir = path.join(root, "out");
  if (!existsSync(outDir)) return [];
  const res: Array<{ file: string; t?: number; group: string }> = [];
  for (const job of readdirSync(outDir)) {
    if (excludeJobs.includes(job)) continue;
    const jd = path.join(outDir, job);
    if (!statSync(jd).isDirectory()) continue;
    if (kind === "thumb") {
      for (const f of readdirSync(jd)) if (/^thumbnail(\.r\d+)?\.jpg$/.test(f)) res.push({ file: path.join(jd, f), group: `ours:${job}` });
      const td = path.join(jd, "thumbs");
      if (existsSync(td)) for (const f of readdirSync(td)) if (/^r\d+\.jpg$/.test(f)) res.push({ file: path.join(td, f), group: `ours:${job}` });
    } else {
      for (const sub of ["previews", "previews_agent", "previews_final"]) {
        const d = path.join(jd, sub);
        if (existsSync(d)) for (const f of readdirSync(d).sort()) if (/\.(jpg|png)$/.test(f) && !/sheet/.test(f)) res.push({ file: path.join(d, f), group: `ours:${job}` });
      }
      for (const f of readdirSync(jd)) if (/\.mp4$/.test(f)) for (let t = 3; t < 60; t += 4) res.push({ file: path.join(jd, f), t, group: `ours:${job}` });
    }
  }
  return res;
}

/** `excludeFilms` (reference film ids) and `excludeJobs` (our out/ folders) are left out of training entirely, so a
 *  referee can be tested on material the model never saw; `write: false` returns the model without saving it. */
export async function trainTaste(o: { root: string; data: string; reference: string; channel: ChannelId; kind: TasteKind; log?: (s: string) => void; excludeFilms?: string[]; excludeJobs?: string[]; write?: boolean }): Promise<TasteModel> {
  const exFilms = new Set(o.excludeFilms ?? []);
  const log = o.log ?? (() => {});
  const ix = await loadReferenceIndex(o.data);
  if (!ix) throw new Error("no reference index — run `pnpm opumia build-reference-index` first");
  const rnd = seeded(o.kind === "thumb" ? 11 : 23);
  const real: Sample[] = [];
  const degradeItems: Array<EmbedItem & { group: string }> = [];
  if (o.kind === "thumb") {
    ix.thumbs.forEach((t, i) => {
      if (!ix.thumbOk[i]) return;
      real.push({ x: Float32Array.from(row(ix.thumbVec, i)), y: 1, group: t.film, tag: t.channel === o.channel ? "real" : "other" });
      for (const [j, d] of DEGRADES.entries()) if (t.channel === o.channel || (i + j) % 3 === 0) degradeItems.push({ file: path.join(o.reference, t.file), degrade: d, seed: i * 7 + j, group: t.film });
    });
  } else {
    // A sample of real shots: up to 60 per film, all channels; degraded versions of a smaller sample.
    const byFilm = new Map<string, number[]>();
    ix.shots.forEach((s, i) => {
      if (ix.shotOk[i] && !exFilms.has(s.film)) (byFilm.get(s.film) ?? byFilm.set(s.film, []).get(s.film)!).push(i);
    });
    const films = new Map(ix.manifest.films.map((f) => [f.id, f]));
    for (const [film, idx] of byFilm) {
      const ch = films.get(film)!.channel;
      const take = idx.filter(() => rnd() < Math.min(1, 60 / idx.length));
      for (const i of take) real.push({ x: Float32Array.from(row(ix.shotVec, i)), y: 1, group: film, tag: ch === o.channel ? "real" : "other" });
      for (const i of take.filter(() => rnd() < (ch === o.channel ? 0.35 : 0.1))) {
        const s = ix.shots[i]!;
        const dir = (await readFile(path.join(o.reference, ".analysis", "meta", `${film}.json`), "utf8").then((t) => (JSON.parse(t) as { folder: string }).folder, () => null));
        if (!dir) continue;
        const mp4 = readdirSync(path.join(o.reference, dir)).find((f) => f.endsWith(".mp4"));
        if (mp4) degradeItems.push({ file: path.join(o.reference, dir, mp4), t: (s.t0 + s.t1) / 2, degrade: DEGRADES[Math.floor(rnd() * DEGRADES.length)]!, seed: i, group: film });
      }
    }
  }
  const ours = ourWork(o.root, o.kind, o.excludeJobs ?? []);
  log(`  taste ${o.kind}: ${real.length} real, ${ours.length} of ours, ${degradeItems.length} degraded — embedding what is not cached…`);
  const ov = await embedPictures({ root: o.root, data: o.data, items: ours.map((x) => ({ file: x.file, t: x.t ?? null })), log });
  const dv = await embedPictures({ root: o.root, data: o.data, items: degradeItems, log });
  const oursS: Sample[] = ours.flatMap((x, i) => (ov[i] ? [{ x: ov[i]!, y: 0, group: x.group, tag: "ours" as const }] : []));
  const degS: Sample[] = degradeItems.flatMap((x, i) => (dv[i] ? [{ x: dv[i]!, y: 0, group: x.group, tag: "degraded" as const }] : []));

  // pro head: all real vs ours + degraded. Degraded versions share their source film's group (never split across folds).
  const proSet = [...real, ...oursS, ...degS];
  const proHeld = heldOut(proSet);
  const proAuc = auc(proHeld, proSet.map((s) => s.y));
  // channel head: this channel's real vs other channels' real.
  const chSet = real.map((s) => ({ ...s, y: s.tag === "real" ? 1 : 0 }));
  const chHeld = heldOut(chSet);
  const chAuc = auc(chHeld, chSet.map((s) => s.y));
  const proM = fit(proSet.map((s) => s.x), proSet.map((s) => s.y));
  const chM = fit(chSet.map((s) => s.x), chSet.map((s) => s.y));

  // Calibration on held-out predictions: the channel head for ours/degraded is the full model's (they were never in
  // its training set); the pro head is held-out.
  const score = (pro: number, ch: number) => 10 * Math.sqrt(pro * ch);
  const realCh = new Map(real.map((s, i) => [s, chHeld[i]!]));
  const scored = proSet.map((s, i) => ({ s, v: score(proHeld[i]!, realCh.get(s) ?? predict(chM, s.x)) }));
  const tagged = (t: Sample["tag"]) => scored.filter((x) => x.s.tag === t).map((x) => x.v);
  const model: TasteModel = {
    schemaVersion: 1, channel: o.channel, kind: o.kind,
    pro: { w: Array.from(proM.w, (v) => Math.round(v * 1e5) / 1e5), b: proM.b, auc: Math.round(proAuc * 1000) / 1000, n: { pos: real.length, neg: oursS.length + degS.length } },
    channelHead: { w: Array.from(chM.w, (v) => Math.round(v * 1e5) / 1e5), b: chM.b, auc: Math.round(chAuc * 1000) / 1000, n: { pos: chSet.filter((s) => s.y).length, neg: chSet.filter((s) => !s.y).length } },
    calibration: {
      ours: { median: pct(tagged("ours"), 0.5), p90: pct(tagged("ours"), 0.9), n: tagged("ours").length },
      real: { median: pct(tagged("real"), 0.5), p10: pct(tagged("real"), 0.1), n: tagged("real").length },
      degraded: { median: pct(tagged("degraded"), 0.5), n: tagged("degraded").length },
    },
    trainedAt: new Date().toISOString(),
  };
  if (o.write === false) return model;
  const file = path.join(o.data, "taste", `${o.channel}-${o.kind}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(model) + "\n");
  await rename(`${file}.tmp`, file);
  return model;
}

/** A model's 0–10 score for one embedding (the same formula as scoreTaste). */
export function tasteOf(m: TasteModel, v: Float32Array): number {
  return Math.round(100 * Math.sqrt(predict(m.pro, v) * predict(m.channelHead, v))) / 10;
}

const models = new Map<string, Promise<TasteModel | null>>();
export function loadTaste(data: string, channel: ChannelId, kind: TasteKind): Promise<TasteModel | null> {
  const k = `${data}|${channel}|${kind}`;
  if (!models.has(k)) models.set(k, readFile(path.join(data, "taste", `${channel}-${kind}.json`), "utf8").then((t) => JSON.parse(t) as TasteModel, () => null));
  return models.get(k)!;
}

export interface TasteScore { score: number; pro: number; channel: number; /** where it sits against the real channel's held-out scores */ verdict: string; nearest: Array<{ id: string; sim: number; what: string }> }

/** Score our pictures with the trained taste model; also the nearest real examples by picture. */
export async function scoreTaste(o: { root: string; data: string; channel: ChannelId; kind: TasteKind; items: EmbedItem[]; log?: (s: string) => void }): Promise<Array<TasteScore | null>> {
  const m = await loadTaste(o.data, o.channel, o.kind);
  if (!m) return o.items.map(() => null);
  const ix = await loadReferenceIndex(o.data);
  const vs = await embedPictures({ root: o.root, data: o.data, items: o.items, ...(o.log ? { log: o.log } : {}) });
  return vs.map((v) => {
    if (!v) return null;
    const pro = predict(m.pro, v);
    const ch = predict(m.channelHead, v);
    const score = Math.round(100 * Math.sqrt(pro * ch)) / 10;
    const c = m.calibration;
    const verdict = score >= c.real.median ? "inside the real channel's typical range" : score >= c.real.p10 ? "inside the real channel's range (lower part)" : score > c.ours.p90 ? "better than most of our past work, still below the real channel" : "reads like our past work, not like the channel";
    const near = !ix ? [] : o.kind === "thumb"
      ? nearest(ix.thumbVec, ix.thumbOk, v, 3, (i) => ix.thumbs[i]!.channel === o.channel).map((n) => ({ id: ix.thumbs[n.i]!.film, sim: Math.round(n.sim * 1000) / 1000, what: ix.thumbs[n.i]!.title }))
      : nearest(ix.shotVec, ix.shotOk, v, 3, (i) => ix.shots[i]!.channel === o.channel).map((n) => ({ id: ix.shots[n.i]!.id, sim: Math.round(n.sim * 1000) / 1000, what: `${ix.shots[n.i]!.picture}/${ix.shots[n.i]!.overlay}: "${ix.shots[n.i]!.line.slice(0, 80)}"` }));
    return { score, pro: Math.round(pro * 1000) / 1000, channel: Math.round(ch * 1000) / 1000, verdict, nearest: near };
  });
}
