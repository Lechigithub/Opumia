// Build list 5, item 4: every agent's craft score on a job, at the film's own length.
//   npx tsx apps/cli/src/dev/craft-score.ts out/<job> [--judge]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ResolutionReport, ScenePlan, ScriptDraft, Storyboard, TimedScript } from "@opumia/contracts";
import { usageLedger } from "@opumia/agents";
import { craftReport } from "../craft-report.js";
import { loadKeys } from "../keys.js";

const root = process.cwd();
loadKeys(root);
const job = path.resolve(process.argv[2] ?? "out/bl4c-nokia");
const j = async (f: string) => JSON.parse(await readFile(path.join(job, f), "utf8"));
const meta = await j("job.json");
const r = await craftReport({ root, data: path.join(root, "data"), reference: process.env.OPUMIA_REFERENCE_DIR ?? path.join(root, "Reference"), jobDir: job, channel: meta.channel, draft: ScriptDraft.parse(await j("script.draft.json")), timed: TimedScript.parse(await j("timed-script.json")), board: Storyboard.parse(await j("storyboard.json")), scenes: ScenePlan.parse(await j("scenes.json")), resolution: ResolutionReport.parse(await j("resolution.json")), judge: process.argv.includes("--judge"), log: console.log });
for (const s of r.scores) console.log(`${s.craft.padEnd(10)} ${String(s.score).padStart(3)}  floor ${r.floors[s.craft] ?? "-"}  ${s.outside.slice(0, 4).map((x) => `${x.key} ${x.ours} (${x.band.p10}–${x.band.p90})`).join("; ")}${s.judge ? `  judge ${s.judge.realness} ${s.judge.tells.slice(0, 2).join(" | ")}` : ""}`);
console.log(`$${usageLedger().reduce((a, x) => a + x.usd, 0).toFixed(3)}`);
