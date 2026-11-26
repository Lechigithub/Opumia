// Wirecard v4 (build list 6, 2026-11-25): the same narration, the picture rebuilt WORLD-FIRST from its world bible
// (apps/cli/src/dev/hand/world-wirecard-v4.md): the story's real subjects and the company's own visual language (thermal
// receipts, the terminal's screen, the FT's pink paper). Nothing of FTX or of Wirecard v1–v3's design.
// Previously: Wirecard's cold open, built from nothing for MOTION. Same plumbing as build.ts (storyboard,
// resolution, scenes, manifest, render); nothing of the FTX film's design, pictures, sounds or music.
//   OPUMIA_NO_CLAUDE=1 npx tsx apps/cli/src/dev/hand/build-wirecard.ts [--only B1,B2] [--render | --stretch a-b | --mix]
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { FilmDesignSystem, LibraryIndex, ResolutionReport, ScenePlan, Storyboard, TimedScript, type ResolvedMedia, type SceneSpec } from "@opumia/contracts";
import { buildManifest, renderShotPreviews, renderStretches, renderVideo, masterAudio, muxFinal } from "@opumia/motion-engine";
import { resolveAudio } from "@opumia/resolver";
import { BED_GAP, COLD_OPEN_DUCK, levelBeds } from "@opumia/agents";

const root = process.cwd();
const job = path.join(root, "out", "hand-wirecard-v5");
const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1]!.split(",")) : null;
const timed = TimedScript.parse(JSON.parse(await readFile(path.join(job, "timed-script-marcus.json"), "utf8")));
const NEWS = timed.segments, W = NEWS.flatMap((s) => s.words), FPS = 24;
const G = (line: string, k: number) => { let n = 0; for (const sg of NEWS) { if (sg.id === line) return n + Math.min(k, sg.words.length - 1); n += sg.words.length; } throw new Error(`no line ${line}`); };
const at = (line: string, k: number) => W[G(line, k)]!.startS;

