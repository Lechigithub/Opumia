// Hand-made film, shot by shot (session-designed, no model): storyboard, resolution (real media copied into public/),
// scenes, design tokens → manifest → previews (and, with --render, the film).
//   OPUMIA_NO_CLAUDE=1 npx tsx apps/cli/src/dev/hand/build.ts out/hand-ftx [--only S05,S06] [--render]
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { FilmDesignSystem, LibraryIndex, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ResolvedMedia, type SceneSpec } from "@opumia/contracts";
import { buildManifest, renderShotPreviews, renderVideo, masterAudio, muxFinal } from "@opumia/motion-engine";
import { resolveAtmosphere, resolveAudio } from "@opumia/resolver";

const root = process.cwd();
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]!.split(",")) : null;
const timed = TimedScript.parse(JSON.parse(await readFile(path.join(job, "timed-script.json"), "utf8")));
const W = timed.segments.flatMap((s) => s.words);
const at = (i: number) => W[i]!.startS;
const FPS = 24;
const fr = (shotStart: number, wordIdx: number) => Math.max(0, Math.round((at(wordIdx) - shotStart) * FPS));
const rel = (shotStart: number, wordIdx: number) => Math.max(0, +(at(wordIdx) - shotStart).toFixed(2));

// ---- media catalogue (every file here was chosen by looking at it) ----
type M = { file: string; kind: "video" | "image"; origin: ResolvedMedia["origin"]; provider: ResolvedMedia["provider"]; license: string; credit?: string; url?: string; fair?: { title: string; channel: string; atS: number }; depicts?: string };
const ST = (id: string, credit: string): M => ({ file: `downloads/stock/pexels_${id}.mp4`, kind: "video", origin: "stock", provider: "pexels", license: "Pexels License", credit, url: `https://www.pexels.com/video/${id}/` });
const YT = (name: string, id: string, title: string, channel: string, atS: number, depicts: string): M => ({ file: `downloads/press/${name}.mp4`, kind: "video", origin: "press", provider: "youtube", license: "Fair use (news excerpt under commentary)", url: `https://www.youtube.com/watch?v=${id}`, fair: { title, channel, atS }, depicts });
const CM = (file: string, license: string, credit: string, depicts: string): M => ({ file, kind: "image", origin: "archival", provider: "commons", license, credit, depicts });
const PG = (file: string, url: string, title: string, channel: string, depicts: string): M => ({ file, kind: "image", origin: "press", provider: "web", license: "Fair use (source article shown under commentary)", url, fair: { title, channel, atS: 0 }, depicts });
const MEDIA: Record<string, M> = {
  phone: ST("33942937", "Pexels"), burn100: ST("8370593", "Pexels"), crash1: ST("38687556", "Pexels"), crash2: ST("38859052", "Pexels"),
  coins: ST("30804767", "Pexels"), run: ST("25786069", "Pexels"), gavel: ST("6699964", "Pexels"), fire: ST("11977691", "Pexels"),
  hand: ST("8426049", "Pexels"), walk: ST("14569532", "Pexels"), paperburn: ST("30509780", "Pexels"),
  sbf_bbg: YT("sbf_bloomberg", "HOMA3RxhAPw", "FTX CEO Sam Bankman-Fried: Bloomberg Crypto 09/27/2022", "Bloomberg Television", 251.5, "Sam Bankman-Fried (press)"),
  sbf_cnbc: YT("sbf_cnbc", "PMneW1ZxHSc", "FTX CEO Sam Bankman-Fried on decision to move company to Bahamas", "CNBC Television", 56, "Sam Bankman-Fried (press)"),
  sbf_court: YT("sbf_court_nbc", "vZ5KTF0-Om0", "Sam Bankman-Fried sentenced to 25 years in prison for cryptocurrency fraud", "NBC News", 82, "Sam Bankman-Fried (press)"),
  ray: YT("ray_house", "zEHgEiuniNY", "Watch John Ray Explain FTX Collapse to Congress (Opening Statement)", "CNET Highlights", 236, "John J. Ray III (press)"),
  cz: YT("cz_bloomberg", "rdHDShM_n_Q", "Binance CEO Says Crypto Showing 'Normal Market Behavior'", "Bloomberg Television", 100, "Changpeng Zhao (press)"),
  scrum: YT("court_scrum", "Vr22nHBwFI8", "Sam Bankman-Fried arrives for arraignment hearing in New York", "WKYC Channel 3", 4, "press at the Manhattan federal court (press)"),
  sbf_cnbc_still: { ...YT("sbf_cnbc", "PMneW1ZxHSc", "FTX CEO Sam Bankman-Fried on decision to move company to Bahamas", "CNBC Television", 58, "Sam Bankman-Fried (press frame)"), file: "downloads/press/sbf_cnbc_still.jpg", kind: "image" },
  scrum_still: { ...YT("court_scrum", "Vr22nHBwFI8", "Sam Bankman-Fried arrives for arraignment hearing in New York", "WKYC Channel 3", 6, "press at the court (frame)"), file: "downloads/press/court_scrum_still.jpg", kind: "image" },
  tweet: { ...YT("tweet_cbs", "Pb4NR_MqhdM", "Crypto exchange FTX files for bankruptcy", "CBS Evening News", 78, "Bankman-Fried's 7 Nov 2022 post"), file: "downloads/press/tweet_card.png", kind: "image" },
  cut_sbf: CM("downloads/cut/sbf.png", "CC BY 3.0", "Cointelegraph, CC BY 3.0, via Wikimedia Commons", "Sam Bankman-Fried (cut-out)"),
  cut_cz: CM("downloads/cut/cz.png", "CC BY-SA 4.0", "Aevozer, CC BY-SA 4.0, via Wikimedia Commons", "Changpeng Zhao (cut-out)"),
  cut_sbf_court: { ...YT("sbf_court_nbc", "vZ5KTF0-Om0", "Sam Bankman-Fried sentenced to 25 years in prison for cryptocurrency fraud", "NBC News", 86, "Sam Bankman-Fried at court (cut-out)"), file: "downloads/cut/sbf_court.png", kind: "image" },
  ftx_logo: CM("downloads/commons/FTX_logo.png", "Public domain", "FTX logo, public domain, via Wikimedia Commons", "FTX logo"),
  alameda: CM("downloads/commons/Alameda_Research_logo.png", "Public domain", "Alameda Research logo, public domain, via Wikimedia Commons", "Alameda Research logo"),
  enron: CM("downloads/commons/Logo_of_Enron_Corporation_1997_.png", "Public domain", "Enron logo by Paul Rand, public domain, via Wikimedia Commons", "Enron logo"),
  courthouse: CM("downloads/commons/Daniel_Patrick_Moynihan_United_States_Courthouse_55314001073_.jpg", "CC BY 4.0", "ajay_suresh, CC BY 4.0, via Wikimedia Commons", "Moynihan US Courthouse, Manhattan"),
  coindesk: PG("downloads/pages/coindesk_card2.png", "https://www.coindesk.com/business/2022/11/02/divisions-in-sam-bankman-frieds-crypto-empire-blur-on-his-trading-titan-alamedas-balance-sheet/", "Divisions in Sam Bankman-Fried's Crypto Empire Blur on His Trading Titan Alameda's Balance Sheet", "CoinDesk", "CoinDesk article, 2 Nov 2022"),
  cnbc: PG("downloads/pages/cnbc_card2.png", "https://www.cnbc.com/2022/11/08/cryptocurrencies-slide-as-worries-about-ftx-fester-in-latest-crypto-liquidity-scare.html", "Bitcoin briefly touches a new low for the year, FTX token plunges more than 75%", "CNBC", "CNBC article, 8 Nov 2022"),
  cbs: PG("downloads/pages/cbs_card.png", "https://www.cbsnews.com/news/ftx-bankruptcy-john-ray-ceo-failure/", "FTX's new CEO: Never in my career have I seen such a complete failure", "CBS News", "CBS News article, 17 Nov 2022"),
};

