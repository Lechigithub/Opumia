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
// Cut points are designed on one narration (the cut reference) and carried word by word onto the narration in use, so a
// re-recorded line never misaligns a cut. v2 script: cut on timed-script-cutref-v2.json (v16); v1: on Christopher's.
const CUTREF = NARRATOR === "marcus2" ? "cutref-v2" : "christopher";
const WARP = true;
const timed = TimedScript.parse(JSON.parse(await readFile(path.join(job, `timed-script-${NARRATOR}.json`), "utf8")));
const W = timed.segments.flatMap((s) => s.words);
const OLDS = TimedScript.parse(JSON.parse(await readFile(path.join(job, `timed-script-${CUTREF}.json`), "utf8"))).segments;
const NEWS = timed.segments;
const segById = (id: string) => NEWS.find((x) => x.id === id);
/** A cut-reference time carried onto the narration in use, line by line: inside a line, to the same word of the same
 *  line; in the pause after a line (or inside a line that was removed, e.g. a tweet now shown in silence),
 *  proportionally into the pause that follows the nearest line still spoken. Lines may change length freely. */
const warp = (t: number) => {
  if (!WARP) return t;
  let i = 0;
  for (let q = 0; q < OLDS.length; q++) if (OLDS[q]!.startS <= t + 1e-6) i = q;
  const o = OLDS[i]!, n = segById(o.id);
  if (n && t <= o.endS) {
    let k = -1;
    for (let q = 0; q < o.words.length; q++) if (o.words[q]!.startS <= t) k = q;
    if (k < 0) return n.startS + (t - o.startS);
    k = Math.min(k, n.words.length - 1);
    const oa = o.words[k]!.startS, ob = o.words[k + 1]?.startS ?? o.endS, na = n.words[k]!.startS, nb = n.words[k + 1]?.startS ?? n.endS;
    return na + ((t - oa) / Math.max(0.01, ob - oa)) * (nb - na);
  }
  let j = i, m = n;
  while (!m && j > 0) { j--; m = segById(OLDS[j]!.id); }
  if (!m) return t;
  const g0 = n ? o.endS : OLDS[j]!.endS, g1 = OLDS.slice(i + 1).find((x) => segById(x.id))?.startS ?? g0 + 1;
  const mi = NEWS.indexOf(m), h0 = m.endS, h1 = NEWS[mi + 1]?.startS ?? m.endS + 1;
  return h0 + ((t - g0) / Math.max(0.01, g1 - g0)) * (h1 - h0);
};
const at = (i: number) => W[i]!.startS;
/** Global index of word k of a line in the narration in use (word anchors survive changes to other lines). */
const G = (line: string, k: number) => { let n = 0; for (const sg of NEWS) { if (sg.id === line) return n + Math.min(k, sg.words.length - 1); n += sg.words.length; } throw new Error(`no line ${line}`); };
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
  phone_still: { file: "downloads/stills/phone_typing.jpg", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/video/6414098/" },
  crash_still: { file: "downloads/stills/crash_chart.jpg", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/video/38859052/" },
  hourglass: { file: "downloads/library/hourglass.png", kind: "image", origin: "library", provider: "library", license: "CC BY-SA 3.0", credit: "\"Wooden hourglass 3.jpg\" by User:S Sepp, CC BY-SA 3.0, via Wikimedia Commons", url: "https://commons.wikimedia.org/wiki/File:Wooden_hourglass_3.jpg" },
  coinpile: { file: "downloads/library/coins_pile.png", kind: "image", origin: "library", provider: "library", license: "CC BY-SA 2.0", credit: "\"Medieval coin haord (pile of coins)\" by Birmingham Museums Trust, Angie Bolton, CC BY-SA 2.0, via Wikimedia Commons", url: "https://commons.wikimedia.org/" },
  btc_still: { file: "downloads/stills/btc.jpg", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/video/4406964/" },
  money_still: { file: "downloads/stills/money_pile_soft.jpg", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/video/6266286/" },
  crowd: ST("5695519", "Pexels"), bin: ST("7668957", "Pexels"), phone2: ST("6414098", "Pexels"), phone3: ST("6279142", "Pexels"),
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
  cut_sbf: CM("downloads/cut/sbf_mono.png", "CC BY 3.0", "Cointelegraph, CC BY 3.0, via Wikimedia Commons", "Sam Bankman-Fried (cut-out)"),
  cut_cz: CM("downloads/cut/cz_mono.png", "CC BY-SA 4.0", "Aevozer, CC BY-SA 4.0, via Wikimedia Commons", "Changpeng Zhao (cut-out)"),
  cut_sbf_court: { ...YT("sbf_court_nbc", "vZ5KTF0-Om0", "Sam Bankman-Fried sentenced to 25 years in prison for cryptocurrency fraud", "NBC News", 86, "Sam Bankman-Fried at court (cut-out)"), file: "downloads/cut/sbf_court_mono.png", kind: "image" },
  ftx_logo: CM("downloads/commons/FTX_logo.png", "Public domain", "FTX logo, public domain, via Wikimedia Commons", "FTX logo"),
  alameda: CM("downloads/commons/Alameda_Research_logo.png", "Public domain", "Alameda Research logo, public domain, via Wikimedia Commons", "Alameda Research logo"),
  enron: CM("downloads/commons/Logo_of_Enron_Corporation_1997_.png", "Public domain", "Enron logo by Paul Rand, public domain, via Wikimedia Commons", "Enron logo"),
  courthouse: CM("downloads/commons/Daniel_Patrick_Moynihan_United_States_Courthouse_55314001073_.jpg", "CC BY 4.0", "ajay_suresh, CC BY 4.0, via Wikimedia Commons", "Moynihan US Courthouse, Manhattan"),
  coindesk: PG("downloads/pages/coindesk_card2.png", "https://www.coindesk.com/business/2022/11/02/divisions-in-sam-bankman-frieds-crypto-empire-blur-on-his-trading-titan-alamedas-balance-sheet/", "Divisions in Sam Bankman-Fried's Crypto Empire Blur on His Trading Titan Alameda's Balance Sheet", "CoinDesk", "CoinDesk article, 2 Nov 2022"),
  cnbc: PG("downloads/pages/cnbc_card2.png", "https://www.cnbc.com/2022/11/08/cryptocurrencies-slide-as-worries-about-ftx-fester-in-latest-crypto-liquidity-scare.html", "Bitcoin briefly touches a new low for the year, FTX token plunges more than 75%", "CNBC", "CNBC article, 8 Nov 2022"),
  cbs: PG("downloads/pages/cbs_card.png", "https://www.cbsnews.com/news/ftx-bankruptcy-john-ray-ceo-failure/", "FTX's new CEO: Never in my career have I seen such a complete failure", "CBS News", "CBS News article, 17 Nov 2022"),
};

// ---- shots ----
interface Shot { id: string; start: number; seg: string; intent: string; footage?: string; trim?: number; slots?: Record<number, string>; tr?: Storyboard["shots"][number]["transitionIn"]; /** a still hold: no camera move (the channel holds ~4 % of the time) */ hold?: boolean; /** the storyboard camera's horizontal centre, from → to (default 0.5 ± 0.1, alternating) */ panX?: [number, number];
  /** start on this word of the narration in use (minus `lead` s) instead of a cut-reference time (lines whose words changed) */ atWord?: number; lead?: number; scene: (t0: number) => Omit<SceneSpec, "shotId" | "idea"> & { idea?: string } }
const cam = (a = 1.0, b = 1.2, x0 = 0.47, x1 = 0.53, y0 = 0.5, y1 = 0.5) => ({ fromScale: a, toScale: b, fromX: x0, toX: x1, fromY: y0, toY: y1 });
const kin = (t0: number, parts: Array<[number | "|", string, string?, boolean?]>) => parts.map(([i, text, c, script]) => (i === "|" ? { text: "|", from: 0 } : { text, from: fr(t0, i), ...(c ? { c } : {}), ...(script ? { script } : {}) }));
const fin = (g = 0.35, v = 0.55, leak = 0) => ({ grain: g, vignette: v, leak });

const SHOTS: Shot[] = [
  { id: "S01", start: 0, seg: "l01", intent: "a message sent at night (a terminal: the date typed)", slots: { 1: "phone_still" }, tr: "cut",
    scene: (t) => ({ backdrop: "world", world: { kind: "terminal", slot: 1, color: "primary", accent: "accent" }, dim: 0, camera: cam(1.0, 1.3), finish: fin(0.35, 0.65),
      elements: [{ type: "component", name: "Kinetic", x: 0.1, y: 0.38, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { words: kin(t, [[G("l01", 2), "NOV 7", "y"], [G("l01", 5), "2022"]]), size: 170, font: "mono" } }] }) },
  { id: "S02", start: 2.9, seg: "l01", intent: "Sam Bankman-Fried (his cut-out over his own interview in cool duotone)", slots: { 0: "cut_sbf", 1: "sbf_cnbc_still" }, tr: "film",
    scene: (t) => ({ backdrop: "world", world: { kind: "duotone", slot: 1, color: "primary", accent: "accent" }, dim: 0.3, camera: cam(1.0, 1.16), finish: fin(0.35, 0.6),
      elements: [
        { type: "cutout", slot: 0, x: 0.46, y: 0.08, w: 0.5, z: 0.6, rot: 0, at: 0, enter: "settle", shadow: true, glow: "accent", contactShadow: 0.5 },
        { type: "component", name: "Name", x: 0.04, y: 0.3, w: 0.5, at: rel(t, G("l01", 7)), z: 0.5, rot: 0, enter: "fade", props: { text: "Sam | Bankman-Fried", role: "founder of FTX" } },
      ] }) },
  { id: "S02b", start: 4.0, seg: "l01", intent: "has a message for the world", footage: "sbf_cnbc", trim: 3, tr: "cut",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.05, 1.25), finish: fin(0.3, 0.5), elements: [] }) },
  { id: "S03", start: 0, atWord: G("l03", 0), lead: 1.55, seg: "l02", intent: "the post: FTX is fine (a lit screen floating in a night sky)", slots: { 0: "tweet", 1: "crash_still" }, tr: "flash",
    scene: (t) => ({ backdrop: "world", world: { kind: "gradient", color: "primary", accent: "primarySoft" }, dim: 0, camera: cam(1.1, 1.28), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: 0.14, y: 0.24, w: 0.72, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: -10 } }] }) },
  { id: "S04", start: 0, atWord: G("l03", 0), lead: 0.1, seg: "l03", intent: "four days later (a red burst, the logo falling)", slots: { 0: "ftx_logo" }, tr: "film",
    scene: (t) => ({ backdrop: "world", world: { kind: "burst", color: "primary", accent: "accentDeep" }, dim: 0.1, drift: { slot: 0, mode: "fall", count: 10 }, camera: cam(1.0, 1.18), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.36, w: 0.84, at: 0, z: 0.7, rot: 0, enter: "fade", props: { words: kin(t, [[G("l03", 0), "Four"], [G("l03", 1), "days"], [G("l03", 2), "later", "y", true]]), size: 150, font: "wide" } }] }) },
  { id: "S05", start: 10.5, seg: "l03", intent: "the $32 billion empire burning (a trading-screen counter over fire)", footage: "burn100", trim: 1.5, slots: { 0: "ftx_logo" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.25, camera: cam(1.05, 1.23), finish: fin(0.4, 0.55),
      elements: [{ type: "card3d", slot: 0, x: 0.06, y: 0.06, w: 0.22, z: 0.6, rot: 0, at: 0, enter: "zoom", tilt: -12, spin: 40 },
        { type: "component", name: "Counter", x: 0.1, y: 0.3, w: 0.8, at: rel(t, G("l03", 4)), z: 0.75, rot: 0, enter: "fade", props: { prefix: "$", to: 32, suffix: "B", frames: 18, label: "an empire worth" } }] }) },
  { id: "S06", start: 12.7, seg: "l03", intent: "bankrupt (glitching chart, a red error banner)", footage: "crash1", trim: 4, slots: { 0: "ftx_logo" }, tr: "zoom_punch",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, wash: { color: "accentDeep", strength: 0.35, mode: "tint" }, fx: { glitch: true }, drift: { slot: 0, mode: "fall", count: 5 }, camera: cam(1.1, 1.33), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Stamp", x: 0.24, y: 0.42, w: 0.52, at: rel(t, G("l03", 9)), z: 0.9, rot: 0, enter: "fade", props: { text: "Bankrupt", size: 170 } }] }) },
  { id: "S07", start: 14.1, seg: "l03", intent: "so how does a company worth that much vanish? (SBF on air, all smiles)", footage: "sbf_bbg", trim: 0.2, tr: "film",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.0, 1.14), finish: fin(0.35, 0.55), elements: [] }) },
  { id: "S07b", start: 16.4, seg: "l03", intent: "vanish in less than a week (an hourglass on a flat navy field, handwritten)", slots: { 0: "hourglass" }, tr: "cut",
    scene: (t) => ({ backdrop: "world", world: { kind: "flat_field", color: "primary", accent: "accent" }, dim: 0, camera: cam(1.05, 1.22), finish: fin(0.4, 0.6),
      elements: [{ type: "cutout", slot: 0, x: 0.06, y: 0.1, w: 0.3, z: 0.6, rot: -4, at: 0, enter: "settle", shadow: true, glow: "accent" },
        { type: "component", name: "Kinetic", x: 0.4, y: 0.32, w: 0.56, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l03", 20), "less than"], ["|", ""], [G("l03", 22), "a week", "y"]]), size: 150, font: "hand", align: "left" } }] }) },
  { id: "S07c", start: 18.25, seg: "l03", intent: "title: FTX, the $32 billion empire that vanished (chrome type in a lit room)", slots: { 1: "courthouse" }, tr: "film",
    scene: (t) => ({ backdrop: "world", world: { kind: "room3d", slot: 1, color: "primary", accent: "accent" }, dim: 0, camera: cam(1.05, 1.2), finish: fin(0.4, 0.6),
      elements: [{ type: "text3d", text: "FTX", x: 0.2, y: 0.12, w: 0.6, h: 0.42, at: 0, z: 0.8, rot: 0, enter: "fade", spin: 14, material: "chrome" },
        { type: "component", name: "Kinetic", x: 0.1, y: 0.64, w: 0.8, at: 0.4, z: 0.8, rot: 0, enter: "fade", props: { words: [{ text: "THE", from: 0 }, { text: "$32 BILLION", from: 3, c: "y" }, { text: "EMPIRE", from: 6 }, { text: "THAT", from: 9 }, { text: "VANISHED", from: 12 }], size: 52, font: "mono" } }] }) },
  { id: "S08", start: 20.85, seg: "l03", intent: "the leaked balance sheet (CoinDesk on a lit screen in a server room)", footage: "cables", trim: 2, slots: { 0: "coindesk" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.55, fx: { dof: 0.8 }, camera: cam(1.0, 1.14), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: 0.1, y: 0.28, w: 0.8, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: 7, aspect: 305 / 780, crop: { y0: 0.12, y1: 0.7 }, hl: { x: 0.02, y: 0.75, w: 0.74, h: 0.15, from: fr(t, G("l04", 5)), to: fr(t, G("l04", 9)) + 8 } } },
        { type: "component", name: "Label", x: 0.06, y: 0.1, w: 0.4, at: 0, z: 0.9, rot: 0, enter: "fade", props: { text: "Leaked · 2 Nov 2022", size: 58 } }] }) },
  { id: "S09", start: 24.7, seg: "l04", intent: "Alameda's $14.6 billion", footage: "spread", trim: 2, slots: { 0: "alameda" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.4, fx: { dof: 0.6 }, camera: cam(1.08, 1.2, 0.45, 0.55), finish: fin(0.35, 0.6),
      elements: [
        { type: "photo", slot: 0, x: 0.3, y: 0.1, w: 0.4, z: 0.6, rot: 0, at: 0, enter: "slide_down", grade: "natural" },
        { type: "component", name: "Counter", x: 0.1, y: 0.42, w: 0.8, at: rel(t, G("l04", 16)), z: 0.8, rot: 0, enter: "fade", props: { prefix: "$", to: 14.6, decimals: 1, suffix: "B", frames: 20, label: "Alameda assets" } },
      ] }) },
  { id: "S10", start: 23.7, seg: "l04", intent: "40% was FTT (a ring on the trading grid, coins beside it)", slots: { 0: "coinpile" }, tr: "flash",
    scene: (t) => ({ backdrop: "stage", dim: 0, camera: cam(1.0, 1.16), finish: fin(0.35, 0.6),
      elements: [{ type: "cutout", slot: 0, x: 0.52, y: 0.4, w: 0.44, z: 0.5, rot: 0, at: 0, enter: "settle", shadow: true },
        { type: "component", name: "Donut", x: 0.1, y: 0.14, w: 0.38, at: 0, z: 0.7, rot: 0, enter: "fade", props: { share: 0.4, label: "FTT", from: 1, frames: 14 } }] }) },
  { id: "S11", start: 27.7, seg: "l04", intent: "a token his own exchange had made up", footage: "coins", trim: 1.5, tr: "cut",
    scene: () => ({ backdrop: "footage", dim: 0, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55), elements: [] }) },
  { id: "S12", start: 31.9, seg: "l05", intent: "his own coupons (his face in one colour, logos falling, the word handwritten)", slots: { 0: "ftx_logo", 1: "sbf_cnbc_still" }, tr: "film",
    scene: (t) => ({ backdrop: "world", world: { kind: "mono_accent", slot: 1, color: "primary", accent: "accent" }, dim: 0.15, drift: { slot: 0, mode: "fall", count: 14 }, camera: cam(1.1, 1.28), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.55, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l05", 7), "his own"], [G("l05", 9), "coupons", "y"]]), size: 190, font: "hand" } }] }) },
  { id: "S12b", start: 35.4, seg: "l05", intent: "coupons are only worth something while people believe in them", footage: "btc", trim: 8, tr: "cut",
    scene: () => ({ backdrop: "footage", dim: 0, wash: { color: "black", strength: 0.8, mode: "duotone" }, camera: cam(1.05, 1.22), finish: fin(0.35, 0.5), elements: [] }) },
  { id: "S13", start: 38.85, seg: "l06", intent: "Changpeng Zhao, head of Binance (cut out over a red crash)", slots: { 0: "cut_cz", 1: "crash_still" }, tr: "film",
    scene: (t) => ({ backdrop: "world", world: { kind: "duotone", slot: 1, color: "primary", accent: "accentDeep" }, dim: 0.35, camera: cam(1.0, 1.16), finish: fin(0.3, 0.45),
      elements: [{ type: "cutout", slot: 0, x: 0.5, y: 0.08, w: 0.46, z: 0.6, rot: 0, at: 0, enter: "settle", shadow: true, glow: "accent", contactShadow: 0.4 },
        { type: "component", name: "Name", x: 0.05, y: 0.32, w: 0.42, at: rel(t, G("l06", 5)), z: 0.8, rot: 0, enter: "fade", props: { text: "Changpeng | Zhao", role: "CEO of Binance" } }] }) },
  { id: "S14", start: 41.6, seg: "l06", intent: "sell every FTT (an order typed over the crash)", footage: "crash2", trim: 8, slots: { 1: "ftx_logo" }, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, wash: { color: "accentDeep", strength: 0.3, mode: "tint" }, drift: { slot: 1, mode: "fall", count: 14 }, camera: cam(1.1, 1.28), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.34, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l06", 10), "SELL", "r"], [G("l06", 11), "EVERY"], [G("l06", 12), "FTT", "y"]]), size: 170, font: "mono" } }] }) },
  { id: "S15", start: 44.75, seg: "l06", intent: "you can guess what happened next: customers ran", footage: "crowd", trim: 1, tr: "flash",
    scene: () => ({ backdrop: "footage", dim: 0, wash: { color: "black", strength: 0.8, mode: "duotone" }, camera: cam(1.02, 1.18), finish: fin(0.3, 0.45), elements: [] }) },
  { id: "S16", start: 48.55, seg: "l07", intent: "$6 billion out (red ticker)", footage: "queue", trim: 2, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, camera: cam(1.1, 1.3), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Counter", x: 0.1, y: 0.3, w: 0.8, at: 0, z: 0.8, rot: 0, enter: "fade", props: { prefix: "−$", to: 6, suffix: "B", frames: 14, label: "withdrawn", fill: "red" } }] }) },
  { id: "S17", start: 51.35, seg: "l07", intent: "in 72 hours (the terminal clock)", slots: { 1: "crash_still" }, tr: "cut",
    scene: (t) => ({ backdrop: "world", world: { kind: "terminal", slot: 1, color: "primary", accent: "accentDeep" }, dim: 0, camera: cam(1.05, 1.23), finish: fin(0.4, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.33, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l07", 10), "72:00:00", "r"], ["|", ""], [G("l07", 11), "HOURS"]]), size: 220, font: "mono" } }] }) },
  { id: "S18", start: 53.2, seg: "l08", intent: "Binance agreed to buy (a handshake, a HUD tag)", footage: "hand", trim: 1, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.1, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Label", x: 0.06, y: 0.12, w: 0.5, at: 0.2, z: 0.9, rot: 0, enter: "fade", props: { text: "Deal: Binance buys FTX", size: 58 } }] }) },
  { id: "S19", start: 55.35, seg: "l08", intent: "one day later it walked away", footage: "walk", trim: 0, tr: "cut",
    scene: () => ({ backdrop: "footage", dim: 0, wash: { color: "black", strength: 0.85, mode: "duotone" }, camera: cam(1.0, 1.16), finish: fin(0.35, 0.55), elements: [] }) },
  { id: "S20", start: 57.9, seg: "l08", intent: "whatever it had found was beyond saving (serif, quiet)", footage: "bin", trim: 7, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.4, fx: { dof: 0.5 }, camera: cam(1.1, 1.26), finish: fin(0.4, 0.65),
      elements: [{ type: "component", name: "Kinetic", x: 0.08, y: 0.38, w: 0.84, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l08", 18), "beyond", "w"], [G("l08", 19), "saving.", "r"]]), size: 190, font: "serif" } }] }) },
  { id: "S21", start: 61.0, seg: "l09", intent: "John J. Ray III, brought in to clean up", footage: "ray", trim: 0, tr: "flash",
    scene: (t) => ({ backdrop: "footage", dim: 0.1, camera: cam(1.0, 1.16), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Name", x: 0.6, y: 0.3, w: 0.37, at: rel(t, G("l09", 1)), z: 0.8, rot: 0, enter: "fade", props: { text: "John J. | Ray III", role: "new CEO of FTX", align: "right" } }] }) },
  { id: "S22", start: 63.1, seg: "l09", intent: "Enron (the two collapses side by side)", slots: { 0: "enron", 1: "ftx_logo", 2: "courthouse", 3: "crash_still" }, tr: "zoom_punch",
    scene: () => ({ backdrop: "world", world: { kind: "split", slot: 2, slots: [3], color: "primary", accent: "accent" }, dim: 0.35, camera: cam(1.0, 1.12), finish: fin(0.35, 0.6),
      elements: [{ type: "card3d", slot: 0, x: 0.1, y: 0.22, w: 0.3, z: 0.6, rot: 0, at: 0, enter: "zoom", tilt: -10, spin: 30 },
        { type: "component", name: "Kinetic", x: 0.04, y: 0.7, w: 0.42, at: 0.05, z: 0.8, rot: 0, enter: "fade", props: { words: [{ text: "2001", from: 0, c: "y" }], size: 120, font: "mono" } },
        { type: "card3d", slot: 1, x: 0.6, y: 0.22, w: 0.3, z: 0.6, rot: 0, at: 0.3, enter: "zoom", tilt: 10, spin: -30 },
        { type: "component", name: "Kinetic", x: 0.54, y: 0.7, w: 0.42, at: 0.35, z: 0.8, rot: 0, enter: "fade", props: { words: [{ text: "2022", from: 0, c: "r" }], size: 120, font: "mono" } }] }) },
  { id: "S23", start: 64.7, seg: "l09", intent: "even by his standards (CBS headline on a lit screen)", slots: { 0: "cbs" }, tr: "cut",
    scene: (t) => ({ backdrop: "stage", dim: 0, camera: cam(1.0, 1.14), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Card", x: 0.06, y: 0.28, w: 0.88, at: 0, z: 0.7, rot: 0, enter: "fade", props: { slot: 0, rot: 6, aspect: 560 / 700, crop: { y0: 0.065, y1: 0.225 }, hl: { x: 0.36, y: 0.52, w: 0.44, h: 0.42, from: fr(t, G("l09", 20)), to: fr(t, G("l09", 23)) } } }] }) },
  { id: "S23b", start: 66.2, seg: "l09", intent: "a complete failure (his words in italic serif)", tr: "zoom_punch",
    scene: (t) => ({ backdrop: "world", world: { kind: "gradient", color: "primary", accent: "primarySoft" }, dim: 0, camera: cam(1.05, 1.2), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Quote", x: 0.1, y: 0.28, w: 0.8, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l09", 20), "“such"], [G("l09", 21), "a"], [G("l09", 22), "complete", "y"], [G("l09", 23), "failure.”", "y"]]), size: 120, by: "John J. Ray III", byFrom: 26 } }] }) },
  { id: "S24", start: 0, atWord: G("l10", 0), lead: 0.1, seg: "l10", intent: "the twenty-eighth of March, 2024 (press at the court, a polaroid of the courthouse)", footage: "scrum", trim: 0, slots: { 0: "courthouse" }, tr: "film",
    scene: (t) => ({ backdrop: "footage", dim: 0.1, wash: { color: "black", strength: 0.85, mode: "duotone" }, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "photo", slot: 0, x: 0.6, y: 0.1, w: 0.34, z: 0.6, rot: 4, at: 0.2, enter: "slide_down", grade: "natural", frame: "polaroid" },
        { type: "component", name: "Label", x: 0.05, y: 0.12, w: 0.5, at: 0, z: 0.9, rot: 0, enter: "fade", props: { text: "28 Mar 2024 · New York", size: 58 } }] }) },
  { id: "S25", start: 0, atWord: G("l10", 6), lead: 0.1, seg: "l10", intent: "stood before Judge Kaplan, sentenced to 25 years", footage: "sbf_court", trim: 2.5, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.3, camera: cam(1.05, 1.2), finish: fin(0.35, 0.55),
      elements: [{ type: "component", name: "Kinetic", x: 0.52, y: 0.3, w: 0.44, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l10", 15), "25", "r"], ["|", ""], [G("l10", 15), "YEARS"]]), size: 200, font: "wide", align: "left" } }] }) },
  { id: "S26", start: 0, atWord: G("l10", 17), seg: "l10", intent: "for stealing $8 billion (money, red)", footage: "pile", trim: 1, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.35, wash: { color: "accentDeep", strength: 0.55, mode: "duotone" }, camera: cam(1.05, 1.23), finish: fin(0.35, 0.6),
      elements: [{ type: "component", name: "Counter", x: 0.1, y: 0.32, w: 0.8, at: rel(t, G("l10", 19)), z: 0.8, rot: 0, enter: "fade", props: { prefix: "$", to: 8, suffix: "B", frames: 14, label: "stolen from customers", fill: "red" } }] }) },
  { id: "S26b", start: 0, atWord: G("l11", 0), seg: "l11", intent: "soon after that tweet (his week as a contact sheet)", slots: { 0: "tweet", 1: "sbf_cnbc_still", 2: "scrum_still", 3: "crash_still" }, tr: "film",
    scene: (t) => ({ backdrop: "world", world: { kind: "contact_grid", slot: 0, slots: [1, 2, 3], color: "primary", accent: "accent" }, dim: 0, camera: cam(1.0, 1.08), finish: fin(0.45, 0.6),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.06, w: 0.5, at: 0.1, z: 0.9, rot: 0, enter: "fade", props: { words: [{ text: "soon after", from: 0, script: true }, { text: "that tweet", from: 6, c: "y", script: true }], size: 90, font: "hand", align: "left" } }] }) },
  { id: "S26c", start: 0, atWord: G("l11", 9), seg: "l11", intent: "he had started to worry FTX would not be fine", footage: "phone3", trim: 2.5, tr: "zoom_punch",
    scene: (t) => ({ backdrop: "footage", dim: 0.45, fx: { dof: 0.9 }, camera: cam(1.1, 1.3), finish: fin(0.45, 0.7),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.38, w: 0.88, at: 0, z: 0.85, rot: 0, enter: "fade", props: { words: kin(t, [[G("l11", 11), "would"], [G("l11", 12), "not", "r"], [G("l11", 13), "be fine."]]), size: 150, font: "serif" } }] }) },
  { id: "S27", start: 0, atWord: G("l11", 15), seg: "l11", intent: "in the end (the Manhattan federal court)", footage: "courthouse", tr: "film", hold: true,
    scene: () => ({ backdrop: "footage", dim: 0.15, camera: cam(1.0, 1.0, 0.5, 0.5, 0.45, 0.45), finish: fin(0.35, 0.55), elements: [] }) },
  { id: "S28", start: 0, atWord: G("l11", 18), seg: "l11", intent: "he had made a very bad bet (his face in one colour, the words behind him)", slots: { 0: "cut_sbf_court", 1: "scrum_still" }, tr: "cut",
    scene: (t) => ({ backdrop: "world", world: { kind: "mono_accent", slot: 1, color: "primary", accent: "accentDeep" }, dim: 0.25, camera: cam(1.0, 1.16), finish: fin(0.45, 0.65),
      elements: [
        { type: "component", name: "Kinetic", x: 0.06, y: 0.26, w: 0.5, at: 0, z: 0.5, rot: 0, enter: "fade", props: { words: kin(t, [[G("l11", 22), "A VERY"], ["|", ""], [G("l11", 23), "BAD", "r"], [G("l11", 24), "BET"]]), size: 130, font: "wide", align: "left" } },
        { type: "cutout", slot: 0, x: 0.52, y: 0.06, w: 0.46, z: 0.6, rot: 0, at: 0, enter: "settle", shadow: true, glow: "accent" },
      ] }) },
  { id: "S29", start: 0, atWord: G("l11", 25), seg: "l11", intent: "that he would never get caught", footage: "sbf_court", trim: 0, tr: "cut",
    scene: (t) => ({ backdrop: "footage", dim: 0.35, wash: { color: "black", strength: 0.85, mode: "duotone" }, camera: cam(1.05, 1.33), finish: fin(0.45, 0.75),
      elements: [{ type: "component", name: "Kinetic", x: 0.06, y: 0.38, w: 0.88, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words: kin(t, [[G("l11", 28), "never"], [G("l11", 29), "get"], [G("l11", 30), "caught.", "r"]]), size: 170, font: "serif" } }] }) },
];

// v16: cut points are set on this narration's own words (the warp carried the v1 script's cuts to another narrator)
if (WARP) for (const s of SHOTS) s.start = +(s.atWord !== undefined ? at(s.atWord) - (s.lead ?? 0.08) : warp(s.start)).toFixed(2);
// Cut timing (v23): the channel's cuts sit a median 0.10 s from a word boundary (0.06–0.21 by film) and 5–28 % fall in
// a pause; cutting exactly on word starts gave 0.04 (too mechanical). A cut that opens a line stays in the pause before
// it; a cut inside a line lands half-way into its word (on the stressed middle, as an editor cuts on rhythm).
{
  const lineStarts = new Set(NEWS.map((sg) => sg.words[0]?.startS));
  for (const sh of SHOTS) {
    const w = W.find((x) => x.startS >= sh.start - 0.02);
    if (!w || w.startS - sh.start > 0.6 || lineStarts.has(w.startS)) continue;
    sh.start = +(w.startS + 0.5 * Math.max(0, w.endS - w.startS)).toFixed(2);
  }
}
SHOTS.sort((a, b) => a.start - b.start);
// One world for the film (v3 "Night exchange", 2026-11-24, rebuilt from scratch — the gold kit had become a template):
// a cool navy tint over footage that carries no treatment of its own; deliberate black-and-white shots and red danger
// shots keep theirs. Atmospheres are cool and sparse (dust, bokeh, scratches; smoke and embers only where it burns).
const WORLD_WASH = { color: (process.env.WORLD_COLOR ?? "primarySoft") as "primarySoft", strength: Number(process.env.WORLD_STRENGTH ?? 0.2), mode: (process.env.WORLD_MODE ?? "tint") as "duotone" };
const ATMOS: Record<string, [string, number]> = { S01: ["scratches", 0.4], S02: ["bokeh", 0.5], S03: ["bokeh", 0.6], S04: ["embers", 0.6], S05: ["embers", 0.7], S06: ["smoke", 0.5], S07b: ["dust", 0.4], S07c: ["dust", 0.5], S08: ["dust", 0.4], S09: ["bokeh", 0.5], S12: ["money", 0.6], S12b: ["scratches", 0.5], S13: ["smoke", 0.4], S15: ["scratches", 0.5], S16: ["smoke", 0.4], S19: ["scratches", 0.5], S20: ["dust", 0.5], S23b: ["bokeh", 0.5], S24: ["scratches", 0.5], S26: ["money", 0.7], S26b: ["dust", 0.4], S28: ["embers", 0.6], S29: ["smoke", 0.5] };
for (const sh of SHOTS) {
  const orig = sh.scene;
  sh.scene = (t0: number) => {
    const sc = orig(t0) as Record<string, unknown> & { backdrop?: string; world?: { accent?: string } };
    // the world tint, except shots kept in black and white on purpose (the channel's monochrome technique)
    if ((sc.backdrop ?? "footage") === "footage" && !(sc as { wash?: unknown }).wash) sc.wash = WORLD_WASH;
    const a = ATMOS[sh.id];
    if (a && !(sc as { atmos?: unknown }).atmos) (sc as { atmos?: unknown }).atmos = { kind: a[0], opacity: a[1] };
    return sc as ReturnType<typeof orig>;
  };
}
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
  ["1b0b7141511d7bc1", warp(5.62) + 0.35, -8], // the post lands, in silence
  ["608bd9f4437bc222", at(G("l03", 0)), -4], // boom: FOUR days later
  ["506353c7272f6de3", at(G("l03", 9)), -2], ["1794a26d359d39b5", at(G("l03", 9)), -6], // stamp: BANKRUPT
  ["f0ecbbabe0339b24", at(G("l06", 10)), -4], // SELL
  ["5b238f52f756cf20", at(G("l07", 2)), -5], // $6B
  ["76f884fedb10e13b", at(G("l10", 15)) + 0.67, -4], // 25 lands
  ["f112c4720b330a9e", at(G("l11", 24)), -3], // BET
];
for (const [id, moment, gain] of HITS) {
  const atS = Math.max(0, +(moment - (prof.sfx[id]?.attackS ?? 0)).toFixed(3));
  const sh = shots.find((x) => atS >= x.startS && atS < x.endS) ?? shots.at(-1)!;
  sh.sfx.push({ assetId: id, atS, gainDb: gain });
}
const MUSIC0 = [
  { assetId: "17d16bdc91e20542", startS: 0, endS: 46.98, gainDb: -12, mood: "tension" as const, drops: [{ startS: 46.2, endS: 46.98 }] },
  { assetId: "a5b692a28d20ada4", startS: 46.98, endS: 68.6, gainDb: -13, mood: "collapse" as const, drops: [{ startS: 62.4, endS: 63.1 }] },
  { assetId: "55e3d88a31ecffee", startS: 68.6, endS: dur, gainDb: -12, mood: "resolve" as const, drops: [{ startS: 81.3, endS: 82.05 }] },
];
const MUSIC = MUSIC0.map((c) => ({ ...c, startS: +warp(c.startS).toFixed(2), endS: c.endS === dur ? dur : +warp(c.endS).toFixed(2), drops: c.drops.map((d) => ({ startS: +warp(d.startS).toFixed(2), endS: +warp(d.endS).toFixed(2) })) }));
// line 11's words changed (v17b): its drop sits on its own words, before "In the end"
MUSIC[2]!.drops = [{ startS: +(at(G("l11", 15)) - 0.75).toFixed(2), endS: +at(G("l11", 15)).toFixed(2) }];
let board = Storyboard.parse({ schemaVersion: 1, id: "sb_hand_ftx", scriptId: timed.id, styleProfileId: "magnates-media", aspect: "16:9", durationS: dur, shots, music: [], generatedAt: new Date().toISOString() });
board = Storyboard.parse({ ...board, music: MUSIC });
let resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 0, stock: media.filter((m) => m.origin === "stock").length, archival: media.filter((m) => m.origin === "archival").length, designed: shots.length }, generatedAt: new Date().toISOString() });
const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(root, "data", "library-index.json"), "utf8")));
const atm = await resolveAtmosphere({ storyboard: board, scenes: scenes.map((s) => ({ shotId: s.shotId, ...(s.atmos ? { atmos: s.atmos } : {}) })), index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution, seed: "hand-ftx" });
board = atm.storyboard; resolution = atm.resolution;
resolution = await resolveAudio({ storyboard: board, index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution });
const plan = ScenePlan.parse({ schemaVersion: 2, storyboardId: board.id, scenes, generatedAt: new Date().toISOString() });
const design = FilmDesignSystem.parse({ schemaVersion: 2, id: "hand-ftx", channelId: "magnates-media", topic: "FTX", concept: "Night exchange: an empire that lived on screens and vanished overnight. Midnight navy, electric cyan for the exchange, signal red only for danger; four type voices (wide caps headlines, terminal mono figures, italic serif human words, handwritten asides); documents float as lit screens; every cut a cyan data tear.",
  palette: { primary: "#0a1630", primarySoft: "#1b3f8a", accent: "#28e7ff", accentDeep: "#ff2e4d", surface: "#05070d", surfaceAlt: "#0f1830", paper: "#e9eef6", marker: "#28e7ff", text: "#ffffff", textMuted: "#b9c6dd" },
  fonts: { display: "Unbounded", body: "IBM Plex Mono" }, texture: { grain: 0.22, vignette: 0.55 }, acts: [{ name: "fall", tint: "#2a6bff", tintStrength: 0.06, saturation: 1.04, contrast: Number(process.env.ACT_CONTRAST ?? 1.12), brightness: 1.0 }], generatedAt: new Date().toISOString() });
