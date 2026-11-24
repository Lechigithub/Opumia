// A fair picture-style measure (hand film 1, owner 2026-11-24): does a frame look like MagnatesMedia rather than
// the other reference channels, with every channel's corner logo masked (degrade "corners", ours too)? Trained on
// real frames only, so it cannot learn "our renders"; validated on held-out films (grouped by film), and then it must
// rank our films the way the owner does before it is trusted.
//   npx tsx apps/cli/src/dev/hand/style-head.ts train
//   npx tsx apps/cli/src/dev/hand/style-head.ts score label=file …
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DIM, embedPictures } from "@opumia/agents";

const root = process.cwd(), data = path.join(root, "data"), ref = path.join(root, "Reference");
const OUT = path.join(data, "taste", "magnates-media-style.json");
const sig = (z: number) => 1 / (1 + Math.exp(-z));
function fit(X: Float32Array[], y: number[], lambda = 2e-3, iters = 300) {
  const n = X.length, pos = y.filter((v) => v === 1).length, wp = n / (2 * pos), wn = n / (2 * (n - pos));
  const w = new Float64Array(DIM), v = new Float64Array(DIM); let b = 0, vb = 0;
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(DIM); let gb = 0;
    for (let i = 0; i < n; i++) { const x = X[i]!; let z = b; for (let d = 0; d < DIM; d++) z += w[d]! * x[d]!; const e = (sig(z) - y[i]!) * (y[i] ? wp : wn); for (let d = 0; d < DIM; d++) g[d]! += e * x[d]!; gb += e; }
    for (let d = 0; d < DIM; d++) { v[d] = 0.9 * v[d]! - 1.5 * (g[d]! / n + lambda * w[d]!); w[d]! += v[d]!; }
    vb = 0.9 * vb - 1.5 * (gb / n); b += vb;
  }
  return { w: Array.from(w, (x) => Math.round(x * 1e5) / 1e5), b };
}
const pred = (m: { w: number[]; b: number }, x: Float32Array) => { let z = m.b; for (let d = 0; d < DIM; d++) z += m.w[d]! * x[d]!; return sig(z); };
const auc = (s: number[], y: number[]) => { const p = s.filter((_, i) => y[i]), q = s.filter((_, i) => !y[i]); let c = 0; for (const a of p) for (const b of q) c += a > b ? 1 : a === b ? 0.5 : 0; return c / (p.length * q.length); };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]!; };

if (process.argv[2] === "train") {
  // film id → its mp4 (Reference/.analysis/meta/<id>.json names the folder)
  const files = new Map<string, string>();
  const metaDir = path.join(ref, ".analysis", "meta");
  for (const mf of await readdir(metaDir)) {
    const meta = JSON.parse(await readFile(path.join(metaDir, mf), "utf8")) as { id: string; folder: string };
    const dir = path.join(ref, meta.folder);
    if (!existsSync(dir)) continue;
    const mp4 = (await readdir(dir)).find((f) => f.endsWith(".mp4"));
    if (mp4) files.set(meta.id, path.join(dir, mp4));
  }
  const byFilm = new Map<string, Array<{ t: number; channel: string }>>();
  for (const l of (await readFile(path.join(data, "reference-index", "shots.jsonl"), "utf8")).split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as { film: string; channel: string; t0: number; t1: number; picture: string };
    if (!files.has(r.film) || r.t1 - r.t0 < 0.8) continue;
    (byFilm.get(r.film) ?? byFilm.set(r.film, []).get(r.film)!).push({ t: +((r.t0 + r.t1) / 2).toFixed(2), channel: r.channel });
  }
  // even sample: MagnatesMedia 36 frames a film, other channels 12 a film (≈ 1:1 overall)
  const items: Array<{ file: string; t: number; film: string; y: number }> = [];
  for (const [film, shots] of byFilm) {
    const mm = shots[0]!.channel === "magnates-media";
    const k = mm ? 36 : 12;
    const step = Math.max(1, Math.floor(shots.length / k));
    for (let i = 0; i < shots.length && items.filter((x) => x.film === film).length < k; i += step) items.push({ file: files.get(film)!, t: shots[i]!.t, film, y: mm ? 1 : 0 });
  }
  console.log(`embedding ${items.length} real frames (corners masked): ${items.filter((x) => x.y).length} MagnatesMedia, ${items.filter((x) => !x.y).length} other channels`);
  const vs = await embedPictures({ root, data, items: items.map((x) => ({ file: x.file, t: x.t, degrade: "corners" })), log: console.log });
  const ok = items.map((x, i) => ({ ...x, v: vs[i] })).filter((x): x is typeof x & { v: Float32Array } => Boolean(x.v));
  // grouped CV by film: 5 folds
  const films = [...new Set(ok.map((x) => x.film))].sort();
  const fold = new Map(films.map((f, i) => [f, i % 5]));
  const held: number[] = new Array(ok.length).fill(NaN);
  for (let f = 0; f < 5; f++) {
    const tr = ok.filter((x) => fold.get(x.film) !== f);
    const m = fit(tr.map((x) => x.v), tr.map((x) => x.y));
    ok.forEach((x, i) => { if (fold.get(x.film) === f) held[i] = pred(m, x.v); });
  }
  const a = auc(held, ok.map((x) => x.y));
  // per held-out film: the median score of its frames (the unit a film is judged on)
  const filmScore = (ch: number) => films.filter((f) => ok.find((x) => x.film === f)!.y === ch).map((f) => pct(ok.map((x, i) => (x.film === f ? held[i]! : NaN)).filter(Number.isFinite), 0.5));
  const mmF = filmScore(1), otherF = filmScore(0);
  const m = fit(ok.map((x) => x.v), ok.map((x) => x.y));
  await writeFile(OUT, JSON.stringify({ schemaVersion: 1, what: "MagnatesMedia vs the other 4 reference channels, every corner masked, real frames only", auc: +a.toFixed(3), heldOutFilms: { magnatesMedia: { p10: +pct(mmF, 0.1).toFixed(3), median: +pct(mmF, 0.5).toFixed(3), n: mmF.length }, others: { median: +pct(otherF, 0.5).toFixed(3), p90: +pct(otherF, 0.9).toFixed(3), n: otherF.length } }, head: m, trainedAt: new Date().toISOString() }));
  console.log(`style head: frame AUC ${a.toFixed(3)} on held-out films; held-out MagnatesMedia films p10 ${pct(mmF, 0.1).toFixed(3)} median ${pct(mmF, 0.5).toFixed(3)}; other channels' films median ${pct(otherF, 0.5).toFixed(3)} p90 ${pct(otherF, 0.9).toFixed(3)}`);
} else {
  const hd = JSON.parse(await readFile(OUT, "utf8")) as { head: { w: number[]; b: number }; heldOutFilms: Record<string, Record<string, number>> };
  for (const arg of process.argv.slice(3)) {
    const [label, file] = arg.split("=") as [string, string];
    const vs = await embedPictures({ root, data, items: Array.from({ length: 38 }, (_, i) => ({ file, t: 1 + i * 2, degrade: "corners" })) });
    const s = vs.filter((v): v is Float32Array => Boolean(v)).map((v) => pred(hd.head, v));
    console.log(`${label}: style ${pct(s, 0.5).toFixed(3)} (MagnatesMedia films p10 ${hd.heldOutFilms.magnatesMedia!.p10}, median ${hd.heldOutFilms.magnatesMedia!.median}; other channels median ${hd.heldOutFilms.others!.median})`);
  }
}