// ---- shots ----
interface Shot { id: string; start: number; seg: string; intent: string; footage?: string; trim?: number; slots?: Record<number, string>; tr?: Storyboard["shots"][number]["transitionIn"]; scene: (t0: number) => Omit<SceneSpec, "shotId" | "idea"> & { idea?: string } }
const cam = (a = 1.0, b = 1.2, x0 = 0.47, x1 = 0.53, y0 = 0.5, y1 = 0.5) => ({ fromScale: a, toScale: b, fromX: x0, toX: x1, fromY: y0, toY: y1 });
const kin = (t0: number, parts: Array<[number | "|", string, string?, boolean?]>) => parts.map(([i, text, c, script]) => (i === "|" ? { text: "|", from: 0 } : { text, from: fr(t0, i), ...(c ? { c } : {}), ...(script ? { script } : {}) }));
const fin = (g = 0.35, v = 0.55, leak = 0) => ({ grain: g, vignette: v, leak });

const SHOTS: Shot[] = [
  { id: "S01", start: 0, seg: "l01", intent: "a message sent at night", footage: "phone", trim: 2, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, camera: cam(1.08, 1.26), finish: fin(0.4, 0.7, 0.3),
      elements: [{ type: "component", name: "Kinetic", x: 0.1, y: 0.36, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { words: kin(t, [[2, "NOVEMBER", "w"], [2, "7", "y"], ["|", ""], [5, "2022", "y"]]), size: 190 } }] }) },
  { id: "S02", start: 2.72, seg: "l01", intent: "Sam Bankman-Fried", slots: { 0: "cut_sbf", 1: "sbf_cnbc_still" }, tr: "film",
    scene: (t) => ({ backdrop: "world", world: { kind: "mono_accent", slot: 1, color: "primary", accent: "accent" }, dim: 0.15, camera: cam(1.0, 1.16), finish: fin(0.35, 0.6, 0.2),
      elements: [
        { type: "cutout", slot: 0, x: 0.46, y: 0.08, w: 0.5, z: 0.6, rot: 0, at: 0, enter: "settle", shadow: true, glow: "accent", contactShadow: 0.5 },
        { type: "component", name: "Label", x: 0.07, y: 0.62, w: 0.42, at: rel(t, 6), z: 0.8, rot: 0, enter: "fade", props: { text: "Sam Bankman-Fried", sub: "Founder of FTX", size: 70 } },
      ] }) },
  { id: "S03", start: 5.8, seg: "l02", intent: "the post: FTX is fine", footage: "sbf_cnbc", trim: 1, slots: { 0: "tweet" }, tr: "flash",
    scene: (t) => ({ backdrop: "footage", dim: 0.5, fx: { dof: 0.7 }, wash: { color: "primary", strength: 0.3, mode: "tint" }, camera: cam(1.1, 1.28), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: 0.1, y: 0.28, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: -2 } }] }) },
  { id: "S04", start: 9.75, seg: "l03", intent: "four days later", footage: "fire", trim: 3, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.2, camera: cam(1.0, 1.18), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.33, w: 0.84, at: 0, z: 0.7, rot: 0, enter: "fade", props: { words: kin(t, [[19, "FOUR", "y"], [20, "DAYS"], [21, "LATER", "w"]]), size: 220 } }] }) },
  { id: "S05", start: 11.05, seg: "l03", intent: "the $32 billion empire burning", footage: "burn100", trim: 1.5, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.25, camera: cam(1.05, 1.23), finish: fin(0.4, 0.55, 0.25),
      elements: [{ type: "component", name: "Counter", x: 0.1, y: 0.3, w: 0.8, at: rel(t, 23), z: 0.75, rot: 0, enter: "fade", props: { prefix: "$", to: 32, suffix: "B", frames: 18, label: "empire", size: 300 } }] }) },
  { id: "S06", start: 13.7, seg: "l03", intent: "bankrupt", footage: "crash1", trim: 4, slots: { 0: "ftx_logo" }, tr: "zoom_punch",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, wash: { color: "accentDeep", strength: 0.35, mode: "tint" }, fx: { glitch: true }, camera: cam(1.1, 1.33), finish: fin(0.4, 0.6),
      elements: [
        { type: "card3d", slot: 0, x: 0.3, y: 0.08, w: 0.4, z: 0.5, rot: 0, at: 0, enter: "zoom", tilt: -8, spin: 18 },
        { type: "component", name: "Stamp", x: 0.24, y: 0.52, w: 0.52, at: rel(t, 28), z: 0.9, rot: 0, enter: "fade", props: { text: "Bankrupt", size: 190 } },
      ] }) },
  { id: "S07", start: 15.2, seg: "l04", intent: "a week before: SBF on air, all smiles", footage: "sbf_bbg", trim: 0.2, tr: "film",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.0, 1.14), finish: fin(0.3, 0.45), elements: [] }) },
  { id: "S08", start: 17.5, seg: "l04", intent: "the leaked balance sheet (CoinDesk)", footage: "sbf_bbg", trim: 0, slots: { 0: "coindesk" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, fx: { dof: 0.75 }, camera: cam(1.0, 1.14), finish: fin(0.35, 0.6, 0.2),
      elements: [{ type: "component", name: "Card", x: 0.12, y: 0.2, w: 0.76, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: 1.5, hl: { x: 0.02, y: 0.62, w: 0.62, h: 0.09, from: fr(t, 41), to: fr(t, 44) + 8 } } }] }) },
  { id: "S09", start: 20.4, seg: "l04", intent: "Alameda's $14.6 billion", footage: "crash2", trim: 2, slots: { 0: "alameda" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, wash: { color: "primary", strength: 0.3, mode: "tint" }, camera: cam(1.08, 1.2, 0.45, 0.55), finish: fin(0.35, 0.6),
      elements: [
        { type: "photo", slot: 0, x: 0.25, y: 0.12, w: 0.5, z: 0.6, rot: 0, at: rel(t, 47), enter: "slide_down", grade: "natural" },
        { type: "component", name: "Counter", x: 0.1, y: 0.38, w: 0.8, at: rel(t, 49), z: 0.8, rot: 0, enter: "fade", props: { prefix: "$", to: 14.6, decimals: 1, suffix: "B", frames: 20, label: "in assets", size: 260 } },
      ] }) },
  { id: "S10", start: 24.15, seg: "l04", intent: "40% was FTT", footage: "crash2", trim: 15, tr: "flash",
    scene: (t) => ({ backdrop: "footage", dim: 0.6, fx: { dof: 0.8 }, camera: cam(1.0, 1.16), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Donut", x: 0.33, y: 0.12, w: 0.34, at: 0, z: 0.7, rot: 0, enter: "fade", props: { share: 0.4, label: "FTT" } }] }) },
  { id: "S11", start: 25.7, seg: "l04", intent: "a token his own exchange had made up", footage: "coins", trim: 0.5, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.2, wash: { color: "accent", strength: 0.2, mode: "tint" }, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.3, w: 0.88, at: 0, z: 0.7, rot: 0, enter: "fade", props: { words: kin(t, [[59, "A TOKEN"], [62, "HE"], ["|", ""], [64, "MADE", "y"], [65, "UP", "y"]]), size: 200 } }] }) },
  { id: "S12", start: 28.5, seg: "l05", intent: "his own coupons", footage: "sbf_cnbc", trim: 0, slots: { 0: "ftx_logo" }, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.4, wash: { color: "primary", strength: 0.5, mode: "duotone" }, drift: { slot: 0, mode: "fall", count: 14 }, camera: cam(1.1, 1.28), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.55, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[73, "HIS OWN"], [75, "coupons", "y", true]]), size: 200 } }] }) },
  { id: "S13", start: 32.55, seg: "l06", intent: "Changpeng Zhao, head of Binance", footage: "cz", trim: 0, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.1, camera: cam(1.0, 1.16), finish: fin(0.3, 0.45),
      elements: [{ type: "component", name: "Label", x: 0.06, y: 0.7, w: 0.42, at: rel(t, 81), z: 0.8, rot: 0, enter: "fade", props: { text: "Changpeng Zhao", sub: "CEO of Binance", size: 70 } }] }) },
  { id: "S14", start: 35.4, seg: "l06", intent: "sell every FTT", footage: "crash2", trim: 8, slots: { 0: "cut_cz" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.5, wash: { color: "accentDeep", strength: 0.4, mode: "tint" }, camera: cam(1.1, 1.28), finish: fin(0.4, 0.6),
      elements: [
        { type: "cutout", slot: 0, x: 0.04, y: 0.18, w: 0.4, z: 0.6, rot: 0, at: 0, enter: "slide_right", shadow: true, glow: "accent", contactShadow: 0.4 },
        { type: "component", name: "Kinetic", x: 0.46, y: 0.24, w: 0.5, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[86, "SELL", "r"], ["|", ""], [87, "EVERY"], ["|", ""], [88, "FTT", "y"]]), size: 190 } },
      ] }) },
  { id: "S15", start: 38.75, seg: "l07", intent: "customers ran", footage: "run", trim: 3, tr: "flash",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.02, 1.18), finish: fin(0.3, 0.45), elements: [] }) },
  { id: "S16", start: 40.8, seg: "l07", intent: "$6 billion out", footage: "crash1", trim: 12, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, wash: { color: "accentDeep", strength: 0.3, mode: "tint" }, camera: cam(1.1, 1.3), finish: fin(0.4, 0.6),
      elements: [
        { type: "component", name: "Counter", x: 0.06, y: 0.28, w: 0.6, at: 0, z: 0.8, rot: 0, enter: "fade", props: { prefix: "$", to: 6, suffix: "B", frames: 14, label: "withdrawn", size: 300 } },
        { type: "component", name: "Arrow", x: 0.62, y: 0.2, w: 0.3, h: 0.6, at: rel(t, 98), z: 0.8, rot: 0, enter: "fade", props: { dir: "down" } },
      ] }) },
  { id: "S17", start: 43.7, seg: "l07", intent: "in 72 hours", footage: "paperburn", trim: 4, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, camera: cam(1.05, 1.23), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.33, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[103, "72", "y"], [104, "HOURS"]]), size: 260 } }] }) },
  { id: "S18", start: 45.65, seg: "l08", intent: "Binance agreed to buy", footage: "hand", trim: 1, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.2, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.08, w: 0.88, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[106, "AGREED"], [107, "TO"], [108, "BUY", "y"]]), size: 170 } }] }) },
  { id: "S19", start: 48.0, seg: "l08", intent: "one day later it walked away", footage: "walk", trim: 0, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.2, camera: cam(1.0, 1.16), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.74, w: 0.6, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[112, "ONE DAY"], [114, "LATER", "y"]]), size: 120, align: "left" } }] }) },
  { id: "S20", start: 50.2, seg: "l08", intent: "beyond our control (Binance's words)", footage: "paperburn", trim: 12, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.57, fx: { dof: 0.6 }, camera: cam(1.1, 1.26), finish: fin(0.4, 0.65),
      elements: [{ type: "component", name: "Quote", x: 0.1, y: 0.22, w: 0.8, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[119, "THE ISSUES"], [121, "ARE"], [122, "BEYOND", "y"], [123, "OUR"], [124, "CONTROL", "y"], [125, "OR"], [126, "ABILITY"], [127, "TO"], [128, "HELP."]]), by: "Binance, 9 November 2022", byFrom: fr(t, 128) + 4, size: 110 } }] }) },
  { id: "S21", start: 54.6, seg: "l09", intent: "John J. Ray III, sent in to clean up", footage: "ray", trim: 0, tr: "flash",
    scene: (t) => ({ backdrop: "footage", dim: 0.1, camera: cam(1.0, 1.16), finish: fin(0.3, 0.45),
      elements: [{ type: "component", name: "Label", x: 0.06, y: 0.72, w: 0.42, at: rel(t, 130), z: 0.8, rot: 0, enter: "fade", props: { text: "John J. Ray III", sub: "New CEO of FTX", size: 70 } }] }) },
  { id: "S22", start: 57.55, seg: "l09", intent: "Enron", footage: "paperburn", trim: 20, slots: { 0: "enron" }, tr: "zoom_punch",
    scene: () => ({ backdrop: "footage", dim: 0.35, camera: cam(1.0, 1.23), finish: fin(0.35, 0.6, 0.3),
      elements: [{ type: "card3d", slot: 0, x: 0.3, y: 0.06, w: 0.4, z: 0.6, rot: 0, at: 0, enter: "zoom", tilt: -10, spin: 30 },
        { type: "component", name: "Kinetic", x: 0.1, y: 0.74, w: 0.8, at: 0.05, z: 0.8, rot: 0, enter: "fade", props: { words: [{ text: "ENRON", from: 0, c: "w" }, { text: "2001", from: 6, c: "y" }], size: 120 } }] }) },
  { id: "S23", start: 58.6, seg: "l09", intent: "never such a complete failure (CBS)", footage: "ray", trim: 0.5, slots: { 0: "cbs" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, fx: { dof: 0.75 }, camera: cam(1.0, 1.14), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: 0.24, y: 0.06, w: 0.52, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: -1.5, hl: { x: 0.02, y: 0.79, w: 0.95, h: 0.11, from: fr(t, 147), to: fr(t, 155) } } }] }) },
  { id: "S24", start: 64.2, seg: "l10", intent: "March 2024, the court", footage: "scrum", trim: 0, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.25, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.34, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[157, "MARCH", "w"], [158, "2024", "y"]]), size: 220 } }] }) },
  { id: "S25", start: 65.95, seg: "l10", intent: "sentenced to 25 years", footage: "sbf_court", trim: 2.5, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.2, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Counter", x: 0.5, y: 0.3, w: 0.46, at: rel(t, 163), z: 0.8, rot: 0, enter: "fade", props: { to: 25, frames: 16, label: "years", size: 300 } }] }) },
  { id: "S26", start: 69.05, seg: "l10", intent: "for stealing $8 billion", footage: "gavel", trim: 1, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.35, camera: cam(1.05, 1.23), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.3, w: 0.88, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[166, "STEALING", "r"], ["|", ""], [167, "$8 BILLION", "y"]]), size: 210 } }] }) },
  { id: "S27", start: 72.9, seg: "l11", intent: "the judge (Manhattan federal court)", footage: "courthouse", tr: "film",
    scene: () => ({ backdrop: "footage", dim: 0.15, camera: cam(1.0, 1.1, 0.5, 0.5, 0.45, 0.4), finish: fin(0.35, 0.55), elements: [] }) },
  { id: "S28", start: 74.75, seg: "l11", intent: "he knew it was criminal", slots: { 0: "cut_sbf_court", 1: "scrum_still" }, tr: "cut",
    scene: (t) => ({ backdrop: "world", world: { kind: "mono_accent", slot: 1, color: "primary", accent: "accentDeep" }, dim: 0.25, camera: cam(1.0, 1.16), finish: fin(0.45, 0.65),
      elements: [
        { type: "cutout", slot: 0, x: 0.52, y: 0.06, w: 0.46, z: 0.6, rot: 0, at: 0, enter: "settle", shadow: true, glow: "accent" },
        { type: "component", name: "Kinetic", x: 0.04, y: 0.3, w: 0.5, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[181, "HE KNEW"], ["|", ""], [184, "CRIMINAL", "r"]]), size: 150, align: "left" } },
      ] }) },
  { id: "S29", start: 76.65, seg: "l11", intent: "a very bad bet", footage: "sbf_court", trim: 0, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.4, wash: { color: "primary", strength: 0.6, mode: "duotone" }, camera: cam(1.05, 1.33), finish: fin(0.45, 0.75),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.36, w: 0.88, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[189, "A VERY"], [190, "BAD", "r"], [191, "BET", "y"]]), size: 230 } }] }) },
];

