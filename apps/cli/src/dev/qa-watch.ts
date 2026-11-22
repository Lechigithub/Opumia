// The viewer QA agent on a rendered job: watches the finished mp4 start to end. Writes out/<job>/qa.viewer.json;
// history data/agents/qa/score-history.json (known-bad films from eval/known-bad.json should not pass).
//   npx tsx apps/cli/src/dev/qa-watch.ts out/<job>
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { qaAgent, usageLedger } from "@opumia/agents";
import { Storyboard, TimedScript } from "@opumia/contracts";
import { watchFile } from "@opumia/motion-engine";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const [job] = process.argv.slice(2);
if (!job) throw new Error("usage: qa-watch.ts out/<job>");
const jd = path.resolve(job);
const data = path.resolve("data");
const rd = async (f: string) => JSON.parse(await readFile(path.join(jd, f), "utf8"));
const channel = ((await rd("job.json")) as { channel: string }).channel;
const board = Storyboard.parse(await rd("storyboard.json"));
const timed = TimedScript.parse(await rd("timed-script.json"));
const mp4 = readdirSync(jd).find((f) => /_(16x9|9x16)\.mp4$/.test(f));
if (!mp4) throw new Error("no finished film in the job");
const qa = (await rd("qa.json").catch(() => ({ checks: [] }))) as { checks: Array<{ id: string; passed: boolean; severity: string; message: string }> };
const t0 = Date.now();
const v = await qaAgent({ channel, title: timed.title, durationS: timed.durationS, qaText: qa.checks.map((c) => `${c.passed ? "✓" : "✗"} [${c.severity}] ${c.id}: ${c.message}`).join("\n") || "(no measured QA)", shots: board.shots.map((x) => ({ id: x.id, startS: x.startS, endS: x.endS })), words: timed.segments.flatMap((s) => s.words), watch: (a, b) => watchFile({ video: path.join(jd, mp4), fromS: a, toS: b, outDir: path.join(jd, "watch") }), memoryDir: path.join(data, "agents", "qa"), log: console.log });
await writeFile(path.join(jd, "qa.viewer.json"), JSON.stringify(v, null, 2) + "\n");
const knownBad = (JSON.parse(readFileSync("eval/known-bad.json", "utf8")) as { jobs: string[] }).jobs.some((j) => path.basename(j) === path.basename(jd));
const row = { job: path.basename(jd), at: new Date().toISOString(), knownBad, verdict: v.verdict, issues: v.issues.length, worst: Math.max(0, ...v.issues.map((x) => x.severity)), watched: v.watchedShare, seconds: Math.round((Date.now() - t0) / 1000), usd: v.agent.usd };
const hf = path.join(data, "agents", "qa", "score-history.json");
await mkdir(path.dirname(hf), { recursive: true });
const hist: unknown[] = await readFile(hf, "utf8").then((t) => JSON.parse(t), () => []);
hist.push(row);
await writeFile(`${hf}.tmp`, JSON.stringify(hist, null, 1) + "\n");
await rename(`${hf}.tmp`, hf);
console.log(JSON.stringify(row), `ledger $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
for (const i of v.issues) console.log(`  ${i.atS.toFixed(1)} s [${i.severity}] ${i.owner}: ${i.what}`);
