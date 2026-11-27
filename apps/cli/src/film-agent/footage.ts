// The footage a scene places, checked against the channel with the referee (code, no model). Measured on agent
// Juicero (2026-11-27): with only the agents' own material the film went 4.59 → 4.70, because
//   - builders placed weaker footage than they had already found (s05 4.6 → 5.6, s07 5.0 → 6.0 by swapping in
//     candidates from their own downloads);
//   - their treatment buried good footage (the cupped-hands clip: 5.57 on its own, 4.57 in the scene, zoomed 130 %
//     into the dark);
//   - a Bloomberg clip put on a screen uncropped showed its burned-in caption and logo (4.6 → 3.6);
//   - for abstract lines nothing fitting was found at all.
//   best_footage    a candidate in the scene's own downloads ranks far above what it placed (the builder may keep its
//                   choice by writing why in notes/<id>.md: the referee does not know what fits the line)
//   footage_shows   the finished scene scores far below its own footage: the treatment hides it
//   burned_in_text  words on the scene's stills that are neither its own words nor the narration: a broadcaster's
//                   caption or logo left in the picture
//   searched_enough the placed footage is below the channel's weakest moments and the builder ran fewer than three
//                   searches
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { toolCalls } from "./process.js";
import { PERSON } from "./plan.js";

export const FOOTAGE_GAP = 0.8; // a candidate this far above the placed footage must be used or answered
export const TREATMENT_LOSS = 0.6; // a scene this far below its own footage is hiding it
// a stock preview is one chosen still; the clip behind it, three frames, scores lower (median 0.35 over 60 pairs of
// agent Juicero's downloads), so previews are compared after this discount
export const PREVIEW_BIAS = 0.35;
const isPreview = (f: string) => /\.(jpg|jpeg|png)$/i.test(f);
/** How much of a picture can be seen (share of pixels brighter than luma 48), from a still or a clip's middle frame. */
function litOf(f: string): number {
  const args = VIDEO.test(f) ? ["-v", "error", "-ss", String(Math.max(0.2, dur(f) / 2)), "-i", f, "-frames:v", "1"] : ["-v", "error", "-i", f];
  const b = spawnSync("ffmpeg", [...args, "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 }).stdout as Buffer | null;
  if (!b?.length) return 1;
  let n = 0; for (const v of b) if (v > 48) n++;
  return n / b.length;
}
const MEDIA = /\.(mp4|mov|webm|jpg|jpeg|png)$/i;
const VIDEO = /\.(mp4|mov|webm)$/i;
const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
const dur = (f: string) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim() || 0);
/** A picture's stable id across previews and downloads: pexels_7458246 for s05_pexels_7458246.mp4 and pexels_7458246.jpg. */
export const mediaId = (f: string) => path.basename(f).replace(/\.\w+$/, "").replace(/^s\d{2}_/, "").replace(/_(cut|mask|depth|crop)$/, "");

/** Referee scores of pictures and clips (3 frames of a clip), cached in the job by path, size and time. */
export async function rankFiles(root: string, job: string, files: string[], channel = "magnates-media"): Promise<Map<string, number>> {
  const cacheFile = path.join(job, "checks", "rank-cache.json");
  const cache = jread<Record<string, number>>(cacheFile, {});
  const key = (f: string) => { const s = statSync(f); return `${path.relative(job, f)}|${s.size}|${Math.round(s.mtimeMs)}`; };
  const todo = files.filter((f) => existsSync(f) && cache[key(f)] === undefined);
  if (todo.length) {
    const { refereeModel } = await import("../referee/score.js");
    const { embedPictures, tasteOf } = await import("@opumia/agents");
    const m = await refereeModel({ root, data: path.join(root, "data"), reference: path.resolve(root, process.env.OPUMIA_REFERENCE_DIR ?? "Reference"), channel });
    const items = todo.flatMap((f) => (VIDEO.test(f) ? [0.25, 0.5, 0.75].map((k) => ({ file: f, t: Math.max(0.2, dur(f) * k), degrade: "corners" })) : [{ file: f, degrade: "corners" }]));
    const vs = await embedPictures({ root, data: path.join(root, "data"), items });
    const by = new Map<string, number[]>();
    items.forEach((it, i) => { if (vs[i]) (by.get(it.file) ?? by.set(it.file, []).get(it.file)!).push(tasteOf(m, vs[i]!)); });
    for (const [f, xs] of by) cache[key(f)] = Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache));
    renameSync(`${cacheFile}.tmp`, cacheFile);
  }
  const out = new Map<string, number>();
  for (const f of files) if (existsSync(f) && cache[key(f)] !== undefined) out.set(f, cache[key(f)]!);
  return out;
}

