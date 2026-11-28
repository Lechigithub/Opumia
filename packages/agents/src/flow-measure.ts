/**
 * How a film moves, how long its words stay up, and how much it shares with our earlier films — the three measures the
 * hand film (FTX, v28–v32) was built against, moved from the session's Python scripts into the platform (2026-11-25).
 * The same function runs on the channel's real films (the band) and on ours.
 *
 *  motion   (owner, 2026-11-24: "the reference moves smoothly between scenes, sometimes with no cut")
 *           frames at 12 fps, 192×108 grey: hard cuts a minute; picture changes made WITHOUT a cut (the layout no longer
 *           correlates with where the stretch was); softShare = moves / (moves + cuts); share of time moving; median
 *           frame-to-frame change. MagnatesMedia: softShare median 0.76 (p10 0.41), cuts 8.7 a minute.
 *  words    (owner: "words … never feel rushed, so viewers can actually see what the word says clearly")
 *           on-device OCR at 4 fps, every big line (≥ 5 % of the frame high) followed while it stays readable;
 *           holdTime = the hold of the typical second of words on screen; readable = share of word-time on lines
 *           held ≥ 1.5 s. MagnatesMedia: holdTime median 2.5 s (p10 1.4), readable 0.78 (p10 0.53).
 *  template share (owner: "every film designed from scratch … even the same film produced twice with the same script
 *           and voiceover should never look similar")
 *           against every earlier film: pictures shared, the same device (backdrop/world + element kinds) at the same
 *           moment, cuts landing together, frames that look alike — each as EXCESS over chance (the other film
 *           shifted in time).
 * No model call.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ocrBinary } from "@opumia/senses";

const pexec = promisify(execFile);
type Q = { p10: number; med: number; p90: number };

// ---------------------------------------------------------------------------------------------------------------
// motion

export interface MotionMeasure { cutsPerMin: number; softPerMin: number; softShare: number; moving: number; still: number; motionMed: number; segMed: number }
const MW = 192, MH = 108, MFPS = 12;

async function greyFrames(file: string, fromS: number, len: number): Promise<Float32Array[]> {
  const r = await pexec("ffmpeg", ["-v", "error", "-ss", fromS.toFixed(2), "-t", len.toFixed(2), "-i", file, "-vf", `fps=${MFPS},scale=${MW}:${MH}:flags=area,format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 30 });
  const buf = r.stdout as Buffer, n = Math.floor(buf.length / (MW * MH)), out: Float32Array[] = [];
  for (let i = 0; i < n; i++) out.push(Float32Array.from(buf.subarray(i * MW * MH, (i + 1) * MW * MH)));
  return out;
}
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
const r2 = (x: number) => Math.round(x * 100) / 100, r3 = (x: number) => Math.round(x * 1000) / 1000;

export async function measureMotion(file: string, o: { fromS?: number; len?: number } = {}): Promise<MotionMeasure | null> {
  const f = await greyFrames(file, o.fromS ?? 0, o.len ?? 120).catch(() => []);
  const n = f.length;
  if (n < 24) return null;
  const d: number[] = [];
  for (let i = 0; i + 1 < n; i++) { let s = 0; const a = f[i]!, b = f[i + 1]!; for (let k = 0; k < a.length; k++) s += Math.abs(b[k]! - a[k]!); d.push(s / a.length); }
  const cuts: number[] = [];
  for (let i = 0; i < d.length; i++) { const a = i > 0 ? d[i - 1]! : 0, b = i + 1 < d.length ? d[i + 1]! : 0; if (d[i]! > 18 && d[i]! > 2.5 * Math.max(a, b, 1.5)) cuts.push(i + 1); }
  const cutset = new Set(cuts);
  // coarse layout: 14×24 block means (falling money or flicker changes pixels, not the layout)
  const BR = 14, BC = 24, bh = Math.floor(MH / BR), bw = Math.floor(MW / BC);
  const coarse = f.map((fr) => { const c = new Float64Array(BR * BC); for (let r = 0; r < BR; r++) for (let q = 0; q < BC; q++) { let s = 0; for (let y = r * bh; y < (r + 1) * bh; y++) for (let x = q * bw; x < (q + 1) * bw; x++) s += fr[y * MW + x]!; c[r * BC + q] = s / (bh * bw); } return c; });
  const corr = (a: Float64Array, b: Float64Array) => { let ma = 0, mb = 0; for (let k = 0; k < a.length; k++) (ma += a[k]!, mb += b[k]!); ma /= a.length; mb /= b.length; let num = 0, da = 0, db = 0; for (let k = 0; k < a.length; k++) { const x = a[k]! - ma, y = b[k]! - mb; num += x * y; da += x * x; db += y * y; } const den = Math.sqrt(da * db); return den > 1e-6 ? num / den : 1; };
  let soft = 0, ref = coarse[0]!, last = 0;
  for (let i = 1; i < n; i++) {
    if (cutset.has(i)) { ref = coarse[i]!; last = i; continue; }
    if (i - last >= 6 && corr(coarse[i]!, ref) < 0.35) { soft++; ref = coarse[i]!; last = i; }
  }
  const mins = n / MFPS / 60;
  const nc = d.filter((_, i) => !cutset.has(i + 1));
  const bounds = [0, ...cuts, n];
  const segs = bounds.slice(1).map((b, k) => (b - bounds[k]!) / MFPS);
  return { cutsPerMin: r2(cuts.length / mins), softPerMin: r2(soft / mins), softShare: r3(soft / Math.max(1, soft + cuts.length)), moving: r3(nc.filter((x) => x > 2).length / Math.max(1, nc.length)), still: r3(nc.filter((x) => x < 0.6).length / Math.max(1, nc.length)), motionMed: r2(median(nc)), segMed: r2(median(segs)) };
}

// ---------------------------------------------------------------------------------------------------------------
// words on screen

export interface TextHoldMeasure { lines: number; holdTime: number; readable: number; holdMed: number; perWord: number; shortShare: number; rushed: Array<{ atS: number; holdS: number; text: string }> }
const TFPS = 4, GAP = 4, LOGO = ["magnates", "media"];
let WORDS: Set<string> | null = null;
const words = () => (WORDS ??= existsSync("/usr/share/dict/words") ? new Set(readFileSync("/usr/share/dict/words", "utf8").split("\n").map((w) => w.trim().toLowerCase())) : new Set<string>());
const normT = (t: string) => t.toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();
/** A line a viewer would read: most of its tokens are words or figures (OCR noise on textures and banknotes is not). */
function realLine(t: string): boolean {
  const toks = t.split(" ").filter((x) => x.length >= 2);
  if (!toks.length) return false;
  const W = words();
  if (!W.size) return toks.some((x) => x.length >= 4);
  const ok = toks.filter((x) => W.has(x) || /^[$]?[0-9][0-9.,%]*[a-z]?$/.test(x) || (x.endsWith("s") && W.has(x.slice(0, -1)))).length;
  return ok / toks.length >= 0.6 && toks.some((x) => x.length >= 4);
}
function ratio(a: string, b: string): number {
  // a cheap similarity: shared bigrams (stand-in for SequenceMatcher)
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i + 1 < s.length; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1); return m; };
  const A = bg(a), B = bg(b); let both = 0;
  for (const [k, v] of A) both += Math.min(v, B.get(k) ?? 0);
  return (2 * both) / Math.max(1, a.length - 1 + b.length - 1);
}
function sameLine(a: string, b: string): boolean {
  if (a === b || (b.length > 4 && (a.includes(b) || b.includes(a)))) return true;
  if (ratio(a, b) > 0.6) return true;
  const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
  const both = [...ta].filter((x) => tb.has(x)).length;
  return both >= Math.max(1, Math.floor(Math.min(ta.size, tb.size) / 2));
}

