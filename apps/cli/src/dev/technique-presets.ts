// The technique presets (each technique's recipe in the scene format), built once from the grammar.
//   npx tsx apps/cli/src/dev/technique-presets.ts [--fresh]
import path from "node:path";
import { ensureTechniquePresets, usageLedger } from "@opumia/agents";
import { loadKeys } from "../keys.js";

const root = process.cwd();
loadKeys(root);
const p = await ensureTechniquePresets({ data: path.join(root, "data"), channel: "magnates-media", fresh: process.argv.includes("--fresh") });
for (const [k, v] of Object.entries(p).slice(0, 10)) console.log(k, JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, x]) => x && x !== "none"))));
console.log(`${Object.keys(p).length} presets; $${usageLedger().reduce((a, r) => a + r.usd, 0).toFixed(3)}`);