// ---- write the job ----
const dur = +(timed.durationS + 0.6).toFixed(2);
const pub = path.join(job, "public");
await mkdir(path.join(pub, "media"), { recursive: true });
const media: ResolvedMedia[] = [];
const probe = (f: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f]).toString();
async function place(shotId: string, key: string, role: "primary" | "layer", slot?: number) {
  const m = MEDIA[key]!;
  const src = path.join(job, m.file);
  const out = path.join(pub, "media", `${shotId}_${key}${path.extname(m.file)}`);
  if (!existsSync(out)) await copyFile(src, out);
  const p = JSON.parse(probe(out)) as { streams: Array<{ width: number; height: number }>; format: { duration?: string } };
  media.push({ shotId, role, origin: m.origin, ...(slot !== undefined ? { slot } : {}), ...(m.depicts ? { depicts: m.depicts } : {}), ...(m.fair ? { fairUse: { sourceTitle: m.fair.title, channel: m.fair.channel, atS: m.fair.atS, usedS: 0, reason: "news excerpt / source shown under commentary, muted, reframed and graded" } } : {}),
    ref: `${m.provider}:${key}`, provider: m.provider, kind: m.kind, localPath: out, publicPath: `media/${path.basename(out)}`, ...(m.kind === "video" && p.format.duration ? { durationS: Number(p.format.duration) } : {}),
    width: p.streams[0]?.width, height: p.streams[0]?.height, license: m.license, attributionRequired: m.origin !== "stock" || true, ...(m.credit ? { attributionText: m.credit } : {}), ...(m.url ? { sourceUrl: m.url } : {}), aiGenerated: false, score: 1, query: "chosen by eye" } as ResolvedMedia);
}
const shots = [] as Storyboard["shots"];
const scenes: SceneSpec[] = [];
for (const [i, s] of SHOTS.entries()) {
  const end = SHOTS[i + 1]?.start ?? dur;
  if (s.footage) await place(s.id, s.footage, "primary");
  for (const [slot, key] of Object.entries(s.slots ?? {})) await place(s.id, key, "layer", Number(slot));
  const fp = s.footage ? MEDIA[s.footage]! : null;
  shots.push({ schemaVersion: 2, id: s.id, scriptSegmentId: s.seg, index: i, startS: s.start, endS: end, intent: s.intent, lineLink: "literal",
    source: { kind: "designed", designed: "scene", props: { brief: s.intent }, assetIds: [] }, ...(s.trim !== undefined && fp?.kind === "video" ? { trimInS: s.trim } : {}),
    camera: { type: "static" }, overlays: [], sfx: [], transitionIn: s.tr ?? "cut" } as Storyboard["shots"][number]);
  scenes.push({ shotId: s.id, idea: s.intent, ...s.scene(s.start) } as SceneSpec);
}
// ---- sound: hits peak on the visual moment (start = moment − measured attack); beds change at the turns ----
const prof = JSON.parse(await readFile(path.join(root, "data", "audio-profile.json"), "utf8")) as { sfx: Record<string, { attackS: number }> };
const HITS: Array<[string, number, number]> = [
  ["608bd9f4437bc222", at(19), -4], // boom: FOUR days later
  ["506353c7272f6de3", at(28), -2], ["1794a26d359d39b5", at(28), -6], // stamp: BANKRUPT
  ["c8eac9e229c3fd1c", 24.15, -8], // whoosh-hit into the 40 %
  ["e8e77cb57b045804", at(73), -12], // coins under "his own coupons"
  ["f0ecbbabe0339b24", at(86), -4], // SELL
  ["3c04c2822cfb527f", 38.75, -8], // riser into "customers ran"
  ["5b238f52f756cf20", at(95), -5], // $6B
  ["f5e1453e264ceac1", 57.55, -5], // Enron
  ["76f884fedb10e13b", at(163) + 0.67, -4], // 25 lands
  ["f112c4720b330a9e", at(191), -3], // BET
];
for (const [id, moment, gain] of HITS) {
  const atS = Math.max(0, +(moment - (prof.sfx[id]?.attackS ?? 0)).toFixed(3));
  const sh = shots.find((x) => atS >= x.startS && atS < x.endS) ?? shots.at(-1)!;
  sh.sfx.push({ assetId: id, atS, gainDb: gain });
}
const MUSIC = [
  { assetId: "17d16bdc91e20542", startS: 0, endS: 38.75, gainDb: -17, mood: "tension" as const, drops: [{ startS: 9.1, endS: 9.85 }, { startS: 37.9, endS: 38.75 }] },
  { assetId: "a5b692a28d20ada4", startS: 38.75, endS: 64.2, gainDb: -18, mood: "collapse" as const, drops: [{ startS: 56.9, endS: 57.55 }] },
  { assetId: "55e3d88a31ecffee", startS: 64.2, endS: dur, gainDb: -17, mood: "resolve" as const, drops: [{ startS: 76.2, endS: 76.65 }] },
];
let board = Storyboard.parse({ schemaVersion: 1, id: "sb_hand_ftx", scriptId: timed.id, styleProfileId: "magnates-media", aspect: "16:9", durationS: dur, shots, music: [], generatedAt: new Date().toISOString() });
board = Storyboard.parse({ ...board, music: MUSIC });
let resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 0, stock: media.filter((m) => m.origin === "stock").length, archival: media.filter((m) => m.origin === "archival").length, designed: shots.length }, generatedAt: new Date().toISOString() });
const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(root, "data", "library-index.json"), "utf8")));
const atm = await resolveAtmosphere({ storyboard: board, scenes: scenes.map((s) => ({ shotId: s.shotId, ...(s.atmos ? { atmos: s.atmos } : {}) })), index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution, seed: "hand-ftx" });
board = atm.storyboard; resolution = atm.resolution;
resolution = await resolveAudio({ storyboard: board, index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution });
const plan = ScenePlan.parse({ schemaVersion: 2, storyboardId: board.id, scenes, generatedAt: new Date().toISOString() });
const design = FilmDesignSystem.parse({ schemaVersion: 2, id: "hand-ftx", channelId: "magnates-media", topic: "FTX", concept: "The receipt: gold light on black money; claims land as huge condensed caps; documents taped down and highlighted; every cut a burst of gold light.",
  palette: { primary: "#3a2408", primarySoft: "#8a6420", accent: "#ffcc00", accentDeep: "#ff2b2b", surface: "#0b0806", surfaceAlt: "#1c140a", paper: "#f4efe4", marker: "#ffcc00", text: "#ffffff", textMuted: "#d9cdb5" },
  fonts: { display: "Anton", body: "Oswald" }, texture: { grain: 0.22, vignette: 0.55 }, acts: [{ name: "fall", tint: "#ffb000", tintStrength: 0.08, saturation: 1.12, contrast: 1.12, brightness: 1.1 }], generatedAt: new Date().toISOString() });
