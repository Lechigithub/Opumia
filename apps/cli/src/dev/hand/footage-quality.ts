// Pixel quality of each shot's footage at the moment the film uses it (trim + 0.5 s), against the channel's frames
// (data/quality-profile/<channel>.json: sharpest/typical detail and contrast floors).
//   npx tsx apps/cli/src/dev/hand/footage-quality.ts out/<job>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { measureCraft } from "@opumia/senses";
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const q = (JSON.parse(await readFile(path.join(process.cwd(), "data", "quality-profile", "magnates-media.json"), "utf8")) as { frames: Record<string, { p10: number }> }).frames;
const sb = (JSON.parse(await readFile(path.join(job, "storyboard.json"), "utf8")) as { shots: Array<{ id: string; trimInS?: number }> }).shots;
const res = (JSON.parse(await readFile(path.join(job, "resolution.json"), "utf8")) as { media: Array<{ shotId: string; role: string; kind: string; localPath: string }> }).media;
let below = 0;
for (const s of sb) {
  const m = res.find((x) => x.shotId === s.id && x.role === "primary" && x.kind === "video");
  if (!m) continue;
  const c = await measureCraft(m.localPath, (s.trimInS ?? 0) + 0.5);
  const bad = [c.sharpTop < q.sharpTop!.p10 ? "soft" : "", c.contrast < q.contrast!.p10 ? "flat" : ""].filter(Boolean);
  if (bad.length) below++;
  console.log(`${s.id.padEnd(5)} sharpest ${String(Math.round(c.sharpTop)).padStart(5)} · contrast ${String(Math.round(c.contrast)).padStart(3)}${bad.length ? `  ← ${bad.join(", ")}` : ""}`);
}
console.log(`${below} shots below the channel's frame floor (sharpest ${q.sharpTop!.p10}, contrast ${q.contrast!.p10})`);
