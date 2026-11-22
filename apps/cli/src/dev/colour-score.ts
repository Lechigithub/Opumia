// The colourist on a planned job (previews must exist in out/<job>/previews). Writes out/<job>/colour.agent.json,
// design.colour.json and scenes.colour.json (the job's own files are not changed); history in data/agents/colourist.
//   npx tsx apps/cli/src/dev/colour-score.ts out/<job>
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildStylePack, colouristAgent, usageLedger } from "@opumia/agents";
import { FilmDesignSystem, RenderManifest, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ChannelId } from "@opumia/contracts";
import { buildManifest, lookFromProfile, renderShotPreviews } from "@opumia/motion-engine";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const [job] = process.argv.slice(2);
if (!job) throw new Error("usage: colour-score.ts out/<job>");
const jd = path.resolve(job);
const data = path.resolve("data");
const library = path.resolve("Library");
const rd = async (f: string) => JSON.parse(await readFile(path.join(jd, f), "utf8"));
const channel = ((await rd("job.json")) as { channel: string }).channel as ChannelId;
const board = Storyboard.parse(await rd("storyboard.json"));
const scenes = ScenePlan.parse(await rd("scenes.json"));
const resolution = ResolutionReport.parse(await rd("resolution.json"));
const timed = TimedScript.parse(await rd("timed-script.json"));
const design = FilmDesignSystem.parse(await rd("design.json"));
const manifest = RenderManifest.parse(await rd("manifest.json"));
const pack = await buildStylePack(channel, { reference: path.resolve("Reference"), data });
const prevDir = path.join(jd, "previews_colour");
const frames = new Map(scenes.scenes.map((x) => [x.shotId, path.join(jd, "previews", `${x.shotId}_1.jpg`)] as [string, string]).filter(([, f]) => existsSync(f)));
const actStarts = [0, ...manifest.video.filter((l) => l.ref === "chapter").map((l) => l.startFrame / manifest.fps)];
const look = lookFromProfile(pack.profile.look, design.palette.primarySoft);
const t0 = Date.now();
const res = await colouristAgent({
  channel, title: timed.title, data, design, scenes, frames,
  actOf: (id) => Math.max(0, actStarts.filter((t) => t <= (board.shots.find((x) => x.id === id)?.startS ?? 0) + 0.01).length - 1),
  lineOf: (id) => { const sh = board.shots.find((x) => x.id === id); return sh ? timed.segments.flatMap((sg) => sg.words).filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : ""; },
  render: async (d, plan, ids) => {
    const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: library, outputPath: path.join(jd, "_colour.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: board.aspect === "9:16" || pack.captions.burnLongForm, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
    const prev = await renderShotPreviews({ manifest: m, look, design: d, publicDir: path.join(jd, "public"), outDir: prevDir, shotIds: ids });
    return new Map(prev.map((pv) => [pv.shotId, pv.frames[1]!.path] as [string, string]));
  },
  memoryDir: path.join(data, "agents", "colourist"), log: console.log,
});
await writeFile(path.join(jd, "colour.agent.json"), JSON.stringify(res.report, null, 1) + "\n");
await writeFile(path.join(jd, "design.colour.json"), JSON.stringify(res.design, null, 1) + "\n");
await writeFile(path.join(jd, "scenes.colour.json"), JSON.stringify(res.scenes, null, 1) + "\n");
const row = { job: path.basename(jd), at: new Date().toISOString(), pass: res.report.pass, before: res.report.before, after: res.report.after, ops: res.report.ops.length, seconds: Math.round((Date.now() - t0) / 1000), usd: res.report.agent.usd };
const hf = path.join(data, "agents", "colourist", "score-history.json");
await mkdir(path.dirname(hf), { recursive: true });
const hist: unknown[] = await readFile(hf, "utf8").then((t) => JSON.parse(t), () => []);
hist.push(row);
await writeFile(`${hf}.tmp`, JSON.stringify(hist, null, 1) + "\n");
await rename(`${hf}.tmp`, hf);
console.log(JSON.stringify(row), `ledger $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
