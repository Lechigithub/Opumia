/**
 * The hand film's three measures as gate checks (2026-11-25), each owned by the scene designer:
 *  - before the render, on the judge's preview stretches: does the picture change by moving (not cutting), does the
 *    frame keep moving, do words stay up long enough to read (`cuts_not_moves`, `too_still`, `words_rushed`);
 *  - on the plan: does it share devices, cut timing or pictures with ANY earlier film of ours, the same topic included
 *    (`template_share`; owner: "even the same film produced twice … should never look similar");
 *  - after the render, on the whole film (QA): the same motion and word-hold measures.
 */
import path from "node:path";
import { BED_GAP, measureBedGap, ensureFlowBand, flowIssues, flowText, measureMotion, measureTextHold, producedJobs, templateShare, TEMPLATE_LIMITS, type FlowBand, type MotionMeasure, type TextHoldMeasure } from "@opumia/agents";
import type { ResolutionReport, ScenePlan, Storyboard } from "@opumia/contracts";
import type { PreflightCheck } from "./preflight.js";

const overlapping = (board: Storyboard, a: number, b: number) => board.shots.filter((s) => s.endS > a && s.startS < b).map((s) => s.id);

/** Motion and word holds measured on the preview stretches, against the channel's band. */
export async function flowChecks(o: { root: string; data: string; channel: string; board: Storyboard; clips: Array<{ fromS: number; len: number; file: string }>; log?: (s: string) => void }): Promise<PreflightCheck[]> {
  const band = await ensureFlowBand({ root: o.root, data: o.data, reference: path.join(o.root, "Reference"), channel: o.channel, ...(o.log ? { log: o.log } : {}) });
  if (!band || !o.clips.length) return [];
  const per = await Promise.all(o.clips.map(async (c) => ({ c, m: await measureMotion(c.file, { len: c.len }).catch(() => null), t: await measureTextHold(c.file, { root: o.root, data: o.data, len: c.len }).catch(() => null) })));
  const out: PreflightCheck[] = [];
  for (const id of ["cuts_not_moves", "too_still", "words_rushed"] as const) {
    const bad = per.map((x) => ({ ...x, issue: flowIssues(x.m, x.t ? { ...x.t, rushed: x.t.rushed.map((r) => ({ ...r, atS: r.atS + x.c.fromS })) } : null, band).find((i) => i.id === id) })).filter((x) => x.issue);
    const label = id === "cuts_not_moves" ? "Picture changes made by moving, not cutting (the channel's continuous camera)" : id === "too_still" ? "Share of the time the frame is moving" : "Words on screen held long enough to read";
    out.push({ id, label, value: bad.length, target: "every preview stretch inside the channel's band", pass: bad.length === 0, level: "blocker", repair: "redesign_scene", shots: [...new Set(bad.flatMap((x) => overlapping(o.board, x.c.fromS, x.c.fromS + x.c.len)))], ...(bad.length ? { note: bad.map((x) => `${x.c.fromS.toFixed(0)}–${(x.c.fromS + x.c.len).toFixed(0)} s: ${x.issue!.detail}`).join(" | ").slice(0, 900) } : {}) } as PreflightCheck);
  }
  return out;
}

/** The plan against every earlier film of ours (produced films, the same topic included). */
export async function templateShareCheck(o: { root: string; data: string; jobId: string; board: Storyboard; scenes: ScenePlan; resolution: ResolutionReport }): Promise<PreflightCheck[]> {
  const others = [...(await producedJobs(o.data))].filter((j) => j !== o.jobId).map((j) => path.join(o.root, "out", j));
  const rows = await templateShare({ board: o.board, scenes: o.scenes as never, resolution: o.resolution as never }, others);
  const over = rows.filter((r) => r.pictures > TEMPLATE_LIMITS.pictures || r.devices > TEMPLATE_LIMITS.devices || r.cuts > TEMPLATE_LIMITS.cuts);
  const worst = over[0] ?? rows[0];
  return [{ id: "template_share", label: "What the plan shares with our earlier films (devices at the same moment, cut timing, pictures — excess over chance)", value: worst ? Math.max(worst.devices, worst.cuts, worst.pictures) : 0, target: `devices ≤ ${TEMPLATE_LIMITS.devices}, cuts ≤ ${TEMPLATE_LIMITS.cuts}, pictures ≤ ${TEMPLATE_LIMITS.pictures} against every earlier film`, pass: over.length === 0, level: "blocker", repair: "redesign_scene", shots: [...new Set(over.flatMap((r) => r.shots))].slice(0, 8), ...(over.length ? { note: `too like ${over.slice(0, 3).map((r) => `${r.film} (devices ${r.devices}, cuts ${r.cuts}, pictures ${r.pictures})`).join(", ")} — redesign these shots from nothing: another device, another picture, other cut points; never the same layout at the same moment` } : {}) } as PreflightCheck];
}

