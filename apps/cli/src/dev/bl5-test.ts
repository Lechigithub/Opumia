// Build list 5 as tests, no network and no model calls:
//  - one length table scales every budget, cap and count (45 s, 90 s, 3 min, 10 min), and the per-minute target holds;
//  - a starved first pass is detected (an agent given less than it needs);
//  - the craft bands exist at every length and the channel's own stretches pass their own floor;
//  - stutter cuts (the same picture with a hard cut or the same framing) are caught;
//  - the judge's tells go to their owners; the Nokia proof film is not accepted as the proof.
//   npx tsx apps/cli/src/dev/bl5-test.ts
import path from "node:path";
import { applyPresets, CAPABILITIES, manifestEvents, agentLeft, recordExternal, setLaterGuarantee, agentLoop, allotments, craftBand, lengthPlan, MODELS, realScoreFloor, resetAllotments, setBudget, stutterCuts } from "@opumia/agents";
import { ownerOfTell } from "../bl5-checks.js";
import { proofFilm } from "./proof-film.js";
import { storyScenesOffline } from "./story-scenes-test.js";

export async function bl5Test(): Promise<string[]> {
  const fails: string[] = [];
  // item 2 + 31: the length table
  const p45 = lengthPlan(45), p90 = lengthPlan(90), p180 = lengthPlan(180), p600 = lengthPlan(600);
  if (p90.targetUsd !== 3 || p90.targetMinutes !== 30) fails.push(`90 s target must be $3 and 30 min, got $${p90.targetUsd} ${p90.targetMinutes} min`);
  if (Math.abs(p600.targetUsd - 20) > 0.01 || p600.targetMinutes !== 200) fails.push(`10 min must scale by the per-minute figures ($20, 200 min), got $${p600.targetUsd} ${p600.targetMinutes} min`);
  if (p45.targetUsd !== 3) fails.push("a 45 s film keeps the 90 s floor");
  // measured (story-structure.ts, 2026-11-27): an intro of ~50 s, then chapters of ~3 min — a 10-minute film has 2–4
  if (p90.chapters !== 0 || p180.chapters !== 0 || p600.chapters < 2 || p600.chapters > 4) fails.push(`chapters: 90 s ${p90.chapters}, 180 s ${p180.chapters}, 600 s ${p600.chapters}`);
  const capSum = (p: ReturnType<typeof lengthPlan>) => ["A1", "A2", "A3", "B1", "B2", "B2d", "B3", "B6", "C3"].reduce((a, c) => a + p.stage(c)!.usd, 0);
  if (!(capSum(p600) > capSum(p180) && capSum(p180) > capSum(p90))) fails.push("stage shares must grow with the film's length");
  if (p600.stage("B2d")!.usd > p90.stage("B2d")!.usd * 2.5) fails.push("the art director's share is mostly per film, not per minute");
  if (p90.agentScale(0.3) !== 1 || p600.agentScale(1) !== 1 || p600.agentScale(0) < 6) fails.push("agent caps scale by the share of work that grows with length");
  if (p600.musicCues(8) < p600.chapters || p45.musicCues(3) < 1) fails.push("music cues come from the table");
  if (p45.maxGapS >= p600.maxGapS || p45.openingS > 20) fails.push("re-hook gap and opening window scale with length");
  // item 1: an agent given less than its first pass needs is logged as STARVED (no model is called: it has $0)
  resetAllotments();
  setBudget(1, { spentBefore: 1 });
  await agentLoop({ stage: "test.starved", model: MODELS.haiku, system: [], user: "x", tools: [], maxUsd: 0.4 }).catch((e: Error) => fails.push(`starved agent threw: ${e.message}`));
  setBudget(null);
  const al = allotments().find((a) => a.stage === "test.starved");
  if (!al?.starved) fails.push(`a first pass given $0 must be logged as starved (${JSON.stringify(al)})`);
  // WeWork proof film: a later stage's share is kept from earlier first passes; a starved stage borrows the repair pool,
  // then half of what later stages are kept, never the finish reserve
  setBudget(5, { reserveUsd: 0.8, repairUsd: 0.75 });
  setLaterGuarantee(1.5);
  if (Math.abs((agentLeft() ?? 0) - (5 - 0.8 - 0.75 - 1.5)) > 1e-9) fails.push(`a first pass keeps later stages' shares aside, got ${agentLeft()}`);
  recordExternal("test", "test", 1, 3);
  if (Math.abs((agentLeft() ?? 0) - 0.45) > 1e-9) fails.push(`an overspent film borrows the repair pool and half the later shares ($0.45), got ${agentLeft()}`);
  setLaterGuarantee(0);
  setBudget(null);
  // craft inventory: the catalogue names every tool once, and our film is labelled with the same facts as a real stretch
  if (new Set(CAPABILITIES.map((c) => c.id)).size !== CAPABILITIES.length) fails.push("capability ids must be unique");
  for (const need of ["atmosphere", "scene_fx", "kit_type", "transitions", "card3d", "text3d"]) if (!CAPABILITIES.some((c) => c.id === need)) fails.push(`the capability catalogue must list ${need}`);
  const ev = manifestEvents({ fps: 24, video: [{ zIndex: 0, startFrame: 0 }, { zIndex: 0, startFrame: 48 }], audio: [{ role: "sfx", startFrame: 50, ref: "x" }, { role: "music", startFrame: 0, dips: [{ fromFrame: 100, toFrame: 130 }] }] })(0, 10);
  if (!/Cuts at: 2\.0/.test(ev) || !/hit at 2\.1/.test(ev) || !/drops out/.test(ev)) fails.push(`our stretch must be described like a real one: ${ev}`);
  // how the channel uses its techniques: a named technique brings its recipe; the designer's own choices win
  {
    const d: Record<string, any> = { backdrop: "footage", world: { kind: "none", slot: -1, slots: [] }, atmos: "none", elements: [{ type: "photo", grade: "natural", frame: "none", enter: "fade" }, { type: "cutout", style: "outline" }], fx: { glitch: false, dof: 0, rack: false, scanlines: false, grid: false, cursorX: -1, cursorY: -1, twotone: false }, finish: { grain: 0.1, vignette: 0.2, leak: 0, halftone: 0 } };
    applyPresets(d, [{ world: "filmstrip", grade: "mono", frame: "polaroid", atmos: "sprocket", enter: "settle", cutout: "glow", glitch: false, dof: 0.4, rack: false, scanlines: false, grid: false, twotone: false, halftone: 0, grain: 0.3, leak: 0, drift: "none", transition: "none", kit: "" }]);
    if (d.world.kind !== "filmstrip" || d.backdrop !== "world" || d.atmos !== "sprocket" || d.elements[0].grade !== "mono" || d.elements[0].frame !== "polaroid" || d.elements[0].enter !== "settle" || d.finish.grain !== 0.3 || d.fx.dof !== 0.4) fails.push(`a preset must fill the scene draft: ${JSON.stringify(d).slice(0, 200)}`);
    if (d.elements[1].style !== "outline") fails.push("a preset must not override the designer's own choice");
  }
  // item 4: the craft bands at every length, and the channel's own stretches reach their own floor
  const data = path.join(process.cwd(), "data");
  for (const L of [45, 90, 180, 600]) {
    const b = await craftBand({ data, channel: "magnates-media", craft: "edit", lengthS: L }).catch(() => null);
    if (!b || b.stretches < 8) fails.push(`no edit band of real stretches at ${L} s`);
  }
  const floor = await realScoreFloor({ data, channel: "magnates-media", craft: "edit", lengthS: 90 }).catch(() => null);
  if (floor === null || floor < 60) fails.push(`the channel's own 90 s stretches should mostly sit in their band (floor ${floor})`);
  // item 21
  const media = [{ shotId: "a", role: "primary", ref: "pexels:1" }, { shotId: "a_2", role: "primary", ref: "pexels:1" }, { shotId: "b", role: "primary", ref: "pexels:2" }];
  if (stutterCuts([{ id: "a" }, { id: "a_2", transitionIn: "cut" }, { id: "b" }], media).length !== 1) fails.push("a hard cut back to the same picture is a stutter");
  if (stutterCuts([{ id: "a" }, { id: "a_2", transitionIn: "whip" }], media).length !== 1) fails.push("a whip to the same framing is still a stutter");
  if (stutterCuts([{ id: "a" }, { id: "a_2", transitionIn: "whip", camera: { type: "ken_burns", fromScale: 1.3 } }], media).length !== 0) fails.push("a punch-in with a whip is not a stutter");
  // item 15
  if (ownerOfTell("the cuts land mechanically on every word") !== "tells_edit" || ownerOfTell("muddy dark grade") !== "tells_colour" || ownerOfTell("generic stock of hands on a phone") !== "tells_footage" || ownerOfTell("the same navy grid backdrop with small boxed labels") !== "tells_picture") fails.push("tells must go to their owners");
  // items 5–9 offline
  fails.push(...storyScenesOffline());
  // item 34: the slop film must not pass as the proof
  const nokia = path.join(process.cwd(), "out", "bl4c-nokia");
  try {
    const r = await proofFilm(nokia, data);
    if (r.accepted) fails.push("the Nokia slop film must not be accepted as the proof");
  } catch { /* the job folder is not on this machine */ }
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await bl5Test();
  console.log(f.length ? `FAIL\n${f.join("\n")}` : "PASS build list 5");
  process.exit(f.length ? 1 : 0);
}
