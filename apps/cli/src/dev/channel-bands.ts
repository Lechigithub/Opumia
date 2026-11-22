/**
 * Every band for one channel (build list D42): story (labelled narration lines), visual (labelled shot kinds),
 * thumbnail (labelled thumbnails), pixel quality, then the unified channel profile that gathers them.
 * Exemplars must exist first (`pnpm opumia build-exemplars --channel ID`).
 *   npx tsx apps/cli/src/dev/channel-bands.ts how-money-works [moon …]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildChannelProfile, ensureQualityBand, ensureReferenceFilms, ensureStoryBand, ensureThumbBand, ensureVisualBand, usageLedger } from "@opumia/agents";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const data = process.env.OPUMIA_DATA_DIR ?? "data";
const reference = process.env.OPUMIA_REFERENCE_DIR ?? "Reference";
const spent = () => usageLedger().reduce((t, r) => t + r.usd, 0);
for (const channel of process.argv.slice(2)) {
  const t0 = Date.now(), u0 = spent();
  console.log(`\n== ${channel}`);
  const story = await ensureStoryBand({ reference, data, channelId: channel, log: console.log });
  await ensureReferenceFilms({ reference, data, channelId: channel });
  console.log(`  story band: ${story ? "ok" : "none (no narrations)"}`);
  const visual = await ensureVisualBand({ data, channelId: channel, log: console.log });
  console.log(`  visual band: ${visual ? "ok" : "none (no exemplars)"}`);
  const exDir = path.join(data, "exemplars", channel);
  const ex = JSON.parse(readFileSync(path.join(exDir, "index.json"), "utf8")) as { thumbs: Array<{ file: string; title: string; views: number | null; look: { colourfulness: number; luma: number } }> };
  const thumb = await ensureThumbBand({ data, channel, thumbs: ex.thumbs.map((t) => ({ file: path.join(exDir, t.file), title: t.title, views: t.views, colourfulness: t.look.colourfulness, luma: t.look.luma })), log: console.log });
  console.log(`  thumbnail band: ${thumb ? `${thumb.count} labelled` : "none"}`);
  const q = await ensureQualityBand({ data, channel, log: console.log });
  console.log(`  quality band: ${q ? "ok" : "none"}`);
  await buildChannelProfile({ data, channel: channel as never, log: console.log });
  console.log(`  ${channel}: ${((Date.now() - t0) / 1000).toFixed(0)} s, $${(spent() - u0).toFixed(3)}`);
}
