// The hand thumbnail on the platform's thumbnail taste scorer (the same head as the packaging agent), with the
// channel's own thumbnails scored the same way for the band.
//   npx tsx apps/cli/src/dev/hand/thumb-score.ts <thumbnail.jpg>
import path from "node:path";
import { scoreTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const r = await scoreTaste({ root, data, channel: "magnates-media", kind: "thumb", items: [{ file: path.resolve(process.argv[2]!) }] });
console.log(JSON.stringify(r[0]));
