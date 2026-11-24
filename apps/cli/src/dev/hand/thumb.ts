// The hand film's thumbnail, composed from the film's own real pictures (no generated imagery), on the platform's
// thumbnail renderer. Measured against the channel's 37 thumbnails: a cut-out person as hero (~40 % of the frame),
// a real photo behind, a glow, money or fire, one or two heavy words, often on a coloured box.
//   npx tsx apps/cli/src/dev/hand/thumb.ts out/hand-ftx
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { renderThumbnailScene } from "@opumia/motion-engine";
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
// variants of the same subject (VARIANT=a|b|c|d), compared on the same measures; the best is kept as thumbnail.jpg
const V = process.env.VARIANT ?? "a";
const hero = V === "b" || V === "d" ? "pic/sbf_court.png" : "pic/sbf.png";
const bg = V === "b" ? "pic/crash.jpg" : "pic/bg_burn.jpg";
const heroW = V === "c" ? 0.6 : 0.52;
const big = V === "c" ? "$32B → $0" : "$32B";
const box = V === "d" ? "BANKRUPT" : "GONE";
const spec = {
  shotId: "thumbnail", idea: "the $32 billion empire gone in four days", backdrop: "world", dim: 0.25,
  camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 },
  elements: [
    ...(V === "c" ? [] : [{ type: "card3d", slot: 2, x: 0.05, y: 0.06, w: 0.2, rot: 0, z: 0.5, at: 0, enter: "fade", tilt: -14, spin: 10 }]),
    { type: "cutout", slot: 1, x: 1 - heroW - 0.0, y: 0.04, w: heroW, rot: 0, z: 0.6, at: 0, enter: "fade", shadow: true, glowColor: V === "b" ? "#ffcc00" : "#ff2b2b", glowSize: 1.3, matchColor: "#5a2a1a", matchStrength: 0.35, brightness: 1.08 },
    { type: "text", text: big, role: "display", x: 0.04, y: V === "c" ? 0.3 : 0.36, w: V === "c" ? 0.5 : 0.5, rot: 0, z: 0.7, at: 0, enter: "fade", size: V === "c" ? 0.17 : 0.26, align: "left", color: "text", font: "heavy_sans", letter: "plain", fill: "#ffcc00" },
    { type: "text", text: box, role: "display", x: 0.05, y: 0.68, w: 0.45, rot: -3, z: 0.7, at: 0, enter: "fade", size: 0.13, align: "left", color: "text", font: "heavy_sans", letter: "label_box", fill: "#ffffff", boxFill: "#d0021b" },
  ],
};
const finish = { background: { slot: 0, blur: 0, dim: 0.35 }, overlays: [{ slot: 3, blend: "screen", opacity: 0.55, under: true }], vignette: 0.55, grade: { contrast: 1.18, saturation: 1.35, warmth: 0.25 } };
const out = path.join(job, process.env.VARIANT ? `thumb-${V}.jpg` : "thumbnail.jpg");
// the platform's finishing (publish.ts): twice the size, brought down sharply, unsharp mask, film grain on real pixels
const big = out.replace(/\.jpg$/, ".2x.png");
await renderThumbnailScene({ publicDir: path.join(job, "thumb-public"), spec, finish, slots: { "0": bg, "1": hero, "2": "pic/ftx.png", "3": "pic/fire.jpg" }, width: 2560, height: 1440, out: big, fresh: true, log: () => {} });
const SHARPEN = Number(process.env.SHARPEN ?? 1), GRAIN = Number(process.env.GRAIN ?? 1);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", big, "-vf", `scale=1280:720:flags=lanczos,unsharp=5:5:${(0.4 + SHARPEN * 0.9).toFixed(2)}:5:5:0,noise=alls=${Math.round(GRAIN * 14)}:allf=t`, "-q:v", "2", "-frames:v", "1", "-update", "1", out]);
rmSync(big, { force: true });
console.log(`thumbnail → ${out}`);
