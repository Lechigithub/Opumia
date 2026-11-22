// Frozen production runs on the fixed topic suite (build list 2, step 7): every film produced untouched from the
// current tag, then measured with the step-1 tools (dev/film-baseline.ts), and the same-topic pair compared for
// uniqueness. Costs about $5 per film — run only on a frozen platform tag.
//   npx tsx apps/cli/src/dev/topic-suite.ts [--max-usd 6]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { filmLook, lookSimilarity, uniquenessBand } from "@opumia/agents";

const suite = JSON.parse(readFileSync("eval/sets/suite.json", "utf8")) as { channel: string; aspect: string; durationS: number; films: Array<{ job: string; topic: string }> };
const tag = execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"]).toString().trim();
const maxUsd = process.argv.includes("--max-usd") ? process.argv[process.argv.indexOf("--max-usd") + 1]! : "6";
const results: Array<{ job: string; ok: boolean; verdict?: string }> = [];
for (const f of suite.films) {
  const jd = path.join("out", f.job);
  let ok = true;
  try {
    execFileSync("pnpm", ["-s", "opumia", "produce", "--topic", f.topic, "--channel", suite.channel, "--aspect", suite.aspect, "--duration", String(suite.durationS), "--job", f.job], { stdio: "inherit", env: { ...process.env, OPUMIA_MAX_USD: maxUsd } });
  } catch { ok = false; }
  const qa = existsSync(path.join(jd, "qa.json")) ? (JSON.parse(readFileSync(path.join(jd, "qa.json"), "utf8")) as { verdict: string }).verdict : undefined;
  if (ok && existsSync(path.join(jd, "timed-script.json"))) try { execFileSync("npx", ["tsx", "apps/cli/src/dev/film-baseline.ts", jd], { stdio: "inherit" }); } catch { /* measured where possible */ }
  results.push({ job: f.job, ok, ...(qa ? { verdict: qa } : {}) });
}
const video = (j: string) => { const d = path.join("out", j); const f = existsSync(d) ? readdirSync(d).find((x) => /_(16x9|9x16)\.mp4$/.test(x)) : undefined; return f ? path.join(d, f) : null; };
const a = video(suite.films[0]!.job), b = video(suite.films[1]!.job);
let sameTopic: { similarity: number; channelP90: number; pass: boolean } | null = null;
if (a && b) {
  const band = await uniquenessBand({ data: "data", channel: suite.channel as never });
  const s = lookSimilarity(await filmLook({ root: process.cwd(), data: "data", video: a, film: "a" }), await filmLook({ root: process.cwd(), data: "data", video: b, film: "b" }));
  sameTopic = { similarity: s, channelP90: band.p90, pass: s <= band.p90 };
}
const out = { tag, at: new Date().toISOString(), results, sameTopic };
writeFileSync(path.join("out", `suite-${tag}.json`), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));
