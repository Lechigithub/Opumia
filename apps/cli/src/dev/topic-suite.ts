// The reliability target (build list 3, item 33), measured on the fixed topic suite (eval/sets/suite.json), produced
// untouched from a frozen platform tag:
//  - at least 9 films in 10 finish on the FIRST run with no human: exit 0, a final film, inside the film's budget and the
//    time target, the release gate passed (preflight passed and QA's verdict "pass");
//  - the rest finish after an automatic pause and resume (exit 3 → `opumia resume <job>`, run here on its own);
//  - the same topic twice must look different (the first two films share a topic: their look similarity must be inside
//    the channel's band of real film pairs).
// Costs about $6–9 per film. Run only on a frozen platform tag.
//   npx tsx apps/cli/src/dev/topic-suite.ts [--max-usd 9] [--time-min 90] [--only N] [--report-only]
//   --report-only measures the suite's existing out/<job>/ folders without producing anything.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { filmLook, lookSimilarity, uniquenessBand } from "@opumia/agents";

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const reportOnly = process.argv.includes("--report-only");
const suite = JSON.parse(readFileSync("eval/sets/suite.json", "utf8")) as { channel: string; aspect: string; durationS: number; films: Array<{ job: string; topic: string }> };
const films = suite.films.slice(0, Number(arg("--only") ?? suite.films.length));
const tag = (() => { try { return execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } })();
if (!tag && !reportOnly) throw new Error("run the suite from a frozen platform tag (git tag …), or use --report-only");
const maxUsd = Number(arg("--max-usd") ?? (suite.durationS <= 90 ? 9 : suite.durationS <= 240 ? 16 : 35));
const timeMin = Number(arg("--time-min") ?? (suite.durationS <= 90 ? 90 : 240));
const read = <T>(f: string): T | null => (existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null);
const jsonl = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
const video = (j: string) => { const d = path.join("out", j); const f = existsSync(d) ? readdirSync(d).find((x) => /_(16x9|9x16)\.mp4$/.test(x)) : undefined; return f ? path.join(d, f) : null; };

interface FilmResult { job: string; exitCodes: number[]; firstRun: boolean; finished: boolean; resumed: number; pausedS: number; usd: number; withinBudget: boolean; minutes: number; withinTime: boolean; preflight: boolean | null; verdict: string | null; gatePassed: boolean; ladderAttempts: number; unresolved: number; meetsTarget: boolean }
const results: FilmResult[] = [];
for (const f of films) {
  const jd = path.join("out", f.job);
  const exitCodes: number[] = [];
  const t0 = Date.now();
  if (!reportOnly) {
    const go = (args: string[]) => spawnSync("pnpm", ["-s", "opumia", ...args], { stdio: "inherit", env: { ...process.env, OPUMIA_MAX_USD: String(maxUsd) } }).status ?? 1;
    exitCodes.push(go(["produce", "--topic", f.topic, "--channel", suite.channel, "--aspect", suite.aspect, "--duration", String(suite.durationS), "--job", f.job]));
    // exit 3 = paused by a failure outside the platform: resumed automatically (part D), counted apart from first runs
    for (let k = 0; k < 5 && exitCodes.at(-1) === 3; k++) exitCodes.push(go(["resume", f.job]));
  }
  const pauses = jsonl<{ waitedS: number }>(path.join(jd, "pauses.jsonl"));
  const pausedS = pauses.reduce((t, p) => t + p.waitedS, 0);
  const usage = read<{ runs: Array<{ usd: number }> }>(path.join(jd, "usage.json"));
  const usd = Math.round((usage?.runs ?? []).reduce((t, r) => t + r.usd, 0) * 100) / 100;
  const timing = read<{ runs: Array<{ seconds: number }> }>(path.join(jd, "timing.json"));
  const minutes = Math.round(((reportOnly ? (timing?.runs ?? []).reduce((t, r) => t + r.seconds, 0) : (Date.now() - t0) / 1000) - pausedS) / 6) / 10;
  const pre = read<{ pass: boolean }>(path.join(jd, "preflight.json"));
  const qa = read<{ verdict: string }>(path.join(jd, "qa.json"));
  const ladders = jsonl<{ kind: string }>(path.join(jd, "ladders.jsonl"));
  const finished = Boolean(video(f.job)) && (reportOnly || exitCodes.at(-1) === 0);
  const firstRun = reportOnly ? finished && pauses.length === 0 : exitCodes[0] === 0 && finished;
  const r: FilmResult = { job: f.job, exitCodes, firstRun, finished, resumed: Math.max(0, exitCodes.length - 1), pausedS: Math.round(pausedS), usd, withinBudget: usd <= maxUsd, minutes, withinTime: minutes <= timeMin, preflight: pre?.pass ?? null, verdict: qa?.verdict ?? null, gatePassed: Boolean(pre?.pass) && qa?.verdict === "pass", ladderAttempts: ladders.filter((x) => x.kind === "attempt").length, unresolved: ladders.filter((x) => x.kind === "unresolved").length, meetsTarget: false };
  r.meetsTarget = r.firstRun && r.withinBudget && r.withinTime && r.gatePassed;
  results.push(r);
  if (!reportOnly && r.finished && existsSync(path.join(jd, "timed-script.json"))) try { execFileSync("npx", ["tsx", "apps/cli/src/dev/film-baseline.ts", jd], { stdio: "inherit" }); } catch { /* measured where possible */ }
}
const a = video(films[0]?.job ?? ""), b = video(films[1]?.job ?? "");
let sameTopic: { similarity: number; channelP90: number; pass: boolean } | null = null;
if (a && b) {
  const band = await uniquenessBand({ data: "data", channel: suite.channel as never });
  const s = lookSimilarity(await filmLook({ root: process.cwd(), data: "data", video: a, film: "a" }), await filmLook({ root: process.cwd(), data: "data", video: b, film: "b" }));
  sameTopic = { similarity: Math.round(s * 1000) / 1000, channelP90: band.p90, pass: s <= band.p90 };
}
const n = results.length;
const met = results.filter((r) => r.meetsTarget).length;
const afterPause = results.filter((r) => !r.firstRun && r.finished && r.resumed > 0).length;
const summary = {
  films: n,
  firstRunTarget: `${met}/${n} finished first time, no human, in budget ($${maxUsd}) and time (${timeMin} min), gate passed — target ≥ 0.9${n < 10 ? " (fewer than 10 films: not yet a measure of the target)" : ""}`,
  rate: n ? Math.round((met / n) * 100) / 100 : 0,
  passes: n >= 10 && met / n >= 0.9 && results.every((r) => r.meetsTarget || (r.finished && r.resumed > 0)) && (sameTopic?.pass ?? false),
  finishedAfterPause: afterPause,
  needingHuman: results.filter((r) => !r.finished).map((r) => r.job),
  sameTopicLooksDifferent: sameTopic,
};
const out = { tag, at: new Date().toISOString(), reportOnly, maxUsd, timeMin, summary, results };
const file = path.join("out", `reliability-${tag ?? "untagged"}.json`);
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(summary, null, 1));
console.log(`→ ${file}`);
