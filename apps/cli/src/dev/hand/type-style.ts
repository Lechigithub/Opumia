// A type-only style scorer (owner, 2026-11-24): does a film's lettering look like MagnatesMedia's rather than the other
// four reference channels'? It sees only letter shapes (type-crops.py masks: white glyphs on black, no footage, no
// colour), so it cannot win on what the footage shows. Trained on real channels only; validated on held-out films
// (grouped by film); not trusted until held-out films separate and the owner's eye agrees.
//   npx tsx apps/cli/src/dev/hand/type-style.ts train
//   npx tsx apps/cli/src/dev/hand/type-style.ts score <crops-dir> …
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DIM, embedPictures } from "@opumia/agents";

const root = process.cwd(), data = path.join(root, "data");
const OUT = path.join(data, "taste", "magnates-media-type.json");
const PER_FILM = 40;
type Row = { film: string; channel: string; mask: string; h: number };
const sig = (z: number) => 1 / (1 + Math.exp(-z));
function fit(X: Float32Array[], y: number[], lambda = 3e-3, iters = 300) {
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
const rows = async (dir: string) => (await readFile(path.join(dir, "crops.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.h >= 0.03);

if (process.argv[2] === "train") {
  const all = await rows(path.join(data, "type-crops"));
  const byFilm = new Map<string, Row[]>();
  for (const r of all) (byFilm.get(r.film) ?? byFilm.set(r.film, []).get(r.film)!).push(r);
  const items: Array<Row & { y: number }> = [];
  for (const [, rs] of byFilm) { const step = Math.max(1, rs.length / PER_FILM); for (let i = 0; i < rs.length && items.length < 1e6; i += step) { const r = rs[Math.floor(i)]!; items.push({ ...r, y: r.channel === "magnates-media" ? 1 : 0 }); } }
  console.log(`embedding ${items.length} lines of type: ${items.filter((x) => x.y).length} MagnatesMedia, ${items.filter((x) => !x.y).length} other channels, ${byFilm.size} films`);
  const vs = await embedPictures({ root, data, items: items.map((x) => ({ file: path.resolve(x.mask) })), log: console.log });
  const ok = items.map((x, i) => ({ ...x, v: vs[i] })).filter((x): x is typeof x & { v: Float32Array } => Boolean(x.v));
  const films = [...new Set(ok.map((x) => x.film))].sort();
  const fold = new Map(films.map((f, i) => [f, i % 5]));
  const held: number[] = new Array(ok.length).fill(NaN);
  for (let f = 0; f < 5; f++) {
    const tr = ok.filter((x) => fold.get(x.film) !== f);
    const m = fit(tr.map((x) => x.v), tr.map((x) => x.y));
    ok.forEach((x, i) => { if (fold.get(x.film) === f) held[i] = pred(m, x.v); });
  }
  const a = auc(held, ok.map((x) => x.y));
  const filmScore = (ch: number) => films.filter((f) => ok.find((x) => x.film === f)!.y === ch).map((f) => pct(ok.map((x, i) => (x.film === f ? held[i]! : NaN)).filter(Number.isFinite), 0.5));
  const mmF = filmScore(1), otherF = filmScore(0);
  const filmAuc = auc([...mmF, ...otherF], [...mmF.map(() => 1), ...otherF.map(() => 0)]);
  const m = fit(ok.map((x) => x.v), ok.map((x) => x.y));
  const res = { schemaVersion: 1, what: "MagnatesMedia's lettering vs the other 4 reference channels: letter-shape masks only (type-crops.py), real films only", lineAuc: +a.toFixed(3), filmAuc: +filmAuc.toFixed(3), heldOutFilms: { magnatesMedia: { p10: +pct(mmF, 0.1).toFixed(3), median: +pct(mmF, 0.5).toFixed(3), n: mmF.length }, others: { median: +pct(otherF, 0.5).toFixed(3), p90: +pct(otherF, 0.9).toFixed(3), n: otherF.length } }, head: m, trainedAt: new Date().toISOString() };
  await writeFile(OUT, JSON.stringify(res));
  console.log(`type scorer: line AUC ${a.toFixed(3)}, film AUC ${filmAuc.toFixed(3)} on held-out films; MagnatesMedia films p10 ${res.heldOutFilms.magnatesMedia.p10} median ${res.heldOutFilms.magnatesMedia.median}; other channels median ${res.heldOutFilms.others.median} p90 ${res.heldOutFilms.others.p90}`);
} else {
  const hd = JSON.parse(await readFile(OUT, "utf8")) as { head: { w: number[]; b: number }; heldOutFilms: Record<string, Record<string, number>> };
  for (const dir of process.argv.slice(3)) {
    const rs = await rows(dir);
    const vs = await embedPictures({ root, data, items: rs.map((r) => ({ file: path.resolve(r.mask) })) });
    const s = vs.filter((v): v is Float32Array => Boolean(v)).map((v) => pred(hd.head, v));
    console.log(JSON.stringify({ dir, type: +pct(s, 0.5).toFixed(3), lines: s.length, channel: hd.heldOutFilms }));
  }
}
