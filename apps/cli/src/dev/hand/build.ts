// Hand-made film, shot by shot (session-designed, no model): storyboard, resolution (real media copied into public/),
// scenes, design tokens → manifest → previews (and, with --render, the film).
//   OPUMIA_NO_CLAUDE=1 npx tsx apps/cli/src/dev/hand/build.ts out/hand-ftx [--only S05,S06] [--render]
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { FilmDesignSystem, LibraryIndex, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ResolvedMedia, type SceneSpec } from "@opumia/contracts";
const LOWKEY = Number(process.env.LOWKEY ?? 0.22);
import { buildManifest, renderShotPreviews, renderVideo, masterAudio, muxFinal } from "@opumia/motion-engine";
import { resolveAtmosphere, resolveAudio } from "@opumia/resolver";

const root = process.cwd();
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]!.split(",")) : null;
// the narration in use (NARRATOR=marcus → timed-script-marcus.json); cut points were designed on Christopher's timing
// and are carried over word by word (warp), so every cut stays on the same word
const NARRATOR = process.env.NARRATOR ?? "marcus2";
const WARP = NARRATOR !== "marcus2"; // the v1 script's narrations were cut on Christopher's timings and warped
const timed = TimedScript.parse(JSON.parse(await readFile(path.join(job, `timed-script-${NARRATOR}.json`), "utf8")));
const W = timed.segments.flatMap((s) => s.words);
const OLD = TimedScript.parse(JSON.parse(await readFile(path.join(job, "timed-script-christopher.json"), "utf8"))).segments.flatMap((s) => s.words);
const warp = (t: number) => {
  if (!WARP) return t;
  if (t <= OLD[0]!.startS) return Math.max(0, t - OLD[0]!.startS + W[0]!.startS);
  for (let k = 0; k < OLD.length - 1; k++) if (t < OLD[k + 1]!.startS) return W[k]!.startS + ((t - OLD[k]!.startS) / Math.max(0.01, OLD[k + 1]!.startS - OLD[k]!.startS)) * (W[k + 1]!.startS - W[k]!.startS);
  return t - OLD.at(-1)!.startS + W.at(-1)!.startS;
};
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
  queue: ST("6229548", "Pexels"), pile: ST("6266286", "Pexels"), spread: ST("5466776", "Pexels"), btc: ST("4406964", "Pexels"), cables: ST("1085656", "Pexels"),
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
interface Shot { id: string; start: number; seg: string; intent: string; footage?: string; trim?: number; slots?: Record<number, string>; tr?: Storyboard["shots"][number]["transitionIn"]; /** a still hold: no camera move (the channel holds ~4 % of the time) */ hold?: boolean; /** the storyboard camera's horizontal centre, from → to (default 0.5 ± 0.1, alternating) */ panX?: [number, number]; scene: (t0: number) => Omit<SceneSpec, "shotId" | "idea"> & { idea?: string } }
const cam = (a = 1.0, b = 1.2, x0 = 0.47, x1 = 0.53, y0 = 0.5, y1 = 0.5) => ({ fromScale: a, toScale: b, fromX: x0, toX: x1, fromY: y0, toY: y1 });
const kin = (t0: number, parts: Array<[number | "|", string, string?, boolean?]>) => parts.map(([i, text, c, script]) => (i === "|" ? { text: "|", from: 0 } : { text, from: fr(t0, i), ...(c ? { c } : {}), ...(script ? { script } : {}) }));
const fin = (g = 0.35, v = 0.55, leak = 0) => ({ grain: g, vignette: v, leak });

