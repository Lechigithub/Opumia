// The editor agent on a planned job, on copies (the job's files are not changed): before/after on the editor's
// measures and the whole-film structure, written to out/<job>/edit.agent.json and data/agents/editor/score-history.json.
//   npx tsx apps/cli/src/dev/editor-score.ts out/<job> [channel]
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { editFilmAgent, loadChannelProfile, ourShotsFrom, structureOf, usageLedger } from "@opumia/agents";
import { ResolutionReport, ScenePlan, Storyboard, StyleProfile, TimedScript, type ChannelId } from "@opumia/contracts";
import { buildManifest, listen, listeningText, lookFromProfile, watchClip } from "@opumia/motion-engine";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const [job, channel = "magnates-media"] = process.argv.slice(2);
if (!job) throw new Error("usage: editor-score.ts out/<job> [channel]");
const jd = path.resolve(job);
const rd = async (f: string) => JSON.parse(await readFile(path.join(jd, f), "utf8"));
const board = Storyboard.parse(await rd("storyboard.json"));
const scenes = ScenePlan.parse(await rd("scenes.json"));
const resolution = ResolutionReport.parse(await rd("resolution.json"));
const timed = TimedScript.parse(await rd("timed-script.json"));
const design = await rd("design.json");
const prof = StyleProfile.parse(JSON.parse(await readFile("data/style-profiles/magnates-media.json", "utf8")));
const data = path.resolve("data");
const t0 = Date.now();
const watch = async (st: { storyboard: Storyboard; scenes: ScenePlan; resolution: ResolutionReport }, fromS: number, toS: number) => {
  const m = await buildManifest({ storyboard: st.storyboard, script: timed, resolution: st.resolution, libraryRoot: path.resolve("Library"), outputPath: path.join(jd, "_edit.mp4"), narrationPath: timed.voice.audioPath, scenes: new Map<string, unknown>(st.scenes.scenes.map((x) => [x.shotId, x])) });
  const c = await watchClip({ manifest: m, look: lookFromProfile(prof.look, design.palette?.primarySoft), design, publicDir: path.join(jd, "public"), jobDir: jd, fromS, toS });
  const l = await listen({ manifest: m, jobDir: jd, fromS, toS, cutsS: m.video.map((v) => v.startFrame / m.fps) });
  return { strip: c.strip, text: `${c.fromS.toFixed(1)}–${c.toS.toFixed(1)} s, frames left to right, top to bottom: ${c.frames.join(", ")}; measured motion ${JSON.stringify(c.motion)}\n${listeningText(l)}` };
};
const res = await editFilmAgent({ channel: channel as ChannelId, data, storyboard: board, scenes, resolution, script: timed, watch, memoryDir: path.join(data, "agents", "editor"), log: console.log });
const cp = (await loadChannelProfile(data, channel as ChannelId))!;
const whole = (b: Storyboard, s: ScenePlan, r: ResolutionReport) => {
  const o = ourShotsFrom({ storyboard: b, scenes: s.scenes, media: r.media, words: timed.segments.flatMap((x) => x.words) } as never);
  return structureOf(cp, o.shots, o.hits, o.durS).structure;
};
const row = { job: path.basename(jd), at: new Date().toISOString(), pass: res.report.pass, editorBefore: res.report.before.structure, editorAfter: res.report.after.structure, filmBefore: whole(board, scenes, resolution), filmAfter: whole(res.storyboard, res.scenes, res.resolution), ops: res.report.ops.length, seconds: Math.round((Date.now() - t0) / 1000), usd: res.report.agent.usd, remaining: res.report.after.gaps.map((g) => `${g.segment}:${g.key}`) };
await writeFile(path.join(jd, "edit.agent.json"), JSON.stringify({ ...res.report, storyboard: res.storyboard, scenes: res.scenes }, null, 1) + "\n");
const hf = path.join(data, "agents", "editor", "score-history.json");
await mkdir(path.dirname(hf), { recursive: true });
const hist: unknown[] = await readFile(hf, "utf8").then((t) => JSON.parse(t), () => []);
hist.push(row);
await writeFile(`${hf}.tmp`, JSON.stringify(hist, null, 1) + "\n");
await rename(`${hf}.tmp`, hf);
console.log(JSON.stringify(row), `ledger $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
