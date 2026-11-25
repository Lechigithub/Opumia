// Hand film 2 (2026-11-25): Wirecard's cold open, built from nothing for MOTION. Same plumbing as build.ts (storyboard,
// resolution, scenes, manifest, render); nothing of the FTX film's design, pictures, sounds or music.
//   OPUMIA_NO_CLAUDE=1 npx tsx apps/cli/src/dev/hand/build-wirecard.ts [--only B1,B2] [--render | --stretch a-b | --mix]
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { FilmDesignSystem, LibraryIndex, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ResolvedMedia, type SceneSpec } from "@opumia/contracts";
import { buildManifest, renderShotPreviews, renderStretches, renderVideo, masterAudio, muxFinal } from "@opumia/motion-engine";
import { resolveAudio } from "@opumia/resolver";
import { levelBeds } from "@opumia/agents";

const root = process.cwd();
const job = path.join(root, "out", "hand-wirecard");
const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]!.split(",")) : null;
const timed = TimedScript.parse(JSON.parse(await readFile(path.join(job, "timed-script-marcus.json"), "utf8")));
const NEWS = timed.segments, W = NEWS.flatMap((s) => s.words), FPS = 24;
const G = (line: string, k: number) => { let n = 0; for (const sg of NEWS) { if (sg.id === line) return n + Math.min(k, sg.words.length - 1); n += sg.words.length; } throw new Error(`no line ${line}`); };
const at = (line: string, k: number) => W[G(line, k)]!.startS;

// ---- media (every file chosen by looking at it; none used by the FTX film) ----
type M = { file: string; kind: "video" | "image"; origin: ResolvedMedia["origin"]; provider: ResolvedMedia["provider"]; license: string; credit: string; url: string };
const PX = (id: string, credit: string): M => ({ file: `downloads/stock/pexels_${id}.mp4`, kind: "video", origin: "stock", provider: "pexels", license: "Pexels License", credit, url: `https://www.pexels.com/video/${id}/` });
const PB = (id: string, credit: string): M => ({ file: `downloads/stock/pixabay_${id}.mp4`, kind: "video", origin: "stock", provider: "pixabay", license: "Pixabay Content License", credit, url: `https://pixabay.com/videos/id-${id}/` });
const stockCredit = JSON.parse(await readFile(path.join(job, "downloads", "stock.json"), "utf8")) as Record<string, { credit?: string }>;
const cr = (k: string) => stockCredit[k]?.credit ?? (k.startsWith("pexels") ? "Pexels" : "Pixabay");
const MEDIA: Record<string, M> = {
  card: PX("11158789", cr("pexels_11158789")), munich: PX("19023114", cr("pexels_19023114")), tower: PB("361362", cr("pixabay_361362")),
  board: PX("3191576", cr("pexels_3191576")), frankfurt: PX("27604521", cr("pexels_27604521")), confetti: PX("31540263", cr("pexels_31540263")),
  press: PX("30183300", cr("pexels_30183300")), police: PX("7714378", cr("pexels_7714378")), gavel: PB("162047", cr("pixabay_162047")),
  papers: PX("7732805", cr("pexels_7732805")), lens: PX("6929604", cr("pexels_6929604")), manila: PX("39617781", cr("pexels_39617781")), safe: PX("39060937", cr("pexels_39060937")),
  cuffs: PX("7714092", cr("pexels_7714092")), crash: PX("38687556", cr("pexels_38687556")), jet: PX("1650628", cr("pexels_1650628")),
  jetsky: PX("32301926", cr("pexels_32301926")), counter: PX("6266288", cr("pexels_6266288")), euros: PX("33402648", cr("pexels_33402648")), fire: PX("11977691", cr("pexels_11977691")),
  hq: { file: "downloads/wiki/wikipedia_File_Wirecard_headquarters_Aschheim_49556187461_.jpg.jpg", kind: "image", origin: "archival", provider: "commons", license: "CC BY-SA 2.0", credit: "Wirecard headquarters, Aschheim (49556187461).jpg by Leo Molatore, CC BY-SA 2.0, via Wikimedia Commons", url: "https://commons.wikimedia.org/wiki/File:Wirecard_headquarters,_Aschheim_(49556187461).jpg" },
  villa: { file: "downloads/wiki/wikipedia_File_Prinzregentenstr._61_Muenchen-3.jpg.jpg", kind: "image", origin: "archival", provider: "commons", license: "CC BY-SA 3.0", credit: "Prinzregentenstr. 61 Muenchen-3.jpg by AHert, CC BY-SA 3.0, via Wikimedia Commons", url: "https://commons.wikimedia.org/wiki/File:Prinzregentenstr._61_Muenchen-3.jpg" },
};