const SHOTS: Shot[] = [
  { id: "S01", start: 0, seg: "l01", intent: "a message sent at night", footage: "phone", trim: 2, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, camera: cam(1.0, 1.4), finish: fin(0.4, 0.7, 0.3), atmos: { kind: "dust", opacity: 0.6 },
      elements: [{ type: "component", name: "Kinetic", x: 0.1, y: 0.36, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { words: kin(t, [[2, "NOVEMBER", "w"], [2, "7", "y"], ["|", ""], [5, "2022", "y"]]), size: 190 } }] }) },
  { id: "S02", start: 2.9, seg: "l01", intent: "Sam Bankman-Fried", slots: { 0: "cut_sbf", 1: "sbf_cnbc_still" }, tr: "film",
    scene: (t) => ({ backdrop: "world", atmos: { kind: "leak", opacity: 0.6 }, world: { kind: "mono_accent", slot: 1, color: "primary", accent: "accent" }, dim: 0.15, camera: cam(1.0, 1.16), finish: fin(0.35, 0.6, 0.2),
      elements: [
        { type: "cutout", slot: 0, x: 0.46, y: 0.08, w: 0.5, z: 0.6, rot: 0, at: 0, enter: "settle", shadow: true, outline: true, contactShadow: 0.5 },
        { type: "component", name: "Name", x: 0.04, y: 0.26, w: 0.46, at: rel(t, 7), z: 0.8, rot: 0, enter: "fade", props: { text: "Sam | Bankman-Fried", role: "founder of FTX" } },
      ] }) },
  { id: "S02b", start: 4.0, seg: "l01", intent: "has a message for the world", footage: "sbf_cnbc", trim: 3, tr: "cut",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.05, 1.25), finish: fin(0.35, 0.5, 0.2), elements: [] }) },
  { id: "S03", start: 5.62, seg: "l02", intent: "the post: FTX is fine", footage: "phone", trim: 8, slots: { 0: "tweet" }, tr: "flash",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.7 }, wash: { color: "primary", strength: 0.3, mode: "tint" }, camera: cam(1.1, 1.28), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: 0.1, y: 0.28, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: -2 } }] }) },
  { id: "S03b", start: 7.3, seg: "l02", intent: "assets are fine (punch in)", footage: "phone", trim: 10, slots: { 0: "tweet" }, tr: "zoom_punch",
    scene: () => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.8 }, camera: cam(1.1, 1.3), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: -0.12, y: -0.05, w: 1.5, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: -3 } }] }) },
  { id: "S04", start: 9.3, seg: "l03", intent: "four days later", footage: "fire", trim: 3, tr: "film",
    scene: (t) => ({ backdrop: "footage", atmos: { kind: "embers", opacity: 0.7 }, dim: 0.2, camera: cam(1.0, 1.18), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.33, w: 0.84, at: 0, z: 0.7, rot: 0, enter: "fade", props: { words: kin(t, [[21, "Four"], [22, "days"], [23, "later", "y"]]), size: 150, font: "wide" } }] }) },
  { id: "S05", start: 10.5, seg: "l03", intent: "the $32 billion empire burning", footage: "burn100", trim: 1.5, tr: "cut",
    scene: (t) => ({ backdrop: "footage", atmos: { kind: "money", opacity: 0.8 }, dim: 0.25, camera: cam(1.05, 1.23), finish: fin(0.4, 0.55, 0.25),
      elements: [{ type: "component", name: "Counter", x: 0.1, y: 0.2, w: 0.8, at: rel(t, 25), z: 0.75, rot: 0, enter: "fade", props: { prefix: "$", to: 32, suffix: " BILLION", frames: 18, label: "an empire worth" } }] }) },
  { id: "S06", start: 12.7, seg: "l03", intent: "bankrupt", footage: "crash1", trim: 4, slots: { 0: "ftx_logo" }, tr: "zoom_punch",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, wash: { color: "accentDeep", strength: 0.35, mode: "tint" }, fx: { glitch: true }, camera: cam(1.1, 1.33), finish: fin(0.4, 0.6),
      elements: [
        { type: "card3d", slot: 0, x: 0.3, y: 0.08, w: 0.4, z: 0.5, rot: 0, at: 0, enter: "zoom", tilt: -8, spin: 18 },
        { type: "component", name: "Stamp", x: 0.24, y: 0.52, w: 0.52, at: rel(t, 30), z: 0.9, rot: 0, enter: "fade", props: { text: "Bankrupt", size: 190 } },
      ] }) },
  { id: "S07", start: 14.1, seg: "l03", intent: "so how does a company worth that much vanish? (SBF on air, all smiles)", footage: "sbf_bbg", trim: 0.2, tr: "film",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.0, 1.14), finish: fin(0.3, 0.45), elements: [] }) },
  { id: "S07b", start: 16.4, seg: "l03", intent: "vanish in less than a week", footage: "paperburn", trim: 0, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, camera: cam(1.05, 1.22), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.3, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[41, "LESS THAN"], ["|", ""], [43, "A WEEK", "y"]]), size: 170, font: "wide" } }] }) },
  { id: "S07c", start: 18.25, seg: "l03", intent: "it started with one document (a data room)", footage: "cables", trim: 4, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.35, camera: cam(1.05, 1.25), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.34, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[48, "ONE"], [49, "DOCUMENT", "y"]]), size: 170, font: "wide" } }] }) },
  { id: "S08", start: 20.85, seg: "l03", intent: "the leaked balance sheet (CoinDesk)", footage: "sbf_bbg", trim: 0, slots: { 0: "coindesk" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.75 }, camera: cam(1.0, 1.14), finish: fin(0.35, 0.6, 0.2),
      elements: [{ type: "component", name: "Card", x: 0.1, y: 0.26, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: 1.5, aspect: 305 / 780, crop: { y0: 0.12, y1: 0.7 }, hl: { x: 0.02, y: 0.75, w: 0.74, h: 0.15, from: fr(t, 55), to: fr(t, 59) + 8 } } }] }) },
  { id: "S09", start: 24.7, seg: "l04", intent: "Alameda's $14.6 billion", footage: "spread", trim: 2, slots: { 0: "alameda" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, wash: { color: "primary", strength: 0.3, mode: "tint" }, fx: { dof: 0.6 }, camera: cam(1.08, 1.2, 0.45, 0.55), finish: fin(0.35, 0.6),
      elements: [
        { type: "photo", slot: 0, x: 0.25, y: 0.12, w: 0.5, z: 0.6, rot: 0, at: 0, enter: "slide_down", grade: "natural" },
        { type: "component", name: "Counter", x: 0.1, y: 0.34, w: 0.8, at: rel(t, 66), z: 0.8, rot: 0, enter: "fade", props: { prefix: "$", to: 14.6, decimals: 1, suffix: " BILLION", frames: 20, label: "in assets" } },
      ] }) },
  { id: "S10", start: 23.7, seg: "l04", intent: "40% was FTT", footage: "btc", trim: 2, tr: "flash",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.8 }, camera: cam(1.0, 1.16), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Donut", x: 0.33, y: 0.12, w: 0.34, at: 0, z: 0.7, rot: 0, enter: "fade", props: { share: 0.4, label: "FTT", from: 1, frames: 14 } }] }) },
  { id: "S11", start: 27.7, seg: "l04", intent: "a token his own exchange had made up", footage: "coins", trim: 0.5, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0, wash: { color: "accent", strength: 0.55, mode: "duotone" }, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [] }) },
  { id: "S12", start: 31.9, seg: "l05", intent: "his own coupons", footage: "sbf_cnbc", trim: 0, slots: { 0: "ftx_logo" }, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, wash: { color: "primary", strength: 0.5, mode: "duotone" }, drift: { slot: 0, mode: "fall", count: 14 }, camera: cam(1.1, 1.28), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.55, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[88, "HIS OWN"], [90, "coupons", "y", true]]), size: 200 } }] }) },
  { id: "S12b", start: 35.4, seg: "l05", intent: "coupons are only worth something while people believe in them", footage: "btc", trim: 8, tr: "cut",
    scene: () => ({ backdrop: "footage", dim: 0, wash: { color: "accent", strength: 0.35, mode: "tint" }, camera: cam(1.05, 1.22), finish: fin(0.35, 0.5), elements: [] }) },
  { id: "S13", start: 38.85, seg: "l06", intent: "Changpeng Zhao, head of Binance", footage: "cz", trim: 0, tr: "film", panX: [0.44, 0.4],
    scene: (t) => ({ backdrop: "footage", dim: 0.1, camera: cam(1.0, 1.16), finish: fin(0.3, 0.45),
      elements: [{ type: "component", name: "Name", x: 0.05, y: 0.56, w: 0.32, at: rel(t, 107), z: 0.8, rot: 0, enter: "fade", props: { text: "Changpeng | Zhao", role: "CEO of Binance", roleC: "w" } }] }) },
  { id: "S14", start: 41.6, seg: "l06", intent: "sell every FTT", footage: "crash2", trim: 8, slots: { 0: "cut_cz" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, wash: { color: "accentDeep", strength: 0.4, mode: "tint" }, camera: cam(1.1, 1.28), finish: fin(0.4, 0.6),
      elements: [
        { type: "cutout", slot: 0, x: 0.04, y: 0.18, w: 0.4, z: 0.6, rot: 0, at: 0, enter: "slide_right", shadow: true, glow: "accent", contactShadow: 0.4 },
        { type: "component", name: "Kinetic", x: 0.46, y: 0.24, w: 0.5, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[112, "SELL", "r"], ["|", ""], [113, "EVERY"], ["|", ""], [114, "FTT", "y"]]), size: 190, font: "wide" } },
      ] }) },
  { id: "S15", start: 44.75, seg: "l06", intent: "you can guess what happened next: customers ran", footage: "run", trim: 3, tr: "flash",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.02, 1.18), finish: fin(0.3, 0.45), elements: [] }) },
  { id: "S16", start: 48.55, seg: "l07", intent: "$6 billion out", footage: "queue", trim: 2, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, wash: { color: "accentDeep", strength: 0.7, mode: "duotone" }, camera: cam(1.1, 1.3), finish: fin(0.4, 0.6),
      elements: [
        { type: "component", name: "Counter", x: 0.1, y: 0.26, w: 0.8, at: 0, z: 0.8, rot: 0, enter: "fade", props: { prefix: "$", to: 6, suffix: " BILLION", frames: 14, label: "withdrawn", fill: "red" } },
      ] }) },
  { id: "S17", start: 51.35, seg: "l07", intent: "in 72 hours", footage: "paperburn", trim: 4, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, camera: cam(1.05, 1.23), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.33, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[135, "72", "y"], [136, "HOURS"]]), size: 260, font: "wide" } }] }) },
  { id: "S18", start: 53.2, seg: "l08", intent: "Binance agreed to buy", footage: "hand", trim: 1, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [] }) },
  { id: "S19", start: 55.35, seg: "l08", intent: "one day later it walked away", footage: "walk", trim: 0, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0, wash: { color: "surface", strength: 0.85, mode: "duotone" }, camera: cam(1.0, 1.16), finish: fin(0.35, 0.55),
      elements: [] }) },
  { id: "S20", start: 57.9, seg: "l08", intent: "whatever it had found was beyond saving", footage: "run", trim: 11, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.6 }, camera: cam(1.1, 1.26), finish: fin(0.4, 0.65),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.34, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[150, "WHATEVER"], [151, "IT"], [152, "HAD"], [153, "FOUND"], ["|", ""], [154, "WAS"], [155, "BEYOND", "y"], [156, "SAVING", "r"]]), size: 110, font: "wide" } }] }) },
  { id: "S21", start: 61.0, seg: "l09", intent: "John J. Ray III, brought in to clean up", footage: "ray", trim: 0, tr: "flash",
    scene: (t) => ({ backdrop: "footage", dim: 0.1, camera: cam(1.0, 1.16), finish: fin(0.3, 0.45),
      elements: [{ type: "component", name: "Name", x: 0.6, y: 0.3, w: 0.37, at: rel(t, 158), z: 0.8, rot: 0, enter: "fade", props: { text: "John J. | Ray III", role: "new CEO of FTX", align: "right" } }] }) },
  { id: "S22", start: 63.1, seg: "l09", intent: "Enron", footage: "fire", trim: 6, slots: { 0: "enron" }, tr: "zoom_punch",
    scene: () => ({ backdrop: "footage", dim: 0.3, camera: cam(1.0, 1.23), finish: fin(0.35, 0.6, 0.3),
      elements: [{ type: "card3d", slot: 0, x: 0.3, y: 0.06, w: 0.4, z: 0.6, rot: 0, at: 0, enter: "zoom", tilt: -10, spin: 30 },
        { type: "component", name: "Kinetic", x: 0.1, y: 0.74, w: 0.8, at: 0.05, z: 0.8, rot: 0, enter: "fade", props: { words: [{ text: "Enron", from: 0, c: "w" }, { text: "2001", from: 6, c: "y" }], size: 190, font: "wide" } }] }) },
  { id: "S23", start: 64.7, seg: "l09", intent: "even by his standards (CBS headline)", footage: "ray", trim: 0.5, slots: { 0: "cbs" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.75 }, camera: cam(1.0, 1.14), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: 0.1, y: 0.3, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: -1.5, aspect: 560 / 700, crop: { y0: 0.065, y1: 0.225 }, hl: { x: 0.36, y: 0.52, w: 0.44, h: 0.42, from: fr(t, 171), to: fr(t, 173) } } }] }) },
  { id: "S23b", start: 66.2, seg: "l09", intent: "this was a complete failure (punch in on his words)", footage: "ray", trim: 3.5, slots: { 0: "cbs" }, tr: "zoom_punch",
    scene: () => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.85 }, camera: cam(1.05, 1.2), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: -0.2, y: -1.16, w: 1.4, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: -2, hl: { x: 0.02, y: 0.79, w: 0.95, h: 0.11, from: 0, to: 30 } } }] }) },
  { id: "S24", start: 68.6, seg: "l10", intent: "March 2024, the court", footage: "scrum", trim: 0, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0, wash: { color: "accentDeep", strength: 0.75, mode: "duotone" }, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [] }) },
  { id: "S25", start: 70.3, seg: "l10", intent: "sentenced to 25 years", footage: "sbf_court", trim: 2.5, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.2, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Counter", x: 0.52, y: 0.2, w: 0.44, at: rel(t, 185), z: 0.8, rot: 0, enter: "fade", props: { to: 25, frames: 16, label: "years" } }] }) },
  { id: "S26", start: 73.0, seg: "l10", intent: "for stealing $8 billion", footage: "pile", trim: 1, tr: "cut",
    scene: (t) => ({ backdrop: "footage", wash: { color: "accentDeep", strength: 0.25, mode: "tint" }, dim: 0.3, fx: { dof: 0.85 }, camera: cam(1.05, 1.23), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.3, w: 0.88, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[188, "STEALING", "r"], ["|", ""], [189, "$8 BILLION", "y"]]), size: 210, font: "wide" } }] }) },
  { id: "S26b", start: 76.9, seg: "l11", intent: "soon after that tweet (the post again)", footage: "phone", trim: 11, slots: { 0: "tweet" }, tr: "film",
    scene: () => ({ backdrop: "footage", dim: 0.3, fx: { dof: 0.8 }, wash: { color: "surface", strength: 0.85, mode: "duotone" }, camera: cam(1.08, 1.2), finish: fin(0.45, 0.65),
      elements: [{ type: "component", name: "Card", x: 0.1, y: 0.28, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: 2 } }] }) },
  { id: "S26c", start: 79.45, seg: "l11", intent: "he had started to worry FTX would not be fine", footage: "phone", trim: 12.5, tr: "zoom_punch",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, fx: { dof: 0.9 }, wash: { color: "surface", strength: 0.85, mode: "duotone" }, camera: cam(1.1, 1.3), finish: fin(0.45, 0.7),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.36, w: 0.88, at: 0, z: 0.85, rot: 0, enter: "fade", props: { words: kin(t, [[207, "WOULD"], [208, "NOT", "r"], [209, "BE FINE"]]), size: 170, font: "wide" } }] }) },
  { id: "S27", start: 82.05, seg: "l11", intent: "in the judge's words (Manhattan federal court)", footage: "courthouse", tr: "film", hold: true,
    scene: () => ({ backdrop: "footage", dim: 0.15, camera: cam(1.0, 1.0, 0.5, 0.5, 0.45, 0.45), finish: fin(0.35, 0.55), elements: [] }) },
  { id: "S28", start: 83.7, seg: "l11", intent: "he had made a very bad bet", slots: { 0: "cut_sbf_court", 1: "scrum_still" }, tr: "cut",
    scene: (t) => ({ backdrop: "world", world: { kind: "mono_accent", slot: 1, color: "primary", accent: "accentDeep" }, dim: 0.25, camera: cam(1.0, 1.16), finish: fin(0.45, 0.65),
      elements: [
        { type: "cutout", slot: 0, x: 0.52, y: 0.06, w: 0.46, z: 0.6, rot: 0, at: 0, enter: "settle", shadow: true, glow: "accent" },
        { type: "component", name: "Kinetic", x: 0.04, y: 0.3, w: 0.5, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[220, "A VERY"], ["|", ""], [221, "BAD", "r"], [222, "BET"]]), size: 150, align: "left", font: "wide" } },
      ] }) },
  { id: "S29", start: 85.9, seg: "l11", intent: "that he would never get caught", footage: "sbf_court", trim: 0, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, wash: { color: "primary", strength: 0.6, mode: "duotone" }, camera: cam(1.05, 1.33), finish: fin(0.45, 0.75),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.36, w: 0.88, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[226, "NEVER"], [227, "GET"], [228, "CAUGHT", "r"]]), size: 150, font: "wide" } }] }) },
];

