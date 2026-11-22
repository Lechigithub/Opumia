// The blank-slate art director on a planned job (run on a copy): writes design/film/ (the film's own kit).
//   npx tsx apps/cli/src/dev/film-kit-test.ts out/<job>
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildStylePack, usageLedger } from "@opumia/agents";
import { FilmDesignSystem, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ChannelId } from "@opumia/contracts";
import { lookFromProfile } from "@opumia/motion-engine";
import { runFilmDesigner } from "../film-kit.js";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const jd = path.resolve(process.argv[2]!);
const rd = async (f: string) => JSON.parse(await readFile(path.join(jd, f), "utf8"));
const channel = ((await rd("job.json")) as { channel: string }).channel as ChannelId;
const board = Storyboard.parse(await rd("storyboard.json"));
const timed = TimedScript.parse(await rd("timed-script.json"));
const design = FilmDesignSystem.parse(await rd("design.json"));
const resolution = ResolutionReport.parse(await rd("resolution.json"));
const scenes = existsSync(path.join(jd, "scenes.json")) ? ScenePlan.parse(await rd("scenes.json")) : null;
const pack = await buildStylePack(channel, { reference: path.resolve("Reference"), data: path.resolve("data") });
const treatment = await readFile(path.join(jd, "treatment.md"), "utf8").catch(() => "");
const brief = `${timed.title}\n${treatment}\nNARRATION:\n${timed.segments.map((s) => s.text).join("\n")}`;
const t0 = Date.now();
const r = await runFilmDesigner({ root: process.cwd(), data: path.resolve("data"), library: path.resolve("Library"), jobDir: jd, job: path.basename(jd), channel, title: timed.title, brief, board, scenes, resolution, timed, design, look: lookFromProfile(pack.profile.look, design.palette.primarySoft), log: console.log });
await writeFile(path.join(jd, "film-kit.report.json"), JSON.stringify({ ...r, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1) + "\n");
console.log(JSON.stringify(r), `ledger $${usageLedger().reduce((t, x) => t + x.usd, 0).toFixed(3)}`);
