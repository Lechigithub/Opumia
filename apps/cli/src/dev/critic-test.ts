// Calibration check for the scene critic (no render, a few Haiku calls):
//   npx tsx apps/cli/src/dev/critic-test.ts out/<job-with-previews> [channel]
// 1. Control: real reference shots (data/exemplars) presented as if they were our previews. The critic must pass
//    nearly all of them — a critic that rejects the real channel is judging taste, not defects.
// 2. The job's own previews: how many scenes it would send back.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { critiqueScenes, usageLedger } from "@opumia/agents";
import { contactSheet } from "@opumia/senses";
import { loadKeys } from "../keys.js";

const root = process.cwd();
loadKeys(root);
const jobDir = path.resolve(process.argv[2] ?? "");
const channel = process.argv[3] ?? "magnates-media";
const exDir = path.join(root, "data", "exemplars", channel);
const idx = JSON.parse(await readFile(path.join(exDir, "index.json"), "utf8")) as { shots: Array<{ id: string; kind: string; designed: boolean; layout: string; line: string; frames: string[] }> };
const designed = idx.shots.filter((s) => s.designed && s.frames.length >= 2);
// The standard shown to the critic and the shots under test never overlap.
const reference = designed.slice(0, 4).map((s) => path.join(exDir, s.frames.at(-1)!));
const step = Math.max(1, Math.floor((designed.length - 4) / 24));
const control = designed.slice(4).filter((_, i) => i % step === 0).slice(0, 24);
const scratch = path.join(root, "data", ".cache", "critic-test");
const controlPreviews = await Promise.all(control.map(async (s) => ({ shotId: s.id, sheet: await contactSheet(s.frames.map((f) => path.join(exDir, f)), path.join(scratch, `${s.id}.jpg`), { cols: s.frames.length, cellW: 480 }), line: s.line, idea: s.layout })));
const t0 = Date.now();
const c = await critiqueScenes({ channel, previews: controlPreviews, reference, maxShare: 1 });
console.log(`control (real ${channel} shots): ${c.size} of ${controlPreviews.length} flagged in ${((Date.now() - t0) / 1000).toFixed(0)} s — target ≤ 15 %`);
for (const [k, v] of c) console.log(`   ${k}: ${v.join(" | ").slice(0, 170)}`);

if (process.argv[2]) {
  const plan = JSON.parse(await readFile(path.join(jobDir, "scenes.json"), "utf8")) as { scenes: Array<{ shotId: string; idea?: string }> };
  const board = JSON.parse(await readFile(path.join(jobDir, "storyboard.json"), "utf8")) as { shots: Array<{ id: string; startS: number; endS: number }> };
  const timed = JSON.parse(await readFile(path.join(jobDir, "timed-script.json"), "utf8")) as { segments: Array<{ words: Array<{ word: string; startS: number }> }> };
  const words = timed.segments.flatMap((s) => s.words);
  const ours = plan.scenes.map((s) => {
    const sh = board.shots.find((x) => x.id === s.shotId)!;
    return { shotId: s.shotId, sheet: path.join(jobDir, "previews", `${s.shotId}_sheet.jpg`), line: words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" "), idea: s.idea ?? "" };
  });
  const t1 = Date.now();
  const all = await critiqueScenes({ channel, previews: ours, reference, maxShare: 1 });
  const capped = await critiqueScenes({ channel, previews: ours, reference });
  console.log(`\nour previews (${path.basename(jobDir)}): ${all.size} of ${ours.length} have a visible defect; ${capped.size} would be sent back (cap 40 %) — ${((Date.now() - t1) / 1000).toFixed(0)} s for both passes`);
  for (const [k, v] of all) console.log(`   ${k}: ${v.join(" | ").slice(0, 170)}`);
}
console.log(`\nspend: $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(4)}`);
