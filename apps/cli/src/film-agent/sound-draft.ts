// The draft sound plan (owner, 2026-11-26): code writes the first mix.json from what the film already knows — the
// planner's turns and biggest line, the cut points, the hit points each builder listed (notes/<id>.hits.json), the
// beds ranked by how like the channel they sound — at the channel's measured density; the finisher then adjusts it.
// The levels themselves (voice −16 LUFS, beds 15.8 / 19.1 dB under it and not ducked, master) are mix.ts's, in code.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { readPlan, type FilmPlan } from "./plan.js";

const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
export interface Hit { t: number; what?: string; family?: string }
export interface MixSpec { beds: Array<{ file: string; from: number; to: number; inS: number }>; cues: Array<{ t: number; file: string; db: number; why?: string }>; drops: Array<{ from: number; to: number }>; draft?: string }

/** MagnatesMedia (build list 6): ≈ 3.06 strong hits a minute, ≥ 2.4 s apart, booms ≤ 30 % of them. */
export const HITS_PER_MIN = 3.06, HIT_GAP_S = 2.4, BOOM_SHARE = 0.3;

/** What our recent films used (sound and music), from data/asset-usage.json: only jobs that became films
 *  (data/produced.json), entries as library asset ids (older films recorded ids, film-agent films record paths). */
