// The picture researcher agent on a planned job (run it on a copy: it fetches pictures into the job folder).
// Output: out/<job>/sourcing.agent.json; history data/agents/sourcing/score-history.json.
//   npx tsx apps/cli/src/dev/sourcing-score.ts out/<job> [channel]
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { blockedRefs, loadMemory, sourcingAgent, usageLedger, type CoverageRow } from "@opumia/agents";
import { FactSheet, LibraryIndex, ResolutionReport, ScriptDraft, Storyboard, TimedScript, type ChannelId } from "@opumia/contracts";
import { makeSceneTools } from "@opumia/resolver";
import { cooldownRefs, eraOfFacts } from "../asset-usage.js";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const [job, channel = "magnates-media"] = process.argv.slice(2);
if (!job) throw new Error("usage: sourcing-score.ts out/<job> [channel]");
const jd = path.resolve(job);
const data = path.resolve("data");
const rd = async (f: string) => JSON.parse(await readFile(path.join(jd, f), "utf8"));
const board = Storyboard.parse(await rd("storyboard.json"));
const resolution = ResolutionReport.parse(await rd("resolution.json"));
const timed = TimedScript.parse(await rd("timed-script.json"));
const facts = FactSheet.parse(await rd("facts.json"));
const draft = ScriptDraft.parse(await rd("script.draft.json"));
const design = await rd("design.json");
const cov = (await rd("sourcing.json")) as { rows: CoverageRow[] };
const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(data, "library-index.json"), "utf8")));
const memory = await loadMemory(data);
const cool = await cooldownRefs(data, path.basename(jd));
const era = eraOfFacts(facts);
const when = new Map(cov.rows.filter((r) => r.when).map((r) => [r.shotId, r.when!] as [string, string]));
const tools = makeSceneTools({ jobDir: jd, dataDir: data, libraryRoot: path.resolve("Library"), index, storyboard: board, resolution, words: timed.segments.flatMap((s) => s.words), era: era ? `${era.min}–${era.max}` : "unspecified", blocked: new Set([...blockedRefs(memory), ...cool.pictures]), iconColor: design.palette.text, whenOf: (id) => when.get(id) });
const t0 = Date.now();
const res = await sourcingAgent({ channel: channel as ChannelId, data, jobDir: jd, title: draft.title, rows: cov.rows, resolution, subjects: (facts.story?.characters ?? []).map((c) => c.name), findPicture: (i) => tools.findPicture(i), memoryDir: path.join(data, "agents", "sourcing"), log: console.log });
await writeFile(path.join(jd, "sourcing.agent.json"), JSON.stringify({ ...res.report, dropped: res.dropped }, null, 1) + "\n");
const row = { job: path.basename(jd), at: new Date().toISOString(), pass: res.report.pass, before: res.report.before, after: res.report.after, ops: res.report.ops.length, seconds: Math.round((Date.now() - t0) / 1000), usd: res.report.agent.usd };
const hf = path.join(data, "agents", "sourcing", "score-history.json");
await mkdir(path.dirname(hf), { recursive: true });
const hist: unknown[] = await readFile(hf, "utf8").then((t) => JSON.parse(t), () => []);
hist.push(row);
await writeFile(`${hf}.tmp`, JSON.stringify(hist, null, 1) + "\n");
await rename(`${hf}.tmp`, hf);
console.log(JSON.stringify(row), `ledger $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
