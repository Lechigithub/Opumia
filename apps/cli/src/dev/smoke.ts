// Offline render smoke test: every kit role and scene element, real Library media, no paid APIs. The film kit is the
// test fixture packages/motion-engine/src/remotion/film/test-kit.tsx (a real film's kit is written by its art director).
import { PLATFORM_FPS } from "@opumia/contracts";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LibraryIndex, Storyboard, TimedScript, ResolutionReport, type StoryboardShot } from "@opumia/contracts";
import { isUsable, journeyStops } from "@opumia/agents";
import { findProp3d, materializeProp3d } from "@opumia/resolver";
import { buildManifest, captionGroups, lookFromProfile, masterAudio, muxFinal, renderVideo, toSrt } from "@opumia/motion-engine";

const ROOT = process.cwd();
const LIB = path.join(ROOT, "Library");
const job = path.join(ROOT, "out", "_smoke");
const pub = path.join(job, "public");
// craft inventory: a real 3D prop (CC0 glTF from Poly Haven) — downloaded once into data/.cache, offline after that
const propHit = await findProp3d({ dataDir: path.join(ROOT, "data"), query: "wooden barrel" }).catch(() => null);
const prop = propHit ? await materializeProp3d({ dataDir: path.join(ROOT, "data"), publicDir: pub, id: propHit.id }).catch(() => null) : null;
mkdirSync(path.join(pub, "media"), { recursive: true });
mkdirSync(path.join(job, "audio"), { recursive: true });
mkdirSync(path.join(job, "design", "film"), { recursive: true });
copyFileSync(path.join(ROOT, "packages", "motion-engine", "src", "remotion", "film", "test-kit.tsx"), path.join(job, "design", "film", "index.tsx"));
const index = LibraryIndex.parse(JSON.parse(readFileSync("data/library-index.json", "utf8")));
const ff = (a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const usable = index.assets.filter(isUsable);
const film = usable.find((a) => a.category === "footage" && a.segments?.length)!;
const cine = usable.find((a) => a.category === "cinematic" && /assembly/.test(a.relPath))!;
const photo = usable.find((a) => a.category === "objects" && a.relPath.endsWith(".png"))!;
const leak = usable.find((a) => a.category === "overlays" && /light_leaks/.test(a.relPath))!;
const paper = usable.find((a) => a.category === "overlays" && /paper\//.test(a.relPath))!;
const music = usable.find((a) => a.category === "music" && !a.provenance.generated && (a.probe?.durationS ?? 0) > 60)!;
const sfx = usable.find((a) => a.category === "sfx" && a.facets.class)!;

const ASPECT = (process.env.SMOKE_ASPECT ?? "9:16") as "9:16" | "16:9";
const words = "In 1928 a small company made a bet that would change the world forever and then paid $19 billion for a rival nobody saw coming until far too late".split(" ");
const WORLDS = ["mono_accent", "duotone", "burst", "collage", "flat_field", "paper", "terminal", "filmstrip", "contact_grid", "split", "gradient", "room3d"] as const;
const dur = 24 + (WORLDS.length + 2) * 2.5;
const tw = words.map((w, i) => ({ word: w, startS: +(i * (dur - 1) / words.length).toFixed(3), endS: +((i + 0.8) * (dur - 1) / words.length).toFixed(3) }));
ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${dur}`, "-af", "volume=0.3", path.join(job, "narration.mp3")]);
const script = TimedScript.parse({ schemaVersion: 1, id: "ts_smoke", title: "Smoke test", styleProfileId: "magnates-media", aspect: ASPECT, voice: { provider: "elevenlabs", voiceId: "x", modelId: "x", audioPath: path.join(job, "narration.mp3") }, segments: [{ id: "s01", role: "hook", text: words.join(" "), startS: 0, endS: dur - 1, words: tw }], durationS: dur, generatedAt: new Date().toISOString() });

const kinds: Array<[string, Record<string, unknown>]> = [
  ["broll", {}], ["parallax", {}], ["chart", { type: "bar", title: "Market value", unit: "$", labels: ["1990", "2000", "2007", "2013"], values: [2e9, 3.1e10, 9.4e10, 7.2e9], highlight: 2 }],
  ["map", { title: "Expansion", points: [{ name: "Detroit", lon: -83.05, lat: 42.33 }, { name: "London", lon: -0.12, lat: 51.5 }, { name: "Tokyo", lon: 139.7, lat: 35.7 }], route: true }],
  ["document", { style: "web", tone: "red", masthead: "The Daily Ledger", date: "October 29, 1929", headline: "Stocks Collapse in Record Sell-Off", body: "Panic swept the exchange as billions in value vanished within hours.", highlight: "Stocks Collapse" }],
  ["scene", { brief: "cutout over footage with the kit's headline and phrase" }],
  ["scene", { brief: "a stage scene: photo and the kit's number and label" }],
  ["scene", { brief: "clean footage" }],
  // build list 5, item 10: every world a designed shot can be built in
  ...WORLDS.map((w): [string, Record<string, unknown>] => ["scene", { brief: `world ${w}` }]),
  // hand film (2026-11-25): a continuous journey, and a scene built by hand from the shared craft tools
  ["scene", { brief: "journey" }],
  ["scene", { brief: "composite" }],
];
const shotLen = dur / kinds.length;
const shots: StoryboardShot[] = kinds.map(([k, props], i) => ({
  schemaVersion: 2, id: `sh${String(i + 1).padStart(3, "0")}`, scriptSegmentId: "s01", index: i, startS: +(i * shotLen).toFixed(3), endS: +((i + 1) * shotLen).toFixed(3), intent: k, lineLink: "mood",
  source: k === "broll" || k === "parallax" ? { kind: "query", query: k, mustBe: "any" } : { kind: "designed", designed: k as never, props: { ...props, background: { query: "x" } }, assetIds: [] },
  camera: k === "parallax" ? { type: "parallax", layers: 3, depth: 0.6 } : { type: "ken_burns", fromScale: 1.05, toScale: 1.18, from: [0.5, 0.5], to: [0.5, 0.45], easing: "ease_in_out" },
  overlays: i === 0 ? [{ assetId: leak.id, blend: "screen", opacity: 0.5 }] : [], sfx: i % 3 === 0 ? [{ assetId: sfx.id, atS: i * shotLen + 0.05, gainDb: -4 }] : [],
  transitionIn: i === 2 ? "zoom_through" : i === 4 ? "flash" : i % 2 ? "film" : "cut", focus: [0.5, 0.5],
}));
const board = Storyboard.parse({ schemaVersion: 1, id: "sb_smoke", scriptId: script.id, styleProfileId: "magnates-media", aspect: ASPECT, durationS: dur, shots, music: [{ assetId: music.id, startS: 0, endS: dur, gainDb: -16 }], generatedAt: new Date().toISOString() });

const media: ResolutionReport["media"] = [];
const mat = (shotId: string, role: "primary" | "overlay" | "sfx" | "music", a: typeof film, kind: "video" | "image" | "audio", inS = 0) => {
  const ext = kind === "video" ? "mp4" : kind === "audio" ? "mp3" : a.ext === "png" ? "png" : "jpg";
  const file = `${role}_${shotId}.${ext}`;
  const out = kind === "audio" ? path.join(job, "audio", file) : path.join(pub, "media", file);
  if (kind === "video") ff(["-ss", String(inS), "-stream_loop", "-1", "-i", path.join(LIB, a.relPath), "-t", String(shotLen + 1), "-an", "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=" + PLATFORM_FPS + ",format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", out]);
  else if (kind === "image") ff(["-i", path.join(LIB, a.relPath), "-vf", "scale='min(2400,iw)':-2", "-frames:v", "1", out]);
  else ff(["-i", path.join(LIB, a.relPath), "-c:a", "libmp3lame", "-q:a", "3", out]);
  media.push({ shotId, role, origin: "library", ref: a.id, provider: "library", kind, localPath: out, publicPath: kind === "audio" ? `../audio/${file}` : `media/${file}`, durationS: kind === "audio" ? a.probe?.durationS : shotLen, license: a.provenance.license!, attributionRequired: false, aiGenerated: false, score: 1, query: role });
};
// sh007 sits on the kit's stage (no footage); every other shot has footage.
const worldIds = WORLDS.map((_, k) => `sh${String(9 + k).padStart(3, "0")}`);
const journeyId = `sh${String(9 + WORLDS.length).padStart(3, "0")}`, compositeId = `sh${String(10 + WORLDS.length).padStart(3, "0")}`;
shots.forEach((s, i) => { if (s.id !== "sh007" && !worldIds.includes(s.id)) mat(s.id, "primary", i === 1 ? photo : i % 2 ? cine : film, i === 1 ? "image" : "video", i % 2 ? 0 : (film.segments![5]?.inS ?? 0)); });
mat("sh001", "overlay", leak, "video");
mat("sh005", "overlay", paper, "image");
shots.filter((s) => s.sfx.length).forEach((s) => mat(s.id, "sfx", sfx, "audio"));
mat("music", "music", music, "audio");
// Composed-scene picture slots (layer role).
for (const id of ["sh006", "sh007", ...worldIds, journeyId, compositeId]) {
  const out = path.join(pub, "media", `layer_${id}_0.png`);
  ff(["-i", path.join(LIB, photo.relPath), "-vf", "scale='min(1200,iw)':-2", "-frames:v", "1", out]);
  media.push({ shotId: id, role: "layer", slot: 0, origin: "library", ref: `${photo.id}#layer${id}`, provider: "library", kind: "image", localPath: out, publicPath: `media/layer_${id}_0.png`, license: photo.provenance.license!, attributionRequired: false, aiGenerated: false, score: 1, query: "layer", depicts: "object cutout" });
}
// a second real picture for the collage: a frame of the library film
{
  for (const id of [worldIds[3]!, journeyId]) {
  const out = path.join(pub, "media", `layer_${id}_1.jpg`);
  ff(["-ss", "5", "-i", path.join(LIB, film.relPath), "-frames:v", "1", "-vf", "scale=1200:-2", out]);
  media.push({ shotId: id, role: "layer", slot: 1, origin: "library", ref: `${film.id}#frame`, provider: "library", kind: "image", localPath: out, publicPath: `media/layer_${id}_1.jpg`, license: film.provenance.license!, attributionRequired: false, aiGenerated: false, score: 1, query: "layer", depicts: "film frame" });
  }
}
// the composite: written as a scene designer would with write_composite (design/film/composites/)
mkdirSync(path.join(job, "design", "film", "composites"), { recursive: true });
writeFileSync(path.join(job, "design", "film", "composites", "SmokeCraft.tsx"), `import React from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FILM } from "@film";
import { Cracks, DepthRain, DoubleExposure, Flare, GlassSlab, HeroCutout, Shatter, Slab3D, TwoSided, Whip, WrapAround, ramp, shake } from "@craft";
export default function SmokeCraft(p: { slots: Record<string, string> }) {
  const f = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  const font = String(FILM.fonts?.display ?? "sans-serif");
  const sk = shake(f, 40, 8, 20);
  return <AbsoluteFill style={{ background: "#000", transform: \`translate(\${sk}px, 0)\` }}>
    <Whip k={ramp(f, 0, 10) < 1 ? 1 - ramp(f, 0, 10) : 0} dir="in">
      <OffthreadVideo src={staticFile(p.slots["90"]!)} muted style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(.6)" }} />
      <DoubleExposure src={p.slots["0"]!} opacity={0.35} />
      <AbsoluteFill style={{ perspective: W }}><DepthRain n={20} t={f} layer="far" render={() => <TwoSided front={p.slots["0"]!} back={p.slots["0"]!} w={W * 0.1} />} /></AbsoluteFill>
      <WrapAround frontFrom={0.6} words={<div style={{ position: "absolute", left: W * 0.2, top: H * 0.2, transformStyle: "preserve-3d", transform: \`rotateY(\${20 - 20 * ramp(f, 0, 30)}deg)\` }}><Slab3D text="a bet" size={W * 0.12} fontFamily={font} face="#f4efe6" side="#7a2a16" /></div>}
        subject={<HeroCutout src={p.slots["0"]!} x={0.3} w={0.4} light="rgba(120,180,255,.6)" />} />
      <Flare x={interpolate(f, [10, 40], [0, W])} y={H * 0.4} w={W * 0.8} op={0.8} light="rgba(120,180,255,.7)" />
    </Whip>
    <Shatter k={ramp(f, 30, 44)} cx={W * 0.5} cy={H * 0.5}>
      <AbsoluteFill style={{ background: "#111", justifyContent: "center", alignItems: "center", perspective: W }}><GlassSlab w={W * 0.5} k={ramp(f, 0, 40)} edge="rgba(120,180,255,.2)" glow="rgba(120,180,255,.4)" reflect={p.slots["0"]}><div style={{ height: H * 0.2, background: "#223" }} /></GlassSlab></AbsoluteFill>
      <Cracks cx={W * 0.5} cy={H * 0.5} k={ramp(f, 20, 30)} />
    </Shatter>
  </AbsoluteFill>;
}
`);
writeFileSync(path.join(job, "design", "film", "composites.tsx"), `import C0 from "./composites/SmokeCraft";\nexport const COMPOSITES: Record<string, any> = { SmokeCraft: C0 };\n`);
const journey = journeyStops([
  { at: 0, slot: 90, move: "slide", look: "natural", frame: "none", elements: [{ type: "component", name: "Headline", props: { text: "a small company" }, x: 0.1, y: 0.6, w: 0.6, rot: 0, z: 0.6, at: 0.1, enter: "fade" } as never] },
  { at: 0.9, slot: 0, move: "push", look: "duotone", frame: "none", elements: [], fore: [{ type: "cutout", slot: 0, x: 0.55, y: 0.2, w: 0.35, rot: 0, z: 0.8, at: 0, enter: "fade", shadow: true } as never], dof: 0.6 },
  { at: 1.8, slot: 1, move: "whip", look: "mono", frame: "none", elements: [] },
], shotLen);
const scenes = new Map<string, unknown>([
  [journeyId, { shotId: journeyId, idea: "journey", backdrop: "journey", journey, finish: { grain: 0.25, vignette: 0.3, leak: 0 }, dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [] }],
  [compositeId, { shotId: compositeId, idea: "composite", backdrop: "footage", finish: { grain: 0.2, vignette: 0.3, leak: 0 }, dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [{ type: "component", name: "SmokeCraft", props: {}, x: 0, y: 0, w: 1, h: 1, rot: 0, z: 0.5, at: 0, enter: "fade" }] }],
  ["sh006", { shotId: "sh006", idea: "smoke A", backdrop: "footage", dim: 0.45, camera: { fromScale: 1.02, toScale: 1.14, fromX: 0.45, toX: 0.55, fromY: 0.5, toY: 0.48 }, elements: [
    { type: "cutout", slot: 0, x: 0.56, y: 0.18, w: 0.32, rot: -4, z: 0.8, at: 0.1, enter: "pop", shadow: true, outline: true, glow: "accent", retouch: { smooth: 0.5, sharpen: 0.5, relight: 0.4, warp: 0.5, cx: 0.5, cy: 0.4 } },
    { type: "component", name: "Headline", props: { text: "a bet" }, x: 0.08, y: 0.3, w: 0.45, rot: 0, z: 0.6, at: 0.2, enter: "fade" },
    { type: "component", name: "Phrase", props: { text: "change the world", sync: true }, x: 0.08, y: 0.5, w: 0.48, rot: 0, z: 0.6, at: 0.3, enter: "fade" },
  ] }],
  ["sh007", { shotId: "sh007", idea: "smoke B", backdrop: "stage", fx: { glitch: true, rack: true }, drift: { slot: 0, mode: "fall", count: 12 }, dim: 0.4, camera: { fromScale: 1.0, toScale: 1.1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [
    { type: "photo", slot: 0, x: 0.12, y: 0.14, w: 0.36, rot: 3, z: 0.6, at: 0, enter: "zoom", grade: "mono" },
    ...(prop ? [{ type: "prop3d", query: "wooden barrel", model: prop.publicPath, x: 0.5, y: 0.38, w: 0.48, rot: 0, z: 0.7, at: 0.1, enter: "fade", spin: 60, tilt: 22 }] : []),
    { type: "text3d", text: "BILLIONS GONE", x: 0.08, y: 0.7, w: 0.84, rot: 0, z: 0.7, at: 0.2, enter: "fade", spin: 18, exit: "erode" },
    { type: "component", name: "NumberC", props: { value: "$19 billion", label: "paid for a rival" }, x: 0.55, y: 0.3, w: 0.4, rot: 0, z: 0.6, at: 0.3, enter: "fade" },
    { type: "component", name: "Label", props: { text: "a rival", sub: "nobody saw coming" }, x: 0.55, y: 0.62, w: 0.35, rot: 0, z: 0.6, at: 0.5, enter: "fade" },
  ] }],
  ["sh008", { shotId: "sh008", idea: "clean", backdrop: "footage", finish: { grain: 0.3, vignette: 0.4, leak: 0.5 }, dim: 0.1, camera: { fromScale: 1.02, toScale: 1.12, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [] }],
  ...WORLDS.map((w, k): [string, unknown] => [worldIds[k]!, { shotId: worldIds[k]!, idea: `world ${w}`, backdrop: "world", world: { kind: w, ...(w === "burst" || w === "flat_field" ? {} : { slot: 0 }), ...(w === "collage" || w === "split" || w === "contact_grid" || w === "filmstrip" ? { slots: [1] } : {}), color: k % 2 ? "accentDeep" : "primary", accent: "accent" }, finish: { grain: 0.25, vignette: 0.3, leak: 0 }, dim: 0.3, camera: { fromScale: 1.0, toScale: 1.1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [
    ...(w === "burst" ? [{ type: "cutout", slot: 0, x: 0.3, y: 0.15, w: 0.4, rot: 0, z: 0.8, at: 0, enter: "pop", shadow: true }] : []),
    ...(w === "flat_field" ? [{ type: "photo", slot: 0, x: 0.1, y: 0.2, w: 0.4, rot: -3, z: 0.6, at: 0, enter: "zoom", grade: "duotone" }] : []),
    { type: "component", name: "Headline", props: { text: "a bet" }, x: 0.52, y: 0.62, w: 0.4, rot: 0, z: 0.6, at: 0.2, enter: "fade" },
  ] }]),
]);
const resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 7, stock: 0, archival: 0, designed: 6 }, generatedAt: new Date().toISOString() });

const final = path.join(job, `smoke_${ASPECT.replace(":", "x")}.mp4`);
const manifest = await buildManifest({ storyboard: board, script, resolution, libraryRoot: LIB, outputPath: final, narrationPath: script.voice.audioPath, scenes, burnCaptions: ASPECT === "9:16" });
writeFileSync(path.join(job, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(job, "captions.srt"), toSrt(captionGroups(script)));
const profile = JSON.parse(readFileSync("data/style-profiles/magnates-media.json", "utf8"));
const t0 = Date.now();
await renderVideo({ manifest, look: lookFromProfile(profile.look), ...(process.env.SMOKE_DESIGN ? { design: JSON.parse(readFileSync(process.env.SMOKE_DESIGN, "utf8")) } : {}), publicDir: pub, out: path.join(job, "video_silent.mp4"), maxChunks: Number(process.env.SMOKE_CHUNKS ?? 1), minChunkS: 5, log: console.log });
console.log("render s", ((Date.now() - t0) / 1000).toFixed(1));
const loud = await masterAudio(manifest, path.join(job, "master.wav"));
console.log("master", loud);
await muxFinal(path.join(job, "video_silent.mp4"), path.join(job, "master.wav"), final);
console.log("ok", final);
