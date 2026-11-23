/**
 * Build list 5: the gate checks the SAME measure each owner works to. This module computes, for the preflight gate,
 * the checks whose measures live with their owners:
 *  - picture design (items 10–14): worlds, backdrop variety, treatment, raw stock, type scale, boxed labels, repeated
 *    cards and pictures, data kinds, rate and holds (`designProblems`), and the figure on screen against the voice,
 *    totals included (`figureParity`);
 *  - pictures (items 16–17): idle stock, story-specific share, meaning (`pictureIssues`);
 *  - the final-cut judge's tells on previews (item 15): four stretches rendered cheaply from the plan and judged blind
 *    beside real stretches before any frame of the film is rendered; every tell goes to its owner.
 * Labels are memoised by file and modification time, so an unchanged preview is never labelled twice.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { scoreSoundTaste, checkTechniqueUses, labelTechniques, loadInventory, CATEGORY_OWNER, designProblems, embedPictures, figureParity, judgeClips, labelDesign, pictureIssues, textAreas, withinFilmVariety, labelPictures, DESIGN_FIX, type DesignBand, type DesignLabel, type PictureBand, type PictureLabel } from "@opumia/agents";
import type { ChannelId, ResolutionReport, ScenePlan, Storyboard, TimedScript } from "@opumia/contracts";
import { figureInputs } from "@opumia/motion-engine";
import type { PreflightCheck } from "./preflight.js";

const memo = new Map<string, unknown>();
const key = (f: string, tag: string) => `${tag}|${f}|${existsSync(f) ? statSync(f).mtimeMs : 0}`;
async function memoised<T>(files: string[], tag: string, fn: (fs: string[]) => Promise<T[]>): Promise<T[]> {
  const todo = files.filter((f) => !memo.has(key(f, tag)));
  if (todo.length) {
    const got = await fn(todo);
    todo.forEach((f, i) => memo.set(key(f, tag), got[i]));
  }
  return files.map((f) => memo.get(key(f, tag)) as T);
}

const frameOf = (prevDir: string, id: string) => [`${id}_1.jpg`, `${id}_0.jpg`].map((f) => path.join(prevDir, f)).find(existsSync);

export async function designChecks(o: { root: string; data: string; prevDir: string; board: Storyboard; scenes: ScenePlan; resolution: ResolutionReport; timed: TimedScript; band: DesignBand | null }): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  const shots = o.board.shots;
  // figures on screen against what the voice says (totals included) — no model
  const shownOf = (id: string) => {
    const sc = o.scenes.scenes.find((x) => x.shotId === id);
    const sh = shots.find((x) => x.id === id);
    const strs: string[] = [];
    // words on screen only: string props that read as text (a bare number is a layout value — a size, a position)
    const LAYOUT = /^(slot|size|x|y|w|h|width|height|scale|rotate|angle|delay|duration|at|opacity|align|variant|style|kind|mode|side|tone|edge|color|colour|weight|z|index|order)$/i;
    for (const e of sc?.elements ?? []) if (e.type === "component") for (const [k, v] of Object.entries((e as { props: Record<string, unknown> }).props)) if (typeof v === "string" && !LAYOUT.test(k) && /[A-Za-z$€£¥%]/.test(v)) strs.push(v);
    const props = (sh?.source as { props?: Record<string, unknown> } | undefined)?.props;
    if (props) for (const [k, v] of Object.entries(props)) if (typeof v === "string" && !LAYOUT.test(k) && /[A-Za-z$€£¥%]/.test(v)) strs.push(v);
    // a chart's bars are figures on screen: its values in its unit, as a viewer reads them
    const vals = (props as { values?: unknown; unit?: unknown } | undefined)?.values;
    const unit = String((props as { unit?: unknown } | undefined)?.unit ?? "");
    if (Array.isArray(vals)) for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) {
      const sc2 = Math.abs(v) >= 1e9 ? [1e9, " billion"] as const : Math.abs(v) >= 1e6 ? [1e6, " million"] as const : [1, ""] as const;
      const n = Math.round((v / sc2[0]) * 100) / 100;
      strs.push(unit === "%" ? `${n}%` : `${unit}${n}${sc2[1]}`);
    }
    const display = (props as { display?: unknown } | undefined)?.display;
    if (Array.isArray(display)) for (const v of display) strs.push(String(v));
    return strs;
  };
  const words = o.timed.segments.flatMap((sg) => sg.words);
  const parity = figureParity(figureInputs(shots.map((s) => ({ id: s.id, startS: s.startS, endS: s.endS, shown: shownOf(s.id) })), words));
  for (const p of parity) out.push({ id: p.check, label: p.what, value: p.shots.length, target: p.band, pass: false, level: "blocker", shots: p.shots, note: `${p.measured} — the figure on screen must be what the voice says at that moment, totals included` });
  if (!o.band) return out;
  const ids = shots.map((s) => s.id).filter((id) => frameOf(o.prevDir, id));
  const files = ids.map((id) => frameOf(o.prevDir, id)!);
  const labels = await memoised<DesignLabel | null>(files, "design", (fs) => labelDesign(fs, { data: o.data }));
  const areas = await memoised<number | null>(files, "ocr", (fs) => textAreas(fs, { root: o.root, data: o.data }));
  const designed = ids.filter((_, k) => labels[k] && labels[k]!.world !== "footage");
  const vecs = ((await embedPictures({ root: o.root, data: o.data, items: designed.map((id) => ({ file: frameOf(o.prevDir, id)! })) }).catch(() => [])) as Array<Float32Array | null>).filter((v): v is Float32Array => !!v);
  const problems = designProblems({
    scenes: o.scenes.scenes, shots: shots.map((s) => ({ id: s.id, startS: s.startS, endS: s.endS })), durationS: o.board.durationS, band: o.band,
    labels: Object.fromEntries(ids.map((id, k) => [id, labels[k] ?? null])), textArea: Object.fromEntries(ids.map((id, k) => [id, areas[k] ?? null])), variety: withinFilmVariety(vecs),
    refOf: (shotId, slot) => o.resolution.media.find((m) => m.shotId === shotId && m.role === "layer" && m.slot === slot)?.ref,
  });
  for (const p of problems) {
    // a film-level problem with no shots goes to the designed scenes it is about (at most five)
    const sh = p.shots.length ? p.shots : designed.slice(0, 5);
    out.push({ id: p.check, label: p.what, value: p.shots.length || 1, target: p.band, pass: false, level: "blocker", shots: sh, note: `${p.measured}. ${DESIGN_FIX[p.check] ?? ""}`.trim() });
  }
  return out;
}

export async function pictureChecks(o: { prevDir: string; board: Storyboard; scenes: ScenePlan; resolution: ResolutionReport; timed: TimedScript; subjects: string; band: PictureBand | null }): Promise<PreflightCheck[]> {
  if (!o.band) return [];
  const words = o.timed.segments.flatMap((sg) => sg.words);
  const lineOf = (id: string) => {
    const sh = o.board.shots.find((x) => x.id === id)!;
    return words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
  };
  const ids = o.board.shots.map((s) => s.id).filter((id) => frameOf(o.prevDir, id));
  const files = ids.map((id) => frameOf(o.prevDir, id)!);
  const labels = await memoised<PictureLabel | null>(files, `picture|${o.subjects}`, (fs) => labelPictures(fs.map((f) => ({ frameFile: f, line: lineOf(ids[files.indexOf(f)]!), subjects: o.subjects }))));
  const rows = ids.map((id, k) => ({ shotId: id, label: labels[k] ?? null, footage: o.resolution.media.some((m) => m.shotId === id && m.role === "primary" && m.kind === "video") && o.scenes.scenes.find((x) => x.shotId === id)?.backdrop === "footage" }));
  return pictureIssues(rows, o.band).map((p) => ({ id: p.check, label: p.check === "idle_stock" ? "Stock people doing nothing in particular" : p.check === "generic_pictures" ? "Too few pictures specific to the story" : "Pictures that do not carry the line's meaning", value: p.shots.length, target: p.band, pass: false, level: "blocker" as const, shots: p.shots, note: p.measured }));
}

/** Who owns a tell, read from its words. */
export function ownerOfTell(t: string): "tells_edit" | "tells_colour" | "tells_footage" | "tells_picture" {
  if (/\b(cut|cuts|cutting|pace|pacing|rhythm|jump|stutter|transition|hold|held|lingers?|static|slow)\b/i.test(t)) return "tells_edit";
  if (/\b(colou?r|grade|graded|dark|dim|bright|saturat|tint|wash|hue|muddy|contrast)\b/i.test(t)) return "tells_colour";
  if (/\b(stock|generic|footage|b-roll|broll|clip|actor|model|unrelated|irrelevant|literal)\b/i.test(t)) return "tells_footage";
  return "tells_picture";
}