export function recentlyUsed(root: string, n = 12): { sfx: Set<string>; music: Set<string> } {
  const u = jread<Array<{ job: string; sfx?: string[]; music?: string[] }>>(path.join(root, "data", "asset-usage.json"), []);
  const made = new Set(jread<Array<{ job: string }>>(path.join(root, "data", "produced.json"), []).map((x) => x.job));
  const ids = libraryIds(root);
  const id = (x: string) => (x.includes("/") ? ids.get(x.replace(/^Library\//, "")) ?? x : x);
  const last = Array.isArray(u) ? u.filter((x) => made.has(x.job)).slice(-n) : [];
  return { sfx: new Set(last.flatMap((x) => (x.sfx ?? []).map(id))), music: new Set(last.flatMap((x) => (x.music ?? []).map(id))) };
}
/** Library sound a film may use: a recorded licence (the library's licences.csv / catalogue), never the reference
 *  material folders. Keyed by relPath ("music/…mp3"). */
export function usableAudio(root: string): Map<string, { id: string; license: string; attribution?: string; author?: string; page?: string; generated: boolean }> {
  const idx = jread<{ assets?: Array<{ id: string; relPath: string; category?: string; provenance?: { license?: string; attributionText?: string; author?: string; sourcePageUrl?: string; generated?: boolean } }> }>(path.join(root, "data", "library-index.json"), {});
  const out = new Map<string, { id: string; license: string; attribution?: string; author?: string; page?: string; generated: boolean }>();
  for (const a of idx.assets ?? []) {
    const pv = a.provenance;
    if (!/^(music|sfx)\//.test(a.relPath) || !pv?.license) continue;
    out.set(a.relPath, { id: a.id.slice(0, 16), license: pv.license, ...(pv.attributionText ? { attribution: pv.attributionText } : {}), ...(pv.author ? { author: pv.author } : {}), ...(pv.sourcePageUrl ? { page: pv.sourcePageUrl } : {}), generated: Boolean(pv.generated) });
  }
  return out;
}
/** Library relPath → asset id (16 hex, as the audio profile keys them). */
export function libraryIds(root: string): Map<string, string> {
  const idx = jread<{ assets?: Array<{ id: string; relPath: string }> }>(path.join(root, "data", "library-index.json"), {});
  return new Map((idx.assets ?? []).map((a) => [a.relPath, a.id.slice(0, 16)]));
}

/** Where a bed's quiet intro ends: the first 5 s block within 3 dB of its loudest stretch, on a beat. */
export function bedIn(m: { energyDb?: number[]; beat?: { offsetS: number; periodS: number }; seconds?: number } | undefined, need: number): number {
  const e = m?.energyDb ?? [];
  if (!e.length) return 0;
  const top = Math.max(...e);
  let k = e.findIndex((x) => x >= top - 3);
  if (k < 0) k = 0;
  let t = k * ((m?.seconds ?? e.length * 5) / e.length);
  if (m?.seconds && t + need > m.seconds) t = Math.max(0, m.seconds - need);
  const b = m?.beat;
  return b && b.periodS > 0 ? Math.max(0, b.offsetS + Math.round((t - b.offsetS) / b.periodS) * b.periodS) : t;
}

export function draftMix(o: { root: string; job: string; plan?: FilmPlan; lengthS: number; seed?: string }): MixSpec {
  const plan = o.plan ?? readPlan(o.job);
  if (!plan) throw new Error("no plan.json");
  const prof = jread<{ sfx: Record<string, { family: string; seconds: number; peakDb?: number; attackS: number }>; music: Record<string, { seconds: number; energyDb?: number[]; beat?: { offsetS: number; periodS: number } }> }>(path.join(o.root, "data", "audio-profile.json"), { sfx: {}, music: {} });
  const ids = libraryIds(o.root), byId = new Map([...ids].map(([p, id]) => [id, p]));
  const used = recentlyUsed(o.root);
  const seedN = [...(o.seed ?? path.basename(o.job))].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const shuffle = <T>(xs: T[]) => xs.map((x, i) => ({ x, k: ((seedN + i * 2654435761) >>> 0) % 1000 })).sort((a, b) => a.k - b.k).map((y) => y.x);

  // beds: the cold open, then the body (a change at the first turn after 12 s), from the ranked list, not used lately
  const taste = jread<{ beds?: Array<{ file: string; score: number }> }>(path.join(o.root, "data", "audio-profile-bed-taste.json"), {}).beds ?? [];
  const usable = usableAudio(o.root);
  const fresh = taste.filter((b) => { const rel = b.file.replace(/^Library\//, ""), id = ids.get(rel); return usable.has(rel) && (!id || !used.music.has(id)); });
  const pickFrom = shuffle(fresh.slice(0, 8));
  const turnAt = plan.scenes.find((s) => s.mark && s.from >= 12)?.from ?? plan.scenes.find((s) => s.from >= Math.min(20, o.lengthS / 3))?.from ?? o.lengthS;
  const spans = turnAt < o.lengthS - 8 ? [[0, turnAt], [turnAt, o.lengthS]] : [[0, o.lengthS]];
  const beds = spans.map(([from, to], i) => {
    const b = pickFrom[i % Math.max(1, pickFrom.length)];
    if (!b) return null;
    const m = prof.music[ids.get(b.file.replace(/^Library\//, "")) ?? ""];
    return { file: b.file, from: from!, to: Math.min(o.lengthS, to! + (i < spans.length - 1 ? 0.8 : 0)), inS: Math.round(bedIn(m, to! - from!) * 100) / 100 };
  }).filter((x): x is MixSpec["beds"][number] => Boolean(x));

  // hits: builders' hit points first, then turns and cuts, at the channel's density and spacing
  const fam = (f: string) => shuffle(Object.entries(prof.sfx).filter(([id, v]) => v.family === f && v.seconds < 8 && byId.get(id) && usable.has(byId.get(id)!) && !used.sfx.has(id)).map(([id, v]) => ({ file: `Library/${byId.get(id)}`, attackS: v.attackS, seconds: v.seconds })));
  const pools: Record<string, Array<{ file: string; attackS: number; seconds: number }>> = Object.fromEntries(["thud", "impact", "sub_boom", "riser", "whoosh", "texture", "shimmer"].map((f) => [f, fam(f)]));
  const taken = new Set<string>();
  const take = (f: string) => { const list = [...(pools[f] ?? []), ...(f === "thud" ? pools.impact ?? [] : []), ...(f === "impact" ? pools.thud ?? [] : [])]; const x = list.find((y) => !taken.has(y.file)); if (x) taken.add(x.file); return x; };
  const wanted: Array<Hit & { prio: number }> = [];
  for (const s of plan.scenes) {
    for (const h of jread<Hit[]>(path.join(o.job, "notes", `${s.id}.hits.json`), [])) if (Number.isFinite(h.t)) wanted.push({ ...h, prio: 3 });
    if (s.mark) wanted.push({ t: s.from, what: `${s.mark} (${s.id})`, family: s.mark === "biggest" ? "sub_boom" : "thud", prio: 2 });
  }
  for (const s of plan.scenes.slice(1)) wanted.push({ t: s.from, what: `cut to ${s.id}`, family: "thud", prio: 1 });
  const max = Math.max(1, Math.round((o.lengthS / 60) * HITS_PER_MIN));
  const placed: Array<Hit & { prio: number }> = [];
  for (const w of [...wanted].sort((a, b) => b.prio - a.prio || a.t - b.t)) {
    if (placed.length >= max) break;
    if (w.t < 0.3 || w.t > o.lengthS - 0.3 || placed.some((p) => Math.abs(p.t - w.t) < HIT_GAP_S)) continue;
    const booms = placed.filter((p) => p.family === "sub_boom").length;
    placed.push({ ...w, family: w.family === "sub_boom" && booms + 1 > Math.max(1, Math.floor(max * BOOM_SHARE)) ? "thud" : (w.family ?? "thud") });
  }
  const cues: MixSpec["cues"] = [];
  for (const p of placed.sort((a, b) => a.t - b.t)) {
    const x = take(p.family ?? "thud");
    if (x) cues.push({ t: Math.round(Math.max(0, p.t - x.attackS) * 100) / 100, file: x.file, db: p.family === "sub_boom" ? -6 : -8, why: p.what ?? "" });
  }
  // a riser into the first turn, a drop-out before the biggest line
  const turn = plan.scenes.find((s) => s.mark === "turn");
  const r = turn ? take("riser") : undefined;
  if (turn && r && turn.from - r.seconds > 1) cues.push({ t: Math.round((turn.from - Math.min(r.seconds, 4)) * 100) / 100, file: r.file, db: -12, why: `riser into ${turn.id}` });
  const big = plan.scenes.find((s) => s.mark === "biggest");
  const drops = big && big.from > 2 ? [{ from: Math.round((big.from - 1.3) * 100) / 100, to: Math.round((big.from - 0.05) * 100) / 100 }] : [];
  return { beds, cues: cues.sort((a, b) => a.t - b.t), drops, draft: "written by code from the plan's marks, the cuts and the builders' hit points — listen (film-tools watch shows hits and the spectrogram), then change anything" };
}

/** Write mix.json unless the finisher already has one. */
export function writeDraftMix(o: { root: string; job: string; lengthS: number }): MixSpec | null {
  const f = path.join(o.job, "mix.json");
  if (existsSync(f)) return null;
  const m = draftMix(o);
  writeFileSync(`${f}.tmp`, JSON.stringify(m, null, 1) + "\n");
  renameSync(`${f}.tmp`, f);
  return m;
}
