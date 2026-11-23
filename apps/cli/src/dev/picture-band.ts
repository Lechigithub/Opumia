// Build list 5, items 16–17: the channel's picture band (idle stock share, story-specific share, meaning), labelled on
// its real exemplar shots with the same function the gate runs on ours.
//   npx tsx apps/cli/src/dev/picture-band.ts [channel] [--fresh]
import path from "node:path";
import { usageLedger } from "../../../../packages/agents/src/llm.js";
import { ensurePictureBand } from "../../../../packages/agents/src/picture-measure.js";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const channel = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "magnates-media";
const b = await ensurePictureBand({ data: path.join(process.cwd(), "data"), channelId: channel, fresh: process.argv.includes("--fresh"), log: console.log });
console.log(JSON.stringify(b, null, 1));
console.log(`$${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(4)}`);
