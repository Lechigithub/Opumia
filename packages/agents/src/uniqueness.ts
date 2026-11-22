/**
 * Pixel uniqueness (build list 2, step 1): do two films LOOK alike — the same cards, fonts, patterns, pictures? A
 * film's look is the set of its frames' SigLIP vectors (one a second); two films are compared by how much of each
 * has a near match in the other (mean nearest-neighbour similarity, both ways). The channel's own films set the band:
 * real films share a style but never look like each other, so ours may sit no closer to each other than real films
 * of the channel usually do (their p90).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import { probeDuration } from "@opumia/senses";
import { DIM, embedPictures, loadReferenceIndex, row } from "./reference-index.js";

export interface LookSet { film: string; vecs: Float32Array[] }
export interface UniquenessBand { channel: string; pairs: number; p10: number; median: number; p90: number; max: number; measuredAt: string }

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let d = 0; d < DIM; d++) s += a[d]! * b[d]!; return s; };
/** Mean over A of the best match in B. */
const nn = (A: Float32Array[], B: Float32Array[]) => A.reduce((t, a) => t + Math.max(...B.map((b) => dot(a, b))), 0) / Math.max(1, A.length);
export const lookSimilarity = (A: LookSet, B: LookSet) => Math.round(((nn(A.vecs, B.vecs) + nn(B.vecs, A.vecs)) / 2) * 1000) / 1000;

/** A rendered film's look: one frame a second, embedded (cached in data/.cache/embed). */
export async function filmLook(o: { root: string; data: string; video: string; film: string; every?: number; log?: (s: string) => void }): Promise<LookSet> {
  const dur = await probeDuration(o.video);
  const step = o.every ?? 1;
  const items = Array.from({ length: Math.max(1, Math.floor(dur / step)) }, (_, k) => ({ file: o.video, t: 0.5 + k * step }));
  const vs = await embedPictures({ root: o.root, data: o.data, items, ...(o.log ? { log: o.log } : {}) });
  return { film: o.film, vecs: vs.flatMap((v) => (v ? [v] : [])) };
}

/** The channel's band: pairs of its real films, each film's labelled shots as its look (up to 60 shots). */
export async function uniquenessBand(o: { data: string; channel: ChannelId; pairs?: number }): Promise<UniquenessBand> {
  const file = path.join(o.data, "eval", `uniqueness-band-${o.channel}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as UniquenessBand;
  const ix = await loadReferenceIndex(o.data);
  if (!ix) throw new Error("no reference index");
  const byFilm = new Map<string, number[]>();
  ix.shots.forEach((s, i) => { if (s.channel === o.channel && ix.shotOk[i]) (byFilm.get(s.film) ?? byFilm.set(s.film, []).get(s.film)!).push(i); });
  const looks: LookSet[] = [...byFilm].map(([film, idx]) => ({ film, vecs: idx.filter((_, k) => k % Math.max(1, Math.floor(idx.length / 60)) === 0).slice(0, 60).map((i) => Float32Array.from(row(ix.shotVec, i))) }));
  const sims: number[] = [];
  const want = o.pairs ?? 120;
  for (let k = 0; k < want && looks.length > 1; k++) {
    const a = looks[(k * 7) % looks.length]!, b = looks[(k * 11 + 1) % looks.length]!;
    if (a.film === b.film) continue;
    sims.push(lookSimilarity(a, b));
  }
  sims.sort((x, y) => x - y);
  const q = (p: number) => sims[Math.min(sims.length - 1, Math.round((sims.length - 1) * p))] ?? 0;
  const band: UniquenessBand = { channel: o.channel, pairs: sims.length, p10: q(0.1), median: q(0.5), p90: q(0.9), max: q(1), measuredAt: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(band, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  return band;
}
