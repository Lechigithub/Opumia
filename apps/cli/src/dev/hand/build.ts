// Hand-made film, shot by shot (session-designed, no model): storyboard, resolution (real media copied into public/),
// scenes, design tokens → manifest → previews (and, with --render, the film).
//   OPUMIA_NO_CLAUDE=1 npx tsx apps/cli/src/dev/hand/build.ts out/hand-ftx [--only S05,S06] [--render]
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { FilmDesignSystem, LibraryIndex, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ResolvedMedia, type SceneSpec } from "@opumia/contracts";
const LOWKEY = Number(process.env.LOWKEY ?? 0.22);
import { buildManifest, renderShotPreviews, renderStretches, renderVideo, masterAudio, muxFinal } from "@opumia/motion-engine";
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
const PB = (id: string, credit: string): M => ({ file: `downloads/stock/pixabay_${id}.mp4`, kind: "video", origin: "stock", provider: "pixabay", license: "Pixabay Content License", credit, url: `https://pixabay.com/videos/id-${id}/` });
const MEDIA: Record<string, M> = {
  // v30: none of these was used by an earlier version
  v_city: PB("267744", "Pixabay"), v_aerial: ST("33637800", "Pexels"), v_phone_rg: ST("32246883", "Pexels"), v_phone_man: ST("8212368", "Pexels"),
  v_cards: ST("14925749", "Pexels"), v_dominoes_woman: ST("8102759", "Pexels"), v_dominoes: PB("28659", "Pixabay"), v_beach: PB("4623", "Pixabay"),
  v_sandcastle: ST("18048476", "Pexels"), v_chips: ST("7607942", "Pexels"), v_chart_red: ST("38736271", "Pexels"), v_chart_purple: ST("38711953", "Pexels"),
  c_sbf: { ...YT("v30_sbf_gma", "0Hxf4Vf54PI", "FTX founder Sam Bankman-Fried denies 'improper use' of customer funds | GMA", "Good Morning America", 48.8, "Sam Bankman-Fried (cut-out of a press frame)"), file: "downloads/cut/v30sbf.png", kind: "image" },
  s_sbf: { ...YT("v30_sbf_gma", "0Hxf4Vf54PI", "FTX founder Sam Bankman-Fried denies 'improper use' of customer funds | GMA", "Good Morning America", 48.8, "Sam Bankman-Fried (press frame)"), file: "downloads/cut/v30sbf_src.jpg", kind: "image" },
  c_cz: { ...YT("v30_cz_cnbc", "gN3jW4fhD70", "Twitter has huge value but has not been monetized well, says Binance CEO Changpeng Zhao", "CNBC Television", 20, "Changpeng Zhao (cut-out of a press frame)"), file: "downloads/cut/v30cz.png", kind: "image" },
  s_court: { ...YT("v30_court_gma", "9N7WO24aoT8", "Sam Bankman-Fried reacts to 25-year prison sentence for financial fraud", "Good Morning America", 33.5, "Sam Bankman-Fried arriving at court (press frame)"), file: "downloads/cut/v30court_src.jpg", kind: "image" },
  s_phone: { file: "downloads/stills/v30_phone.jpg", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/video/32246883/" },
  o_dollars: { file: "downloads/library/dollar_stack.png", kind: "image", origin: "library", provider: "library", license: "CC BY 2.0", credit: "\"Money - Flickr - AMagill.jpg\" by Andrew Magill from Boulder, USA, CC BY 2.0, via Wikimedia Commons", url: "https://commons.wikimedia.org/wiki/File:Money_-_Flickr_-_AMagill.jpg" },
  c_chips: { file: "downloads/cut/v30chips.png", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/video/7607942/" },
  v_sparks: ST("29936066", "Pexels"),
  c_sbf_face: { ...YT("v30_sbf_gma", "0Hxf4Vf54PI", "FTX founder Sam Bankman-Fried denies 'improper use' of customer funds | GMA", "Good Morning America", 48.8, "Sam Bankman-Fried (cut-out of a press frame, sharpened)"), file: "downloads/cut/v31sbf_face_sharp.png", kind: "image" },
  s_sbf_face: { ...YT("v30_sbf_gma", "0Hxf4Vf54PI", "FTX founder Sam Bankman-Fried denies 'improper use' of customer funds | GMA", "Good Morning America", 48.8, "Sam Bankman-Fried (press frame, double exposure)"), file: "downloads/cut/v31sbf_face_still.jpg", kind: "image" },
  c_sbf_suit: { ...YT("v30_court_gma", "9N7WO24aoT8", "Sam Bankman-Fried reacts to 25-year prison sentence for financial fraud", "Good Morning America", 33.9, "Sam Bankman-Fried (cut-out of a press frame, sharpened)"), file: "downloads/cut/v31sbf_suit_sharp.png", kind: "image" },
  o_bill_front: { file: "downloads/cut/v30bill_front_flat.png", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/photo/14820441/" },
  o_bill_back: { file: "downloads/cut/v30bill_back_flat.png", kind: "image", origin: "stock", provider: "pexels", license: "Pexels License", credit: "Pexels", url: "https://www.pexels.com/photo/14820443/" },
  v_drives: ST("7140928", "Pexels"), v_boxes: ST("4553296", "Pexels"), v_garage: ST("32078346", "Pexels"), v_lock: ST("35999369", "Pexels"),
  p_nassau: YT("v30_nassau", "weQm-4QgOrw", "Bankman-Fried Arrives at Court in Nassau, Bahamas", "Bloomberg Television", 15, "Sam Bankman-Fried under police escort, Nassau (press)"),
  p_court_gma: YT("v30_court_gma", "9N7WO24aoT8", "Sam Bankman-Fried reacts to 25-year prison sentence for financial fraud", "Good Morning America", 29.5, "Sam Bankman-Fried arriving at court (press)"),
  p_sbf_gma: YT("v30_sbf_gma", "0Hxf4Vf54PI", "FTX founder Sam Bankman-Fried denies 'improper use' of customer funds | GMA", "Good Morning America", 48, "Sam Bankman-Fried (press)"),
  p_cz_cnbc: YT("v30_cz_cnbc", "gN3jW4fhD70", "Twitter has huge value but has not been monetized well, says Binance CEO Changpeng Zhao", "CNBC Television", 18, "Changpeng Zhao (press)"),
  p_ray_yahoo: YT("v30_ray_yahoo", "OrCHMpf2MqI", "FTX CEO John Ray to testify in House hearing after SBF was arrested", "Yahoo Finance", 91, "John J. Ray III at the House hearing (press)"),
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

// v30 "The bet" (2026-11-24), designed from nothing: new pictures (none used by an earlier version), new kit, new plan.
// Eleven continuous scenes: inside each, one camera travels through its pictures (a journey) and never cuts; the
// channel changes picture by moving 76 % of the time and cuts a median 8.7 times a minute.
type Stop = { at: number; move?: string; fore?: unknown[]; dof?: number; drift?: [number, number, number, number]; world?: unknown; blendSlot?: number; x?: number; y?: number; depth?: number; ry?: number; rz?: number; size?: number; slot?: number; trim?: number; look?: string; stage?: boolean; frame?: string; elements?: unknown[] };
// Panels sit next to each other (spacing just over one frame), so a flight always shows the picture it leaves and the
// one it reaches, never an empty table: the written coordinates give only the direction of each move.
const chain = (stops: Stop[]) => {
  let px = 0, py = 0, pd = 0;
  return stops.map((s, i) => {
    if (i > 0) {
      const mv = (s as { move?: string }).move ?? "slide";
      if (mv === "push") pd += 2.6; // straight on, through the last picture into this one
      else if (mv === "rise") { py -= 1.06; pd += 0.15; }
      else { const prev = stops[i - 1]!; const dx = Math.sign((s.x ?? 0) - (prev.x ?? 0)) || 1, dy = Math.sign((s.y ?? 0) - (prev.y ?? 0)); px += dx * (mv === "whip" ? 1.12 : 1.06); py += dy * 1.06; }
    }
    return { ...s, x: px, y: py, depth: pd, ry: Math.max(-12, Math.min(12, s.ry ?? 0)) };
  });
};
const READ_HOLD = 1.1;
const lastWordS = (s: Stop) => Math.max(0, ...((s.elements ?? []) as Array<{ at?: number; props?: { words?: Array<{ from: number; text: string }> } }>).flatMap((e) => [e.at ?? 0, ...(e.props?.words ?? []).filter((w) => w.text !== "|").map((w) => w.from / FPS)]));
const unrush = (stops: Stop[], travel: number) => { const outS = stops.map((s) => ({ ...s })); for (let i = 1; i < outS.length; i++) { const prev = outS[i - 1]!; const need = lastWordS(prev) + READ_HOLD + travel; if (outS[i]!.at < need) outS[i]!.at = +need.toFixed(2); } return outS; };
const J = (stops: Stop[], o: { travel?: number; push?: number } = {}) => ({ backdrop: "journey" as const, journey: { stops: chain(unrush(stops, o.travel ?? 1.0)).map((s) => ({ rz: 0, size: 1, look: "natural", frame: "none", elements: [], ...s })), travel: o.travel ?? 1.0, push: o.push ?? 0.035, ground: "black" as const } as never, dim: 0, camera: cam(1, 1), finish: fin(0.3, 0.25), elements: [] as never[] });
const ph = (x: number, y: number, w: number, words: unknown, extra: Record<string, unknown> = {}) => ({ type: "component", name: "Phrase", x, y, w, at: 0, z: 0.8, rot: 0, enter: "fade", props: { words, ...extra } });
const C = (name: string, x: number, y: number, w: number, at: number, props: Record<string, unknown>) => ({ type: "component", name, x, y, w, at, z: 0.8, rot: 0, enter: "fade", props });
const SHOTS: Shot[] = [
  // v31: the first ten seconds built by hand as one layered composite (the kit's Opening), not panels
  { id: "OPEN", start: 0, seg: "l01", intent: "the date flies through the night city; he rises out of its light with his name swinging in behind him and his messages floating out; into his phone and his post, in silence; the glass cracks; four days later his $32 billion tumbles as banknotes until it is bankrupt", slots: { 0: "v_city", 1: "c_sbf_face", 2: "v_sparks", 3: "o_bill_front", 4: "o_bill_back", 5: "c_sbf_suit", 6: "s_sbf_face" }, tr: "cut",
    scene: (t) => ({ backdrop: "stage", dim: 0, camera: cam(1, 1), finish: fin(0.3, 0.2), elements: [C("Opening", 0, 0, 1, 0, { t: { seventh: at(G("l01", 2)) - t, "2022": at(G("l01", 5)) - t, sam: at(G("l01", 7)) - t, bankman: at(G("l01", 8)) - t, message: at(G("l01", 11)) - t, world: at(G("l01", 14)) - t, post: 5.68 - t, four: at(G("l03", 0)) - t, "thirty-two": at(G("l03", 4)) - t, bankrupt: at(G("l03", 9)) - t }, end: at(G("l03", 10)) - 0.1 - t }) as never] }) },
  { id: "C", start: 0, atWord: G("l03", 10), seg: "l03", intent: "how does it vanish: a castle of sand, then the tide that takes them", slots: { 0: "v_sandcastle", 1: "v_beach" }, tr: "cut",
    scene: (t) => J([
      { at: 0, slot: 0, trim: 6, look: "warm", drift: [0.02, 0, 0.06, -0.3], elements: [ph(0.06, 0.1, 0.88, kin(t, [[G("l03", 11), "How does a company"], ["|", ""], [G("l03", 15), "worth that much"], [G("l03", 18), "vanish?", "r"]]), { size: 130, until: fr(t, G("l03", 18)) + 50 })] },
      { at: rel(t, G("l03", 19)), y: 1, move: "rise", slot: 1, trim: 4, look: "faded", drift: [0.03, 0, 0.03, 0] },
    ]) },
  { id: "D", start: 0, atWord: G("l04", 0), seg: "l04", intent: "the leak: from the machines into the balance sheet itself, cash laid beside it on the table", slots: { 0: "v_drives", 1: "o_dollars" }, tr: "cut",
    scene: (t) => J([
      { at: 0, slot: 0, look: "cool", drift: [0, 0, 0.09, 0.2] },
      { at: rel(t, G("l04", 5)), move: "push", stage: true, drift: [0.015, 0, 0.05, 0.3], fore: [{ type: "cutout", slot: 1, x: 0.7, y: 0.62, w: 0.3, z: 0.9, rot: -12, at: 0.3, enter: "settle", shadow: true }], elements: [C("Ledger", 0.06, 0.08, 0.58, 0, { title: "Alameda Research · balance sheet", rot: -2, rows: [{ a: "Total assets", b: "$14.6B", mark: true, from: fr(t, G("l04", 16)) }, { a: "FTT, the token FTX made", b: "40%", mark: true, from: fr(t, G("l04", 10)) }] })] },
    ]) },
  { id: "D2", start: 0, atWord: G("l04", 21), lead: 0.1, seg: "l04", intent: "his own chips stacked over a market of his own making (cut-out over a duotone chart)", slots: { 0: "c_chips", 1: "v_chart_red" }, tr: "cut",
    scene: (t) => J([
      { at: 0, slot: 1, trim: 3, look: "contrast", dof: 0.45, drift: [-0.01, 0, 0.07, 0.3], elements: [ph(0.08, 0.08, 0.6, kin(t, [[G("l04", 24), "a token his own"], ["|", ""], [G("l04", 26), "exchange made up", "r"]]), { align: "left", size: 120, build: true })], fore: [{ type: "cutout", slot: 0, x: 0.12, y: 0.4, w: 0.86, z: 0.9, rot: 0, at: 0, enter: "slide_up", shadow: true }] },
    ]) },
  { id: "E", start: 0, atWord: G("l05", 0), seg: "l05", intent: "his own coupons over the house of cards they built; worth something only while people believe", slots: { 0: "v_phone_man", 2: "c_chips" }, tr: "cut",
    scene: (t) => J([
      { at: 0, stage: true, drift: [0.02, 0, 0.05, 0.6], fore: [{ type: "cutout", slot: 2, x: 0.58, y: 0.5, w: 0.44, z: 0.9, rot: 0, at: 0.2, enter: "slide_up", shadow: true }], elements: [C("Coupon", 0.08, 0.14, 0.5, 0.1, { text: "FTT", small: "issued by FTX", stub: "FTX", rot: -6 }), ph(0.06, 0.74, 0.6, kin(t, [[G("l05", 3), "the money was"], [G("l05", 7), "his own coupons", "r"]]), { size: 110 })] },
      { at: rel(t, G("l05", 10)) + 0.4, move: "push", slot: 0, trim: 1, look: "bright", drift: [-0.03, 0, 0.05, 0] },
    ]) },
  { id: "F", start: 0, atWord: G("l06", 0), seg: "l06", intent: "the rival's boss, cut out against a falling market in duotone; sell every FTT; the dominoes are set", slots: { 0: "c_cz", 1: "v_chart_purple", 2: "v_dominoes_woman" }, tr: "cut",
    scene: (t) => J([
      { at: 0, slot: 1, look: "duotone", dof: 0.5, drift: [0.01, 0, 0.05, 0.2], elements: [ph(0.1, 0.2, 0.55, kin(t, [[G("l06", 6), "Changpeng"], ["|", ""], [G("l06", 6), "Zhao"]]), { align: "left", size: 210 }), C("Said", 0.1, 0.66, 0.5, 0, { words: [{ text: "the boss of Binance", from: fr(t, G("l06", 2)) }], size: 70 })], fore: [{ type: "cutout", slot: 0, x: 0.5, y: 0.12, w: 0.48, z: 0.9, rot: 0, at: 0, enter: "slide_left", shadow: true }] },
      { at: rel(t, G("l06", 9)), x: 1, move: "whip", slot: 1, trim: 2, look: "contrast", elements: [ph(0.06, 0.3, 0.88, kin(t, [[G("l06", 10), "sell"], [G("l06", 11), "every"], [G("l06", 12), "FTT", "r"]]), { size: 220, build: true })] },
      { at: rel(t, G("l06", 16)), x: 1, y: 1, move: "rise", slot: 2, trim: 0.5, look: "faded" },
    ]) },
  { id: "G", start: 0, atWord: G("l07", 0), seg: "l07", intent: "customers ran: the money floats out of the boxes; six billion in seventy-two hours", slots: { 0: "v_boxes", 1: "v_aerial", 2: "o_dollars" }, tr: "film",
    scene: (t) => ({ ...J([
      { at: 0, slot: 0, look: "warm", drift: [0.04, 0, 0.05, 0] },
      { at: rel(t, G("l07", 2)), move: "push", slot: 1, look: "cool", elements: [C("Figure", 0.1, 0.1, 0.8, rel(t, G("l07", 2)), { text: "$6 BILLION", label: "walked out of FTX", fill: "red" }), C("Figure", 0.25, 0.56, 0.5, rel(t, G("l07", 10)), { text: "IN 72 HOURS" })] },
    ]) }) },
  { id: "H", start: 0, atWord: G("l08", 0), seg: "l08", intent: "Binance said yes, then shut the door; the lock turns", slots: { 0: "v_garage", 1: "v_lock" }, tr: "cut",
    scene: (t) => J([
      { at: 0, slot: 0, trim: 2, look: "bright", drift: [0, 0, 0.06, 0], elements: [ph(0.1, 0.08, 0.8, kin(t, [[G("l08", 7), "one day later"]]), { size: 90 }), ph(0.04, 0.6, 0.92, kin(t, [[G("l08", 10), "it walked away", "r"]]), { size: 230 })] },
      { at: rel(t, G("l08", 13)), y: 1, move: "rise", slot: 1, look: "mono" },
    ]) },
  { id: "I", start: 0, atWord: G("l09", 0), seg: "l09", intent: "the man who wound down Enron, and what he wrote", slots: { 0: "p_ray_yahoo" }, tr: "cut",
    scene: (t) => J([
      { at: 0, slot: 0, trim: 0, elements: [C("Name", 0.05, 0.66, 0.42, rel(t, G("l09", 1)), { text: "John J. Ray III", role: "brought in to clean up" })] },
      { at: rel(t, G("l09", 8)), x: 1, move: "slide", ry: -10, stage: true, elements: [ph(0.1, 0.12, 0.8, kin(t, [[G("l09", 8), "He had wound down"]]), { size: 100 }), ph(0.05, 0.3, 0.9, kin(t, [[G("l09", 11), "Enron", "r"]]), { size: 460 })] },
      { at: rel(t, G("l09", 12)) + 0.3, move: "push", slot: 0, trim: 3.5, look: "mono", elements: [C("Said", 0.06, 0.2, 0.62, 0, { words: kin(t, [[G("l09", 17), "“Never"], [G("l09", 18), "in my career"], ["|", ""], [G("l09", 19), "have I seen such a"], ["|", ""], [G("l09", 22), "complete failure…”", "r"]]), size: 110, by: "John J. Ray III", byFrom: fr(t, G("l09", 23)) + 6 })] },
    ]) },
  { id: "Jd", start: 0, atWord: G("l10", 0), lead: 0.1, seg: "l10", intent: "March 2024: he arrives before Judge Kaplan", slots: { 0: "p_court_gma" }, tr: "film",
    scene: (t) => J([
      { at: 0, slot: 0, trim: 1, drift: [0.02, 0, 0.06, 0], elements: [C("Chip", 0.74, 0.06, 0.2, rel(t, G("l10", 2)), { text: "28 Mar|2024" })] },
      { at: rel(t, G("l10", 6)), move: "push", slot: 0, trim: 3.5, look: "mono", drift: [0, 0, 0.08, 0] },
    ]) },
  { id: "J2", start: 0, atWord: G("l10", 14), lead: 0.15, seg: "l10", intent: "twenty-five years for eight billion: the chips that were his customers' money", slots: { 0: "v_chips" }, tr: "cut",
    scene: (t) => J([
      { at: 0, slot: 0, trim: 8, look: "duotone", dof: 0.8, drift: [0, 0, 0.07, 0.3], elements: [C("Figure", 0.15, 0.1, 0.7, rel(t, G("l10", 15)), { text: "25 YEARS", label: "sentenced to" }), C("Figure", 0.2, 0.52, 0.6, rel(t, G("l10", 19)), { text: "$8 BILLION", label: "for stealing", fill: "red" })] }
    ]) },
  { id: "K", start: 0, atWord: G("l11", 0), seg: "l11", intent: "his week as a filmstrip; it would not be fine; a very bad bet — escorted by police in Nassau", slots: { 0: "s_sbf", 1: "s_phone", 2: "p_nassau", 3: "s_court" }, tr: "cut",
    scene: (t) => J([
      { at: 0, world: { kind: "filmstrip", slot: 0, slots: [1, 3], color: "primary", accent: "accent" }, drift: [0, 0, 0.015, 0], elements: [C("Said", 0.12, 0.1, 0.8, 0, { words: kin(t, [[G("l11", 10), "FTX would"], [G("l11", 12), "not", "r"], [G("l11", 13), "be fine."]]), size: 140, align: "left" })] },
      { at: rel(t, G("l11", 20)), x: 1, move: "whip", slot: 2, trim: 0.5, look: "mono", elements: [ph(0.04, 0.36, 0.92, kin(t, [[G("l11", 21), "a very bad"], [G("l11", 24), "bet", "r"]]), { size: 300 }), ph(0.1, 0.74, 0.8, kin(t, [[G("l11", 25), "that he would never"], [G("l11", 29), "get caught", "r"]]), { size: 110 })] },
    ]) },
];

{
  const leaveOf = (st: Array<{ at: number }>, i: number, travel: number) => { const nx = st[i + 1]; return nx ? nx.at - Math.min(travel, (nx.at - st[i]!.at) * 0.7) : Infinity; };
  for (const sh of SHOTS) {
    const sc = sh.scene(0) as unknown as { journey?: { stops: Array<{ at: number; elements: Array<{ at?: number; props?: { words?: Array<{ from: number }> } }> }>; travel: number } };
    if (!sc.journey) continue;
    sc.journey.stops.forEach((st, i) => {
      const last = Math.max(0, ...st.elements.flatMap((e) => [(e.at ?? 0) * FPS, ...(e.props?.words ?? []).map((w) => w.from)])) / FPS;
      const hold = leaveOf(sc.journey!.stops, i, sc.journey!.travel) - last;
      if (hold < 1.0) console.warn(`hold: ${sh.id} panel ${i} leaves ${hold.toFixed(2)} s after its last word`);
    });
  }
}
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
// v30: no world tint (each journey panel carries its own look); sparse atmospheres.
const WORLD_WASH = { color: "primarySoft" as const, strength: 0.0, mode: "tint" as const };
const ATMOS: Record<string, [string, number]> = { C: ["dust", 0.45], D: ["scratches", 0.35], F: ["smoke", 0.45], H: ["smoke", 0.4], I: ["scratches", 0.4], J2: ["dust", 0.4], G: ["money", 0.4], Jd: ["scratches", 0.35], K: ["burn", 0.45] };
for (const sh of SHOTS) {
  const orig = sh.scene;
  sh.scene = (t0: number) => {
    const sc = orig(t0) as Record<string, unknown> & { backdrop?: string; world?: { accent?: string } };
    // the world tint, except shots kept in black and white on purpose (the channel's monochrome technique)
    if (WORLD_WASH.strength > 0 && (sc.backdrop ?? "footage") === "footage" && !(sc as { wash?: unknown }).wash) sc.wash = WORLD_WASH;
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
// v30: effects and beds no earlier version used
const HITS: Array<[string, number, number]> = [
  ["7f3697654fcda437", 5.72, -8], // shimmer: the post appears, in silence
  ["37e39d84460b602e", at(G("l03", 9)) + 0.1, -3], // sub boom: BANKRUPT
  ["0e43655364c93329", at(G("l06", 12)) + 0.1, -5], // impact: FTT
  ["095f1896d50b6e6f", at(G("l07", 2)) + 0.25, -4], // thud: $6 BILLION lands
  ["2ce5d1ade932f5fd", at(G("l10", 15)) + 0.3, -4], // sub boom: 25 YEARS
  ["46d52a4788d066c0", at(G("l11", 24)) + 0.1, -3], // impact: BET
];
for (const [id, moment, gain] of HITS) {
  const atS = Math.max(0, +(moment - (prof.sfx[id]?.attackS ?? 0)).toFixed(3));
  const sh = shots.find((x) => atS >= x.startS && atS < x.endS) ?? shots.at(-1)!;
  sh.sfx.push({ assetId: id, atS, gainDb: gain });
}
const cueAt = (seg: string) => +at(G(seg, 0)).toFixed(2);
const MUSIC = [
  { assetId: "c7d84c22243cc9b8", startS: 0, endS: cueAt("l07"), gainDb: -4, mood: "tension" as const, drops: [{ startS: +(cueAt("l07") - 0.7).toFixed(2), endS: cueAt("l07") }] },
  { assetId: "cfe84cbe6f131850", startS: cueAt("l07"), endS: cueAt("l10"), gainDb: -13, mood: "collapse" as const, drops: [{ startS: +(cueAt("l10") - 0.7).toFixed(2), endS: cueAt("l10") }] },
  { assetId: "ee760fba94164380", startS: cueAt("l10"), endS: dur, gainDb: -12, mood: "resolve" as const, drops: [{ startS: +(at(G("l11", 15)) - 0.75).toFixed(2), endS: +at(G("l11", 15)).toFixed(2) }] },
];
let board = Storyboard.parse({ schemaVersion: 1, id: "sb_hand_ftx", scriptId: timed.id, styleProfileId: "magnates-media", aspect: "16:9", durationS: dur, shots, music: [], generatedAt: new Date().toISOString() });
board = Storyboard.parse({ ...board, music: MUSIC });
let resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 0, stock: media.filter((m) => m.origin === "stock").length, archival: media.filter((m) => m.origin === "archival").length, designed: shots.length }, generatedAt: new Date().toISOString() });
const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(root, "data", "library-index.json"), "utf8")));
const atm = await resolveAtmosphere({ storyboard: board, scenes: scenes.map((s) => ({ shotId: s.shotId, ...(s.atmos ? { atmos: s.atmos } : {}) })), index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution, seed: "hand-ftx" });
board = atm.storyboard; resolution = atm.resolution;
resolution = await resolveAudio({ storyboard: board, index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution });
const plan = ScenePlan.parse({ schemaVersion: 2, storyboardId: board.id, scenes, generatedAt: new Date().toISOString() });
const design = FilmDesignSystem.parse({ schemaVersion: 2, id: "hand-ftx", channelId: "magnates-media", topic: "FTX", concept: "The bet: an empire built like a house of cards on belief. Green felt and cream like a card table, chip coral for what is lost; one heavy carved extra-condensed face and one display serif for what people said; every scene one continuous camera journey through real pictures; words arrive as whole phrases and stay.",
  palette: { primary: "#0f3d2e", primarySoft: "#1d6b4f", accent: "#ff5b3a", accentDeep: "#c2341b", surface: "#06221a", surfaceAlt: "#123f30", paper: "#f6ecd6", marker: "#ff5b3a", text: "#f6ecd6", textMuted: "#cfc3a8" },
  fonts: { display: "Sofia Sans Extra Condensed", body: "DM Serif Display" }, texture: { grain: 0.22, vignette: 0.3 }, acts: [{ name: "fall", tint: "#ff8a3d", tintStrength: 0.07, saturation: 1.1, contrast: Number(process.env.ACT_CONTRAST ?? 1.12), brightness: 1.0 }], generatedAt: new Date().toISOString() });
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
const look = { accent: "#ff5b3a", saturate: 1.05, contrast: 1.08, vignette: 0.55, grain: 0.25 };
if (process.argv.includes("--stretch")) {
  // re-render only seconds a–b and splice them frame-exact into the last silent render (fast iteration on one stretch)
  const [a, b] = process.argv[process.argv.indexOf("--stretch") + 1]!.split("-").map(Number) as [number, number];
  const silent = path.join(job, "video_silent.mp4"), next = path.join(job, "video_silent.next.mp4"), master = path.join(job, "master.wav");
  await renderStretches({ manifest, look, design, publicDir: pub, previous: silent, out: next, ranges: [[Math.round(a * FPS), Math.round(b * FPS)]], log: console.log });
  await rename(next, silent);
  await masterAudio(manifest, master);
  await muxFinal(silent, master, path.join(job, "film_16x9.mp4"));
  console.log("rendered", path.join(job, "film_16x9.mp4"), `(seconds ${a}–${b} re-rendered)`);
} else if (process.argv.includes("--mix")) {
  // sound only: remaster and mux onto the last silent render (mix passes in seconds)
  const silent = path.join(job, "video_silent.mp4"), master = path.join(job, "master.wav");
  await masterAudio(manifest, master);
  await muxFinal(silent, master, path.join(job, "film_16x9.mp4"));
  console.log("remixed", path.join(job, "film_16x9.mp4"));
} else if (process.argv.includes("--render")) {
  const silent = path.join(job, "video_silent.mp4"), master = path.join(job, "master.wav");
  await renderVideo({ manifest, look, design, publicDir: pub, out: silent, log: console.log });
  await masterAudio(manifest, master);
  await muxFinal(silent, master, path.join(job, "film_16x9.mp4"));
  console.log("rendered", path.join(job, "film_16x9.mp4"));
} else {
  const prev = await renderShotPreviews({ manifest, look, design, publicDir: pub, outDir: path.join(job, "previews"), shotIds: only ? [...only] : board.shots.map((s) => s.id), log: console.log });
  console.log(prev.map((p) => p.sheet).filter(Boolean).length, "preview sheets");
}