/**
 * Item 15: four stretches of the plan (from the opening to the run-in to the ending) are rendered cheaply (one third
 * scale, `render(fromS, toS)` → an mp4) and judged blind beside real stretches that say something close; every tell
 * of a stretch the judge picked out becomes a check for its owner, on that stretch's shots.
 */
export async function previewTells(o: { data: string; reference: string; root: string; channel: ChannelId; board: Storyboard; timed: TimedScript; workDir: string; render: (fromS: number, toS: number) => Promise<string | null>; log?: (s: string) => void }): Promise<{ checks: PreflightCheck[]; realness: number | null; usd: number; stretches: Array<{ fromS: number; toS: number; picked: boolean; tells: string[] }>; clips: Array<{ fromS: number; len: number; file: string; said: string }> }> {
  const d = o.board.durationS;
  const len = Math.min(8, Math.max(4, d / 6));
  const words = o.timed.segments.flatMap((sg) => sg.words);
  const at = [0.04, 0.33, 0.6, 0.86].map((q) => Math.max(0, Math.min(d - len, q * d)));
  const byOwner = new Map<string, { shots: Set<string>; tells: string[] }>();
  const stretches: Array<{ fromS: number; toS: number; picked: boolean; tells: string[] }> = [];
  let usd = 0;
  const real: number[] = [];
  // the four stretches render two at a time (time), then are judged in order
  const files = new Array<string | null>(at.length).fill(null);
  for (let k = 0; k < at.length; k += 2) await Promise.all(at.slice(k, k + 2).map(async (f, j) => { files[k + j] = await o.render(f, f + len).catch(() => null); }));
  for (const [k, fromS] of at.entries()) {
    const toS = fromS + len;
    const file = files[k];
    if (!file) continue;
    const said = words.filter((w) => w.startS >= fromS && w.startS < toS).map((w) => w.word).join(" ");
    const r = await judgeClips({ data: o.data, reference: o.reference, root: o.root, channel: o.channel, video: file, clips: [{ fromS: 0, toS: len, said }], workDir: o.workDir }).catch(() => null);
    if (!r?.clips.length) continue;
    usd += r.usd;
    const c = r.clips[0]!;
    real.push(c.realness);
    stretches.push({ fromS, toS, picked: c.picked, tells: c.tells });
    if (!c.picked) continue;
    const inS = o.board.shots.filter((s) => s.endS > fromS && s.startS < toS).map((s) => s.id);
    for (const t of c.tells) {
      const k = ownerOfTell(t);
      const e = byOwner.get(k) ?? { shots: new Set<string>(), tells: [] };
      inS.forEach((id) => e.shots.add(id));
      e.tells.push(`${fromS.toFixed(0)}–${toS.toFixed(0)} s: ${t}`);
      byOwner.set(k, e);
    }
  }
  const label: Record<string, string> = { tells_edit: "The judge picked the stretch out by its cutting", tells_colour: "The judge picked the stretch out by its colour", tells_footage: "The judge picked the stretch out by its footage", tells_picture: "The judge picked the stretch out by its picture design" };
  const checks: PreflightCheck[] = [...byOwner].map(([k, v]) => ({ id: k, label: label[k]!, value: v.tells.length, target: "no tell", pass: false, level: "blocker" as const, shots: [...v.shots], note: v.tells.slice(0, 4).join(" | ") }));
  o.log?.(`  judge on previews: ${stretches.filter((s) => s.picked).length} of ${stretches.length} stretches picked out${checks.length ? ` — tells to ${checks.map((c) => c.id.replace("tells_", "")).join(", ")}` : ""} ($${usd.toFixed(2)})`);
  const clips = at.flatMap((f, k) => (files[k] ? [{ fromS: f, len, file: files[k]!, said: words.filter((w) => w.startS >= f && w.startS < f + len).map((w) => w.word).join(" ") }] : []));
  return { checks, realness: real.length ? Math.round((real.reduce((a, x) => a + x, 0) / real.length) * 100) / 100 : null, usd, stretches, clips };
}

