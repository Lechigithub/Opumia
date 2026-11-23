// Build list 5: the gate's new checks on an existing job (design and picture measures on its previews, stutter cuts,
// rhythm at the film's length, figures against the voice). Labelling is Haiku (a few cents); nothing is rendered.
//   npx tsx apps/cli/src/dev/bl5-gate-test.ts out/<job>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CRAFT_MEASURES, RHYTHM_KEYS, craftBand, ensureDesignBand, ensurePictureBand, scoreAgainst, stretchOfPlan, stutterCuts, usageLedger } from "@opumia/agents";
import { ResolutionReport, ScenePlan, Storyboard, TimedScript } from "@opumia/contracts";
import { designChecks, pictureChecks } from "../bl5-checks.js";
import { loadKeys } from "../keys.js";

const root = process.cwd();
const data = path.join(root, "data");
loadKeys(root);
const job = path.resolve(process.argv[2] ?? "out/bl4c-nokia");
const j = async (f: string) => JSON.parse(await readFile(path.join(job, f), "utf8"));
const meta = await j("job.json");
const board = Storyboard.parse(await j("storyboard.json"));
const scenes = ScenePlan.parse(await j("scenes.json"));
const resolution = ResolutionReport.parse(await j("resolution.json"));
const timed = TimedScript.parse(await j("timed-script.json"));
const facts = await j("facts.json");
const prevDir = path.join(job, "previews");
const design = await designChecks({ root, data, prevDir, board, scenes, resolution, timed, band: await ensureDesignBand({ root, data, channelId: meta.channel }) });
const pics = await pictureChecks({ prevDir, board, scenes, resolution, timed, subjects: [meta.topic, ...(facts.story?.characters ?? []).map((c: { name: string }) => c.name)].join(", "), band: await ensurePictureBand({ data, channelId: meta.channel }) });
const st = stutterCuts(board.shots as never, resolution.media as never);
const eb = await craftBand({ data, channel: meta.channel, craft: "edit", lengthS: board.durationS });
const rh = eb ? scoreAgainst("edit", await CRAFT_MEASURES.edit!(stretchOfPlan({ storyboard: { shots: board.shots as never, durationS: board.durationS }, scenes: scenes.scenes as never, media: resolution.media as never, words: timed.segments.flatMap((s) => s.words) as never }) as never), { ...eb, bands: Object.fromEntries(Object.entries(eb.bands).filter(([k]) => RHYTHM_KEYS.includes(k))) }) : null;
for (const c of [...design, ...pics]) console.log(`✗ [${c.id}] ${c.label}: ${c.note ?? ""} — ${(c.shots ?? []).slice(0, 6).join(", ")}`.slice(0, 260));
console.log(`stutter cuts: ${st.map((x) => x.why).join("; ") || "none"}`);
console.log(`rhythm at ${eb?.lengthS} s: ${rh?.score}/100 ${rh?.outside.map((x) => `${x.key} ${x.ours} (${x.band.p10}–${x.band.p90})`).join("; ")}`);
console.log(`$${usageLedger().reduce((a, x) => a + x.usd, 0).toFixed(3)}`);
