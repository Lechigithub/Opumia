// Build list 5, item 18: the watermark check on the Nokia proof film's footage. The Lumia clip (sh017, "MTR" bug in
// the bottom-left corner) must be marked; the other clips (stock, press without a bug) must pass.
//   npx tsx apps/cli/src/dev/picture-watermark-test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// direct imports: the test does not depend on the rest of the agents package
import { usageLedger } from "../../../../packages/agents/src/llm.js";
import { watermarkCheck } from "../../../../packages/agents/src/picture-measure.js";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const dir = path.join(process.cwd(), "out/bl4c-nokia/public/media");
const work = mkdtempSync(path.join(tmpdir(), "wm-"));
const cases: Array<[string, boolean]> = [["sh017_6750b5e9.mp4", true], ["sh014_568941cf.mp4", false], ["sh009_33da9cfd.mp4", false], ["sh003_b62fe26a.mp4", false], ["sh004_60e11f74.mp4", false], ["sh005_6ad2e3e6.mp4", false], ["sh021_755d97d2.mp4", false], ["sh024_3d723ed6.mp4", false], ["sh008_64c1a4ef.mp4", false], ["sh011_83862b9c.mp4", false]];
const fails: string[] = [];
for (const [f, want] of cases) {
  const v = await watermarkCheck(path.join(dir, f), { workDir: work });
  console.log(`${v.marked === want ? "ok  " : "FAIL"} ${f}: ${v.marked ? "MARKED" : "clean"} — ${v.note} (pixel hints: ${v.pixels?.suspects.join(",") || "-"})`);
  if (v.marked !== want) fails.push(f);
}
console.log(`$${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(4)}`);
console.log(fails.length ? `FAIL ${fails.join(", ")}` : "PASS watermark check");
process.exit(fails.length ? 1 : 0);