export async function measureTextHold(file: string, o: { root: string; data: string; fromS?: number; len?: number }): Promise<TextHoldMeasure | null> {
  const bin = await ocrBinary(o.root, o.data);
  if (!bin) return null;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "texthold-"));
  try {
    await pexec("ffmpeg", ["-v", "error", "-ss", (o.fromS ?? 0).toFixed(2), "-t", (o.len ?? 60).toFixed(2), "-i", file, "-vf", `fps=${TFPS},scale=960:540`, path.join(tmp, "f%04d.png")]);
    const ps = (await readdir(tmp)).filter((x) => x.endsWith(".png")).sort().map((x) => path.join(tmp, x));
    const rows = new Map<string, Array<{ y0: number; y1: number; text: string }>>();
    for (let i = 0; i < ps.length; i += 60) {
      const r = await pexec(bin, ps.slice(i, i + 60), { maxBuffer: 64 << 20, timeout: 300_000 }).catch(() => null);
      for (const l of (r?.stdout ?? "").split("\n").filter(Boolean)) { const j = JSON.parse(l) as { file: string; boxes: Array<{ y0: number; y1: number; text: string }> }; rows.set(j.file, j.boxes); }
    }
    const open: Array<[string, number, number]> = [], done: Array<[string, number, number]> = [];
    for (const [k, p] of ps.entries()) {
      const lines = (rows.get(p) ?? []).filter((b) => b.y1 - b.y0 >= 0.05 && [...b.text].filter((c) => /\p{L}/u.test(c)).length >= 3 && !LOGO.some((w) => b.text.toLowerCase().includes(w))).map((b) => normT(b.text));
      for (const ln of lines) {
        const hit = open.find((x) => x[2] >= k - GAP && sameLine(x[0], ln));
        if (hit) { hit[2] = k; if (ln.length > hit[0].length) hit[0] = ln; } else open.push([ln, k, k]);
      }
      for (const x of open.filter((x) => x[2] < k - GAP)) { done.push(x); open.splice(open.indexOf(x), 1); }
    }
    done.push(...open);
    const kept = done.filter((x) => realLine(x[0]));
    if (!kept.length) return null;
    const holds = kept.map((x) => ({ h: (x[2] - x[1] + 1) / TFPS, w: Math.max(1, x[0].split(" ").length), at: (o.fromS ?? 0) + x[1] / TFPS, text: x[0] }));
    const hs = holds.map((x) => x.h).sort((a, b) => a - b);
    const tot = hs.reduce((a, x) => a + x, 0);
    let cum = 0, tw = hs.at(-1)!;
    for (const h of hs) { cum += h; if (cum >= tot / 2) { tw = h; break; } }
    return {
      lines: holds.length, holdTime: r2(tw), readable: r3(hs.filter((h) => h >= 1.5).reduce((a, x) => a + x, 0) / Math.max(1e-6, tot)),
      holdMed: r2(median(hs)), perWord: r2(median(holds.map((x) => x.h / x.w))), shortShare: r3(holds.filter((x) => x.h < 1.25).length / holds.length),
      rushed: holds.filter((x) => x.h < 1.25 && x.w >= 2).sort((a, b) => a.at - b.at).slice(0, 12).map((x) => ({ atS: r2(x.at), holdS: x.h, text: x.text.slice(0, 50) })),
    };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------------------
// the channel's band (built from its real films once, then read)

export interface FlowBand { motion: Record<keyof MotionMeasure, Q>; textHold: Record<"holdTime" | "readable" | "holdMed" | "perWord" | "shortShare", Q> }
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]! : 0; };
const bandOf = <K extends string>(rows: Array<Record<K, number>>, keys: K[]) => Object.fromEntries(keys.map((k) => [k, { p10: r3(pct(rows.map((r) => r[k]), 10)), med: r3(pct(rows.map((r) => r[k]), 50)), p90: r3(pct(rows.map((r) => r[k]), 90)) }])) as Record<K, Q>;
const PREFIX: Record<string, string> = { "magnates-media": "MM", "logically-answered": "LA", "modern-mba": "MBA", "how-money-works": "HMW", moon: "MOON" };

