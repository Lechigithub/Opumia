// The referee in use: our film (or one scene) scored with the taste model the referee proved, corners masked.
// Proven 2026-11-26 on 8 held-back channel films and 15 of ours (none in its training): with corners masked every real
// film scored 4.87–5.79 and our films 3.26–4.87 (v7 4.49 above Juicero 4.01). Strong on whole films; on single 8 s
// stretches it catches 69 % of ours while flagging 8 % of real, so stretch scores point to the weakest moments and
// the film's mean is the verdict.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
export interface RefereeConfig { holdout: string[]; filmBar: number; stretchLow: number }
/** The bar a whole film must reach: the lowest held-back channel film's masked score (rounded down), and the stretch
 *  level below which a moment is pointed out (the real held-back stretches' 10th percentile). */
export function refereeConfig(data: string, channel: string): RefereeConfig | null {
  const r = jread<{ holdout?: string[]; bars?: { film: number; stretch: number } }>(path.join(data, "referee", `${channel}.json`), {});
  return r.holdout && r.bars ? { holdout: r.holdout, filmBar: r.bars.film, stretchLow: r.bars.stretch } : null;
}

/** The production taste model: trained on every film except the held-back ones (ours included), saved for the referee. */
export async function refereeModel(o: { root: string; data: string; reference: string; channel: string; log?: (s: string) => void }) {
  const f = path.join(o.data, "referee", `${o.channel}-taste.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as import("@opumia/agents").TasteModel;
  const cfg = refereeConfig(o.data, o.channel);
  if (!cfg) throw new Error("the referee has not been built: npx tsx apps/cli/src/dev/referee-build.ts");
  const { trainTaste } = await import("@opumia/agents");
  const m = await trainTaste({ root: o.root, data: o.data, reference: o.reference, channel: o.channel as never, kind: "shot", excludeFilms: cfg.holdout, write: false, ...(o.log ? { log: o.log } : {}) });
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(m));
  renameSync(`${f}.tmp`, f);
  return m;
}

export interface RefereeVerdict { score: number; bar: number; pass: boolean; stretches: Array<{ from: number; to: number; score: number; low: boolean }>; weakest: string }
const dur = (f: string) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim() || 0);

/** Score a video (a film, or a scene's clip) in 8 s stretches (3 masked frames each), or a set of still images. */
export async function refereeScore(o: { root: string; data: string; reference: string; channel: string; video?: string; from?: number; to?: number; stills?: string[]; log?: (s: string) => void }): Promise<RefereeVerdict> {
  const cfg = refereeConfig(o.data, o.channel);
  if (!cfg) throw new Error("the referee has not been built: npx tsx apps/cli/src/dev/referee-build.ts");
  const m = await refereeModel(o);
  const { embedPictures, tasteOf } = await import("@opumia/agents");
  const ranges: Array<{ from: number; to: number; items: Array<{ file: string; t?: number; degrade: string }> }> = [];
  if (o.stills?.length) ranges.push({ from: 0, to: 0, items: o.stills.map((file) => ({ file, degrade: "corners" })) });
  else if (o.video) {
    const a = o.from ?? 0, b = o.to ?? dur(o.video);
    for (let t = a; t < b - 1; t += 8) { const e = Math.min(b, t + 8); ranges.push({ from: t, to: e, items: [0.2, 0.5, 0.8].map((k) => ({ file: o.video!, t: t + (e - t) * k, degrade: "corners" })) }); }
  }
  const vs = await embedPictures({ root: o.root, data: o.data, items: ranges.flatMap((r) => r.items) });
  let k = 0;
  const stretches = ranges.map((r) => { const v = r.items.map(() => vs[k++]).filter((x): x is Float32Array => Boolean(x)); const score = v.length ? Math.round((v.reduce((t, x) => t + tasteOf(m, x), 0) / v.length) * 100) / 100 : 0; return { from: r.from, to: r.to, score, low: score < cfg.stretchLow }; });
  const score = stretches.length ? Math.round((stretches.reduce((t, s) => t + s.score, 0) / stretches.length) * 100) / 100 : 0;
  const weak = [...stretches].sort((a, b) => a.score - b.score).slice(0, 3);
  return { score, bar: cfg.filmBar, pass: score >= cfg.filmBar, stretches, weakest: weak.map((s) => (o.stills ? `${s.score}` : `${s.from.toFixed(0)}–${s.to.toFixed(0)} s (${s.score})`)).join(", ") };
}