// ---- beats: each starts on its word; `len` runs to the next beat ----
type Beat = { id: string; seg: string; k: number; lead?: number; intent: string; slots: Record<number, string>; props: (t: number, r: (seg: string, k: number) => number) => Record<string, unknown> };
const wd = (r: (s: string, k: number) => number, parts: Array<[string, string, number, boolean?]>, x: number, y: number, w: number, size: number, o: Record<string, unknown> = {}) => ({ words: parts.map(([text, seg, k, br]) => ({ text, at: r(seg, k), ...(br ? { br } : {}) })), x, y, w, size, ...o });
const BEATS: Beat[] = [
  { id: "B1", seg: "w01", k: 0, lead: 0, intent: "a card taps a terminal; the wet night streets of Munich race past", slots: { 0: "card", 1: "munich" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.15, 1.55], pan: [0.05, -0.05], grade: "saturate(0.7) contrast(1.5) brightness(0.45) hue-rotate(10deg)" }, { slot: 1, at: r("w01", 3) - 0.1, push: [1.1, 1.5], pan: [-0.08, 0.08] }], whipOut: true,
      words: [wd(r, [["September", "w01", 1], ["2018", "w01", 2]], 0.05, 0.1, 0.9, 0.13, { slam: true, until: r("w01", 8) - 0.15 }), wd(r, [["a suburb of", "w01", 8], ["Munich", "w01", 10]], 0.05, 0.62, 0.9, 0.09, { style: "label" })] }) },
  { id: "B2", seg: "w01", k: 11, lead: 0.05, intent: "the glass headquarters in Aschheim, rushing at us: almost nobody thought it possible", slots: { 0: "hq" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.05, 1.6], pan: [0.06, -0.02], rot: [-3, 2] }], data: { n: 30, from: 0 }, whipIn: true,
      words: [wd(r, [["almost nobody", "w01", 13], ["thought", "w01", 15]], 0.05, 0.12, 0.9, 0.09, { style: "label" }), wd(r, [["possible", "w01", 17]], 0, 0.5, 1, 0.24, { slam: true })] }) },
  { id: "B3", seg: "w02", k: 0, lead: 0.05, intent: "the exchange board racing; WIRECARD shoves COMMERZBANK out of the DAX", slots: { 0: "board" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.2, 1.6], pan: [0.06, -0.06] }], data: { n: 30, from: 0, speed: 0.016 }, inF: 6, whipOut: true,
      shove: { out: "COMMERZBANK", inn: "WIRECARD", at: r("w02", 9), y: 0.3, size: 0.21 },
      words: [wd(r, [["1 of the 30", "w02", 3], ["founding members", "w02", 7]], 0.05, 0.66, 0.9, 0.07, { style: "label", until: r("w02", 9) - 0.1 }), wd(r, [["out of the", "w02", 9], ["DAX", "w02", 12]], 0.05, 0.64, 0.9, 0.08, { style: "label" })] }) },
  { id: "B4", seg: "w03", k: 0, lead: 0.05, intent: "the Frankfurt skyline flying in; €24 billion counting; more than Deutsche Bank; confetti for a tech champion", slots: { 0: "frankfurt", 1: "confetti" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.0, 1.5], pan: [0.03, -0.03] }, { slot: 1, at: r("w03", 16) - 0.1, push: [1.1, 1.35], pan: [-0.03, 0.03] }], money: { n: 30, from: r("w03", 4) - 0.2, speed: 0.012 }, whipIn: true,
      counter: { to: 24, at: r("w03", 4), dur: 0.9, prefix: "€", suffix: " BILLION", x: 0, y: 0.16, size: 0.18 },
      words: [wd(r, [["more than", "w03", 7], ["Deutsche Bank", "w03", 9]], 0.05, 0.6, 0.9, 0.08, { style: "label", until: r("w03", 16) - 0.15 }), wd(r, [["tech", "w03", 16], ["champion", "w03", 17]], 0, 0.6, 1, 0.16, { slam: true, enter: "spin" })] }) },
  { id: "B5", seg: "w04", k: 0, lead: 0.05, intent: "the presses running at full speed: where was the money? then Munich's tower at night: Germany didn't go after the company", slots: { 0: "press", 1: "tower" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.15, 1.45], pan: [0.08, -0.08], grade: "saturate(0.8) contrast(1.5) brightness(0.55) hue-rotate(10deg)" }, { slot: 1, at: r("w04", 15) - 0.1, push: [1.15, 1.7], pan: [0.1, -0.1], grade: "saturate(0.8) contrast(1.4) brightness(0.8) hue-rotate(8deg)" }], whipOut: true,
      words: [wd(r, [["Financial Times", "w04", 6]], 0.05, 0.1, 0.9, 0.08, { style: "label", until: r("w04", 10) - 0.1 }), wd(r, [["where was", "w04", 10], ["the money?", "w04", 12]], 0, 0.3, 1, 0.17, { slam: true, until: r("w04", 15) - 0.15 }), wd(r, [["Germany didn't go", "w04", 15], ["after the company", "w04", 18, true]], 0.05, 0.56, 0.9, 0.1, { red: true, style: "red" })] }) },
  { id: "B6", seg: "w05", k: 0, lead: 0.05, intent: "a gavel; police light: bets banned, the reporter investigated", slots: { 0: "gavel", 1: "police" },
    props: (t, r) => ({ red: true, plates: [{ slot: 0, push: [1.1, 1.4] }, { slot: 1, at: r("w05", 6) - 0.1, push: [1.2, 1.6], pan: [0.1, -0.1] }], strobe: [r("w05", 6), 99], whipIn: true, outF: 4,
      words: [wd(r, [["bets banned", "w05", 2]], 0, 0.14, 1, 0.2, { style: "red", slam: true, until: r("w05", 8) - 0.15 }), wd(r, [["the reporter", "w05", 10], ["investigated", "w05", 9, true]], 0, 0.5, 1, 0.13, { style: "red", slam: true })] }) },
  { id: "B7", seg: "w06", k: 0, lead: 0.05, intent: "auditors tearing through the paperwork; a magnifier over the figures: €1.9 billion; Manila from the air", slots: { 0: "papers", 1: "lens", 2: "manila" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.15, 1.6], pan: [-0.1, 0.1], rot: [-4, 3] }, { slot: 1, at: r("w06", 9) - 0.1, push: [1.2, 1.7], pan: [0.08, -0.08] }, { slot: 2, at: r("w06", 19) - 0.1, push: [1.1, 1.6], pan: [0.1, -0.1] }], inF: 6, whipOut: true,
      words: [wd(r, [["June", "w06", 2], ["2020", "w06", 3]], 0.05, 0.1, 0.9, 0.09, { style: "label", until: r("w06", 9) - 0.1 }), wd(r, [["€1.9", "w06", 9], ["billion", "w06", 12]], 0, 0.3, 1, 0.24, { slam: true, until: r("w06", 21) - 0.15 }), wd(r, [["two banks in", "w06", 21], ["the Philippines", "w06", 24]], 0.05, 0.6, 0.9, 0.11, {})] }) },
  { id: "B8", seg: "w07", k: 0, lead: 0.05, intent: "a safe opened on nothing: both banks said they had nothing to do with Wirecard", slots: { 0: "safe" },
    props: (t, r) => ({ red: true, plates: [{ slot: 0, trim: 1, push: [1.2, 1.55], pan: [0.05, -0.05] }], whipIn: true,
      words: [wd(r, [["nothing", "w07", 5]], 0, 0.3, 1, 0.3, { style: "red", slam: true }), wd(r, [["to do with Wirecard", "w07", 6]], 0.05, 0.68, 0.9, 0.08, { style: "label" })] }) },
  { id: "B9", seg: "w08", k: 0, lead: 0.05, intent: "handcuffs, police light: the chief executive arrested", slots: { 0: "cuffs", 1: "police" },
    props: (t, r) => ({ red: true, plates: [{ slot: 0, push: [1.15, 1.5], pan: [-0.05, 0.05] }], strobe: [0, 99], inF: 5, whipOut: true,
      words: [wd(r, [["within a week", "w08", 0]], 0.05, 0.1, 0.9, 0.08, { style: "label" }), wd(r, [["arrested", "w08", 7]], 0, 0.42, 1, 0.26, { style: "red", slam: true })] }) },
  { id: "B10", seg: "w08", k: 8, lead: 0.05, intent: "the chart falling off a cliff: the first DAX company ever to go bust", slots: { 0: "crash" },
    props: (t, r) => ({ red: true, plates: [{ slot: 0, push: [1.2, 1.7], pan: [0.08, -0.08], rot: [-4, 3] }], data: { n: 50, from: 0, speed: 0.02 }, whipIn: true, whipOut: true,
      words: [wd(r, [["the first", "w08", 10], ["DAX company", "w08", 12]], 0.05, 0.12, 0.9, 0.1, { style: "label", until: r("w08", 16) - 0.1 }), wd(r, [["ever to", "w08", 14], ["go bust", "w08", 16]], 0, 0.36, 1, 0.24, { style: "red", slam: true })] }) },
  { id: "B11", seg: "w08", k: 18, lead: 0.05, intent: "Marsalek's Munich villa; a private jet rolling; a counting machine spitting notes: paid in cash", slots: { 0: "villa", 1: "jet", 2: "counter" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.1, 1.6], pan: [0.05, -0.05] }, { slot: 1, at: r("w08", 27) - 0.1, trim: 6, push: [1.1, 1.45], pan: [-0.06, 0.06] }, { slot: 2, at: r("w08", 33) - 0.1, push: [1.2, 1.5] }], money: { n: 32, from: r("w08", 33) - 0.2, speed: 0.016 }, whipIn: true, outF: 4,
      words: [wd(r, [["chief operating officer", "w08", 20]], 0.05, 0.1, 0.9, 0.07, { style: "label", until: r("w08", 23) - 0.1 }), wd(r, [["Jan", "w08", 23], ["Marsalek", "w08", 24]], 0, 0.36, 1, 0.22, { slam: true, enter: "spin", until: r("w08", 27) - 0.15 }), wd(r, [["private jet", "w08", 29], ["to Minsk", "w08", 31]], 0, 0.14, 1, 0.14, { slam: true, until: r("w08", 33) - 0.15 }), wd(r, [["paid in cash", "w08", 33]], 0, 0.4, 1, 0.2, { slam: true })] }) },
  { id: "B12", seg: "w09", k: 0, lead: 0.05, intent: "a note burning: a €24 billion company built on money that was never there", slots: { 0: "euros", 7: "fire" },
    props: (t, r) => ({ red: true, lightTrim: 3, lightFilter: "saturate(1.25)", lightOpacity: 0.75, plates: [{ slot: 0, push: [1.15, 1.6], pan: [0.03, -0.03], grade: "saturate(0.9) contrast(1.35) brightness(0.62)" }], inF: 7,
      words: [wd(r, [["€24 billion", "w09", 6]], 0.05, 0.12, 0.9, 0.11, { until: r("w09", 15) - 0.1 }), wd(r, [["money that was", "w09", 15], ["never there", "w09", 18, true]], 0, 0.36, 1, 0.17, { style: "red", slam: true })] }) },
];
const TITLE_AT = +(timed.durationS + 0.25).toFixed(2), TITLE_LEN = 2.8;
const starts = BEATS.map((b) => (b.id === "B1" ? 0 : +(at(b.seg, b.k) - (b.lead ?? 0.05)).toFixed(2)));
const dur = +(TITLE_AT + TITLE_LEN).toFixed(2);

