// Offline render smoke test: every scene primitive, real Library media, no paid APIs.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LibraryIndex, Storyboard, TimedScript, ResolutionReport, type StoryboardShot } from "@opumia/contracts";
import { isUsable } from "@opumia/agents";
import { buildManifest, captionGroups, lookFromProfile, masterAudio, muxFinal, renderVideo, toSrt } from "@opumia/motion-engine";

const ROOT = process.cwd();
const LIB = path.join(ROOT, "Library");
const job = path.join(ROOT, "out", "_smoke");
const pub = path.join(job, "public");
mkdirSync(path.join(pub, "media"), { recursive: true });
mkdirSync(path.join(job, "audio"), { recursive: true });
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
// "$19 billion" is spoken during the money_figure shot so number parity binds the counter to the spoken figure.
const words = "In 1928 a small company made a bet that would change the world forever and then paid $19 billion for a rival nobody saw coming until far too late".split(" ");
const dur = 24;
const tw = words.map((w, i) => ({ word: w, startS: +(i * (dur - 1) / words.length).toFixed(3), endS: +((i + 0.8) * (dur - 1) / words.length).toFixed(3) }));
ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${dur}`, "-af", "volume=0.3", path.join(job, "narration.mp3")]);
const script = TimedScript.parse({ schemaVersion: 1, id: "ts_smoke", title: "Smoke test", styleProfileId: "magnates-media", aspect: ASPECT, voice: { provider: "elevenlabs", voiceId: "x", modelId: "x", audioPath: path.join(job, "narration.mp3") }, segments: [{ id: "s01", role: "hook", text: words.join(" "), startS: 0, endS: dur - 1, words: tw }], durationS: dur, generatedAt: new Date().toISOString() });

const kinds: Array<[string, Record<string, unknown>]> = [
  ["broll", {}], ["parallax", {}], ["chart", { type: "line", title: "Market value", unit: "$", labels: ["1990", "2000", "2007", "2013"], values: [2e9, 3.1e10, 9.4e10, 7.2e9] }],
  ["map", { title: "Expansion", points: [{ name: "Detroit", lon: -83.05, lat: 42.33 }, { name: "London", lon: -0.12, lat: 51.5 }, { name: "Tokyo", lon: 139.7, lat: 35.7 }], route: true }],
  ["document", { style: "web", tone: "red", masthead: "The Daily Ledger", date: "October 29, 1929", headline: "Stocks Collapse in Record Sell-Off", body: "Panic swept the exchange as billions in value vanished within hours, leaving brokers stunned.", highlight: "billions in value vanished" }],
  ["big_word", { text: "Total Collapse", sub: "in 48 hours" }], ["money_figure", { value: 19000000000, prefix: "$", suffix: "", label: "acquisition price" }],
  ["name_label", { name: "The Founder", title: "Chief Executive, 1928" }], ["versus", { title: "Market share", left: { label: "Rival", value: "12%" }, right: { label: "Them", value: "61%" } }],
  ["timeline", { items: [{ year: "1928", label: "Founded" }, { year: "1955", label: "Goes public" }, { year: "2001", label: "Collapse" }] }],
  ["quote_card", { quote: "We never thought anyone would catch us.", by: "Former executive" }],
  ["hero_face", { name: "Stephen Elop", title: "CEO, 2010–2014" }],
  ["cutout_collage", { title: "The Bet", tone: "crimson" }],
  ["screen", { title: "Market share, Q4 2010", lines: ["Symbian 32%", "Android 30%", "iOS 16%"], device: "monitor" }],
  ["scene", { brief: "cutout over footage with kinetic words and an arrow", layers: [{ name: "Object", type: "product" }] }],
  ["scene", { brief: "torn photo on paper with a stamp", layers: [{ name: "Object", type: "product" }] }],
];
const shotLen = dur / kinds.length;
const shots: StoryboardShot[] = kinds.map(([k, props], i) => ({
  schemaVersion: 1, id: `sh${String(i + 1).padStart(3, "0")}`, scriptSegmentId: "s01", index: i, startS: +(i * shotLen).toFixed(3), endS: +((i + 1) * shotLen).toFixed(3), intent: k, lineLink: "mood",
  source: k === "broll" || k === "parallax" ? { kind: "query", query: k, mustBe: "any" } : { kind: "designed", designed: k as never, props: { ...props, background: { query: "x" } }, assetIds: [] },
  camera: k === "parallax" ? { type: "parallax", layers: 3, depth: 0.6 } : { type: "ken_burns", fromScale: 1.05, toScale: 1.18, from: [0.5, 0.5], to: [0.5, 0.45], easing: "ease_in_out" },
  overlays: i === 0 ? [{ assetId: leak.id, blend: "screen", opacity: 0.5 }] : [], sfx: i % 3 === 0 ? [{ assetId: sfx.id, atS: i * shotLen + 0.05, gainDb: -4 }] : [],
  transitionIn: (["cut", "whip", "fade", "light_leak", "dip_black"] as const)[i % 5]!, focus: [0.5, 0.5],
}));
const board = Storyboard.parse({ schemaVersion: 1, id: "sb_smoke", scriptId: script.id, styleProfileId: "magnates-media", aspect: ASPECT, durationS: dur, shots, music: [{ assetId: music.id, startS: 0, endS: dur, gainDb: -16 }], generatedAt: new Date().toISOString() });

const media: ResolutionReport["media"] = [];
const mat = (shotId: string, role: "primary" | "overlay" | "sfx" | "music", a: typeof film, kind: "video" | "image" | "audio", inS = 0) => {
  const ext = kind === "video" ? "mp4" : kind === "audio" ? "mp3" : a.ext === "png" ? "png" : "jpg";
  const file = `${role}_${shotId}.${ext}`;
  const out = kind === "audio" ? path.join(job, "audio", file) : path.join(pub, "media", file);
  if (kind === "video") ff(["-ss", String(inS), "-stream_loop", "-1", "-i", path.join(LIB, a.relPath), "-t", String(shotLen + 1), "-an", "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", out]);
  else if (kind === "image") ff(["-i", path.join(LIB, a.relPath), "-vf", "scale='min(2400,iw)':-2", "-frames:v", "1", out]);
  else ff(["-i", path.join(LIB, a.relPath), "-c:a", "libmp3lame", "-q:a", "3", out]);
  media.push({ shotId, role, origin: "library", ref: a.id, provider: "library", kind, localPath: out, publicPath: kind === "audio" ? `../audio/${file}` : `media/${file}`, durationS: kind === "audio" ? a.probe?.durationS : shotLen, license: a.provenance.license!, attributionRequired: false, aiGenerated: false, score: 1, query: role });
};
shots.forEach((s, i) => mat(s.id, "primary", i === 1 || i === 12 ? photo : i % 2 ? cine : film, i === 1 || i === 12 ? "image" : "video", i % 2 ? 0 : (film.segments![5]?.inS ?? 0)));
mat("sh001", "overlay", leak, "video");
mat("sh005", "overlay", paper, "image");
shots.filter((s) => s.sfx.length).forEach((s) => mat(s.id, "sfx", sfx, "audio"));
mat("music", "music", music, "audio");
// Composed-scene picture slots (layer role).
for (const id of ["sh015", "sh016"]) {
  const out = path.join(pub, "media", `layer_${id}_0.png`);
  ff(["-i", path.join(LIB, photo.relPath), "-vf", "scale='min(1200,iw)':-2", "-frames:v", "1", out]);
  media.push({ shotId: id, role: "layer", slot: 0, origin: "library", ref: `${photo.id}#layer${id}`, provider: "library", kind: "image", localPath: out, publicPath: `media/layer_${id}_0.png`, license: photo.provenance.license!, attributionRequired: false, aiGenerated: false, score: 1, query: "layer", depicts: "object cutout" });
}
const scenes = new Map<string, unknown>([
  ["sh015", { shotId: "sh015", idea: "smoke A", backdrop: "footage", dim: 0.45, camera: { fromScale: 1.02, toScale: 1.14, fromX: 0.45, toX: 0.55, fromY: 0.5, toY: 0.48 }, elements: [
    { type: "texture", texture: "halftone", opacity: 0.25, at: 0 },
    { type: "cutout", slot: 0, x: 0.56, y: 0.18, w: 0.32, rot: -4, z: 0.8, at: 0.1, enter: "pop", shadow: true },
    { type: "text", text: "the bet", role: "kicker", x: 0.08, y: 0.3, w: 0.45, size: 0.04, align: "left", color: "accent", at: 0.2, enter: "slide_left" },
    { type: "text", text: "Nobody saw it coming", role: "display", x: 0.08, y: 0.38, w: 0.48, size: 0.11, align: "left", color: "text", highlightWord: "nobody", at: 0.35, enter: "wipe" },
    { type: "shape", shape: "arrow", x: 0.4, y: 0.72, w: 0.1, h: 0.01, x2: 0.58, y2: 0.55, color: "accent", at: 0.6, enter: "draw" },
  ] }],
  ["sh016", { shotId: "sh016", idea: "smoke B", backdrop: "paper", dim: 0.4, camera: { fromScale: 1.0, toScale: 1.1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [
    { type: "texture", texture: "paper", opacity: 0.5, at: 0 },
    { type: "photo", slot: 0, x: 0.12, y: 0.14, w: 0.36, rot: 3, z: 0.6, at: 0, enter: "zoom", frame: "torn", grade: "mono" },
    { type: "text", text: "Confidential", role: "stamp", x: 0.55, y: 0.36, w: 0.4, size: 0.09, align: "left", color: "accent", rot: -8, at: 0.3, enter: "stamp" },
    { type: "shape", shape: "circle", x: 0.53, y: 0.3, w: 0.42, h: 0.25, color: "accentDeep", at: 0.6, enter: "draw" },
  ] }],
]);
const resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 11, stock: 0, archival: 0, designed: 9 }, generatedAt: new Date().toISOString() });

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
