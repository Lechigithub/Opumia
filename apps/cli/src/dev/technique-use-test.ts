// Craft inventory: does a film use each technique the way the channel does? (the gate's check, on a job's previews)
//   npx tsx apps/cli/src/dev/technique-use-test.ts out/<job>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { usageLedger } from "@opumia/agents";
import { ScenePlan, Storyboard, TimedScript } from "@opumia/contracts";
import { techniqueUseChecks } from "../bl5-checks.js";
import { loadKeys } from "../keys.js";

const root = process.cwd();
loadKeys(root);
const job = path.resolve(process.argv[2] ?? "out/bl5c-quibi");
const j = async (f: string) => JSON.parse(await readFile(path.join(job, f), "utf8"));
const meta = await j("job.json");
const r = await techniqueUseChecks({ data: path.join(root, "data"), channel: meta.channel, prevDir: path.join(job, "previews"), board: Storyboard.parse(await j("storyboard.json")), scenes: ScenePlan.parse(await j("scenes.json")), timed: TimedScript.parse(await j("timed-script.json")) });
for (const c of r) console.log(`✗ [${c.id}] ${c.value} — ${c.note}`);
if (!r.length) console.log("every technique used the channel's way");
console.log(`$${usageLedger().reduce((a, x) => a + x.usd, 0).toFixed(3)}`);
