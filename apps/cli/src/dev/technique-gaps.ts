// The craft inventory's open tool gaps: every technique the channel uses that the platform can make only partly or not
// at all, with what is missing (re-mapped against the current capability catalogue).
//   npx tsx apps/cli/src/dev/technique-gaps.ts [--channel magnates-media]
import path from "node:path";
import { loadInventory, mapTechniquesToTools } from "@opumia/agents";
import { loadKeys } from "../keys.js";

const root = process.cwd();
loadKeys(root);
const data = path.join(root, "data");
const ci = process.argv.indexOf("--channel");
const channel = ci > 0 ? process.argv[ci + 1]! : "magnates-media";
const inv = await loadInventory(data, channel);
if (!inv) throw new Error("no inventory — run dev/techniques.ts first");
const map = await mapTechniquesToTools({ data, channel, taxonomy: inv.taxonomy });
const rows = inv.band.techniques.map((b) => ({ b, t: inv.taxonomy.find((x) => x.id === b.id)!, m: map.find((x) => x.id === b.id) })).filter((x) => x.t && x.m && x.m.status !== "available");
for (const { b, t, m } of rows) console.log(`${b.perMin.toFixed(2).padStart(5)}/min ${m!.status.padEnd(8)} ${t.id} — ${t.name}: ${m!.gap}`);
console.log(`\n${rows.length} not fully available (${rows.filter((r) => r.m!.status === "missing").length} missing)`);
