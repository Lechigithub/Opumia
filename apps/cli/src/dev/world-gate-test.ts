// The world gates (build list 6) on real input, no API: Wirecard v4 as two preview stretches through worldChecks.
//   npx tsx apps/cli/src/dev/world-gate-test.ts <clipA.mp4> <clipB.mp4>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Storyboard } from "@opumia/contracts";
import { worldChecks } from "../flow-checks.js";
const root = process.cwd(), job = path.join(root, "out", "hand-wirecard-v4");
const board = Storyboard.parse(JSON.parse(await readFile(path.join(job, "storyboard.json"), "utf8")));
const [a, b] = process.argv.slice(2) as [string, string];
const checks = await worldChecks({ root, jobId: "hand-wirecard-v4", board, timedPath: path.join(job, "timed-script-marcus.json"), clips: [{ fromS: 0, len: 20, file: a }, { fromS: 40, len: 20, file: b }], versionOf: ["wirecard-v4", "wirecard-v3", "wirecard-v2"] });
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.value} (${c.target})${c.shots?.length ? ` shots ${c.shots.join(",")}` : ""}${c.note ? `\n   ${c.note.slice(0, 300)}` : ""}`);
if (checks.length !== 2) { console.error("expected 2 checks"); process.exit(1); }
// v4 is its own world: against every other film of ours it must not be too close
if (!checks.find((c) => c.id === "world_too_close")?.pass) { console.error("v4 should be too close to no other film"); process.exit(1); }
