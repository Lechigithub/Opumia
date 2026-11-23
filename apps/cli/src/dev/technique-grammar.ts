// How the channel uses each technique: label real stretches with their words, then write the grammar per technique.
//   npx tsx apps/cli/src/dev/technique-grammar.ts [--channel magnates-media] [--fresh]
import path from "node:path";
import { ensureTechniqueGrammar, usageLedger } from "@opumia/agents";
import { loadKeys } from "../keys.js";

const root = process.cwd();
loadKeys(root);
const ci = process.argv.indexOf("--channel");
const channel = (ci > 0 ? process.argv[ci + 1] : "magnates-media") as never;
const g = await ensureTechniqueGrammar({ data: path.join(root, "data"), reference: process.env.OPUMIA_REFERENCE_DIR ?? path.join(root, "Reference"), channel, fresh: process.argv.includes("--fresh"), log: console.log });
for (const x of g.slice(0, 12)) console.log(`- ${x.name} (${x.examples} ex): ${x.when} | never: ${x.avoid}`.slice(0, 300));
console.log(`${g.length} techniques with a grammar; $${usageLedger().reduce((a, r) => a + r.usd, 0).toFixed(3)}`);