for (const [f, v] of [["storyboard.json", board], ["resolution.json", resolution], ["scenes.json", plan], ["design.json", design]] as const) await writeFile(path.join(job, f), JSON.stringify(v, null, 2));
await writeFile(path.join(job, "job.json"), JSON.stringify({ channel: "magnates-media", aspect: "16:9", topic: "How FTX collapsed in four days", hand: true }, null, 2));

const sceneMap = new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x]));
const manifest = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: path.join(root, "Library"), outputPath: path.join(job, "film.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: false, scenes: sceneMap });
await writeFile(path.join(job, "manifest.json"), JSON.stringify(manifest, null, 2));
const look = { accent: "#ffcc00", saturate: 1.05, contrast: 1.08, vignette: 0.55, grain: 0.25 };
if (process.argv.includes("--render")) {
  const silent = path.join(job, "video_silent.mp4"), master = path.join(job, "master.wav");
  await renderVideo({ manifest, look, design, publicDir: pub, out: silent, log: console.log });
  await masterAudio(manifest, master);
  await muxFinal(silent, master, path.join(job, "film_16x9.mp4"));
  console.log("rendered", path.join(job, "film_16x9.mp4"));
} else {
  const prev = await renderShotPreviews({ manifest, look, design, publicDir: pub, outDir: path.join(job, "previews"), shotIds: only ? [...only] : board.shots.map((s) => s.id), log: console.log });
  console.log(prev.map((p) => p.sheet).filter(Boolean).length, "preview sheets");
}