// v16: cut points are set on this narration's own words (the warp carried the v1 script's cuts to another narrator)
if (WARP) for (const s of SHOTS) s.start = +warp(s.start).toFixed(2);
SHOTS.sort((a, b) => a.start - b.start);
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
    camera: s.hold ? { type: "static" } : (() => { const c = s.scene(s.start).camera; const k = i % 2 ? 1 : -1; return { type: "ken_burns", fromScale: c.fromScale + 0.04, toScale: Math.min(1.6, c.toScale + 0.24), from: [s.panX?.[0] ?? 0.5 - 0.1 * k, c.fromY], to: [s.panX?.[1] ?? 0.5 + 0.1 * k, c.toY], easing: "linear" }; })(), overlays: [], sfx: [], transitionIn: s.tr ?? "cut" } as Storyboard["shots"][number]);
  // v11 (2026-11-24): the channel's films run low-key (whole-film luma median 0.25 over the first 80 s, ours was 0.36),
  // so footage sits under a deeper dim: LOWKEY is added to every footage shot's dim, type stays at full brightness.
  const sc = s.scene(s.start) as Omit<SceneSpec, "shotId" | "idea">;
  if ((sc.backdrop ?? "footage") === "footage") (sc as { dim?: number }).dim = Math.min(0.7, ((sc as { dim?: number }).dim ?? 0) + LOWKEY);
  scenes.push({ shotId: s.id, idea: s.intent, ...sc } as SceneSpec);
}
// ---- sound: hits peak on the visual moment (start = moment − measured attack); beds change at the turns ----
const prof = JSON.parse(await readFile(path.join(root, "data", "audio-profile.json"), "utf8")) as { sfx: Record<string, { attackS: number }> };
const HITS: Array<[string, number, number]> = [
  ["608bd9f4437bc222", at(21), -4], // boom: FOUR days later
  ["506353c7272f6de3", at(30), -2], ["1794a26d359d39b5", at(30), -6], // stamp: BANKRUPT
  ["c8eac9e229c3fd1c", 27.7, -8], // whoosh-hit into the 40 %
  ["e8e77cb57b045804", at(88), -12], // coins under "his own coupons"
  ["f0ecbbabe0339b24", at(112), -4], // SELL
  ["3c04c2822cfb527f", at(125), -8], // riser into "customers ran"
  ["5b238f52f756cf20", at(127), -5], // $6B
  ["f5e1453e264ceac1", 63.1, -5], // Enron
  ["76f884fedb10e13b", at(185) + 0.67, -4], // 25 lands
  ["f112c4720b330a9e", at(222), -3], // BET
];
for (const [id, moment, gain] of HITS) {
  const atS = Math.max(0, +(moment - (prof.sfx[id]?.attackS ?? 0)).toFixed(3));
  const sh = shots.find((x) => atS >= x.startS && atS < x.endS) ?? shots.at(-1)!;
  sh.sfx.push({ assetId: id, atS, gainDb: gain });
}
const MUSIC0 = [
  { assetId: "17d16bdc91e20542", startS: 0, endS: 46.98, gainDb: -12, mood: "tension" as const, drops: [{ startS: 8.9, endS: 9.4 }, { startS: 46.2, endS: 46.98 }] },
  { assetId: "a5b692a28d20ada4", startS: 46.98, endS: 68.6, gainDb: -13, mood: "collapse" as const, drops: [{ startS: 62.4, endS: 63.1 }] },
  { assetId: "55e3d88a31ecffee", startS: 68.6, endS: dur, gainDb: -12, mood: "resolve" as const, drops: [{ startS: 81.3, endS: 82.05 }] },
];
const MUSIC = MUSIC0.map((c) => ({ ...c, startS: +warp(c.startS).toFixed(2), endS: c.endS === dur ? dur : +warp(c.endS).toFixed(2), drops: c.drops.map((d) => ({ startS: +warp(d.startS).toFixed(2), endS: +warp(d.endS).toFixed(2) })) }));
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
  fonts: { display: "Anton", body: "Oswald" }, texture: { grain: 0.22, vignette: 0.55 }, acts: [{ name: "fall", tint: "#ffb000", tintStrength: 0.08, saturation: 1.02, contrast: Number(process.env.ACT_CONTRAST ?? 1.12), brightness: 1.0 }], generatedAt: new Date().toISOString() });
for (const [f, v] of [["storyboard.json", board], ["resolution.json", resolution], ["scenes.json", plan], ["design.json", design]] as const) await writeFile(path.join(job, f), JSON.stringify(v, null, 2));
await writeFile(path.join(job, "job.json"), JSON.stringify({ channel: "magnates-media", aspect: "16:9", topic: "How FTX collapsed in four days", hand: true }, null, 2));

const sceneMap = new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x]));
const manifest = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: path.join(root, "Library"), outputPath: path.join(job, "film.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: false, scenes: sceneMap });
await writeFile(path.join(job, "manifest.json"), JSON.stringify(manifest, null, 2));
if (process.argv.includes("--manifest-only")) process.exit(0);
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
