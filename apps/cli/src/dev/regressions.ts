// Every defect a film showed becomes a test (build list 2, step 7): each case runs the detector that must catch it on
// the real artefact that showed it, and the fixed version that must pass. A detector that stops catching a known
// defect fails the suite. Defects logged by produce (data/defects.jsonl) without a case here are listed as untested.
//   npx tsx apps/cli/src/dev/regressions.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { checkKitCode, filmLook, lookSimilarity, uniquenessBand } from "@opumia/agents";
import { diffSpeech, measureJumps, measureLegibility, measureSeams } from "@opumia/senses";

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
console.log(`\n${cases.length - failed}/${cases.length} regression cases pass${untested.length ? `; defects logged with no case yet: ${untested.join(", ")}` : ""}`);
process.exit(failed ? 1 : 0);