// ---- media: the story's real subjects first (Commons, press excerpts logged as fair use), staged stock only where no
// real picture exists. Paths are relative to the repo root.
type M = { file: string; kind: "video" | "image"; origin: ResolvedMedia["origin"]; provider: ResolvedMedia["provider"]; license: string; credit: string; url: string };
const W3 = "out/hand-wirecard/downloads";
const stockCredit = JSON.parse(await readFile(path.join(root, W3, "stock.json"), "utf8")) as Record<string, { credit?: string }>;
const W4 = "out/hand-wirecard-v4/downloads";
const stock4 = JSON.parse(await readFile(path.join(root, W4, "stock.json"), "utf8")) as Record<string, { credit?: string }>;
const PX4 = (id: string): M => ({ file: `${W4}/stock/pexels_${id}.mp4`, kind: "video", origin: "stock", provider: "pexels", license: "Pexels License", credit: stock4[`pexels_${id}`]?.credit ?? "Pexels", url: `https://www.pexels.com/video/${id}/` });
const CUT = (f: string): M => ({ file: `${W4}/cut/${f}`, kind: "image", origin: "archival", provider: "commons", license: "derived cut-out of the picture beside it", credit: "cut-out (local, BiRefNet) of the picture it was cut from", url: "" });
const DEPTH = (f: string): M => ({ file: `out/hand-wirecard-v5/downloads/depth/${f}`, kind: "image", origin: "archival", provider: "commons", license: "depth map derived locally from the picture beside it", credit: "depth map (local, Depth Anything V2)", url: "" });
const filmsMeta = JSON.parse(await readFile(path.join(root, "out/hand-wirecard-v5/downloads/films/films.json"), "utf8")) as Record<string, { sid: string; file: string; in: number; seconds: number }>;
const FILM = (k: string): M => { const m = filmsMeta[k]!; const id = m.sid.split(":")[0]!.replace(/^ia_/, ""); return { file: `out/hand-wirecard-v5/downloads/films/${k}.mp4`, kind: "video", origin: "archival", provider: "archive", license: "Public domain (US) — feature film, used as metaphor, never as the real event", credit: `${id} (public domain, via the Internet Archive), ${m.in}s`, url: `https://archive.org/details/${id}` }; };
const LIB = (rel: string): M => ({ file: `Library/${rel}`, kind: "video", origin: "library", provider: "library", license: "see Library/overlays licences", credit: rel, url: "" });
const PX = (id: string): M => ({ file: `${W3}/stock/pexels_${id}.mp4`, kind: "video", origin: "stock", provider: "pexels", license: "Pexels License", credit: stockCredit[`pexels_${id}`]?.credit ?? "Pexels", url: `https://www.pexels.com/video/${id}/` });
const commonsMeta = JSON.parse(await readFile(path.join(root, W3, "commons.json"), "utf8")) as Array<{ title: string; file?: string; licence?: string; license?: string; credit?: string; author?: string; url?: string }>;
const CM = (title: string, file: string, kind: "video" | "image" = "image"): M => { const m = commonsMeta.find((x) => x.title === title) ?? ({} as never); return { file: `${W3}/commons/${file}`, kind, origin: "archival", provider: "commons", license: String(m.licence ?? m.license ?? "see Commons"), credit: String(m.credit ?? `${title.replace(/^File:/, "")}, via Wikimedia Commons`), url: String(m.url ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`) }; };
const PRESS = (file: string, url: string, who: string): M => ({ file: `${W3}/press/${file}`, kind: "video", origin: "press", provider: "youtube", license: "fair use (excerpt ≤ 6.5 s, muted, reframed under commentary)", credit: who, url });
const MEDIA: Record<string, M> = {
  printer: CM("File:Wiki article receipt being printed.webm", "Wiki_article_receipt_being_printed.webm", "video"),
  hq: CM("File:Wirecard-aschheim-2019.jpg", "Wirecard_aschheim_2019.jpg"),
  hq2: CM("File:Aschheim-Dornach, Einsteinring 31 v N, 3, ret Wirecard.jpeg", "Aschheim_Dornach_Einsteinring_31_v_N_3_ret_Wirecard.jpeg"),
  terminal: CM("File:Credit card terminal.jpg", "Credit_card_terminal.jpg"),
  bullbear: CM("File:Bulle und Bär Frankfurt.jpg", "Bulle_und_B_r_Frankfurt.jpg"),
  bullbear2: CM("File:Bulle und Bär Frankfurt 2.jpg", "Bulle_und_B_r_Frankfurt_2.jpg"),
  bpi: CM("File:Bank of the Philippine Islands (shankar s) - Flickr.jpg", "Bank_of_the_Philippine_Islands_shankar_s_Flickr.jpg"),
  makati: CM("File:09080jfUrdaneta Bel-Air Zuellig Building BDO Paseo de Roxas Makati Avenuesfvf 32.jpg", "09080jfUrdaneta_Bel_Air_Zuellig_Building_BDO_Paseo_de_Roxas_Makati_Avenuesfvf_32.jpg"),
  slip: CM("File:Kortunefookie receipt.jpg", "Kortunefookie_receipt.jpg"),
  braun: PRESS("G0GmcbERGbk_braun.mp4", "https://www.youtube.com/watch?v=G0GmcbERGbk", "Reuters (excerpt, fair use)"),
  braunstage: PRESS("DS0hu0SLsOU_braunstage.mp4", "https://www.youtube.com/watch?v=DS0hu0SLsOU", "Reuters (excerpt, fair use)"),
  mccrum: PRESS("mccrum_clean.mp4", "https://www.youtube.com/watch?v=u-8-QbDpqqw", "Financial Times (excerpt, fair use)"),
  poster: PRESS("marsalek_poster.mp4", "https://www.youtube.com/watch?v=3-yauD_IZHw", "euronews / Polizeipräsidium München wanted notice (excerpt, fair use)"),
  cuffs: PX("7714092"), jet: PX("1650628"), counter: PX("6266288"), euros: PX("33402648"),
  // v4.2: performed reenactment (the channel's staged actors, ≈ 32 % of its shots) and moving real stills
  tap: PX4("6540557"), wallet: PX4("11099870"), reporter: PX4("8369277"), denial: PX4("6415611"), investigators: PX4("8369281"), trader: PX4("7578646"), stage: PX4("35451425"), typing: PX4("13375774"), auditor: PX4("8298011"), phone: PX4("8134512"),
  hqcut: CUT("hq_cut.png"), bullcut: CUT("bullbear_cut.png"),
  // v5: depth maps of the real stills (tools/depth/depth.py, Depth Anything V2, local) for the Three.js depth camera
  astonished: FILM("astonished"), scrum: FILM("scrum"), cheer: FILM("cheer"), writer: FILM("writer"), interrogation: FILM("interrogation"), auditors: FILM("auditors"), fphone: FILM("phone"), arrest: FILM("arrest"), bankrun: FILM("bankrun"), stairs: FILM("stairs"), cashdeal: FILM("cashdeal"),
  dust: LIB("overlays/dust/dust_scratches_on_black_03.mp4"),
  bulldepth: DEPTH("bullbear_depth.png"), hqdepth: DEPTH("hq_depth.png"), bpidepth: DEPTH("bpi_depth.png"), reichstagdepth: DEPTH("reichstag_depth.png"), hq2depth: DEPTH("hq2_depth.png"),
  floor: CM("File:Dirk Müller Börsenmakler.jpg", "Dirk_M_ller_B_rsenmakler.jpg"), bafin: CM("File:Bafin Frankfurt.jpg", "Bafin_Frankfurt.jpg"),
  reichstag: CM("File:Reichstag building Berlin view from west before sunset.jpg", "Reichstag_building_Berlin_view_from_west_before_sunset.jpg"),
};

// ---- beats: each starts on its word; `len` runs to the next beat ----
type Foot = { key: string; trim?: number; push?: [number, number]; pan?: [number, number]; wash?: { color: string; strength: number; mode: "tint" | "duotone" }; fx?: { dof?: number } };
type Beat = { id: string; seg: string; k: number; lead?: number; intent: string; slots: Record<number, string>; footage?: Foot; props: (t: number, r: (seg: string, k: number) => number) => Record<string, unknown> };
type L = { text: string; at: number; size?: number; bold?: boolean; strike?: number; rule?: boolean; align?: "left" | "right" | "center" };
const ln = (text: string, at: number, o: Partial<L> = {}): L => ({ text, at, ...o });
const rule = (at: number): L => ({ text: "", at, rule: true });
const CLEAN = () => ({});
const GRADE = { dusk: "saturate(1.18) contrast(1.38) brightness(0.62) hue-rotate(-6deg)", cool: "saturate(1.22) contrast(1.24) brightness(0.86)", night: "saturate(1.25) contrast(1.3) brightness(0.66)", paper: "saturate(0.9) contrast(1.15) brightness(0.95)" }; // v4.1: full colour (v4 measured colourfulness 18 against the channel's 31–46)
const PAR = (bg: number, cut: number, box: number[], aspect: number, keys: Array<Record<string, number>>, o: Record<string, unknown> = {}) => ({ bg, cut, box, aspect, keys, ...o });
// v5 (the film made the channel's way, no AI): performed scenes from the public-domain feature-film library, used as the
// channel uses film clips — as metaphor, never passed off as the real event; real people and places, stills moved by a
// real camera through their own depth (Three.js); the world's receipts, terminal and FT pink only at their key moments;
// real filmed dust and scratches over the film scenes.
const FILMLOOK = "sepia(0.55) saturate(1.6) contrast(1.28) brightness(0.86)";
const dust = { lightTrim: 0, lightFilter: "contrast(1.25)", lightOpacity: 0.32 };
const DP = (image: number, depth: number, aspect: number, keys: Array<Record<string, number>>, strength = 0.3) => ({ image, depth, aspect, keys, strength });
const BEATS: Beat[] = [
  { id: "V1", seg: "w01", k: 0, lead: 0, intent: "a card tapped on a terminal: September 2018", slots: { 0: "tap" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 1, push: [1.1, 1.45], pan: [0.03, -0.03], tilt: [-1.5, 1.5], grade: GRADE.night }], tearOut: true,
      big: [{ y: 0.36, lines: [{ text: "SEPTEMBER", at: r("w01", 1) }, { text: "2018", at: r("w01", 2) }] }] }) },
  { id: "V2", seg: "w01", k: 8, lead: 0.1, intent: "Wirecard's own headquarters in Aschheim, filmed in depth", slots: { 0: "hq", 1: "hqdepth" },
    props: (t, r) => ({ depthplate: DP(0, 1, 1.5, [{ t: 0, s: 1.0, x: 0.1, y: 0.0, r: -0.4 }, { t: 2.0, s: 1.18, x: -0.1, y: 0.0, r: 0.4 }]), lowkey: true, tearOut: true,
      labels: [{ text: "ASCHHEIM", sub: "OUTSIDE MUNICH", at: r("w01", 8) + 0.1, x: 0.06, y: 0.72, size: 0.034 }] }) },
  { id: "V3", seg: "w01", k: 12, lead: 0.1, intent: "an audience gasping in a theatre (film, 1927): almost nobody thought it possible", slots: { 0: "astonished", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.5, push: [1.1, 1.4], pan: [0.03, -0.03], grade: FILMLOOK }], ...dust, tearOut: true }) },
  { id: "V4", seg: "w02", k: 0, lead: 0.05, intent: "a crowd scrum on a trading floor (film, 1920); the DAX list prints, Commerzbank struck out", slots: { 0: "scrum", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.5, push: [1.12, 1.4], pan: [-0.03, 0.03], grade: FILMLOOK }], ...dust, tearOut: true,
      receipts: [{ x: 0.52, w: 0.42, tilt: -2.5, lines: [ln("DAX 30", r("w02", 0) + 0.1, { bold: true, size: 1.4 }), rule(r("w02", 1)), ln("COMMERZBANK", r("w02", 2), { strike: r("w02", 9) }), ln("FOUNDING MEMBER", r("w02", 7), { size: 0.7 }), ln("+ WIRECARD", r("w02", 9), { bold: true, size: 1.2 })] }] }) },
  { id: "V4b", seg: "w02", k: 11, lead: 0.1, intent: "the Frankfurt exchange's bull and bear, filmed in depth: out of Germany's DAX", slots: { 0: "bullbear", 1: "bulldepth" },
    props: (t, r) => ({ depthplate: DP(0, 1, 1.504, [{ t: 0, s: 0.82, x: -0.16, y: 0.02, r: 0.6 }, { t: 2.2, s: 1.05, x: 0.14, y: -0.02, r: -0.6 }], 0.32), lowkey: true, tearOut: true }) },
  { id: "V5", seg: "w03", k: 0, lead: 0.05, intent: "Wirecard's glass offices filmed in depth: €24 billion", slots: { 0: "hq2", 1: "hq2depth" },
    props: (t, r) => ({ depthplate: DP(0, 1, 1.326, [{ t: 0, s: 0.88, x: -0.1, y: 0.02 }, { t: 5.0, s: 1.25, x: 0.1, y: -0.03 }]), lowkey: true, tearOut: true,
      big: [{ y: 0.38, lines: [{ text: "€24 BILLION", at: r("w03", 4) }] }] }) },
  { id: "V5b", seg: "w03", k: 11, lead: 0.1, intent: "a crowd cheering and waving flags (film, 1930): Germany finally had", slots: { 0: "cheer", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.3, push: [1.02, 1.18], pan: [0.03, -0.03], tilt: [0, 0], grade: FILMLOOK }], ...dust, tearOut: true }) },
  { id: "V6", seg: "w03", k: 15, lead: 0.1, intent: "Markus Braun on stage before the Wirecard logo (Reuters): a tech champion", slots: { 0: "braunstage" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.3, push: [1.08, 1.32], pan: [0.02, -0.02], grade: GRADE.cool }], tearOut: true,
      labels: [{ text: "MARKUS BRAUN", sub: "CHIEF EXECUTIVE", at: r("w03", 16), x: 0.06, y: 0.74, size: 0.036 }] }) },
  { id: "V7a", seg: "w04", k: 0, lead: 0.05, intent: "a man working through papers by lamplight at night (film): a reporter kept asking", slots: { 0: "writer", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.5, push: [1.15, 1.45], pan: [0.04, -0.04], grade: FILMLOOK }], ...dust, tearOut: true }) },
  { id: "V7", seg: "w04", k: 5, lead: 0.1, intent: "the FT reporter Dan McCrum, the FT's pink sheet: where is the money?", slots: { 0: "mccrum" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.3, push: [1.1, 1.3], pan: [-0.16, -0.14], grade: GRADE.cool }], pink: { from: r("w04", 9), box: [0.53, 0.18, 0.42, 0.56] }, tearOut: true,
      labels: [{ text: "DAN McCRUM", sub: "FINANCIAL TIMES", at: r("w04", 6), x: 0.05, y: 0.08, size: 0.03, until: r("w04", 10) - 0.2 }],
      columns: [{ kicker: "Financial Times", x: 0.57, y: 0.3, w: 0.36, size: 0.052, head: [{ text: "Where is", at: r("w04", 10) }, { text: "the money?", at: r("w04", 12) }] }] }) },
  { id: "V8", seg: "w04", k: 15, lead: 0.1, intent: "the Reichstag filmed in depth: Germany didn't go after the company", slots: { 0: "reichstag", 1: "reichstagdepth" },
    props: (t, r) => ({ depthplate: DP(0, 1, 2.645, [{ t: 0, s: 0.9, x: 0.08, y: 0.0 }, { t: 2.2, s: 1.15, x: -0.06, y: -0.03 }], 0.28), lowkey: true, tearOut: true }) },
  { id: "V9", seg: "w05", k: 0, lead: 0.05, intent: "a man questioned by police and a detective (film, 1920): bets banned, the reporter investigated", slots: { 0: "interrogation", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.4, push: [1.1, 1.4], pan: [0.03, -0.03], grade: FILMLOOK }], ...dust, tearOut: true }) },
  { id: "V10", seg: "w06", k: 0, lead: 0.05, intent: "two old men scrutinising a paper (film, 1925): the audit, €1.9 billion", slots: { 0: "auditors", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.4, push: [1.12, 1.42], pan: [0.03, -0.03], grade: FILMLOOK }], ...dust, tearOut: true,
      big: [{ y: 0.36, lines: [{ text: "€1.9 BILLION", at: r("w06", 9) }] }] }) },
  { id: "V11", seg: "w06", k: 22, lead: 0.1, intent: "the two banks, printed as thermal snapshots and pinned together", slots: { 0: "bpi", 1: "makati" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.2, 1.5], pan: [0.06, -0.06], grade: GRADE.dusk + " blur(10px) brightness(0.5)" }], tearOut: true,
      collage: [{ slot: 0, at: r("w06", 21), x: 0.1, y: 0.16, w: 0.38, rot: -4 }, { slot: 1, at: r("w06", 22) + 0.15, x: 0.5, y: 0.22, w: 0.38, rot: 3 }] }) },
  { id: "V12", seg: "w07", k: 0, lead: 0.05, intent: "a man at a wall telephone, taken aback (film): NOTHING to do with Wirecard", slots: { 0: "fphone", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.5, push: [1.1, 1.35], pan: [-0.03, 0.03], grade: FILMLOOK }], ...dust, lowkey: true, tearOut: true,
      lcd: [{ box: [0.5, 0.62, 0.42, 0.2], states: [{ text: "SEARCHING", at: r("w07", 0) }, { text: "NOTHING", at: r("w07", 5), sub: "TO DO WITH WIRECARD" }] }] }) },
  { id: "V13", seg: "w08", k: 0, lead: 0.05, intent: "a policeman hauling a man across a room (film, 1923): ARRESTED", slots: { 0: "arrest", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 2.2, push: [1.12, 1.4], pan: [0.03, -0.03], grade: FILMLOOK }], ...dust, tearOut: true,
      big: [{ y: 0.42, lines: [{ text: "ARRESTED", at: r("w08", 7) }] }] }) },
  { id: "V14", seg: "w08", k: 8, lead: 0.05, intent: "a crowd rushing a bank's doors (film, 1928): the first DAX company ever to go bust", slots: { 0: "bankrun", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.3, push: [1.1, 1.5], pan: [0.06, -0.06], grade: FILMLOOK }], ...dust, tearOut: true,
      big: [{ y: 0.3, lines: [{ text: "FIRST DAX COMPANY", at: r("w08", 11) }, { text: "EVER TO GO BUST", at: r("w08", 14) }] }] }) },
  { id: "V15", seg: "w08", k: 18, lead: 0.05, intent: "the real wanted poster of Jan Marsalek (Munich police, via euronews)", slots: { 0: "poster" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.04, 1.04], pan: [0, 0], grade: GRADE.paper, box: [0.34, 0.03, 0.32, 0.94] }], tearOut: true,
      labels: [{ text: "JAN MARSALEK", sub: "CHIEF OPERATING OFFICER", at: r("w08", 23), x: 0.68, y: 0.62, size: 0.03 }] }) },
  { id: "V16", seg: "w08", k: 27, lead: 0.1, intent: "men climbing airliner stairs past photographers (film, 1927): a private jet to Minsk", slots: { 0: "stairs", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 0.5, push: [1.12, 1.45], pan: [0.04, -0.04], grade: FILMLOOK }], ...dust, tearOut: true }) },
  { id: "V17", seg: "w08", k: 33, lead: 0.05, intent: "two men counting a table piled with banknotes (film, 1927): paid in cash", slots: { 0: "cashdeal", 7: "dust" },
    props: (t, r) => ({ plates: [{ slot: 0, trim: 2.0, push: [1.1, 1.35], pan: [0.03, -0.03], grade: FILMLOOK }], ...dust, tearOut: true,
      big: [{ y: 0.08, lines: [{ text: "PAID IN CASH", at: r("w08", 33) }] }] }) },
  { id: "V18", seg: "w09", k: 0, lead: 0.05, intent: "real euro notes, then hands opening an empty wallet: money that was never there", slots: { 0: "euros", 1: "wallet" },
    props: (t, r) => ({ plates: [{ slot: 0, push: [1.1, 1.5], pan: [0.03, -0.03], tilt: [-2, 2], grade: GRADE.night }, { slot: 1, at: r("w09", 13) - 0.1, trim: 4, push: [1.1, 1.4], pan: [-0.03, 0.03], grade: GRADE.night }], lowkey: true,
      receipts: [{ x: 0.27, w: 0.46, tilt: -1, lines: [ln("COMPANY VALUE", r("w09", 4)), ln("€24,000,000,000", r("w09", 6), { bold: true, size: 1.25, strike: r("w09", 18) })] }],
      big: [{ y: 0.64, lines: [{ text: "NEVER THERE", at: r("w09", 18) }] }] }) },
];
const TITLE_AT = +(timed.durationS + 0.25).toFixed(2), TITLE_LEN = 2.8;
const starts = BEATS.map((b) => (b.id === "B1" ? 0 : +(at(b.seg, b.k) - (b.lead ?? 0.05)).toFixed(2)));
const dur = +(TITLE_AT + TITLE_LEN).toFixed(2);

// ---- the job ----
const pub = path.join(job, "public");
await mkdir(path.join(pub, "media"), { recursive: true });
const media: ResolvedMedia[] = [];
const probe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f]).toString()) as { streams: Array<{ width: number; height: number }>; format: { duration?: string } };
async function place(shotId: string, key: string, slot: number, role: "layer" | "primary" = "layer") {
  const m = MEDIA[key]!;
  const out = path.join(pub, "media", `${shotId}_${key}${path.extname(m.file)}`);
  if (!existsSync(out)) await copyFile(path.join(root, m.file), out);
  const p = probe(out);
  media.push({ shotId, role, origin: m.origin, slot, ref: `${m.provider}:${key}`, provider: m.provider, kind: m.kind, localPath: out, publicPath: `media/${path.basename(out)}`, ...(m.kind === "video" && p.format.duration ? { durationS: Number(p.format.duration) } : {}), width: p.streams[0]?.width, height: p.streams[0]?.height, license: m.license, attributionRequired: true, attributionText: m.credit, sourceUrl: m.url, aiGenerated: false, score: 1, query: "chosen by eye" } as ResolvedMedia);
}
const shots = [] as Storyboard["shots"];
const scenes: SceneSpec[] = [];
for (const [i, b] of BEATS.entries()) {
  const t0 = starts[i]!, t1 = starts[i + 1] ?? TITLE_AT;
  for (const [slot, key] of Object.entries(b.slots)) await place(b.id, key, Number(slot));
  const r = (seg: string, k: number) => +(at(seg, k) - t0).toFixed(2);
  const ft = b.footage;
  if (ft) await place(b.id, ft.key, 0, "primary");
  const camera = ft ? { type: "ken_burns" as const, fromScale: ft.push?.[0] ?? 1.06, toScale: ft.push?.[1] ?? 1.28, from: [ft.pan?.[0] ?? 0.5, 0.5] as [number, number], to: [ft.pan?.[1] ?? 0.5, 0.5] as [number, number], easing: "linear" as const } : { type: "static" as const };
  shots.push({ schemaVersion: 2, id: b.id, scriptSegmentId: b.seg, index: i, startS: t0, endS: t1, intent: b.intent, lineLink: "literal", source: { kind: "designed", designed: "scene", props: { brief: b.intent }, assetIds: [] }, camera, ...(ft?.trim ? { trimInS: ft.trim } : {}), overlays: [], sfx: [], transitionIn: "cut" } as Storyboard["shots"][number]);
  // a footage shot: the clip itself under the film's grade (clean, or with the kit's words over it)
  if (ft) { scenes.push({ shotId: b.id, idea: b.intent, backdrop: "footage", dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, finish: { grain: 0.24, vignette: 0.3, leak: 0 }, ...(ft.wash ? { wash: ft.wash } : {}), fx: { ...ft.fx, rack: true } /* arrives out of focus and pulls sharp: the change moves, it is not a cut */, elements: (((b.props(t0, r) as { words?: unknown[] }).words) ?? []).map((w) => ({ type: "component", name: "Words", x: 0, y: 0, w: 1, h: 1, rot: 0, z: 0.8, at: 0, enter: "fade", props: w })) } as unknown as SceneSpec); continue; }
  scenes.push({ shotId: b.id, idea: b.intent, backdrop: "stage", dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, finish: { grain: 0.24, vignette: 0.2, leak: 0 }, elements: [{ type: "component", name: "Beat", x: 0, y: 0, w: 1, h: 1, rot: 0, z: 0.8, at: 0, enter: "fade", props: { ...b.props(t0, r), len: +(t1 - t0).toFixed(2) } }] } as unknown as SceneSpec);
}
await place("TITLE", "hq", 0);
shots.push({ schemaVersion: 2, id: "TITLE", scriptSegmentId: "w09", index: BEATS.length, startS: TITLE_AT, endS: dur, intent: "the title card", lineLink: "literal", source: { kind: "designed", designed: "scene", props: { brief: "title" }, assetIds: [] }, camera: { type: "static" }, overlays: [], sfx: [], transitionIn: "cut" } as Storyboard["shots"][number]);
scenes.push({ shotId: "TITLE", idea: "title", backdrop: "stage", dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, finish: { grain: 0.2, vignette: 0.2, leak: 0 }, elements: [{ type: "component", name: "Title", x: 0, y: 0, w: 1, h: 1, rot: 0, z: 0.8, at: 0, enter: "fade", props: { title: "Wirecard", subtitle: "THE €24 BILLION COMPANY BUILT ON MONEY THAT WASN'T THERE", len: TITLE_LEN } }] } as unknown as SceneSpec);

// ---- sound: modest hits on the slams; two beds, the change on the turn ("But when a reporter…") ----
const prof = JSON.parse(await readFile(path.join(root, "data", "audio-profile.json"), "utf8")) as { sfx: Record<string, { attackS: number }> };
const HITS: Array<[string, number, number]> = [
  ["b7a2ca48ea6b721a", at("w02", 9) + 0.05, -13], // Commerzbank struck out
  ["a9040acf25874da1", at("w05", 9) + 0.08, -12], // the stamp: investigated
  ["56beec7833560f0f", at("w08", 16) + 0.1, -10], // go bust
  ["8c00d5c5698ec474", TITLE_AT + 0.1, -9], // the title
];
// v4.3: a thud as the headquarters arrives — an early sound event in the cold open (mix 0.75 → 0.79 on the ears
// measure; a whoosh did the same, a thud is the channel's own family; the world's paper and register sounds changed nothing)
HITS.push(["095f1896d50b6e6f", starts[1]! + 0.05, -14]);
for (const [id, moment, gain] of HITS) {
  const atS = Math.max(0, +(moment - (prof.sfx[id]?.attackS ?? 0)).toFixed(3));
  (shots.find((x) => atS >= x.startS && atS < x.endS) ?? shots.at(-1)!).sfx.push({ assetId: id, atS, gainDb: gain });
}
const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(root, "data", "library-index.json"), "utf8")));
const turn = +(at("w04", 0) - 0.3).toFixed(2);
// v4.6 (G3): beds chosen by the voice-blind bed head (data/audio-profile-bed-taste.json): "Rising" 0.907 and "Nightfall"
// 0.920 replace "Floating Cities" 0.589 and "Lightless Dawn" 0.330 (the channel's real beds: p10 0.645, median 0.843);
// the later beds enter a quarter of the way in (their quiet intros scored 0.07 in the film)
const fall = +(at("w08", 0) - 0.25).toFixed(2); // v3: the third bed on "Within a week" (the fall)
const lv = await levelBeds({ music: [{ assetId: "a5f5cde4936f207f", startS: 0, endS: turn + 0.6, gainDb: 0 }, { assetId: "ee760fba94164380", startS: turn, endS: fall + 0.4, gainDb: 0, duckDb: COLD_OPEN_DUCK, inS: 66 }, { assetId: "02a60366aa8488ef", startS: fall, endS: dur, gainDb: 0, duckDb: COLD_OPEN_DUCK, inS: 59 }], /* v3: "discovery" ("emergent" cost the mix 0.80 → 0.70) */ fileOf: (id) => { const a = index.assets.find((x) => x.id === id); return a ? path.join(root, "Library", a.relPath) : null; }, titleCardEndS: turn + 1, cacheDir: path.join(root, "data", ".cache") });
for (const k of [1, 2]) if (lv.music[k]) lv.music[k]!.gainDb += BED_GAP.body - BED_GAP.coldOpen; // the whole film is a cold open: the later beds at the cold-open level too
console.log("beds:", lv.notes.join(" | "));
let board = Storyboard.parse({ schemaVersion: 1, id: "sb_hand_wirecard_v5", scriptId: timed.id, styleProfileId: "magnates-media", aspect: "16:9", durationS: dur, shots, music: lv.music.map((m, k) => ({ ...m, mood: k === 0 ? "rise" : k === 1 ? "tension" : "collapse", drops: k === 1 ? [{ startS: +(at("w07", 0) - 0.15).toFixed(2), endS: +(at("w07", 5) - 0.02).toFixed(2) }] : [] })), generatedAt: new Date().toISOString() });
let resolution = ResolutionReport.parse({ schemaVersion: 1, storyboardId: board.id, media, unresolved: [], stats: { library: 0, stock: media.filter((m) => m.origin === "stock").length, archival: media.filter((m) => m.origin === "archival").length, designed: shots.length }, generatedAt: new Date().toISOString() });
resolution = await resolveAudio({ storyboard: board, index, libraryRoot: path.join(root, "Library"), jobDir: job, resolution });
const plan = ScenePlan.parse({ schemaVersion: 2, storyboardId: board.id, scenes, generatedAt: new Date().toISOString() });
const design = FilmDesignSystem.parse({ schemaVersion: 2, id: "hand-wirecard-v5", channelId: "magnates-media", topic: "Wirecard", concept: "Printed on its own receipts: an empire of transactions that said APPROVED. Thermal paper printing the figures line by line, a card terminal's green-grey screen, and the Financial Times' salmon-pink paper that kept asking where the money was. Courier Prime, VT323, Old Standard TT. No glow, nothing raining.",
  palette: { primary: "#2b2a28", primarySoft: "#8d8a84", accent: "#9fb39a", accentDeep: "#1d2a1c", surface: "#0b0d10", surfaceAlt: "#1a1c1f", paper: "#f3efe6", marker: "#b3261e", text: "#f3efe6", textMuted: "#8d8a84" },
  fonts: { display: "Courier Prime", body: "Old Standard TT" }, texture: { grain: 0.2, vignette: 0.3 }, acts: [{ name: "cold open", tint: "#f2dfcf", tintStrength: 0.03, saturation: 0.9, contrast: 1.08, brightness: 1.0 }], generatedAt: new Date().toISOString() });
for (const [f, v] of [["storyboard.json", board], ["resolution.json", resolution], ["scenes.json", plan], ["design.json", design]] as const) await writeFile(path.join(job, f), JSON.stringify(v, null, 2));
await writeFile(path.join(job, "job.json"), JSON.stringify({ channel: "magnates-media", aspect: "16:9", topic: "Wirecard", hand: true }, null, 2));
const manifest = await buildManifest({ storyboard: board, script: { ...timed, durationS: dur - 0.6 }, resolution, libraryRoot: path.join(root, "Library"), outputPath: path.join(job, "film.mp4"), narrationPath: timed.voice.audioPath, burnCaptions: false, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
await writeFile(path.join(job, "manifest.json"), JSON.stringify(manifest, null, 2));
if (process.argv.includes("--manifest-only")) process.exit(0);
const look = { accent: "#9fb39a", saturate: 0.95, contrast: 1.06, vignette: 0.4, grain: 0.2 };
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