// ---- the job ----
const pub = path.join(job, "public");
await mkdir(path.join(pub, "media"), { recursive: true });
const media: ResolvedMedia[] = [];
const probe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f]).toString()) as { streams: Array<{ width: number; height: number }>; format: { duration?: string } };
async function place(shotId: string, key: string, slot: number) {
  const m = MEDIA[key]!;
  const out = path.join(pub, "media", `${shotId}_${key}${path.extname(m.file)}`);
  if (!existsSync(out)) await copyFile(path.join(job, m.file), out);
  const p = probe(out);
  media.push({ shotId, role: "layer", origin: m.origin, slot, ref: `${m.provider}:${key}`, provider: m.provider, kind: m.kind, localPath: out, publicPath: `media/${path.basename(out)}`, ...(m.kind === "video" && p.format.duration ? { durationS: Number(p.format.duration) } : {}), width: p.streams[0]?.width, height: p.streams[0]?.height, license: m.license, attributionRequired: true, attributionText: m.credit, sourceUrl: m.url, aiGenerated: false, score: 1, query: "chosen by eye" } as ResolvedMedia);
}
const shots = [] as Storyboard["shots"];
const scenes: SceneSpec[] = [];
for (const [i, b] of BEATS.entries()) {
  const t0 = starts[i]!, t1 = starts[i + 1] ?? TITLE_AT;
  for (const [slot, key] of Object.entries(b.slots)) await place(b.id, key, Number(slot));
  const r = (seg: string, k: number) => +(at(seg, k) - t0).toFixed(2);
  shots.push({ schemaVersion: 2, id: b.id, scriptSegmentId: b.seg, index: i, startS: t0, endS: t1, intent: b.intent, lineLink: "literal", source: { kind: "designed", designed: "scene", props: { brief: b.intent }, assetIds: [] }, camera: { type: "static" }, overlays: [], sfx: [], transitionIn: "cut" } as Storyboard["shots"][number]);
  scenes.push({ shotId: b.id, idea: b.intent, backdrop: "stage", dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, finish: { grain: 0.24, vignette: 0.2, leak: 0 }, elements: [{ type: "component", name: "Beat", x: 0, y: 0, w: 1, h: 1, rot: 0, z: 0.8, at: 0, enter: "fade", props: { ...b.props(t0, r), len: +(t1 - t0).toFixed(2) } }] } as unknown as SceneSpec);
}
shots.push({ schemaVersion: 2, id: "TITLE", scriptSegmentId: "w09", index: BEATS.length, startS: TITLE_AT, endS: dur, intent: "the title card", lineLink: "literal", source: { kind: "designed", designed: "scene", props: { brief: "title" }, assetIds: [] }, camera: { type: "static" }, overlays: [], sfx: [], transitionIn: "cut" } as Storyboard["shots"][number]);
scenes.push({ shotId: "TITLE", idea: "title", backdrop: "stage", dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, finish: { grain: 0.2, vignette: 0.2, leak: 0 }, elements: [{ type: "component", name: "Title", x: 0, y: 0, w: 1, h: 1, rot: 0, z: 0.8, at: 0, enter: "fade", props: { title: "Wirecard", subtitle: "The €24 billion company built on money that wasn't there", len: TITLE_LEN } }] } as unknown as SceneSpec);

