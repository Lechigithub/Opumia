// Build list 5, items 10–13: the channel's design band (worlds, treatment, type scale, data kinds, variety), measured
// on its real frames — data/design-profile/<channel>.json.
//   npx tsx apps/cli/src/dev/design-band.ts [channel] [--fresh]
import path from "node:path";
import { ensureDesignBand, usageLedger } from "@opumia/agents";
import { loadKeys } from "../keys.js";

const root = path.resolve(import.meta.dirname, "../../../..");
loadKeys(root);
const ch = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "magnates-media";
const b = await ensureDesignBand({ root, data: path.join(root, "data"), channelId: ch, fresh: process.argv.includes("--fresh"), log: console.log });
console.log(JSON.stringify(b, null, 1));
console.log(`$${usageLedger().reduce((a, r) => a + r.usd, 0).toFixed(3)}`);
