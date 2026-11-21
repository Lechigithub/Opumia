// Preview every shot of a job at one late moment → one contact sheet (no film render).
//   npx tsx apps/cli/src/dev/preview-job.ts out/<job> [moment 0..1]
import { readFileSync } from "node:fs";
import path from "node:path";
import { FilmDesignSystem, RenderManifest } from "@opumia/contracts";
import { lookFromProfile, renderShotPreviews } from "@opumia/motion-engine";
import { contactSheet } from "@opumia/senses";
const job = path.resolve(process.argv[2]!);
const manifest = RenderManifest.parse(JSON.parse(readFileSync(path.join(job, "manifest.json"), "utf8")));
const design = FilmDesignSystem.parse(JSON.parse(readFileSync(path.join(job, "design.json"), "utf8")));
const ch = JSON.parse(readFileSync(path.join(job, "job.json"), "utf8")).channel as string;
const look = lookFromProfile(JSON.parse(readFileSync(`data/style-profiles/${ch}.json`, "utf8")).look, design.palette.primarySoft);
const prev = await renderShotPreviews({ manifest, look, design, publicDir: path.join(job, "public"), outDir: path.join(job, "previews_final"), moments: [Number(process.argv[3] ?? 0.8)] });
console.log(await contactSheet(prev.map((p) => p.frames[0]!.path), path.join(job, "previews_final.jpg"), { cols: 5, cellW: 384 }));
console.log(JSON.stringify(design.treatment), design.palette.primary, design.palette.accent, design.typography.display);
