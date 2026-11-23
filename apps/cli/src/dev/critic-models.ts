// G27 (Opus removed, build list 4): how the thumbnail critic (Sonnet, ROLE_MODEL.thumbnailCraft) scores the same real channel thumbnails
// (held out: never their own reference) and the same renders of ours, beside the same three real references. A good
// critic scores the real ones high and ours lower. Reported: mean score of each group, separation (AUC), cost.
//   npx tsx apps/cli/src/dev/critic-models.ts [channel] [n]
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { critiqueThumbnail, type ThumbCraft } from "@opumia/agents";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const channel = process.argv[2] ?? "magnates-media";
const n = Number(process.argv[3] ?? 6);
const craft = JSON.parse(readFileSync(`data/thumbnail-profile/${channel}-craft.json`, "utf8")) as ThumbCraft;
const items = craft.items.filter((x) => existsSync(x.file));
const real = items.filter((_, k) => k % Math.max(1, Math.floor(items.length / n)) === 0).slice(0, n);
const ours = readdirSync("out").flatMap((j) => (existsSync(path.join("out", j, "thumbs")) ? readdirSync(path.join("out", j, "thumbs")).filter((f) => /^r\d+\.jpg$/.test(f)).map((f) => path.join("out", j, "thumbs", f)) : [])).filter((_, k, a) => k % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
const refsFor = (file: string) => items.filter((x) => x.file !== file && !real.includes(x)).slice(0, 3);
const auc = (pos: number[], neg: number[]) => { let w = 0; for (const p of pos) for (const q of neg) w += p > q ? 1 : p === q ? 0.5 : 0; return w / Math.max(1, pos.length * neg.length); };
const out: Record<string, unknown> = {};
for (const model of ["sonnet"]) {
  let usd = 0;
  const score = async (file: string) => { const r = await critiqueThumbnail({ channel, file, concept: "(not given)", refs: refsFor(file) }); usd += r.usd; return (r.critique as unknown as { score: number }).score; };
  const t0 = Date.now();
  const rs = await Promise.all(real.map((x) => score(x.file)));
  const os = await Promise.all(ours.map((f) => score(f)));
  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 10) / 10;
  out[model] = { real: rs, ours: os, realMean: mean(rs), oursMean: mean(os), auc: Math.round(auc(rs, os) * 100) / 100, usd: Math.round(usd * 1000) / 1000, seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(model, JSON.stringify(out[model]));
}
writeFileSync(`data/agents/packaging/critic-models.json`, JSON.stringify({ at: new Date().toISOString(), channel, real: real.map((x) => path.basename(x.file)), ours, results: out }, null, 1) + "\n");
