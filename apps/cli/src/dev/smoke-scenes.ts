// Offline test of the motion system: six composed scenes in one film treatment (kinetic phrases, washes, colour
// world, particles, cutouts, photo styles, Three.js type and cards). No paid APIs. Renders previews + a short
// video and measures it against the reference band.
//   npx tsx apps/cli/src/dev/smoke-scenes.ts [treatmentIndex]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isUsable } from "@opumia/agents";
import { FilmDesignSystem, LibraryIndex, ResolutionReport, Storyboard, TimedScript, type StoryboardShot } from "@opumia/contracts";
import { buildManifest, lookFromProfile, renderShotPreviews, renderVideo } from "@opumia/motion-engine";
import { contactSheet, measureLook } from "@opumia/senses";

const ROOT = process.cwd();
const LIB = path.join(ROOT, "Library");
const variant = Number(process.argv[2] ?? 0);
const job = path.join(ROOT, "out", `_smoke_scenes_${variant}`);
const pub = path.join(job, "public");
mkdirSync(path.join(pub, "media"), { recursive: true });
const ff = (a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const index = LibraryIndex.parse(JSON.parse(readFileSync("data/library-index.json", "utf8")));
const usable = index.assets.filter(isUsable);
const cines = usable.filter((a) => a.category === "cinematic" && a.kind === "video");
const cutout = usable.filter((a) => a.category === "objects" && a.relPath.endsWith(".png"))[variant * 3 + 1]!;
const photoA = usable.find((a) => a.category === "objects" && /_src\//.test(a.relPath) && /\.jpe?g$/.test(a.relPath)) ?? cutout;

const TREATMENTS = [
  { palette: { primary: "#F5B21A", primarySoft: "#FFD877", accent: "#E5262B", accentDeep: "#6E0F12", surface: "#1B1408", surfaceAlt: "#3A2A0E", paper: "#F3E9D2", marker: "#FFE14D", text: "#FFFFFF", textMuted: "#D9CFB8" }, typography: { display: "slab", body: "humanist", casing: "upper", tracking: 1 }, treatment: { headline: "solid_stroke", phrase: "neon_glow", label: "tag", photo: "polaroid", world: "halftone", particles: "dust", wash: "duotone", washStrength: 0.45, glow: 0.7, motif: "film sprocket strips" } },
  { palette: { primary: "#19C37D", primarySoft: "#8CF0C4", accent: "#B026FF", accentDeep: "#3D0A66", surface: "#07130F", surfaceAlt: "#0E2A20", paper: "#EAF4EE", marker: "#C8FF4D", text: "#FFFFFF", textMuted: "#B7CFC4" }, typography: { display: "geometric_sans", body: "grotesk", casing: "upper", tracking: 2 }, treatment: { headline: "neon_glow", phrase: "boxed", label: "pill", photo: "none", world: "blueprint", particles: "bokeh", wash: "tint", washStrength: 0.4, glow: 0.9, motif: "lab-test crosshair rings" } },
  { palette: { primary: "#2D7BFF", primarySoft: "#9EC2FF", accent: "#FF7A1A", accentDeep: "#7A3200", surface: "#060B1C", surfaceAlt: "#101C40", paper: "#EDEFF5", marker: "#FFD23F", text: "#FFFFFF", textMuted: "#B5BFD9" }, typography: { display: "condensed_sans", body: "grotesk", casing: "upper", tracking: 1 }, treatment: { headline: "gradient", phrase: "solid_stroke", label: "underline", photo: "torn", world: "nebula", particles: "embers", wash: "duotone", washStrength: 0.35, glow: 0.6, motif: "route lines" } },
] as const;
const T = TREATMENTS[variant % TREATMENTS.length]!;
const design = FilmDesignSystem.parse({ schemaVersion: 1, id: `ds_smoke_${variant}`, channelId: "magnates-media", topic: "smoke", concept: "motion system smoke test", palette: T.palette, typography: T.typography, texture: { grain: 0.14, vignette: 0.45, halftone: false, lightLeaks: false }, acts: [{ name: "One", tint: T.palette.primary, tintStrength: 0.12, saturation: 1.15, contrast: 1.08 }], treatment: T.treatment, sceneGrammar: { favour: [], avoid: [], minRepeatGapS: 45 }, generatedAt: new Date().toISOString() });

const lines = ["A small company made a bet that would change everything", "Nobody inside the building saw it coming", "The founder kept one secret for years", "Then a rival quietly copied the whole idea", "The board signed the deal in total silence", "And the empire collapsed in a single week"];
const SHOT = 3.2;
const dur = lines.length * SHOT;
const tw = lines.flatMap((l, i) => l.split(" ").map((w, k, a) => ({ word: w, startS: +(i * SHOT + 0.15 + (k * (SHOT - 0.5)) / a.length).toFixed(3), endS: +(i * SHOT + 0.15 + ((k + 0.8) * (SHOT - 0.5)) / a.length).toFixed(3) })));
ff(["-f", "lavfi", "-i", `anullsrc=r=44100:cl=mono`, "-t", String(dur), path.join(job, "narration.mp3")]);
const script = TimedScript.parse({ schemaVersion: 1, id: "ts_smoke_scenes", title: "Motion smoke", styleProfileId: "magnates-media", aspect: "16:9", voice: { provider: "elevenlabs", voiceId: "x", modelId: "x", audioPath: path.join(job, "narration.mp3") }, segments: [{ id: "s01", role: "hook", text: lines.join(". "), startS: 0, endS: dur, words: tw }], durationS: dur, generatedAt: new Date().toISOString() });
const shots: StoryboardShot[] = lines.map((l, i) => ({ schemaVersion: 1, id: `sh${String(i + 1).padStart(3, "0")}`, scriptSegmentId: "s01", index: i, startS: +(i * SHOT).toFixed(3), endS: +((i + 1) * SHOT).toFixed(3), intent: l, lineLink: "literal", source: { kind: "designed", designed: "scene", props: { brief: l, layers: [], background: { query: "x" } }, assetIds: [] }, camera: { type: "static" }, overlays: [], sfx: [], transitionIn: "cut", focus: [0.5, 0.5] }));
const board = Storyboard.parse({ schemaVersion: 1, id: "sb_smoke_scenes", scriptId: script.id, styleProfileId: "magnates-media", aspect: "16:9", durationS: dur, shots, music: [], generatedAt: new Date().toISOString() });

const media: ResolutionReport["media"] = [];
const base = { origin: "library" as const, provider: "library" as const, license: "smoke", attributionRequired: false, aiGenerated: false as const, score: 1, query: "smoke" };
for (const i of [0, 3, 4, 5]) {
  const a = cines[(i * 7 + variant * 11) % cines.length]!;
  const out = path.join(pub, "media", `v${i}.mp4`);
  if (!existsSync(out)) ff(["-stream_loop", "-1", "-i", path.join(LIB, a.relPath), "-t", String(SHOT + 1), "-an", "-vf", "scale=1920:-2,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", out]);
  media.push({ ...base, shotId: shots[i]!.id, role: "primary", ref: `${a.id}#${i}`, kind: "video", localPath: out, publicPath: `media/v${i}.mp4`, durationS: SHOT });
}
const layer = (shot: number, slot: number, a: typeof cutout, name: string) => {
  const png = a.relPath.endsWith(".png");
  const out = path.join(pub, "media", `l${shot}_${slot}.${png ? "png" : "jpg"}`);
  if (!existsSync(out)) ff(["-i", path.join(LIB, a.relPath), "-vf", "scale='min(1400,iw)':-2", "-frames:v", "1", "-update", "1", out]);
  media.push({ ...base, shotId: shots[shot]!.id, role: "layer", slot, ref: `${a.id}#l${shot}${slot}`, kind: "image", localPath: out, publicPath: `media/${path.basename(out)}`, depicts: name });
};
layer(2, 0, photoA, "photo");
layer(3, 0, cutout, "cutout");
layer(4, 0, photoA, "photo");
const resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 4, stock: 0, archival: 0, designed: 6 }, generatedAt: new Date().toISOString() });