// ---- sound: modest hits on the slams; two beds, the change on the turn ("But when a reporter…") ----
const prof = JSON.parse(await readFile(path.join(root, "data", "audio-profile.json"), "utf8")) as { sfx: Record<string, { attackS: number }> };
const HITS: Array<[string, number, number]> = [
  ["b7a2ca48ea6b721a", at("w02", 9) + 0.05, -12], // whoosh-impact: WIRECARD shoves COMMERZBANK out
  ["a9040acf25874da1", at("w05", 2) + 0.05, -12], // metal hit: bets banned
  ["56beec7833560f0f", at("w08", 16) + 0.1, -10], // big impact: go bust
  ["8c00d5c5698ec474", TITLE_AT + 0.1, -9], // long boom: the title
  ["35464f0613107c92", starts[1]! - 0.08, -16], // whoosh: the whip into the headquarters
  ["0dd08adcb9353b5a", starts[9]! - 0.08, -16], // whoosh: the whip into the crash
];
for (const [id, moment, gain] of HITS) {
  const atS = Math.max(0, +(moment - (prof.sfx[id]?.attackS ?? 0)).toFixed(3));
  (shots.find((x) => atS >= x.startS && atS < x.endS) ?? shots.at(-1)!).sfx.push({ assetId: id, atS, gainDb: gain });
}
const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(root, "data", "library-index.json"), "utf8")));
const turn = +(at("w04", 0) - 0.3).toFixed(2);
const lv = await levelBeds({ music: [{ assetId: "39077750b3a7cb24", startS: 0, endS: turn + 0.6, gainDb: 0 }, { assetId: "83a05b4dfa79db82", startS: turn, endS: dur, gainDb: 0, duckDb: -9 }], fileOf: (id) => { const a = index.assets.find((x) => x.id === id); return a ? path.join(root, "Library", a.relPath) : null; }, titleCardEndS: turn + 1, cacheDir: path.join(root, "data", ".cache") });
lv.music[1]!.gainDb += 4.5; // the second bed is still the cold open (≈ 10.5 dB under the voice, not the body's 15)
console.log("beds:", lv.notes.join(" | "));
let board = Storyboard.parse({ schemaVersion: 1, id: "sb_hand_wirecard", scriptId: timed.id, styleProfileId: "magnates-media", aspect: "16:9", durationS: dur, shots, music: lv.music.map((m, k) => ({ ...m, mood: k ? "tension" : "rise", drops: [] })), generatedAt: new Date().toISOString() });
let resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 0, stock: media.filter((m) => m.origin === "stock").length, archival: media.filter((m) => m.origin === "archival").length, designed: shots.length }, generatedAt: new Date().toISOString() });
resolution = await resolveAudio({ storyboard: board, index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution });
const plan = ScenePlan.parse({ schemaVersion: 2, storyboardId: board.id, scenes, generatedAt: new Date().toISOString() });
const design = FilmDesignSystem.parse({ schemaVersion: 2, id: "hand-wirecard", channelId: "magnates-media", topic: "Wirecard", concept: "Numbers on glass: an empire of payments that existed as numbers on screens. Cold steel and ice-white light, electric cyan while it rises, warning red when it falls; League Gothic for the key words; every frame travelling.",
  palette: { primary: "#0a1420", primarySoft: "#12263a", accent: "#3fe0ff", accentDeep: "#1e8cff", surface: "#05090f", surfaceAlt: "#0d1b2a", paper: "#eaf6ff", marker: "#ff2d3d", text: "#eaf6ff", textMuted: "#9fb6c8" },
  fonts: { display: "League Gothic", body: "Fjalla One" }, texture: { grain: 0.2, vignette: 0.25 }, acts: [{ name: "cold open", tint: "#1e8cff", tintStrength: 0.04, saturation: 1.0, contrast: 1.1, brightness: 1.0 }], generatedAt: new Date().toISOString() });