/** The whole finished film, for QA (major: keeps the verdict at review when outside the band). */
export async function filmFlow(o: { root: string; data: string; channel: string; film: string; durationS: number }): Promise<{ motion: MotionMeasure | null; text: TextHoldMeasure | null; band: FlowBand | null; issues: Array<{ id: string; detail: string }>; summary: string }> {
  const band = await ensureFlowBand({ root: o.root, data: o.data, reference: path.join(o.root, "Reference"), channel: o.channel });
  const motion = await measureMotion(o.film, { len: Math.min(120, o.durationS) }).catch(() => null);
  const text = await measureTextHold(o.film, { root: o.root, data: o.data, len: Math.min(120, o.durationS) }).catch(() => null);
  return { motion, text, band, issues: band ? flowIssues(motion, text, band) : [], summary: flowText(motion, text, band) };
}

/** The mix of the plan (from its stems): the cold-open bed ≈ 10.5 dB under the voice, the body ≈ 15 dB (the channel's
 *  stems: 9.5 and 14–17), a bed that never falls away while he speaks, no dead air. Owner: the sound designer. */
export async function bedChecks(o: { stems: { voice: string; bed: string }; coldOpenEndS: number; durationS: number; board: Storyboard }): Promise<PreflightCheck[]> {
  const cold = await measureBedGap(o.stems.voice, o.stems.bed, 0, o.coldOpenEndS);
  const body = o.durationS > o.coldOpenEndS + 10 ? await measureBedGap(o.stems.voice, o.stems.bed, o.coldOpenEndS, Math.min(120, o.durationS - o.coldOpenEndS)) : null;
  const shotsAt = (t: number) => o.board.shots.filter((s) => s.startS <= t && s.endS > t).map((s) => s.id);
  const dead = [...cold.deadAir, ...(body?.deadAir ?? [])];
  const out: PreflightCheck[] = [
    { id: "bed_gap", label: "Music bed under the voice (cold open; body)", value: cold.gapDb, target: `cold open ≈ ${BED_GAP.coldOpen} dB (≤ 13), body ≈ ${BED_GAP.body} dB (≤ 19), falling away under 15 % of speech`, pass: cold.gapDb <= 13 && cold.fallsAway <= 0.15 && (!body || (body.gapDb <= 19 && body.fallsAway <= 0.25)), level: "blocker", repair: "reseed_sound", shots: [], note: `cold open ${cold.gapDb} dB under (falls away on ${Math.round(cold.fallsAway * 100)} % of speech)${body ? `; body ${body.gapDb} dB (${Math.round(body.fallsAway * 100)} %)` : ""} — raise the bed or choose a steadier one; the channel's bed never drops out while the narrator speaks` },
    { id: "dead_air", label: "Dead air (voice and music both near silent ≥ 0.6 s)", value: dead.length, target: "0 (except a deliberate drop-out before a reveal)", pass: dead.length <= 1, level: "blocker", repair: "reseed_sound", shots: [...new Set(dead.flatMap((d) => shotsAt(d.atS)))].slice(0, 6), ...(dead.length ? { note: dead.map((d) => `${d.atS} s for ${d.s} s`).join(", ") } : {}) },
  ];
  return out;
}

