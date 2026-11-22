// Compositor before/after on a planned job: every scene with a cut-out over footage, rendered without and with the
// automatic compositing, in one sheet (left: before, right: after). Job files are not changed.
//   npx tsx apps/cli/src/dev/composite-test.ts out/<job>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildStylePack } from "@opumia/agents";
import { FilmDesignSystem, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ChannelId } from "@opumia/contracts";
import { buildManifest, lookFromProfile, renderShotPreviews } from "@opumia/motion-engine";
import { compositeScenes } from "@opumia/resolver";
import { contactSheet } from "@opumia/senses";

const jd = path.resolve(process.argv[2]!);
const rd = async (f: string) => JSON.parse(await readFile(path.join(jd, f), "utf8"));
const channel = ((await rd("job.json")) as { channel: string }).channel as ChannelId;
const board = Storyboard.parse(await rd("storyboard.json"));
const plan = ScenePlan.parse(await rd("scenes.json"));
const resolution = ResolutionReport.parse(await rd("resolution.json"));
const timed = TimedScript.parse(await rd("timed-script.json"));
const design = FilmDesignSystem.parse(await rd("design.json"));
const pack = await buildStylePack(channel, { reference: path.resolve("Reference"), data: path.resolve("data") });
const look = lookFromProfile(pack.profile.look, design.palette.primarySoft);
const cp = await compositeScenes({ plan, resolution, jobDir: jd, design, log: console.log });
const ids = plan.scenes.filter((s) => s.elements.some((e) => e.type === "cutout")).map((s) => s.shotId);
if (!ids.length) { console.log("no cut-out over footage in this plan"); process.exit(0); }
const shots = async (p: ScenePlan, dir: string) => {
  const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: path.resolve("Library"), outputPath: path.join(jd, "_comp.mp4"), narrationPath: timed.voice.audioPath, scenes: new Map<string, unknown>(p.scenes.map((x) => [x.shotId, x])) });
  const pv = await renderShotPreviews({ manifest: m, look, design, publicDir: path.join(jd, "public"), outDir: path.join(jd, dir), shotIds: ids });
  return new Map(pv.map((x) => [x.shotId, x.frames[1]!.path]));
};
const a = await shots(plan, "previews_comp_before");
const b = await shots(cp.plan, "previews_comp_after");
const files = ids.flatMap((id) => [a.get(id)!, b.get(id)!]);
console.log(await contactSheet(files, path.join(jd, "composite_before_after.jpg"), { cols: 2, cellW: 480 }));
for (const s of cp.plan.scenes.filter((x) => ids.includes(x.shotId))) console.log(s.shotId, JSON.stringify(s.elements.filter((e) => e.type === "cutout").map((e) => ({ m: (e as { matchColor?: string }).matchColor, l: (e as { lightAngle?: number }).lightAngle, c: (e as { contactShadow?: number }).contactShadow }))));