const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
/** What the builder found for its scene: downloaded clips and photos, and the stock previews it looked at. */
export function candidatesOf(job: string, id: string): string[] {
  return walk(path.join(job, "downloads", id)).filter((f) => MEDIA.test(f) && !/strip|sheet|tile|_blank|ref-similar|\/thumb\/|_[0-9]\.jpg$|\/parts\/.*\.jpg$/i.test(f));
}

/** Words the scene puts on screen itself (string literals in its code) and the narration over it. */
function ownWords(code: string, words: string): Set<string> {
  const lit = [...code.matchAll(/(["'`])((?:(?!\1).){2,200})\1/g)].map((m) => m[2]!).join(" ");
  return new Set(`${lit} ${words}`.toLowerCase().match(/[a-z0-9$]+/g) ?? []);
}
/** Text on stills that the scene did not write and the narration does not say (on-device OCR). */
export function foreignText(root: string, stills: string[], code: string, words: string): string[] {
  const bin = path.join(root, "data", ".cache", "ocr", "ocr");
  if (!existsSync(bin) || !stills.length) return [];
  const own = ownWords(code, words);
  const r = spawnSync(bin, stills, { encoding: "utf8", maxBuffer: 1 << 24 }).stdout ?? "";
  const out: string[] = [];
  for (const line of r.split("\n")) {
    let j: { boxes: Array<{ text: string }> };
    try { j = JSON.parse(line); } catch { continue; }
    for (const b of j.boxes) {
      const ws = (b.text.toLowerCase().match(/[a-z0-9$]+/g) ?? []).filter((w) => w.length > 1);
      if (ws.length < 3) continue;
      const mine = ws.filter((w) => own.has(w)).length;
      if (mine / ws.length < 0.5 && !out.includes(b.text)) out.push(b.text);
    }
  }
  return out;
}

export interface FootageCheck { id: string; pass: boolean; detail: string }
export async function footageChecks(o: { root: string; job: string; id: string; media: string[]; stills: string[]; sceneScore?: number; code: string; words: string; realClip: boolean; stretchLow: number; filmBar: number }): Promise<FootageCheck[]> {
  const out: FootageCheck[] = [];
  const placed = o.media.filter((m) => /^(v|img)\//.test(m) && !/_(cut|mask|depth)\./.test(m)).map((m) => path.join(o.job, "public", m)).filter(existsSync);
  if (!placed.length) return out;
  const notes = existsSync(path.join(o.job, "notes", `${o.id}.md`)) ? readFileSync(path.join(o.job, "notes", `${o.id}.md`), "utf8") : "";
  const placedIds = new Set(placed.map(mediaId));
  const cands = candidatesOf(o.job, o.id).filter((f) => !placedIds.has(mediaId(f)));
  const scores = await rankFiles(o.root, o.job, [...placed, ...cands]);
  const best = Math.max(...placed.map((f) => scores.get(f) ?? 0));
  // a stronger candidate the builder already had: use it, or say why it does not show the line
  const fair = (f: string) => (scores.get(f) ?? 0) - (isPreview(f) ? PREVIEW_BIAS : 0);
  const atBar = o.sceneScore !== undefined && o.sceneScore >= o.filmBar;
  // a near-black candidate would only fail too_dark: the referee rewards darkness whatever the picture shows
  const darkBar = jread<{ p5?: number }>(path.join(o.root, "data", "quality-profile", "magnates-media-lit-band.json"), {}).p5 ?? 0.032;
  const better = atBar ? [] : cands.filter((f) => fair(f) - best >= FOOTAGE_GAP && litOf(f) >= darkBar).sort((a, b) => fair(b) - fair(a));
  const seenIds = new Set<string>();
  const open = better.filter((f) => { const k = mediaId(f); if (seenIds.has(k) || notes.includes(k)) return false; seenIds.add(k); return true; }).slice(0, 4);
  out.push({ id: "best_footage", pass: open.length === 0, detail: open.length ? `your own downloads hold footage that reads far more like the channel than what you placed (${best.toFixed(2)}): ${open.map((f) => `${path.relative(o.job, f)} ${fair(f).toFixed(2)}${isPreview(f) ? " (preview: film-tools stock-get it)" : ""}`).join(", ")} — use one that shows your line, or write in notes/${o.id}.md why not ("not used: <name> — <why>"; the referee does not know what fits the line)` : `placed footage ${best.toFixed(2)}${better.length ? `; stronger candidates answered in notes/${o.id}.md` : ", nothing much stronger in your downloads"}` });
  // the treatment must not bury the footage
  if (o.sceneScore !== undefined) {
    const lost = best - o.sceneScore;
    const ok = lost < TREATMENT_LOSS || o.sceneScore >= o.filmBar;
    out.push({ id: "footage_shows", pass: ok, detail: ok ? `the scene ${o.sceneScore.toFixed(2)}, its footage ${best.toFixed(2)}` : `the scene scores ${o.sceneScore.toFixed(2)} but its own footage ${best.toFixed(2)} — what is laid over it, cropped from it or dimmed hides it: less zoom, a lighter grade, a smaller card, or the words where the footage is empty` });
  }
  // a broadcaster's burned-in caption or logo left in the picture
  if (o.realClip && o.stills.length) {
    const foreign = foreignText(o.root, o.stills, o.code, o.words);
    out.push({ id: "burned_in_text", pass: foreign.length === 0, detail: foreign.length ? `words in the picture that are not yours or the narration's — a broadcaster's caption or logo: ${foreign.slice(0, 3).map((t) => `"${t.slice(0, 60)}"`).join(", ")} — crop them away (RoomScreen crop/focus, a tighter frame) or choose another moment` : "no broadcaster text left in the picture" });
  }
  // footage below the channel's weakest moments after fewer than three searches
  const calls = toolCalls(o.job, `build-${o.id}`);
  if (calls.length && best < o.stretchLow) {
    const prefetch = existsSync(path.join(o.job, "downloads", o.id, "PREFETCH.md")) ? (readFileSync(path.join(o.job, "downloads", o.id, "PREFETCH.md"), "utf8").match(/^## film-tools .*/gm) ?? []) : [];
    const own = [...new Set(calls.filter((c) => c.name === "Bash").map((c) => String(c.input.command ?? "")).flatMap((c) => c.match(/film-tools\s+(stock|press|films|commons|screenshot|clip)\s+[^;&|\n]*/g) ?? []))];
    const searches = prefetch.length + own.length;
    const performed = [...prefetch, ...own].some((q) => /film-tools\s+(stock|films)\b/.test(q) && PERSON.test(q.replace(/film-tools\s+\S+/, "")));
    const ok = searches >= 3 && performed;
    out.push({ id: "searched_enough", pass: ok, detail: ok ? `${searches} searches, one for a person acting out the line, before settling on footage at ${best.toFixed(2)}` : `the footage you placed (${best.toFixed(2)}) is below the channel's weakest moments (${o.stretchLow}) after ${searches} search${searches === 1 ? "" : "es"}${performed ? "" : ", none for a person acting out the line"} — the channel's most common shot is a person performing or reacting to the line, lit low-key: film-tools stock "man counting money desk lamp" "man staring at machine dark room" (people doing YOUR line); at least three searches` });
  }
  return out;
}
