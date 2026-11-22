/**
 * The full reference index (ingest/reference/shot-index.ts → data/reference-index/) as agents use it: every real
 * shot and thumbnail with its labels and SigLIP 2 embedding, nearest-neighbour search by picture, and embedding of
 * our own pictures with the same function (tools/siglip/embed.py), memoised in data/.cache/embed/.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runEmbedder, type ReferenceIndexManifest, type ReferenceShot, type ReferenceThumb } from "@opumia/ingest";

export const DIM = 1152;

export interface ReferenceIndex {
  manifest: ReferenceIndexManifest;
  shots: ReferenceShot[];
  thumbs: ReferenceThumb[];
  /** Row-major N × DIM, L2-normalised; a row of zeros was not read. */
  shotVec: Float32Array;
  thumbVec: Float32Array;
  shotOk: Uint8Array;
  thumbOk: Uint8Array;
}

/** IEEE half → float. */
function f16ToF32(buf: Buffer): Float32Array {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = buf[2 * i]! | (buf[2 * i + 1]! << 8);
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    out[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  return out;
}

const cache = new Map<string, Promise<ReferenceIndex | null>>();

export function loadReferenceIndex(data: string): Promise<ReferenceIndex | null> {
  const dir = path.join(data, "reference-index");
  if (!cache.has(dir))
    cache.set(dir, (async () => {
      const manifest = await readFile(path.join(dir, "manifest.json"), "utf8").then((t) => JSON.parse(t) as ReferenceIndexManifest, () => null);
      if (!manifest || !existsSync(path.join(dir, "shots.f16"))) return null;
      const lines = async (f: string) => (await readFile(path.join(dir, f), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const [shots, thumbs] = [(await lines("shots.jsonl")) as ReferenceShot[], (await lines("thumbs.jsonl")) as ReferenceThumb[]];
      return {
        manifest, shots, thumbs,
        shotVec: f16ToF32(await readFile(path.join(dir, "shots.f16"))), thumbVec: f16ToF32(await readFile(path.join(dir, "thumbs.f16"))),
        shotOk: new Uint8Array(await readFile(path.join(dir, "shots.ok"))), thumbOk: new Uint8Array(await readFile(path.join(dir, "thumbs.ok"))),
      };
    })());
  return cache.get(dir)!;
}

export const row = (m: Float32Array, i: number) => m.subarray(i * DIM, (i + 1) * DIM);
export const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i]! * b[i]!;
  return s;
};

/** The k rows of m nearest to v (cosine), optionally filtered by row index. */
export function nearest(m: Float32Array, ok: Uint8Array, v: Float32Array, k: number, keep?: (i: number) => boolean): Array<{ i: number; sim: number }> {
  const best: Array<{ i: number; sim: number }> = [];
  const n = ok.length;
  for (let i = 0; i < n; i++) {
    if (!ok[i] || (keep && !keep(i))) continue;
    const s = dot(row(m, i), v);
    if (best.length < k || s > best[best.length - 1]!.sim) {
      best.push({ i, sim: s });
      best.sort((a, b) => b.sim - a.sim);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

export interface EmbedItem { file: string; t?: number | null; degrade?: string; seed?: number }

/** Embed our own pictures (or degraded versions of any picture) with the same function as the reference. Memoised by
 * file|size|mtime|t|degrade|seed in data/.cache/embed/. Returns null for a picture that could not be read. */
export async function embedPictures(o: { root: string; data: string; items: EmbedItem[]; log?: (s: string) => void }): Promise<Array<Float32Array | null>> {
  const dir = path.join(o.data, ".cache", "embed");
  await mkdir(dir, { recursive: true });
  const keys = await Promise.all(o.items.map(async (it) => {
    const st = await stat(it.file).catch(() => null);
    return createHash("sha1").update(`${path.resolve(it.file)}|${st?.size}|${st?.mtimeMs}|${it.t ?? ""}|${it.degrade ?? ""}|${it.seed ?? 0}`).digest("hex");
  }));
  const out: Array<Float32Array | null> = new Array(o.items.length).fill(null);
  const todo: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    const b = await readFile(path.join(dir, `${keys[i]}.f16`)).catch(() => null);
    if (b && b.length === DIM * 2) out[i] = f16ToF32(b);
    else todo.push(i);
  }
  if (todo.length) {
    const tmp = path.join(dir, `batch-${process.pid}-${Date.now()}`);
    await runEmbedder({ root: o.root, out: tmp, items: todo.map((i) => ({ file: o.items[i]!.file, t: o.items[i]!.t ?? null, ...(o.items[i]!.degrade ? { degrade: o.items[i]!.degrade, seed: o.items[i]!.seed ?? 0 } : {}) })) as Array<{ file: string; t: number | null }>, ...(o.log ? { log: o.log } : {}) });
    const all = await readFile(`${tmp}.f16`);
    const ok = await readFile(`${tmp}.ok`);
    for (let j = 0; j < todo.length; j++) {
      if (!ok[j]) continue;
      const b = all.subarray(j * DIM * 2, (j + 1) * DIM * 2);
      out[todo[j]!] = f16ToF32(Buffer.from(b));
      await writeFile(path.join(dir, `${keys[todo[j]!]}.f16.tmp`), b);
      await rename(path.join(dir, `${keys[todo[j]!]}.f16.tmp`), path.join(dir, `${keys[todo[j]!]}.f16`));
    }
    await rm(`${tmp}.f16`, { force: true });
    await rm(`${tmp}.ok`, { force: true });
  }
  return out;
}