/** The channel's real films (Reference/.analysis/meta → their mp4), read only. */
export async function channelFilms(reference: string, channel: string, max = 30): Promise<string[]> {
  const metaDir = path.join(reference, ".analysis", "meta"), pre = PREFIX[channel];
  if (!pre || !existsSync(metaDir)) return [];
  const out: string[] = [];
  for (const mf of (await readdir(metaDir)).filter((x) => x.startsWith(`${pre}-`)).sort()) {
    const meta = JSON.parse(await readFile(path.join(metaDir, mf), "utf8")) as { folder?: string };
    const dir = meta.folder ? path.join(reference, meta.folder) : "";
    if (!dir || !existsSync(dir)) continue;
    const mp4 = (await readdir(dir)).find((f) => f.endsWith(".mp4"));
    if (mp4) out.push(path.join(dir, mp4));
    if (out.length >= max) break;
  }
  return out;
}

/** The band (data/quality-profile/<channel>-motion-band.json and -text-hold-band.json), built from real films when missing. */
export async function ensureFlowBand(o: { root: string; data: string; reference: string; channel: string; log?: (s: string) => void }): Promise<FlowBand | null> {
  const dir = path.join(o.data, "quality-profile"), mf = path.join(dir, `${o.channel}-motion-band.json`), tf = path.join(dir, `${o.channel}-text-hold-band.json`);
  if (!existsSync(mf) || !existsSync(tf)) {
    const films = await channelFilms(o.reference, o.channel);
    if (films.length < 6) return null;
    o.log?.(`  flow band: measuring ${films.length} of the channel's real films (motion, word holds)…`);
    await mkdir(dir, { recursive: true });
    if (!existsSync(mf)) {
      const rows = (await Promise.all(films.map((f) => measureMotion(f, { len: 90 }).catch(() => null)))).filter((x): x is MotionMeasure => Boolean(x));
      await writeFile(mf, JSON.stringify({ band: bandOf(rows as never, ["cutsPerMin", "softPerMin", "softShare", "moving", "still", "motionMed", "segMed"]), window: 90, films: rows.length }, null, 1) + "\n");
    }
    if (!existsSync(tf)) {
      const rows: TextHoldMeasure[] = [];
      for (const f of films) { const m = await measureTextHold(f, { root: o.root, data: o.data, len: 60 }).catch(() => null); if (m) rows.push(m); }
      if (rows.length >= 6) await writeFile(tf, JSON.stringify({ band: bandOf(rows as never, ["holdTime", "readable", "holdMed", "perWord", "shortShare"]), window: 60, films: rows.length }, null, 1) + "\n");
    }
  }
  if (!existsSync(mf) || !existsSync(tf)) return null;
  return { motion: (JSON.parse(await readFile(mf, "utf8")) as { band: FlowBand["motion"] }).band, textHold: (JSON.parse(await readFile(tf, "utf8")) as { band: FlowBand["textHold"] }).band };
}

