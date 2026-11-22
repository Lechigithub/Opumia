// Build the unified channel profile from the full reference index (no model call).
//   npx tsx apps/cli/src/dev/channel-profile.ts [channel]
import path from "node:path";
import { buildChannelProfile } from "@opumia/agents";
import type { ChannelId } from "@opumia/contracts";

const channel = (process.argv[2] ?? "magnates-media") as ChannelId;
const p = await buildChannelProfile({ data: path.resolve("data"), channel, log: console.log });
for (const d of p.directives) console.log(`- ${d}`);
console.log("views ρ:", JSON.stringify(p.views.rankCorrelation));
