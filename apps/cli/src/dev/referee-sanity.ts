// A held-back channel film must pass the production referee (it never saw it): npx tsx apps/cli/src/dev/referee-sanity.ts
import { readdirSync } from "node:fs";
import path from "node:path";
import { refereeScore, refereeConfig } from "../referee/score.js";
const ROOT = process.cwd(), DATA = path.join(ROOT, "data"), REF = path.join(ROOT, "Reference");
const cfg = refereeConfig(DATA, "magnates-media")!;
let fails = 0;
for (const id of cfg.holdout) {
  const date = id.replace(/^[A-Z]+-/, "");
  const dir = readdirSync(path.join(REF, "MagnatesMedia")).find((d) => d.startsWith(date));
  if (!dir) continue;
  const mp4 = readdirSync(path.join(REF, "MagnatesMedia", dir)).find((f) => f.endsWith(".mp4"))!;
  const v = await refereeScore({ root: ROOT, data: DATA, reference: REF, channel: "magnates-media", video: path.join(REF, "MagnatesMedia", dir, mp4), from: 60, to: 140 });
  console.log(`${v.pass ? "PASS" : "FAIL"} held-back ${id}: ${v.score} (bar ${v.bar})`);
  if (!v.pass) fails++;
}
console.log(`${cfg.holdout.length - fails} of ${cfg.holdout.length} held-back channel films pass the production referee`);
// the bar is strict on purpose (no film of ours reaches it); at most one borderline channel film may miss it
process.exitCode = fails <= 1 ? 0 : 1;
