// Every step-1 measuring tool on one finished film (build list 2): voice seams, picture jumps against the channel's
// band, text legibility, the video taste judge against real channel stretches, and pixel uniqueness against our other
// rendered films and the channel's own band. Writes out/<job>/baseline.json.
//   npx tsx apps/cli/src/dev/film-baseline.ts out/<job> [--calibrate]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { calibrateClipJudge, filmLook, judgeClips, lookSimilarity, uniquenessBand, usageLedger } from "@opumia/agents";
import type { ChannelId } from "@opumia/contracts";
import { measureJumps, measureLegibility, measureSeams, textBoxesOf } from "@opumia/senses";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const jd = path.resolve(process.argv[2]!);
const root = process.cwd(), data = path.resolve("data"), reference = path.resolve("Reference");
const job = JSON.parse(readFileSync(path.join(jd, "job.json"), "utf8")) as { channel: ChannelId };
const video = path.join(jd, readdirSync(jd).find((f) => /_(16x9|9x16)\.mp4$/.test(f))!);
const ts = JSON.parse(readFileSync(path.join(jd, "timed-script.json"), "utf8")) as { durationS: number; segments: Array<{ words: Array<{ word: string; startS: number }> }> };
const words = ts.segments.flatMap((s) => s.words);
const work = path.join(jd, "baseline");
if (process.argv.includes("--calibrate")) console.log(await calibrateClipJudge({ data, reference, channel: job.channel, n: 9, workDir: path.join(data, ".cache", "clip-cal"), log: console.log }));

const seams = await measureSeams(path.join(jd, "narration.mp3"));
console.log(`seams: ${seams.seams.length} in the narration (${seams.perMin}/min)`);
const jumps = await measureJumps(video);
const band = existsSync(`data/detector-band/magnatesmedia.json`) ? (JSON.parse(readFileSync(`data/detector-band/magnatesmedia.json`, "utf8")) as { band: Record<string, { p10: number; median: number; p90: number }> }).band : null;
console.log(`jumps: ${jumps.jumpCutsPerMin}/min unbridged, ${jumps.bridgedPerMin}/min bridged, ${((jumps.cuts.length / jumps.seconds) * 60).toFixed(1)} cuts/min${band ? ` — channel unbridged ${band.unbridgedPerMin!.median} (p90 ${band.unbridgedPerMin!.p90}), bridged ${band.bridgedPerMin!.p10}–${band.bridgedPerMin!.p90}, cuts ${band.cutsPerMin!.p10}–${band.cutsPerMin!.p90}` : ""}`);
const plan = JSON.parse(readFileSync(path.join(jd, "scenes.json"), "utf8")) as { scenes: Array<{ shotId: string; elements: Array<Record<string, unknown>> }> };
const legible: Array<{ shot: string; label: string; issues: string[] }> = [];
for (const sc of plan.scenes) {
  const f = path.join(jd, "previews", `${sc.shotId}_2.jpg`);
  if (existsSync(f) && textBoxesOf(sc).length) for (const l of await measureLegibility(f, textBoxesOf(sc))) legible.push({ shot: sc.shotId, label: l.label, issues: l.issues });
}
console.log(`legibility: ${legible.filter((l) => l.issues.length).length} of ${legible.length} text elements fail`);
// clips of ~8 s across the film
const clips: Array<{ fromS: number; toS: number; said: string }> = [];
for (let t = 0; t + 6 < ts.durationS; t += 8) clips.push({ fromS: t, toS: Math.min(ts.durationS, t + 8), said: words.filter((w) => w.startS >= t && w.startS < t + 8).map((w) => w.word).join(" ") });
const judged = await judgeClips({ data, reference, root, channel: job.channel, video, clips, workDir: work, log: console.log });
console.log(`video taste: realness ${judged.realness} (2/3 = indistinguishable), picked out in ${judged.clips.filter((c) => c.picked).length} of ${judged.clips.length}; trained taste ${judged.taste}; calibration ${JSON.stringify(judged.calibration)}`);
const ub = await uniquenessBand({ data, channel: job.channel });
const me = await filmLook({ root, data, video, film: path.basename(jd) });
const others = readdirSync("out").filter((j) => j !== path.basename(jd) && existsSync(path.join("out", j, "job.json"))).flatMap((j) => { const f = readdirSync(path.join("out", j)).find((x) => /_(16x9|9x16)\.mp4$/.test(x)); return f ? [{ job: j, file: path.join("out", j, f) }] : []; });
const sims: Array<{ job: string; similarity: number }> = [];
for (const o of others) sims.push({ job: o.job, similarity: lookSimilarity(me, await filmLook({ root, data, video: o.file, film: o.job })) });
sims.sort((a, b) => b.similarity - a.similarity);
console.log(`uniqueness: channel band ${ub.p10}–${ub.p90} (max ${ub.max}); ours: ${sims.map((s) => `${s.job} ${s.similarity}${s.similarity > ub.p90 ? " TOO CLOSE" : ""}`).join(", ")}`);
const out = { job: path.basename(jd), at: new Date().toISOString(), seams: { count: seams.seams.length, perMin: seams.perMin, byKind: seams.seams.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {} as Record<string, number>) }, jumps: { unbridgedPerMin: jumps.jumpCutsPerMin, bridgedPerMin: jumps.bridgedPerMin, cutsPerMin: Math.round((jumps.cuts.length / jumps.seconds) * 600) / 10, events: jumps.events, transitions: jumps.transitions, band }, legibility: legible, videoTaste: judged, uniqueness: { band: ub, closest: sims }, usd: Math.round(usageLedger().reduce((t, r) => t + r.usd, 0) * 1000) / 1000 };
writeFileSync(path.join(jd, "baseline.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`baseline → ${path.join(jd, "baseline.json")} ($${out.usd})`);
