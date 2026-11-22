/**
 * The reference's own quality bar, measured at pixel level (senses/craft.ts) on the channel's real thumbnails and
 * on frames of its real shots: data/quality-profile/<channel>.json. Built once per exemplar set; no model call.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { craftBand, measureCraft, type Craft, type CraftBand } from "@opumia/senses";

export interface QualityBand { channel: string; thumbs: CraftBand; frames: CraftBand; generatedAt: string }

export async function ensureQualityBand(o: { data: string; channel: string; log?: (s: string) => void }): Promise<QualityBand | null> {
  const file = path.join(o.data, "quality-profile", `${o.channel}.json`);
  const exDir = path.join(o.data, "exemplars", o.channel);
  const ex = await readFile(path.join(exDir, "index.json"), "utf8").then((t) => JSON.parse(t) as { thumbs: Array<{ file: string }>; shots: Array<{ frames: string[] }> }, () => null);
  if (!ex) return null;
  const thumbFiles = ex.thumbs.map((t) => path.join(exDir, t.file));
  // The second frame of each labelled shot (mid-shot), every real shot of the exemplar set.
  const frameFiles = ex.shots.filter((s) => s.frames.length).map((s) => path.join(exDir, s.frames.at(-1)!));
  const prev = await readFile(file, "utf8").then((t) => JSON.parse(t) as QualityBand, () => null);
  if (prev && prev.thumbs.count === thumbFiles.length && prev.frames.count === frameFiles.length) return prev;
  o.log?.(`  quality band: measuring ${thumbFiles.length} reference thumbnails and ${frameFiles.length} reference frames…`);
  const measure = async (fs: string[]) => {
    const out: Craft[] = [];
    for (let i = 0; i < fs.length; i += 8) out.push(...(await Promise.all(fs.slice(i, i + 8).map((f) => measureCraft(f).catch(() => null)))).filter((x): x is Craft => x !== null));
    return out;
  };
  const band: QualityBand = { channel: o.channel, thumbs: craftBand(await measure(thumbFiles)), frames: craftBand(await measure(frameFiles)), generatedAt: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(band, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  return band;
}