/**
 * Craft inventory: is each technique used the way the channel uses it? Every shot's techniques — those the designer
 * named and those the labeller sees on its final preview — with its line and place in the film, against the channel's
 * grammar. Misuses go back to their owner before the render.
 */
export async function techniqueUseChecks(o: { data: string; channel: string; prevDir: string; board: Storyboard; scenes: ScenePlan; timed: TimedScript }): Promise<PreflightCheck[]> {
  const inv = await loadInventory(o.data, o.channel);
  if (!inv) return [];
  const words = o.timed.segments.flatMap((sg) => sg.words);
  const dur = o.board.durationS || 1;
  const uses: Array<{ shotId: string; technique: string; line: string; position: number }> = [];
  for (const sh of o.board.shots) {
    const sc = o.scenes.scenes.find((x) => x.shotId === sh.id);
    const line = words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
    const named = new Set((sc as { techniques?: string[] } | undefined)?.techniques ?? []);
    const sheet = [`${sh.id}_sheet.jpg`].map((f) => path.join(o.prevDir, f)).find(existsSync);
    if (sheet) {
      const seen = await memoised<Record<string, number>>([sheet], "techniques", async (fs) => Promise.all(fs.map((f) => labelTechniques({ sheet: f, text: `Words spoken: "${line}"`, taxonomy: inv.taxonomy }))));
      for (const id of Object.keys(seen[0] ?? {})) {
        const t = inv.taxonomy.find((x) => x.id === id);
        if (t && CATEGORY_OWNER[t.category] === "scene designer") named.add(id);
      }
    }
    for (const t of named) uses.push({ shotId: sh.id, technique: t, line, position: sh.startS / dur });
  }
  const bad = (await checkTechniqueUses({ data: o.data, channel: o.channel, uses }).catch(() => [])).filter((v) => !v.ok);
  return bad.length ? [{ id: "technique_misuse", label: "Techniques used the way the channel does not use them", value: bad.length, target: "0", pass: false, level: "blocker", shots: [...new Set(bad.map((v) => v.shotId))], note: bad.slice(0, 6).map((v) => `${v.shotId} ${v.technique}: ${v.why}`).join(" | ") }] : [];
}

/** Ears: the soundtrack of the judge's preview stretches, scored by the trained mix taste against the real channel. */
export async function mixTasteCheck(o: { root: string; data: string; channel: string; clips: Array<{ file: string; len: number }> }): Promise<PreflightCheck[]> {
  const items = o.clips.map((c) => ({ file: c.file, t: 0, dur: Math.min(8, c.len) }));
  const r = await scoreSoundTaste({ root: o.root, data: o.data, channel: o.channel, kind: "mix", items }).catch(() => null);
  if (!r) return [];
  return [{ id: "mix_taste", label: "The soundtrack (voice, music, effects together) heard against the channel's", value: Math.round(r.median * 1000) / 1000, target: `≥ ${r.realP10} (the channel's lowest tenth; its median ${r.realMedian})`, pass: !r.below, level: "blocker", shots: [] }];
}
