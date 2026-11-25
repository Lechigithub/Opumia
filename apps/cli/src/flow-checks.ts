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
