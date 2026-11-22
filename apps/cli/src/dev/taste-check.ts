/**
 * Does the trained taste rank the films the owner rejected below the rest? Scores frames of every job's rendered
 * film (or its previews) and prints them sorted, known-bad marked.
 *   npx tsx apps/cli/src/dev/taste-check.ts [channel]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import { scoreTaste } from "@opumia/agents";

const root = process.cwd();
const data = path.join(root, "data");
const channel = (process.argv[2] ?? "magnates-media") as ChannelId;
const bad = new Set((JSON.parse(readFileSync("eval/known-bad.json", "utf8")) as { jobs: string[] }).jobs.map((j) => path.basename(j)));
const rows: Array<{ job: string; what: string; median: number; n: number }> = [];
for (const job of readdirSync("out")) {
  const jd = path.join("out", job);
  if (!statSync(jd).isDirectory()) continue;
  const mp4 = readdirSync(jd).find((f) => /\.mp4$/.test(f) && !/clip|watch/.test(f));
  const pdir = ["previews_final", "previews_agent", "previews"].map((d) => path.join(jd, d)).find((d) => existsSync(d));
  const items = mp4
    ? Array.from({ length: 15 }, (_, i) => ({ file: path.join(jd, mp4), t: 2 + i * 4 }))
    : pdir ? readdirSync(pdir).filter((f) => /\.(jpg|png)$/.test(f) && !/sheet/.test(f)).sort().map((f) => ({ file: path.join(pdir, f) })) : [];
  if (items.length < 4) continue;
  const sc = (await scoreTaste({ root, data, channel, kind: "shot", items })).flatMap((x) => (x ? [x.score] : [])).sort((a, b) => a - b);
  if (sc.length) rows.push({ job, what: mp4 ? "film" : "previews", median: sc[Math.floor(sc.length / 2)]!, n: sc.length });
}
for (const r of rows.sort((a, b) => a.median - b.median)) console.log(`${r.median.toFixed(2).padStart(5)}  ${bad.has(r.job) ? "KNOWN-BAD " : "          "}${r.job} (${r.what}, ${r.n} frames)`);