/**
 * The world check (build list 6, B1/B2): local SigLIP 2 + on-device OCR, no API (tools/world/world_check.py).
 *  - `line_fit`: with on-screen words blurred out, does each picture show what its line says? (the channel's p10 is
 *    the floor; an unmasked score would reward writing the line on screen);
 *  - `world_too_close`: is the film's word look or its pictures closer to an earlier film of ours than the channel's own
 *    films are to each other (p90)? Versions of one job are not compared.
 * Before the render it runs on the judge's preview stretches (a draft: never stored); in QA on the finished film, which
 * then joins the memory every later film is compared with.
 */
type WorldReport = { lineFit: { mean: number; pass: boolean; band: { p10: number }; weakest: Array<{ t: number; line: string; fit: number }> }; tooClose: Array<{ film: string; words: number | null; pictures: number | null }>; pass: boolean };
async function runWorldCheck(o: { root: string; name: string; film: string; timed: string; clips?: Array<{ fromS: number; len: number; file: string }>; save: boolean; versionOf?: string[]; lenS?: number }): Promise<WorldReport | null> {
  const { embedPython } = await import("@opumia/ingest");
  const { execFile } = await import("node:child_process");
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const args = ["-I", path.join(o.root, "tools/world/world_check.py"), o.name, o.film, o.timed, "--json", "--len", String(Math.round(o.lenS ?? 70))];
  if (o.clips?.length) { const f = path.join(await mkdtemp(path.join(os.tmpdir(), "world-")), "clips.json"); await writeFile(f, JSON.stringify(o.clips)); args.push("--clips", f); }
  if (!o.save) args.push("--no-save");
  if (o.versionOf?.length) args.push("--version-of", o.versionOf.join(","));
  const out = await new Promise<string>((res, rej) => execFile(embedPython(), args, { cwd: o.root, maxBuffer: 1 << 26, timeout: 30 * 60_000 }, (e, stdout) => (e ? rej(e) : res(stdout))));
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  return line ? (JSON.parse(line) as WorldReport) : null;
}
const shotsAt = (board: Storyboard, ts: number[]) => [...new Set(ts.flatMap((t) => board.shots.filter((s) => s.startS <= t && s.endS > t).map((s) => s.id)))];
function worldItems(r: WorldReport, board: Storyboard): PreflightCheck[] {
  const words = r.tooClose.filter((x) => (x.words ?? 0) > 0), pics = r.tooClose.filter((x) => (x.pictures ?? 0) > 0);
  return [
    { id: "line_fit", label: "Pictures show what each line says (words on screen blurred out first)", value: r.lineFit.mean, target: `≥ ${r.lineFit.band.p10} (the channel's lowest tenth)`, pass: r.lineFit.pass, level: "blocker", repair: "replace_picture", shots: shotsAt(board, r.lineFit.weakest.filter((w) => w.fit < 0.25).map((w) => w.t)).slice(0, 6), ...(r.lineFit.pass ? {} : { note: `weakest: ${r.lineFit.weakest.slice(0, 4).map((w) => `${w.t.toFixed(0)} s "${w.line.slice(0, 50)}" ${w.fit}`).join(" | ")} — show what the line names (its real people, places, documents, or someone performing it), not a mood picture or a card` }) } as PreflightCheck,
    { id: "world_too_close", label: "Word look and pictures against every earlier film of ours (closer than the channel's own film pairs = a template)", value: r.tooClose.length, target: "0 earlier films over the channel's p90", pass: r.tooClose.length === 0, level: "blocker", repair: words.length ? "redesign_scene" : "replace_picture", shots: [], ...(r.tooClose.length ? { note: `too like ${r.tooClose.map((x) => `${x.film} (words ${x.words}, pictures ${x.pictures})`).join(", ")} — ${words.length ? "the words on screen look like that film's: give this film its own word device from its world bible" : ""}${pics.length ? " the pictures are that film's genre stock: use this story's own subjects" : ""}` } : {}) } as PreflightCheck,
  ];
}
export async function worldChecks(o: { root: string; jobId: string; board: Storyboard; timedPath: string; clips: Array<{ fromS: number; len: number; file: string }>; versionOf?: string[]; log?: (s: string) => void }): Promise<PreflightCheck[]> {
  if (!o.clips.length) return [];
  const r = await runWorldCheck({ root: o.root, name: `${o.jobId}-preflight`, film: o.clips[0]!.file, timed: o.timedPath, clips: o.clips, save: false, versionOf: [o.jobId, ...(o.versionOf ?? [])] });
  return r ? worldItems(r, o.board) : [];
}
export async function filmWorld(o: { root: string; jobId: string; film: string; timedPath: string; durationS: number; board: Storyboard }): Promise<{ checks: PreflightCheck[]; report: WorldReport } | null> {
  const r = await runWorldCheck({ root: o.root, name: o.jobId, film: o.film, timed: o.timedPath, save: true, versionOf: [o.jobId], lenS: Math.min(120, o.durationS) });
  return r ? { checks: worldItems(r, o.board), report: r } : null;
}

