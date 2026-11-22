// Real passages of the channel nearest to a line being cut, as edit decision lists.
//   npx tsx apps/cli/src/dev/passages.ts "narration text" [segment] [channel]
import path from "node:path";
import { edl, findPassages, type Segment } from "@opumia/agents";
import type { ChannelId } from "@opumia/contracts";
const [said, segment, channel = "magnates-media"] = process.argv.slice(2);
if (!said) throw new Error('usage: passages.ts "text" [cold_open|chapter_open|middle|ending] [channel]');
for (const p of await findPassages({ data: path.resolve("data"), channel: channel as ChannelId, said, ...(segment ? { segment: segment as Segment } : {}) })) console.log(edl(p.shots, p.title) + "\n");