/** What is outside the channel's band, in words an agent can act on (empty when inside). */
export function flowIssues(m: MotionMeasure | null, t: TextHoldMeasure | null, b: FlowBand): Array<{ id: "cuts_not_moves" | "too_still" | "words_rushed"; detail: string }> {
  const out: Array<{ id: "cuts_not_moves" | "too_still" | "words_rushed"; detail: string }> = [];
  if (m && m.softShare < b.motion.softShare.p10) out.push({ id: "cuts_not_moves", detail: `the picture changes by cutting, not by moving: ${Math.round(m.softShare * 100)} % of changes are moves (the channel ${Math.round(b.motion.softShare.p10 * 100)}–${Math.round(b.motion.softShare.p90 * 100)} %, median ${Math.round(b.motion.softShare.med * 100)} %) — carry pictures into each other with a journey (push through, slide, whip), a parallax layer or a transition made of the picture` });
  if (m && m.moving < b.motion.moving.p10) out.push({ id: "too_still", detail: `the frame is moving only ${Math.round(m.moving * 100)} % of the time (the channel ${Math.round(b.motion.moving.p10 * 100)}–${Math.round(b.motion.moving.p90 * 100)} %): the camera never stops in the channel's films — drift while holding, layers moving at their own depths` });
  if (t && (t.holdTime < b.textHold.holdTime.p10 || t.readable < b.textHold.readable.p10)) out.push({ id: "words_rushed", detail: `words leave before they can be read: the typical word stays up ${t.holdTime} s (the channel ${b.textHold.holdTime.p10}–${b.textHold.holdTime.p90} s, median ${b.textHold.holdTime.med}), ${Math.round(t.readable * 100)} % of word-time on lines held ≥ 1.5 s (the channel ≥ ${Math.round(b.textHold.readable.p10 * 100)} %)${t.rushed.length ? `; rushed: ${t.rushed.slice(0, 5).map((x) => `${x.atS} s "${x.text}" ${x.holdS} s`).join(", ")}` : ""} — fewer words, each held until read, the camera leaving only after them` });
  return out;
}