const cam = (k: number) => ({ fromScale: k % 2 ? 1.16 : 1.02, toScale: k % 2 ? 1.02 : 1.16, fromX: k % 2 ? 0.44 : 0.56, toX: k % 2 ? 0.56 : 0.44, fromY: 0.5, toY: 0.48 });
const scenes = new Map<string, unknown>([
  ["sh001", { shotId: "sh001", idea: "phrase over washed footage", backdrop: "footage", dim: 0.3, wash: { color: "primary", strength: T.treatment.washStrength, mode: T.treatment.wash }, camera: cam(0), elements: [{ type: "phrase", text: "a bet that would change everything", x: 0.08, y: 0.62, w: 0.84, size: 0.085, align: "center", color: "text", emphasis: "everything", z: 0.6, at: 0, enter: "fade" }, { type: "shape", shape: "underline", x: 0.3, y: 0.86, w: 0.4, h: 0.008, color: "accent", z: 0.6, at: 2.0, enter: "draw" }] }],
  ["sh002", { shotId: "sh002", idea: "3D word on the colour world", backdrop: "world", dim: 0.3, camera: cam(1), elements: [{ type: "text", text: "inside the building", role: "kicker", x: 0.3, y: 0.2, w: 0.4, size: 0.035, align: "center", color: "text", z: 0.4, at: 0.2, enter: "slide_down" }, { type: "text3d", text: "Nobody", x: 0.18, y: 0.3, w: 0.64, color: "primary", spin: 20, z: 0.7, at: 0.1, enter: "pop" }, { type: "phrase", text: "saw it coming", x: 0.25, y: 0.72, w: 0.5, size: 0.07, align: "center", color: "text", z: 0.6, at: 0, enter: "fade" }] }],
  ["sh003", { shotId: "sh003", idea: "3D picture card with a name", backdrop: "world", dim: 0.3, camera: cam(2), elements: [{ type: "card3d", slot: 0, x: 0.08, y: 0.14, w: 0.44, tilt: -16, spin: 26, z: 0.8, at: 0.1, enter: "zoom" }, { type: "text", text: "The Founder", role: "headline", x: 0.56, y: 0.3, w: 0.4, size: 0.11, align: "left", color: "text", highlightWord: "founder", z: 0.5, at: 0.5, enter: "slide_right" }, { type: "text", text: "kept one secret", role: "label", x: 0.56, y: 0.6, w: 0.34, size: 0.04, align: "left", color: "text", z: 0.5, at: 1.0, enter: "fade" }] }],
  ["sh004", { shotId: "sh004", idea: "sticker cutout over footage with a phrase", backdrop: "footage", dim: 0.35, camera: cam(3), elements: [{ type: "cutout", slot: 0, x: 0.58, y: 0.14, w: 0.32, rot: -5, outline: true, shadow: true, z: 0.85, at: 0.15, enter: "pop" }, { type: "phrase", text: "quietly copied the whole idea", x: 0.06, y: 0.36, w: 0.5, size: 0.075, align: "left", color: "text", emphasis: "copied", z: 0.55, at: 0, enter: "fade" }, { type: "shape", shape: "arrow", x: 0.42, y: 0.72, w: 0.1, h: 0.01, x2: 0.6, y2: 0.56, color: "accent", z: 0.6, at: 1.6, enter: "draw" }] }],
  ["sh005", { shotId: "sh005", idea: "photo in the film's frame style with a stamp", backdrop: "split", dim: 0.3, camera: cam(4), elements: [{ type: "photo", slot: 0, x: 0.56, y: 0.16, w: 0.34, rot: 3, frame: T.treatment.photo, grade: "natural", z: 0.75, at: 0.1, enter: "slide_right" }, { type: "text", text: "Signed", role: "stamp", x: 0.6, y: 0.7, w: 0.26, size: 0.08, align: "center", color: "accent", rot: -7, z: 0.9, at: 1.4, enter: "stamp" }, { type: "phrase", text: "in total silence", x: 0.05, y: 0.7, w: 0.42, size: 0.07, align: "left", color: "text", z: 0.6, at: 0, enter: "fade" }] }],
  ["sh006", { shotId: "sh006", idea: "slam on footage", backdrop: "footage", dim: 0.45, wash: { color: "accent", strength: T.treatment.washStrength, mode: T.treatment.wash }, camera: cam(5), elements: [{ type: "text", text: "Collapsed", role: "display", x: 0.1, y: 0.3, w: 0.8, size: 0.19, align: "center", color: "primary", z: 0.7, at: 0.3, enter: "stamp" }, { type: "phrase", text: "in a single week", x: 0.25, y: 0.68, w: 0.5, size: 0.065, align: "center", color: "text", emphasis: "week", z: 0.5, at: 0, enter: "fade" }, { type: "shape", shape: "cross", x: 0.42, y: 0.1, w: 0.06, h: 0.1, color: "accent", z: 0.6, at: 1.8, enter: "draw" }] }],
]);

