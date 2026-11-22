// The scene designer's own score: run the designer on jobs that already have a storyboard and resolved pictures,
// and record whether its film was accepted and where it sits against the channel's real shots. Previews only.
//   npx tsx apps/cli/src/dev/scene-score.ts out/<job> [out/<job> …]
// History: data/agents/scenes/score-history.json. Output: out/<job>/scenes.agent.json, previews_agent/, scenes_agent.jpg
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FactSheet, FilmDesignSystem, ResolutionReport, Storyboard, TimedScript, type ScenePlan } from "@opumia/contracts";
import { buildStylePack, designScenesAgent, ensureVisualBand, loadTaste, scoreTaste, usageLedger, type ReferenceShot, type SceneReport, type FilmKitMeta } from "@opumia/agents";
import { buildManifest, lookFromProfile, renderShotPreviews } from "@opumia/motion-engine";
import { makeSceneTools } from "@opumia/resolver";
import { LibraryIndex } from "@opumia/contracts";
import { contactSheet } from "@opumia/senses";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const roots = { reference: process.env.OPUMIA_REFERENCE_DIR ?? "Reference", data: process.env.OPUMIA_DATA_DIR ?? "data", library: process.env.OPUMIA_LIBRARY_DIR ?? "Library" };
const memoryDir = path.join(roots.data, "agents", "scenes");
const read = <T>(f: string) => JSON.parse(readFileSync(f, "utf8")) as T;
const results: Array<{ job: string; pass: boolean; measurements: number; seconds: number; usd: number; remaining: string[]; kinds: number; clean: number; text: number; pictures: number; top: string }> = [];
for (const arg of process.argv.slice(2)) {
  const jobDir = path.resolve(arg);
  const job = read<{ channel: string }>(path.join(jobDir, "job.json"));
  const board = Storyboard.parse(read(path.join(jobDir, "storyboard.json")));
  const timed = TimedScript.parse(read(path.join(jobDir, "timed-script.json")));
  const resolution = ResolutionReport.parse(read(path.join(jobDir, "resolution.json")));
  const design = FilmDesignSystem.parse(read(path.join(jobDir, "design.json")));
  const facts = FactSheet.parse(read(path.join(jobDir, "facts.json")));
  const pack = await buildStylePack(job.channel as never, roots);
  const band = await ensureVisualBand({ data: roots.data, channelId: job.channel, log: console.log });
  if (!band) throw new Error(`no visual band for ${job.channel} (run build-exemplars)`);
  const exDir = path.join(roots.data, "exemplars", job.channel);
  const idx = read<{ shots: Array<{ kind: string; layout: string; motion: string; line: string; frames: string[] }> }>(path.join(exDir, "index.json"));
  const referenceShots: ReferenceShot[] = idx.shots.filter((s) => s.frames.length).map((s) => ({ kind: s.kind, layout: s.layout, motion: s.motion, line: s.line, frame: path.join(exDir, s.frames.at(-1)!) }));
  const look = lookFromProfile(pack.profile.look, design.palette.primarySoft);
  const pub = path.join(jobDir, "public");
  const outDir = path.join(jobDir, "previews_agent");
  const render = async (plan: ScenePlan, shotIds: string[]) => {
    const manifest = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: roots.library, outputPath: path.join(jobDir, "_agent.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: board.aspect === "9:16" || pack.captions.burnLongForm, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
    const prev = await renderShotPreviews({ manifest, look, design, publicDir: pub, outDir, shotIds });
    return prev.map((p) => ({ shotId: p.shotId, sheet: p.sheet, mid: p.frames[1]!.path }));
  };
  const manifestOf = (plan: ScenePlan) => buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: roots.library, outputPath: path.join(jobDir, "_agent.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: board.aspect === "9:16" || pack.captions.burnLongForm, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
  const play = async (plan: ScenePlan, shotId: string) => (await renderShotPreviews({ manifest: await manifestOf(plan), look, design, publicDir: pub, outDir: path.join(outDir, "play"), shotIds: [shotId], moments: [0.04, 0.2, 0.35, 0.5, 0.65, 0.8, 0.96] }))[0]?.sheet ?? null;
  const index = LibraryIndex.parse(read(path.join(roots.data, "library-index.json")));
  const whenByShot = new Map<string, string>(existsSync(path.join(jobDir, "sourcing.json")) ? read<{ rows: Array<{ shotId: string; when?: string }> }>(path.join(jobDir, "sourcing.json")).rows.filter((r) => r.when).map((r) => [r.shotId, r.when!] as [string, string]) : []);
  const pictures = makeSceneTools({ jobDir, dataDir: roots.data, libraryRoot: roots.library, index, storyboard: board, resolution, words: timed.segments.flatMap((sg) => sg.words), era: "unspecified", iconColor: design.palette.text, whenOf: (id) => whenByShot.get(id) });
  let report: SceneReport | null = null;
  const before = usageLedger().reduce((t, r) => t + r.usd, 0);
  const t0 = Date.now();
  console.log(`\n### ${path.basename(jobDir)}`);
  const tm = await loadTaste(roots.data, job.channel as never, "shot");
  const taste = tm ? { score: async (files: string[]) => (await scoreTaste({ root: process.cwd(), data: roots.data, channel: job.channel as never, kind: "shot", items: files.map((file) => ({ file })) })).map((x) => x?.score ?? null), realP10: tm.calibration.real.p10, realMedian: tm.calibration.real.median } : undefined;
  const kit = read<FilmKitMeta>(path.join(jobDir, "design", "film", "meta.json"));
  const plan = await designScenesAgent({ storyboard: board, script: timed, resolution, design, channel: job.channel, visualBand: band, referenceShots, render, play, pictures, kit, ...(taste ? { taste } : {}), memoryDir, people: (facts.story?.characters ?? []).map((c) => c.name), onReport: (r) => (report = r), log: console.log });
  writeFileSync(path.join(jobDir, "scenes.agent.json"), JSON.stringify(plan, null, 2));
  writeFileSync(path.join(jobDir, "resolution.agent.json"), JSON.stringify(resolution, null, 2));
  const mids = plan.scenes.map((s) => path.join(outDir, `${s.shotId}_1.jpg`)).filter((f) => existsSync(f));
  if (mids.length) console.log(await contactSheet(mids, path.join(jobDir, "scenes_agent.jpg"), { cols: 6, cellW: 320 }));
  const rp = report as SceneReport | null;
  const p = rp?.rounds.at(-1)?.profile;
  results.push({ job: path.basename(jobDir), pass: Boolean(rp?.pass), measurements: rp?.rounds.length ?? 0, seconds: Math.round((Date.now() - t0) / 1000), usd: Math.round((usageLedger().reduce((t, r) => t + r.usd, 0) - before) * 1000) / 1000, remaining: rp?.remaining.map((x) => x.kind) ?? [], kinds: p?.distinctKinds ?? 0, clean: p?.share.plain_footage ?? 0, text: p?.textShare ?? 0, pictures: p?.pictureShare ?? 0, top: p ? `${p.topKind} ${Math.round(p.topShare * 100)}%` : "" });
  if (rp && !rp.pass) for (const x of rp.remaining) console.log(`  still: [${x.kind}] ${x.detail.slice(0, 220)}`);
}
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(); } catch { return "?"; } })();
mkdirSync(memoryDir, { recursive: true });
const hf = path.join(memoryDir, "score-history.json");
const hist = existsSync(hf) ? (JSON.parse(readFileSync(hf, "utf8")) as unknown[]) : [];
hist.push({ at: new Date().toISOString(), commit, profileVersion: (() => { try { return (JSON.parse(readFileSync(path.join(process.env.OPUMIA_DATA_DIR ?? "data", "channel-profile", "magnates-media.json"), "utf8")) as { version: string }).version; } catch { return null; } })(), results });
writeFileSync(hf, JSON.stringify(hist, null, 2) + "\n");
console.log("\nSCENE DESIGNER SCORE");
for (const r of results) console.log(`  ${r.job.padEnd(20)} ${r.pass ? "accepted" : `NOT accepted (${r.remaining.join(", ")})`} | ${r.measurements} measurement(s), ${r.seconds} s, $${r.usd} | ${r.kinds} kinds, clean footage ${Math.round(r.clean * 100)}%, text on ${Math.round(r.text * 100)}%, pictures ${Math.round(r.pictures * 100)}%, top ${r.top}`);