export const flowText = (m: MotionMeasure | null, t: TextHoldMeasure | null, b: FlowBand | null) => [
  m ? `- motion: ${m.cutsPerMin} cuts/min, ${Math.round(m.softShare * 100)} % of picture changes made by moving, moving ${Math.round(m.moving * 100)} % of the time${b ? ` (the channel: cuts ${b.motion.cutsPerMin.med}/min, moves ${Math.round(b.motion.softShare.med * 100)} %, moving ${Math.round(b.motion.moving.med * 100)} %)` : ""}` : "",
  t ? `- words: the typical word stays up ${t.holdTime} s, ${Math.round(t.readable * 100)} % of word-time readable (held ≥ 1.5 s)${b ? ` (the channel: ${b.textHold.holdTime.med} s, ${Math.round(b.textHold.readable.med * 100)} %)` : ""}${t.rushed.length ? `; rushed: ${t.rushed.slice(0, 4).map((x) => `${x.atS} s "${x.text}"`).join(", ")}` : ""}` : "",
].filter(Boolean).join("\n");

// ---------------------------------------------------------------------------------------------------------------
// template share (zero template share between our films, the same topic included)

interface PlanShot { id: string; t0: number; t1: number; dev: string; pics: Set<string> }
type PlanFiles = { craft?: Record<string, string[]>; board: { shots: Array<{ id: string; startS: number; endS: number }> }; scenes: { scenes: Array<{ shotId: string } & Record<string, unknown>> }; resolution: { media: Array<{ shotId: string; role: string; sourceUrl?: string; ref?: string }> } };
/** A plan's shots as the template-share measure sees them (device = backdrop/world + element kinds; pictures by source). */
/** The channel's named devices a hand-written composite draws with (its @craft imports), per shot. */
export function craftOfComposites(meta: Record<string, { shotId: string }>, code: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, m] of Object.entries(meta)) {
    const imp = /import\s*\{([^}]*)\}\s*from\s*["']@craft["']/.exec(code[name] ?? "")?.[1] ?? "";
    const tools = imp.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!.trim()).filter((x) => /^[A-Z]/.test(x) && !["CameraPath", "Parallax"].includes(x));
    out[m.shotId] = [...new Set([...(out[m.shotId] ?? []), ...tools])].sort();
  }
  return out;
}
export function planShots(p: PlanFiles): PlanShot[] {
  const sc = new Map(p.scenes.scenes.map((s) => [s.shotId, s as Record<string, unknown>]));
  return p.board.shots.map((s) => {
    const x: Record<string, unknown> = sc.get(s.id) ?? {};
    const world = ((x.world as { kind?: string } | undefined)?.kind) ?? String(x.backdrop ?? "footage");
    const els = [...new Set(((x.elements as Array<{ name?: string; type?: string }> | undefined) ?? []).map((e) => e.name ?? e.type ?? ""))].sort();
    const pics = new Set(p.resolution.media.filter((m) => m.shotId === s.id && (m.role === "primary" || m.role === "layer")).map((m) => m.sourceUrl ?? m.ref ?? "").filter(Boolean));
    const craft = (p.craft?.[s.id] ?? []).join("+");
    return { id: s.id, t0: s.startS, t1: s.endS, dev: `${world}|${els.join(",")}${craft ? `|${craft}` : ""}`, pics };
  });
}
export async function loadCraft(job: string): Promise<Record<string, string[]>> {
  const dir = path.join(job, "design", "film");
  try {
    const meta = JSON.parse(await readFile(path.join(dir, "composites.json"), "utf8")) as Record<string, { shotId: string }>;
    const code: Record<string, string> = {};
    for (const n of Object.keys(meta)) code[n] = await readFile(path.join(dir, "composites", `${n}.tsx`), "utf8").catch(() => "");
    return craftOfComposites(meta, code);
  } catch { return {}; }
}
async function loadPlan(job: string): Promise<PlanShot[] | null> {
  const rd = async <T>(f: string) => JSON.parse(await readFile(path.join(job, f), "utf8")) as T;
  try { return planShots({ board: await rd("storyboard.json"), scenes: await rd("scenes.json"), resolution: await rd("resolution.json"), craft: await loadCraft(job) }); } catch { return null; }
}
const at = (shots: PlanShot[], t: number) => shots.find((s) => s.t0 <= t && t < s.t1) ?? null;
function compareShots(A: PlanShot[], B: PlanShot[], shift: number) {
  const dur = Math.max(...A.map((s) => s.t1)), durB = Math.max(...B.map((s) => s.t1));
  const tb = (t: number) => (t + shift) % durB;
  const allB = new Set(B.flatMap((s) => [...s.pics]));
  const ts: number[] = []; for (let t = 0; t < dur; t += 0.1) ts.push(t);
  const pic = shift === 0 ? ts.filter((t) => { const a = at(A, t); return Boolean(a && [...a.pics].some((p) => allB.has(p))); }).length / ts.length : 0;
  const devHit = (t: number) => { const a = at(A, t), b = at(B, tb(t)); return Boolean(a && b && a.dev === b.dev); };
  const dev = ts.filter(devHit).length / ts.length;
  const cb = B.map((s) => (s.t0 - shift + durB) % durB);
  const cuts = A.slice(1).filter((s) => Math.min(...cb.map((c) => Math.abs(s.t0 - c))) < 0.3).length / Math.max(1, A.length - 1);
  const shotsSame = A.filter((s) => { const mid = (s.t0 + s.t1) / 2; return devHit(mid) || [...s.pics].some((p) => allB.has(p)); }).map((s) => s.id);
  return { pictures: pic, devices: dev, cuts, shotsSame };
}
export interface TemplateShare { film: string; pictures: number; devices: number; cuts: number; shots: string[] }
/** Limits on excess over chance (hand film: the from-scratch v30 measured 0 / 0 / 0.17 against every earlier version). */
export const TEMPLATE_LIMITS = { pictures: 0.05, devices: 0.12, cuts: 0.3 } as const;
/** This plan against every earlier film's plan (job folders with storyboard.json, scenes.json, resolution.json). */
export async function templateShare(job: string | PlanFiles, others: string[]): Promise<TemplateShare[]> {
  const A = typeof job === "string" ? await loadPlan(job) : planShots(job);
  if (!A?.length) return [];
  const out: TemplateShare[] = [];
  for (const o of others) {
    if (typeof job === "string" && path.resolve(o) === path.resolve(job)) continue;
    const B = await loadPlan(o);
    if (!B?.length) continue;
    const same = compareShots(A, B, 0), chance = compareShots(A, B, 17);
    out.push({ film: path.basename(o), pictures: r3(same.pictures), devices: r3(Math.max(0, same.devices - chance.devices)), cuts: r3(Math.max(0, same.cuts - chance.cuts)), shots: same.shotsSame });
  }
  return out.sort((a, b) => b.devices + b.cuts + b.pictures - (a.devices + a.cuts + a.pictures));
}

