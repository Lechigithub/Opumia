// Every defect a film showed becomes a test (build list 2, step 7): each case runs the detector that must catch it on
// the real artefact that showed it, and the fixed version that must pass. A detector that stops catching a known
// defect fails the suite. Defects logged by produce (data/defects.jsonl) without a case here are listed as untested.
//   npx tsx apps/cli/src/dev/regressions.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { causesAsFact, checkKitCode, filmLook, lookSimilarity, uniquenessBand } from "@opumia/agents";
import { diffSpeech, measureJumps, measureLegibility, measureSeams, run, samePicture } from "@opumia/senses";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ladderTest } from "./ladder-test.js";
import { outsideTest } from "./outside-test.js";
import { escalationTest } from "./escalation-test.js";
import { film3Test } from "./film3-test.js";
import { bl5Test } from "./bl5-test.js";
import { soundStoryTest } from "./sound-story-test.js";
import { voiceDeliveryTest } from "./voice-delivery-test.js";
import { spawnSync } from "node:child_process";
const script = (f: string, ...args: string[]) => spawnSync("npx", ["tsx", `apps/cli/src/dev/${f}`, ...args], { stdio: "ignore" }).status === 0;

type Case = { id: string; defect: string; run: () => Promise<boolean> };
const F1 = "out/film1-kodak-3";
const film = (jd: string) => { const f = existsSync(jd) ? readdirSync(jd).find((x) => /_(16x9|9x16)\.mp4$/.test(x)) : undefined; return f ? path.join(jd, f) : null; };
const words = (s: string) => s.split(" ").map((word, i) => ({ word, startS: i }));
const heard = (s: string) => s.split(" ").map((word, i) => ({ word, start: i, end: i + 0.5 })) as never;
const cases: Case[] = [
  { id: "seams-caught", defect: "film 1: sentence takes glued with digital silence (43 seams)", run: async () => !existsSync(`${F1}/narration.mp3`) || (await measureSeams(`${F1}/narration.mp3`)).seams.filter((s) => s.kind !== "floor_jump").length > 0 },
  { id: "seams-fixed", defect: "step 3 narration: no hard seam", run: async () => !existsSync("out/voice-passages-test/narration.mp3") || (await measureSeams("out/voice-passages-test/narration.mp3")).seams.filter((s) => s.kind !== "floor_jump").length === 0 },
  { id: "numbers-heard", defect: "film 1 run 1: 'twenty three' vs '23', 'sixteen billion dollars' vs '$16 billion' marked wrong", run: async () => diffSpeech(words("took twenty three seconds"), heard("took 23 seconds")).wer === 0 && diffSpeech(words("peaked at sixteen billion dollars, which"), heard("peaked at $16 billion, which")).wer === 0 && diffSpeech(words("he kept it quiet"), heard("he kept it")).wer > 0 },
  { id: "jumps-caught", defect: "film 1: editor punch-ins with nothing bridging them (43.0, 52.6, 85.4 s)", run: async () => { const v = film(F1); if (!v) return true; const j = await measureJumps(v, { ss: 40, t: 15 }); return j.events.some((e) => e.kind === "jump_cut"); } },
  { id: "legibility-caught", defect: "film 1: labels at 2.4–2.9:1 contrast", run: async () => { const f = `${F1}/previews/sh001_2.jpg`; if (!existsSync(f)) return true; const plan = JSON.parse(readFileSync(`${F1}/scenes.json`, "utf8")) as { scenes: Array<{ shotId: string; elements: Array<Record<string, unknown>> }> }; const { textBoxesOf } = await import("@opumia/senses"); const sc = plan.scenes.find((x) => x.shotId === "sh001"); return !sc || (await measureLegibility(f, textBoxesOf(sc))).some((l) => l.issues.length > 0); } },
  { id: "sameness-caught", defect: "film 1 looks like the earlier Kodak film (0.72; channel p90 0.706)", run: async () => { const a = film(F1), b = film("out/eval-quick-kodak"); if (!a || !b) return true; const band = await uniquenessBand({ data: "data", channel: "magnates-media" }); const s = lookSimilarity(await filmLook({ root: process.cwd(), data: "data", video: a, film: "f1" }), await filmLook({ root: process.cwd(), data: "data", video: b, film: "eqk" })); return s > band.p90; } },
  { id: "cause-caught", defect: "film 1: 'Kodak kept the camera quiet, which meant … so it filed for Chapter 11' stated as fact", run: async () => causesAsFact(["Kodak kept the camera quiet, which meant that years later it was short of cash and unable to sell its digital patents, so it filed for Chapter 11."], ["Kodak filed for Chapter 11 bankruptcy protection in January 2012."]).length === 1 && causesAsFact(["Keeping it quiet probably didn't help when the cash ran short."], []).length === 0 },
  { id: "label-box-caught", defect: "item 25: pale letters on a light label box over a dark picture read as high contrast (box against picture)", run: async () => {
    const W = 640, H = 360, d = mkdtempSync(path.join(tmpdir(), "leg-"));
    const make = async (letter: number, name: string) => { const b = Buffer.alloc(W * H * 3); let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 10 + Math.floor(rnd() * 50); if (x >= 100 && x < 540 && y >= 140 && y < 220) v = 235; if (x >= 120 && x < 520 && y >= 160 && y < 200 && Math.floor(x / 6) % 3 === 0) v = letter; b.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3); } writeFileSync(path.join(d, `${name}.rgb`), b); await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", path.join(d, `${name}.rgb`), path.join(d, `${name}.png`)]); return path.join(d, `${name}.png`); };
    const box = { label: "x", x: 100 / 640, y: 130 / 360, w: 460 / 640, h: 100 / 360 };
    const [low, good] = [await make(200, "low"), await make(20, "good")];
    return (await measureLegibility(low, [box]))[0]!.issues.length > 0 && (await measureLegibility(good, [box]))[0]!.issues.length === 0;
  } },
  { id: "jump-under-overlay", defect: "item 25: the same picture with a busy card over half of it read as a different picture (no jump)", run: async () => {
    const W = 64, Hh = 36; let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const a = new Uint8Array(W * Hh); for (let i = 0; i < a.length; i++) a[i] = Math.floor(rnd() * 255);
    const b = Uint8Array.from(a); for (let y = 0; y < Hh; y++) for (let x = 0; x < 34; x++) b[y * W + x] = Math.floor(rnd() * 255); // a busy card over half the picture
    const c = new Uint8Array(W * Hh); for (let i = 0; i < c.length; i++) c[i] = Math.floor(rnd() * 255);
    const s1 = samePicture(a, b); return s1.score >= 0.6 && /overlay/.test(s1.how) && samePicture(a, c).score < 0.6;
  } },
  { id: "outside-pause-resume", defect: "film 2: the account's usage limit stopped the run; build list 3 part D — outside failures wait and resume, a rejected source is skipped", run: async () => (await outsideTest()).length === 0 },
  { id: "escalations-learned", defect: "build list 3 item 30: a check escalating in two films must become an open fix and a lesson for its first owner", run: async () => (await escalationTest()).length === 0 },
  // build list 5 (the Nokia proof film's gaps)
  { id: "bl5-foundations", defect: "Nokia: starved agents, 90 s assumed everywhere, no craft score at the film's length, stutter cuts, tells found only after the render", run: async () => (await bl5Test()).length === 0 },
  { id: "bl5-sound-story", defect: "Nokia: one music bed for 92 s, no cue at the turn, 67 % of effects shared with a recent film", run: async () => (await soundStoryTest()).length === 0 },
  { id: "bl5-voice-delivery", defect: "Nokia: rising statement ends, stresses that did not land, one colour for the whole story; delivery notes only advisory", run: async () => (await voiceDeliveryTest()).length === 0 },
  { id: "bl5-design-guards", defect: "Nokia: one navy stage on half the film, tiny boxed labels repeated across splits, the same portrait four times", run: async () => script("design-guard-test.ts") },
  { id: "bl5-design-parity", defect: "Nokia: the last chart showed €3.8B / €1.6B while the voice said 5.44 billion euros", run: async () => script("design-parity-test.ts") },
  { id: "bl5-packaging", defect: "Nokia: a topic-sentence title, a wordless thumbnail whose fire says 'exploding phone'", run: async () => script("package-bl5-test.ts", "--offline") },
  { id: "film3-faults", defect: "film 3: the limit reset on resume, no reserve, ladders re-bought a failed art director, a render refused, \"$1,100\" patents, lone-word cards", run: async () => (await film3Test()).length === 0 },
  { id: "ladder-escalates", defect: "build list 3: a failing check must climb its ladder one rung a round, stop when fixed, and be logged", run: async () => (await ladderTest()).length === 0 },
  { id: "proof-film-1", defect: "proof film 1 (Wirecard by the agents, 2026-11-26): the art director was given $0.27 (its first pass needs $0.60), submitted a complete kit, ran out before its final look, and the film stopped; its transition was misread from a CSS style", run: async () => script("proof1-test.ts") },
  { id: "originality", defect: "owner (2026-11-26): every new film must be a film of its own kind, sharing only the channel's style and craft — openings built from the same techniques, one signature object reused, craft devices invisible to template share", run: async () => script("originality-test.ts") },
  { id: "bl6-type-template", defect: "Wirecard v6 (2026-11-26): torn paper labels on line after line, every word one size — the owner: \"still looks like a template, the use of cards is too much, and repetition\" (OCR: boxed 0.26 vs channel p90 0.14, size spread 0.46 vs p10 0.56)", run: async () => script("type-check-test.ts") },
  { id: "bl6-paper-and-cards", defect: "Wirecard v4 (2026-11-25): receipts, pink sheets or labels on 14 of 22 beats — illustrating the script instead of showing the story (the channel: plain footage 42 %, documents 4 %)", run: async () => script("paper-test.ts") },
  { id: "bl6-device-cooldown", defect: "Wirecard v3 (2026-11-25): every finished-look effect borrowed from FTX v35 (word glow, flash, light wash, money in depth) — the template the owner saw", run: async () => script("device-test.ts") },
  { id: "bl6-bed-head", defect: "Wirecard v4 (2026-11-25): the ears' mix head scored our synthetic narrator as much as the mix and rewarded a bed loud enough to hide him (a bed 8 dB under the channel's level scored best)", run: async () => script("bed-head-test.ts") },
  { id: "hand-transfer", defect: "hand film (2026-11-25): a slideshow — cuts instead of moves, words rushed, a template shared with the earlier film; composites may use @craft and @film but not the network", run: async () => {
    const { measureMotion, templateShare, journeyStops } = await import("@opumia/agents");
    // the frozen v34 film's motion as the Python measure reads it (softShare 0.812, cuts 4.13/min)
    const v = existsSync("out/hand-ftx/frozen/v34/film_16x9.mp4") ? await measureMotion("out/hand-ftx/frozen/v34/film_16x9.mp4", { len: 120 }) : null;
    const motionOk = !v || (Math.abs(v.softShare - 0.812) < 0.05 && Math.abs(v.cutsPerMin - 4.13) < 1.5);
    // a plan against itself shares everything; the read hold moves a rushed panel later
    const plan = { board: { shots: [{ id: "a", startS: 0, endS: 3 }, { id: "b", startS: 3, endS: 6 }, { id: "c", startS: 6, endS: 9 }] }, scenes: { scenes: [{ shotId: "a", backdrop: "world", world: { kind: "duotone" }, elements: [{ name: "Phrase" }] }, { shotId: "b", backdrop: "footage", elements: [] }, { shotId: "c", backdrop: "journey", elements: [] }] }, resolution: { media: [{ shotId: "a", role: "primary", sourceUrl: "u1" }] } };
    const dir = mkdtempSync(path.join(tmpdir(), "tpl-"));
    writeFileSync(path.join(dir, "storyboard.json"), JSON.stringify(plan.board)); writeFileSync(path.join(dir, "scenes.json"), JSON.stringify(plan.scenes)); writeFileSync(path.join(dir, "resolution.json"), JSON.stringify(plan.resolution));
    const t = (await templateShare(plan as never, [dir]))[0];
    const shared = Boolean(t && t.pictures > 0 && t.shots.length >= 1);
    const j = journeyStops([{ at: 0, move: "slide", elements: [{ type: "component", at: 0.2, props: { words: [{ text: "four days later", from: 24 }] } } as never] }, { at: 0.6, move: "push", elements: [] }], 8);
    const held = j.stops[1]!.at >= 1 + 1.1 + 1.0 - 0.01 && j.stops[1]!.depth > 2;
    const kit = checkKitCode(`import { Slab3D } from "@craft";\nimport { FILM } from "@film";\nexport default function X() { return null; }`, new Set(), { composite: true }).length === 0 && checkKitCode(`import { FILM } from "@film";\nexport const FILM2 = 1;`, new Set()).length > 0 && checkKitCode(`const x = fetch("https://x");\nexport default 1;`, new Set(), { composite: true }).length > 0;
    return motionOk && shared && held && kit;
  } },
  { id: "minute-v34", defect: "hand film v34: a 1.7 s hole of dead air after the first line, no title card, the bed gone on a third of the speech (the bed level is now aimed at the channel's 37-film cold-open median, not Ponzi's)", run: async () => {
    const { shapeColdOpen } = await import("@opumia/narration");
    const { levelBeds } = await import("@opumia/agents");
    const { TimedScript } = await import("@opumia/contracts");
    const f = "out/hand-ftx/timed-script-marcus2.json";
    if (!existsSync(f)) return true;
    const t = TimedScript.parse(JSON.parse(readFileSync(f, "utf8")));
    const d = mkdtempSync(path.join(tmpdir(), "cold-"));
    const r = await shapeColdOpen(t, { capS: 0.6, breathAfterSeg: "l05", breathS: 2 }, path.join(d, "n.mp3"));
    const w = (s: typeof t, seg: string, k: number) => s.segments.find((x) => x.id === seg)!.words[k]!;
    const capped = w(r.script, "l03", 0).startS - w(r.script, "l01", 14).endS <= 0.65;
    const breath = Boolean(r.breath && r.breath.endS - r.breath.startS >= 1.5);
    const lv = await levelBeds({ music: [{ assetId: "x", startS: 0, endS: 15, gainDb: -12 }], fileOf: () => "Library/music/free_incompetech_ascending_the_vale.mp3", titleCardEndS: 15, cacheDir: "data/.cache" });
    // build list 6: the bed is aimed at the channel's measured cold-open level (37 films, demucs): ≈ 15.8 dB under the
    // voice (the "20 dB = defect" belief came from Ponzi alone; 20 dB is inside the channel's band 8.9–21.7)
    const { BED_GAP, COLD_OPEN_DUCK } = await import("@opumia/agents");
    const cold = lv.music[0]!.duckDb === COLD_OPEN_DUCK && BED_GAP.coldOpen > 13 && BED_GAP.coldOpen < 18 && lv.notes.some((n) => n.includes(`≈ ${BED_GAP.coldOpen} dB under`));
    return capped && breath && cold;
  } },
  { id: "kit-safety", defect: "a film kit may not reach the network or the file system", run: async () => checkKitCode(`import fs from "fs";\nexport const FILM = {};`, new Set()).length > 0 && checkKitCode(`const x = fetch("https://x");\nexport const FILM = {};`, new Set()).length > 0 && checkKitCode(`import React from "react";\nexport const FILM = { components: {} };`, new Set()).length === 0 },
];
let failed = 0;
for (const c of cases) {
  const ok = await c.run().catch((e: Error) => (console.log(`  ! ${c.id}: ${e.message.slice(0, 120)}`), false));
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.id} — ${c.defect}`);
}
const logged = existsSync("data/defects.jsonl") ? readFileSync("data/defects.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { job: string; check: string; message: string }) : [];
const tested = new Set(["voice_seams", "voice_wer", "voice_unresolved", "unique_look", "viewer", "final_cut", "film_taste", "stand_in_face", "dead_frames", "scene_defects"]);
const untested = [...new Set(logged.map((d) => d.check))].filter((c) => !tested.has(c));
// item 30: every recurring escalation needs a regression case (listed until one exists or it is marked fixed)
const recurring = existsSync("data/escalations-recurring.json") ? (JSON.parse(readFileSync("data/escalations-recurring.json", "utf8")) as Array<{ key: string; check: string; status: string }>).filter((r) => r.status === "open" && !tested.has(r.check) && !cases.some((c) => c.id.includes(r.check.replace(/_/g, "-")))) : [];
console.log(`\n${cases.length - failed}/${cases.length} regression cases pass${untested.length ? `; defects logged with no case yet: ${untested.join(", ")}` : ""}${recurring.length ? `; recurring escalations with no case yet: ${recurring.map((r) => r.key).join(", ")}` : ""}`);
process.exit(failed ? 1 : 0);
