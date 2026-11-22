// Pixel-level quality of a job's pictures against the reference's own bar (no model call).
//   npx tsx apps/cli/src/dev/quality-gap.ts out/<job> [channel]
// Measures: the job's thumbnail renders (thumbs/r*.jpg), its footage (first frame at 1 s of each primary media)
// and its scene previews if present. Prints the reference band and how many of ours fall below it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ensureQualityBand } from "@opumia/agents";
import { craftIssues, measureCraft, type Craft, type CraftBand } from "@opumia/senses";

const [jobArg, channel = "magnates-media"] = process.argv.slice(2);
if (!jobArg) throw new Error("usage: quality-gap.ts out/<job> [channel]");
const job = path.resolve(jobArg);
const band = await ensureQualityBand({ data: path.resolve("data"), channel, log: console.log });
if (!band) throw new Error("no exemplars for the channel");
const show = (name: string, b: CraftBand) => console.log(`REFERENCE ${name} (${b.count}): sharpest-part detail p10 ${Math.round(b.sharpTop.p10)} / median ${Math.round(b.sharpTop.median)} · typical detail p10 ${Math.round(b.sharpMedian.p10)} / median ${Math.round(b.sharpMedian.median)} · contrast p10 ${Math.round(b.contrast.p10)} / median ${Math.round(b.contrast.median)} · grain median ${b.grain.median}`);
show("thumbnails", band.thumbs);
show("frames", band.frames);
const report = async (name: string, items: Array<{ id: string; file: string; atS?: number }>, b: CraftBand) => {
  const rows: Array<{ id: string; c: Craft; issues: string[] }> = [];
  for (const it of items) {
    const c = await measureCraft(it.file, it.atS).catch(() => null);
    if (c) rows.push({ id: it.id, c, issues: craftIssues(c, b).map((x) => x.kind) });
  }
  const below = rows.filter((r) => r.issues.length);
  console.log(`\nOURS ${name}: ${below.length} of ${rows.length} below the reference bar`);
  for (const r of rows) console.log(`  ${r.id.padEnd(14)} sharpest ${String(Math.round(r.c.sharpTop)).padStart(5)} · typical ${String(Math.round(r.c.sharpMedian)).padStart(4)} · contrast ${String(Math.round(r.c.contrast)).padStart(3)} · grain ${r.c.grain}${r.issues.length ? `  ← ${r.issues.join(", ")}` : ""}`);
};
const td = path.join(job, "thumbs");
if (existsSync(td)) await report("thumbnails", readdirSync(td).filter((f) => /^r\d+\.jpg$/.test(f)).sort((a, b) => Number(a.slice(1, -4)) - Number(b.slice(1, -4))).map((f) => ({ id: f, file: path.join(td, f) })), band.thumbs);
const res = JSON.parse(readFileSync(path.join(job, "resolution.json"), "utf8")) as { media: Array<{ shotId: string; role: string; kind: string; localPath: string; durationS?: number }> };
await report("footage", res.media.filter((m) => m.role === "primary" && existsSync(m.localPath)).map((m) => ({ id: m.shotId, file: m.localPath, ...(m.kind === "video" ? { atS: Math.min(1, (m.durationS ?? 2) / 2) } : {}) })), band.frames);
