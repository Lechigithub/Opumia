// Render the G24 scene vocabulary (counter, steps, icon grid, newspaper, screen) on a planned job's shots, using
// slots that exist there, into one sheet. Job files are not changed.
//   npx tsx apps/cli/src/dev/vocab-test.ts out/<job>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildStylePack } from "@opumia/agents";
import { FilmDesignSystem, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ChannelId, type SceneSpec } from "@opumia/contracts";
import { buildManifest, lookFromProfile, renderShotPreviews } from "@opumia/motion-engine";
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
const cam = { fromScale: 1.02, toScale: 1.08, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 };
const B = { rot: 0, z: 0.6, at: 0.1, enter: "fade" as const };
const tests: Record<string, SceneSpec> = {
  sh005: { shotId: "sh005", idea: "counter", backdrop: "surface", dim: 0.4, camera: cam, elements: [{ type: "counter", x: 0.12, y: 0.2, w: 0.76, ...B, count: 13, highlight: 13, label: "13 STAFF" } as never] },
  sh007: { shotId: "sh007", idea: "steps", backdrop: "paper", dim: 0.4, camera: cam, elements: [{ type: "steps", x: 0.06, y: 0.3, w: 0.88, ...B, direction: "row", items: [{ label: "Film", slot: 0 }, { label: "Prints", slot: 5 }, { label: "Digital", slot: 7 }] } as never] },
  sh009: { shotId: "sh009", idea: "icongrid", backdrop: "world", dim: 0.4, camera: cam, elements: [{ type: "icongrid", x: 0.15, y: 0.22, w: 0.7, ...B, items: [{ slot: 0, label: "Sasson" }, { slot: 7, label: "Prototype" }] } as never] },
  sh011: { shotId: "sh011", idea: "newspaper", backdrop: "surface", dim: 0.4, camera: cam, elements: [{ type: "newspaper", x: 0.3, y: 0.04, w: 0.4, ...B, rot: -3, headline: "Kodak will go bankrupt", date: "2012", slot: 0 } as never] },
  sh017: { shotId: "sh017", idea: "screen", backdrop: "surface", dim: 0.4, camera: cam, elements: [{ type: "screen", x: 0.18, y: 0.12, w: 0.64, ...B, slot: 7, device: "browser", scroll: 0.3 } as never] },
};
const scenes = plan.scenes.map((s) => tests[s.shotId] ?? s);
for (const id of Object.keys(tests)) if (!scenes.some((s) => s.shotId === id)) scenes.push(tests[id]!);
const p2 = ScenePlan.parse({ ...plan, scenes });
const m = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: path.resolve("Library"), outputPath: path.join(jd, "_vocab.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: false, scenes: new Map<string, unknown>(p2.scenes.map((x) => [x.shotId, x])) });
const pv = await renderShotPreviews({ manifest: m, look, design, publicDir: path.join(jd, "public"), outDir: path.join(jd, "previews_vocab"), shotIds: Object.keys(tests) });
console.log(await contactSheet(pv.map((x) => x.frames[2]!.path), path.join(jd, "vocab.jpg"), { cols: 3, cellW: 480 }));
