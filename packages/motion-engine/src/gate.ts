import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FilmDesignSystem, RenderManifest } from "@opumia/contracts";
import { renderStill, selectComposition } from "@remotion/renderer";
import { serveUrlFor, type Look } from "./render.js";

export interface GateFrame {
  frame: number;
  shotId: string;
  layout: string;
  path: string;
}

/**
 * Pick up to `n` key frames: every designed layout once (its 60 % point), every archival/parallax still, then
 * footage shots spread evenly — the moments where layout or relevance mistakes would show.
 */
export function pickGateFrames(m: RenderManifest, n = 10): Array<{ frame: number; shotId: string; layout: string }> {
  const at = (l: RenderManifest["video"][number]) => Math.round(l.startFrame + (l.endFrame - l.startFrame) * 0.6);
  const designed = m.video.filter((l) => l.sourceKind === "designed" && !["captions", "atmosphere"].includes(l.ref));
  const seenKind = new Set<string>();
  const picks: Array<{ frame: number; shotId: string; layout: string }> = [];
  for (const l of designed) if (!seenKind.has(l.ref) && picks.length < Math.ceil(n * 0.6)) (seenKind.add(l.ref), picks.push({ frame: at(l), shotId: l.shotId, layout: l.ref }));
  const footage = m.video.filter((l) => l.zIndex === 0 && l.sourceKind !== "designed" && !picks.some((p) => p.shotId === l.shotId));
  const cards = footage.filter((l) => (l.props as { mode?: string } | undefined)?.mode === "parallax_card");
  for (const l of cards) if (picks.length < n) picks.push({ frame: at(l), shotId: l.shotId, layout: "archival_card" });
  const rest = footage.filter((l) => !cards.includes(l));
  const need = n - picks.length;
  for (let k = 0; k < need && rest.length; k++) {
    const l = rest[Math.min(rest.length - 1, Math.round((k * (rest.length - 1)) / Math.max(1, need - 1)))]!;
    if (!picks.some((p) => p.shotId === l.shotId)) picks.push({ frame: at(l), shotId: l.shotId, layout: "footage" });
  }
  return picks.sort((a, b) => a.frame - b.frame);
}

/** Render the gate stills (one bundle, JPEG, half resolution). */
export async function renderGateStills(o: { manifest: RenderManifest; look: Look; design?: FilmDesignSystem; publicDir: string; outDir: string; frames: Array<{ frame: number; shotId: string; layout: string }>; log?: (s: string) => void }): Promise<GateFrame[]> {
  await mkdir(o.outDir, { recursive: true });
  const url = await serveUrlFor(o.publicDir, o.log ?? (() => {}), true);
  const inputProps = { manifest: o.manifest, look: o.look, ...(o.design ? { design: o.design } : {}) };
  const composition = await selectComposition({ serveUrl: url, id: "Documentary", inputProps });
  const out: GateFrame[] = [];
  for (const f of o.frames) {
    const p = path.join(o.outDir, `gate_${String(f.frame).padStart(6, "0")}.jpg`);
    await renderStill({ composition, serveUrl: url, output: p, inputProps, frame: Math.min(f.frame, o.manifest.durationFrames - 1), imageFormat: "jpeg", jpegQuality: 80, scale: 0.5 });
    out.push({ ...f, path: p });
  }
  return out;
}