for (const [f, v] of [["storyboard.json", board], ["resolution.json", resolution], ["scenes.json", plan], ["design.json", design]] as const) await writeFile(path.join(job, f), JSON.stringify(v, null, 2));
// what each sentence of the narration does (the script's recorded line kinds), for the ratchet's story measures
{
  const { LINES } = await import("./script.js");
  const { sentencesOf } = await import("@opumia/agents");
  const sentences: string[] = [], kinds: string[] = [];
  for (const L of LINES) { const ss = sentencesOf(L.text); ss.forEach((x, i) => { sentences.push(x); kinds.push(L.kinds?.[i] ?? "story"); }); if (L.kinds && L.kinds.length !== ss.length) throw new Error(`${L.id}: ${ss.length} sentences, ${L.kinds.length} kinds`); }
  await writeFile(path.join(job, "story-kinds.json"), JSON.stringify({ sentences, kinds }, null, 1));
}
await writeFile(path.join(job, "narration-words.json"), JSON.stringify(W.map((w) => ({ word: w.word, startS: w.startS, endS: w.endS }))));
await writeFile(path.join(job, "job.json"), JSON.stringify({ channel: "magnates-media", aspect: "16:9", topic: "How FTX collapsed in four days", hand: true }, null, 2));

const sceneMap = new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x]));
const manifest = await buildManifest({ storyboard: board, script: timed, resolution, libraryRoot: path.join(root, "Library"), outputPath: path.join(job, "film.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: false, scenes: sceneMap });
await writeFile(path.join(job, "manifest.json"), JSON.stringify(manifest, null, 2));
if (process.argv.includes("--manifest-only")) process.exit(0);
const look = { accent: "#28e7ff", saturate: 1.05, contrast: 1.08, vignette: 0.55, grain: 0.25 };
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
