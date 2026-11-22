import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FilmDesignSystem, RenderManifest } from "@opumia/contracts";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { contactSheet } from "@opumia/senses";
import { GL, serveUrlFor, type Look } from "./render.js";

/**
 * Shot preview: the agents' eyes on their own work. Renders any shot at several moments (default: just after
 * the entrance, mid-shot, and settled) at half resolution, plus one contact sheet per shot so motion and layout
 * can be judged at a glance — seconds per shot, before any film render.
 */
export interface ShotPreview {
  shotId: string;
  layout: string;
  frames: Array<{ frame: number; path: string }>;
  sheet: string;
}

export async function renderShotPreviews(o: { manifest: RenderManifest; look: Look; design?: FilmDesignSystem; publicDir: string; outDir: string; shotIds?: string[]; moments?: number[]; scale?: number; fresh?: boolean; log?: (s: string) => void }): Promise<ShotPreview[]> {
  const log = o.log ?? (() => {});
  await mkdir(o.outDir, { recursive: true });
  const url = await serveUrlFor(o.publicDir, log, o.fresh ?? true);
  const inputProps = { manifest: o.manifest, look: o.look, ...(o.design ? { design: o.design } : {}) };
  const composition = await selectComposition({ serveUrl: url, id: "Documentary", inputProps });
  const moments = o.moments ?? [0.18, 0.55, 0.92];
  // One range per shot: the base layer's span (or the designed layer's when there is no base).
  const ranges = new Map<string, { start: number; end: number; layout: string }>();
  for (const l of o.manifest.video) {
    if (l.shotId === "all") continue;
    const r = ranges.get(l.shotId);
    const layout = l.sourceKind === "designed" && l.ref !== "stage" ? l.ref : (r?.layout ?? "footage");
    ranges.set(l.shotId, { start: Math.min(r?.start ?? l.startFrame, l.startFrame), end: Math.max(r?.end ?? l.endFrame, l.endFrame), layout });
  }
  const ids = o.shotIds ?? [...ranges.keys()];
  // One shared browser, four stills at a time (a fresh browser per still cost more than the still itself).
  const jobs: Array<{ id: string; k: number; frame: number; p: string }> = [];
  for (const id of ids) {
    const r = ranges.get(id);
    if (!r) continue;
    for (const [k, m] of moments.entries()) jobs.push({ id, k, frame: Math.min(o.manifest.durationFrames - 1, Math.round(r.start + (r.end - r.start - 1) * m)), p: path.join(o.outDir, `${id}_${k}.jpg`) });
  }
  const browser = await openBrowser("chrome", { chromiumOptions: GL });
  try {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, jobs.length) }, async () => {
        for (;;) {
          const j = jobs[next++];
          if (!j) return;
          await renderStill({ puppeteerInstance: browser, chromiumOptions: GL, composition, serveUrl: url, output: j.p, inputProps, frame: j.frame, imageFormat: "jpeg", jpegQuality: 82, scale: o.scale ?? 0.5 });
        }
      }),
    );
  } finally {
    await browser.close({ silent: true }).catch(() => {});
  }
  const out: ShotPreview[] = [];
  for (const id of ids) {
    const r = ranges.get(id);
    if (!r) continue;
    const frames = jobs.filter((j) => j.id === id).sort((a, b) => a.k - b.k).map((j) => ({ frame: j.frame, path: j.p }));
    const sheet = await contactSheet(frames.map((f) => f.path), path.join(o.outDir, `${id}_sheet.jpg`), { cols: frames.length, cellW: 480 });
    out.push({ shotId: id, layout: r.layout, frames, sheet });
  }
  log(`  preview: ${out.length} shot(s) × ${moments.length} moments → ${o.outDir}`);
  return out;
}