const manifest = await buildManifest({ storyboard: board, script, resolution, libraryRoot: LIB, outputPath: path.join(job, "smoke.mp4"), narrationPath: script.voice.audioPath, scenes, burnCaptions: false });
writeFileSync(path.join(job, "manifest.json"), JSON.stringify(manifest, null, 2));
const profile = JSON.parse(readFileSync("data/style-profiles/magnates-media.json", "utf8"));
const look = lookFromProfile(profile.look, design.palette.primarySoft);
let t0 = Date.now();
const prev = await renderShotPreviews({ manifest, look, design, publicDir: pub, outDir: path.join(job, "previews"), log: console.log });
console.log("previews s", ((Date.now() - t0) / 1000).toFixed(1));
const sheet = await contactSheet(prev.flatMap((p) => p.frames.map((f) => f.path)), path.join(job, "sheet.jpg"), { cols: 3, cellW: 640 });
console.log("sheet", sheet);
t0 = Date.now();
await renderVideo({ manifest, look, design, publicDir: pub, out: path.join(job, "smoke.mp4"), maxChunks: 1, minChunkS: 5, log: () => {} });
console.log("render s", ((Date.now() - t0) / 1000).toFixed(1));
const l = await measureLook(path.join(job, "smoke.mp4"), { fps: 4 });
console.log("look", JSON.stringify({ luma: l.luma, colourfulness: l.colourfulness, hueSpread: l.hueSpread, motion: l.motion * 100, stillShare: l.stillShare, darkShare: l.darkShare, palette: l.palette.slice(0, 4) }));