/**
 * Paper and cards at the channel's rate (build list 6, B3a; owner: "why … paper, documents, cards a lot … instead of
 * showing the story?"). On the plan, no model: the channel lets 19–75 % of its shots play as clean footage (median 40 %),
 * carries text on 26–86 %, and all its non-footage kinds together (title, document, logo, chart, card, map…) are ≈ 27 %
 * (data/visual-profile/<channel>.json). A film that turns every line into an object on screen is illustrating the
 * script, not showing the story.
 */
export async function paperChecks(o: { data: string; channel: string; scenes: ScenePlan }): Promise<PreflightCheck[]> {
  const { readFile } = await import("node:fs/promises");
  const vp = JSON.parse(await readFile(path.join(o.data, "visual-profile", `${o.channel}.json`), "utf8").catch(() => "null")) as { plainFootage: { p10: number; p50: number }; textShare: { p90: number }; mix: Record<string, number> } | null;
  if (!vp) return [];
  type El = { type?: string };
  const sc = o.scenes.scenes as unknown as Array<{ shotId: string; backdrop?: string; elements?: El[] }>;
  const n = Math.max(1, sc.length);
  const clean = sc.filter((s) => (s.backdrop ?? "footage") === "footage" && !(s.elements ?? []).length);
  const carded = sc.filter((s) => (s.backdrop ?? "footage") !== "footage" || (s.elements ?? []).some((e) => ["document", "newspaper", "screen", "quote"].includes(String(e.type))));
  const texted = sc.filter((s) => (s.elements ?? []).length > 0);
  const nonFootage = 1 - (vp.mix.plain_footage ?? 0) - (vp.mix.words_over_footage ?? 0) - (vp.mix.caption_on_footage ?? 0);
  const cardMax = Math.round(nonFootage * 1.3 * 1000) / 1000;
  const r2 = (x: number) => Math.round(x * 1000) / 1000;
  return [
    { id: "clean_footage", label: "Shots that play as clean footage, nothing on them", value: r2(clean.length / n), target: `≥ ${vp.plainFootage.p10} (the channel: ${vp.plainFootage.p10}–, median ${vp.plainFootage.p50})`, pass: clean.length / n >= vp.plainFootage.p10, level: "blocker", repair: "redesign_scene", shots: texted.filter((s) => (s.backdrop ?? "footage") === "footage").map((s) => s.shotId).slice(0, 6), note: "let footage of the story (its people, places, someone performing the line) play with nothing on it" } as PreflightCheck,
    { id: "paper_and_cards", label: "Shots made of paper, documents, cards or a stage (no footage)", value: r2(carded.length / n), target: `≤ ${cardMax} (the channel's non-footage kinds together ≈ ${r2(nonFootage)})`, pass: carded.length / n <= cardMax, level: "blocker", repair: "redesign_scene", shots: carded.map((s) => s.shotId).slice(0, 8), note: "keep the film's paper or card device for its few key moments; show the story on the rest" } as PreflightCheck,
    { id: "text_share", label: "Shots carrying words on screen", value: r2(texted.length / n), target: `≤ ${vp.textShare.p90} (the channel's p90)`, pass: texted.length / n <= vp.textShare.p90, level: "blocker", repair: "redesign_scene", shots: texted.map((s) => s.shotId).slice(0, 8) } as PreflightCheck,
  ];
}
