// Offline render test of the thumbnail finishing layer (fonts, lettering, 3D card, light match, grade, overlays).
//   npx tsx apps/cli/src/dev/thumb-smoke.ts <thumb-public dir> <photo> <cutout> <logo> <overlay> <out.jpg>
// Pictures are paths relative to the thumb-public dir (e.g. pic/p0_x.jpg). No paid API is called.
import path from "node:path";
import { renderThumbnailScene } from "@opumia/motion-engine";

const [dir, photo, cutout, logo, overlay, out] = process.argv.slice(2);
if (!dir || !photo || !cutout || !logo || !overlay || !out) throw new Error("usage: thumb-smoke.ts <dir> <photo> <cutout> <logo> <overlay> <out.jpg>");
const spec = {
  shotId: "thumbnail",
  idea: "smoke test",
  backdrop: "world",
  dim: 0.3,
  camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 },
  elements: [
    { type: "card3d", slot: 2, x: 0.04, y: 0.12, w: 0.4, rot: 0, z: 0.5, at: 0, enter: "fade", tilt: -14, spin: 12 },
    { type: "cutout", slot: 1, x: 0.46, y: 0.08, w: 0.56, rot: 0, z: 0.5, at: 0, enter: "fade", shadow: true, glowColor: "#ff3b1f", glowSize: 1.2, matchColor: "#5a2a1a", matchStrength: 0.5, brightness: 1.1 },
    { type: "text", text: "TOO LATE", role: "display", x: 0.04, y: 0.7, w: 0.5, rot: 0, z: 0.5, at: 0, enter: "fade", size: 0.16, align: "left", color: "text", font: "heavy_sans", letter: "label_box", fill: "#ffffff", boxFill: "#d0021b" },
  ],
};
const finish = { background: { slot: 0, blur: 6, dim: 0.35 }, overlays: [{ slot: 3, blend: "screen", opacity: 0.9, under: true }], vignette: 0.5, grade: { contrast: 1.15, saturation: 1.4, warmth: 0.3 } };
await renderThumbnailScene({ publicDir: path.resolve(dir), spec, finish, slots: { "0": photo, "1": cutout, "2": logo, "3": overlay }, out: path.resolve(out), fresh: true, log: console.log });
console.log(`rendered ${out}`);
