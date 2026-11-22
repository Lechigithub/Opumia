// Label the channel's reference thumbnails and print the band (what they are made of, how many need generation).
//   npx tsx apps/cli/src/dev/thumb-band.ts [channel]
import { readFileSync } from "node:fs";
import path from "node:path";
import { ensureThumbBand, usageLedger } from "@opumia/agents";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const channel = process.argv[2] ?? "magnates-media";
const data = process.env.OPUMIA_DATA_DIR ?? "data";
const exDir = path.join(data, "exemplars", channel);
const ex = JSON.parse(readFileSync(path.join(exDir, "index.json"), "utf8")) as { thumbs: Array<{ file: string; title: string; views: number | null; look: { colourfulness: number; luma: number } }> };
const band = await ensureThumbBand({ data, channel, thumbs: ex.thumbs.map((t) => ({ file: path.join(exDir, t.file), title: t.title, views: t.views, colourfulness: t.look.colourfulness, luma: t.look.luma })), log: console.log });
if (!band) throw new Error("no band");
const { items, ...rest } = band;
console.log(JSON.stringify(rest, null, 1));
for (const x of items.filter((i) => i.label.makeable !== "real_pictures")) console.log(`  ${x.label.makeable}: ${x.title} — ${x.label.why}`);
console.log(`$${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