for (const [f, v] of [["storyboard.json", board], ["resolution.json", resolution], ["scenes.json", plan], ["design.json", design]] as const) await writeFile(path.join(job, f), JSON.stringify(v, null, 2));
await writeFile(path.join(job, "job.json"), JSON.stringify({ channel: "magnates-media", aspect: "16:9", topic: "Wirecard", hand: true }, null, 2));
const manifest = await buildManifest({ storyboard: board, script: { ...timed, durationS: dur - 0.6 }, resolution, libraryRoot: path.join(root, "Library"), outputPath: path.join(job, "film.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: false, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
await writeFile(path.join(job, "manifest.json"), JSON.stringify(manifest, null, 2));
if (process.argv.includes("--manifest-only")) process.exit(0);
const look = { accent: "#3fe0ff", saturate: 1.0, contrast: 1.08, vignette: 0.45, grain: 0.22 };
const silent = path.join(job, "video_silent.mp4"), master = path.join(job, "master.wav"), film = path.join(job, "film_16x9.mp4");
if (process.argv.includes("--stretch")) {
  const [a, b] = process.argv[process.argv.indexOf("--stretch") + 1]!.split("-").map(Number) as [number, number];
  await renderStretches({ manifest, look, design, publicDir: pub, previous: silent, out: `${silent}.next.mp4`, ranges: [[Math.round(a * FPS), Math.round(b * FPS)]], log: console.log });
  await rename(`${silent}.next.mp4`, silent); await masterAudio(manifest, master); await muxFinal(silent, master, film);
  console.log("rendered", film, `(seconds ${a}–${b})`);
} else if (process.argv.includes("--mix")) {
  await masterAudio(manifest, master); await muxFinal(silent, master, film); console.log("remixed", film);
} else if (process.argv.includes("--render")) {
  await renderVideo({ manifest, look, design, publicDir: pub, out: silent, log: console.log }); await masterAudio(manifest, master); await muxFinal(silent, master, film);
  console.log("rendered", film);
} else {
  const prev = await renderShotPreviews({ manifest, look, design, publicDir: pub, outDir: path.join(job, "previews"), shotIds: only ? [...only] : board.shots.map((s) => s.id), log: console.log });
  console.log(prev.map((p) => p.sheet).filter(Boolean).length, "preview sheets");
}
