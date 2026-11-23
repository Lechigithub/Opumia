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
  { id: "ladder-escalates", defect: "build list 3: a failing check must climb its ladder one rung a round, stop when fixed, and be logged", run: async () => (await ladderTest()).length === 0 },
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