// ---------------------------------------------------------------------------------------------------------------
// the bed under the voice (hand film v34): how far the music sits under speech, whether it falls away, dead air

async function db100(file: string, fromS: number, len: number): Promise<number[]> {
  const r = await pexec("ffmpeg", ["-v", "error", "-ss", fromS.toFixed(2), "-t", len.toFixed(2), "-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { encoding: "buffer", maxBuffer: 1 << 28 });
  const b = r.stdout as Buffer, n = Math.floor(b.length / 2), w = 800, out: number[] = [];
  for (let i = 0; i + w <= n; i += w) { let s = 0; for (let k = i; k < i + w; k += 2) { const v = b.readInt16LE(k * 2) / 32768; s += v * v; } out.push(10 * Math.log10(s / (w / 2) + 1e-10)); }
  return out;
}
export interface BedGap { gapDb: number; fallsAway: number; deadAir: Array<{ atS: number; s: number }> }
/** On the voice and bed stems of a stretch: the median distance of the bed under speech; the share of speech where the
 *  bed falls more than 22 dB under the voice (it has gone); stretches ≥ 0.6 s where voice and bed are both near silent. */
export async function measureBedGap(voiceStem: string, bedStem: string, fromS: number, len: number): Promise<BedGap> {
  const [v, b] = await Promise.all([db100(voiceStem, fromS, len), db100(bedStem, fromS, len)]);
  const n = Math.min(v.length, b.length), sp: number[] = [];
  let away = 0, hole = 0;
  const dead: Array<{ atS: number; s: number }> = [];
  for (let i = 0; i < n; i++) {
    if (v[i]! > -40) { sp.push(v[i]! - b[i]!); if (v[i]! - b[i]! > 22) away++; }
    if (v[i]! < -45 && b[i]! < -45) hole++; else { if (hole >= 6) dead.push({ atS: r2(fromS + (i - hole) / 10), s: hole / 10 }); hole = 0; }
  }
  if (hole >= 6) dead.push({ atS: r2(fromS + (n - hole) / 10), s: hole / 10 });
  return { gapDb: r2(median(sp)), fallsAway: r3(away / Math.max(1, sp.length)), deadAir: dead };
}

// ---------------------------------------------------------------------------------------------------------------
// the opening (owner, 2026-11-26: "if you create a new film from scratch the film becomes a new film of its kind"):
// the first seconds are where films look most alike. Distinctive devices in the opening (not plain footage, not a
// word over footage) are compared with every earlier film's opening.
/** The opening's distinctive devices: the channel techniques drawn (@craft) and any world that is not plain footage.
 *  Each film's own kit components are its own and cannot collide; plain footage is the channel's default. */
export function openingDevices(shots: PlanShot[], seconds = 15): string[] {
  const out = new Set<string>();
  for (const s of shots.filter((x) => x.t0 < seconds)) {
    const [world = "", , craft = ""] = s.dev.split("|");
    if (world && world !== "footage") out.add(`world:${world}`);
    for (const c of craft.split("+").filter(Boolean)) out.add(c);
  }
  return [...out].sort();
}
export interface OpeningShare { film: string; shared: string[]; jaccard: number }
export const OPENING_LIMIT = { shared: 2, jaccard: 0.5 } as const;
export async function openingShare(job: string | PlanFiles, others: string[], seconds = 15): Promise<OpeningShare[]> {
  const A = typeof job === "string" ? await loadPlan(job) : planShots(job);
  if (!A?.length) return [];
  const a = new Set(openingDevices(A, seconds));
  const out: OpeningShare[] = [];
  for (const o of others) {
    if (typeof job === "string" && path.resolve(o) === path.resolve(job)) continue;
    const B = await loadPlan(o);
    if (!B?.length) continue;
    const b = new Set(openingDevices(B, seconds));
    const shared = [...a].filter((d) => b.has(d));
    const uni = new Set([...a, ...b]).size;
    out.push({ film: path.basename(o), shared, jaccard: uni ? r3(shared.length / uni) : 0 });
  }
  return out.sort((x, y) => y.jaccard - x.jaccard);
}

