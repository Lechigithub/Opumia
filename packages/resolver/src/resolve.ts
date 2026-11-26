import { execFile } from "node:child_process";
import { PLATFORM_FPS } from "@opumia/contracts";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ResolutionReport, type AssetRecord, type LibraryIndex, type ResolvedMedia, type Storyboard, type StoryboardShot } from "@opumia/contracts";
import { isUsable, MODELS, plain, structured, watermarkCheck } from "@opumia/agents";
import { ensureLocal } from "@opumia/ingest";
import * as z from "zod/v4";
import { Bm25, buildDocs, type LocalDoc } from "./local-search.js";
import { allProviders, archiveAt, downloadCandidate, providerHealth, providersFor, refused, searchStock, sharpEnough, type StockCandidate } from "./stock.js";
import { measureCraft } from "@opumia/senses";
import { MEANING_BAR, archiveMoment, periodCheck, yearOf, closeBrowser, reviewFrame, reviewPictures, screenshotPage, visionCheck, wikipediaImages, youtubeFootage, youtubePress, type PressCandidate } from "./press.js";
import { planSourcing, pooled, replanShots, thumbOf, webPictures, type ShotBrief } from "./widen.js";

const run = promisify(execFile);

type Cand = { src: "local"; doc: LocalDoc; score: number } | { src: "stock"; c: StockCandidate; score: number } | { src: "press"; p: PressCandidate; score: number };

const PickSchema = z.object({ picks: z.array(z.object({ shot: z.string(), choice: z.number().describe("candidate index, or -1 if none fits") })) });

const describe = (c: Cand) =>
  c.src === "press"
    ? `${c.p.kind} | press/${c.p.provider} | ${c.p.title.slice(0, 120)}`
    : c.src === "local"
    ? `${c.doc.kind} | library/${c.doc.asset.category} | ${c.doc.decade ?? "?"}s | ${c.doc.text.slice(0, 160)}`
    : `${c.c.kind} | ${c.c.provider} | ${c.c.title.slice(0, 100)} | ${c.c.tags.slice(0, 6).join(", ")}${c.c.durationS ? ` | ${Math.round(c.c.durationS)}s` : ""}`;

interface Need {
  shot: StoryboardShot;
  query: string;
  kind: "video" | "image" | "any";
  decade: number | null;
  period: boolean;
  durationS: number;
  /** Words spoken over this shot (what the viewer hears while seeing it). */
  line: string;
}

export interface StoryEra {
  min: number;
  max: number;
}

/** Story era from the years spoken in the narration (e.g. 1985–2001), or null for timeless topics. */
export function storyEraOf(text: string): StoryEra | null {
  const years = [...text.matchAll(/\b(1[89]\d\d|20[0-4]\d)\b/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!years.length) return null;
  // Robust to a lone founding-year mention (e.g. "founded in 1865" in a 2007–2013 story): use the 25th percentile.
  const p25 = years[Math.floor((years.length - 1) * 0.25)]!;
  return { min: p25, max: years[years.length - 1]! };
}

function needOf(shot: StoryboardShot, storyEra: StoryEra | null): Need | null {
  const s = shot.source;
  const bg = s.kind === "designed" ? (s.props.background as { query?: string; mustBe?: string; era?: string } | undefined) : s.kind === "query" ? { query: s.query, mustBe: s.mustBe, era: s.era } : undefined;
  if (!bg?.query) return null;
  const era = bg.era ?? "";
  const yr = /(\d{4})s?/.exec(`${era} ${bg.query}`)?.[1];
  const decade = yr ? Math.floor(Number(yr) / 10) * 10 : /modern|today|present/i.test(era) ? 2020 : storyEra ? Math.floor((storyEra.min + storyEra.max) / 20) * 10 : null;
  const kind = (bg.mustBe === "image" ? "image" : bg.mustBe === "video" ? "video" : "any") as Need["kind"];
  return { shot, query: bg.query, kind, decade, period: decade !== null && decade < 2000, durationS: shot.endS - shot.startS, line: "" };
}

async function pick(stage: string, needs: Need[], cands: Map<string, Cand[]>, aspect: string, era: StoryEra | null, model: (typeof MODELS)[keyof typeof MODELS] = MODELS.haiku, notes: Map<string, string> = new Map(), entityMode = false): Promise<Map<string, number>> {
  const rows = needs.filter((n) => (cands.get(n.shot.id) ?? []).length);
  if (!rows.length) return new Map();
  const text = rows
    .map((n) => `SHOT ${n.shot.id} (${n.durationS.toFixed(1)} s) narration: "${n.line}"${n.shot.entities?.length ? ` | MUST DEPICT: ${n.shot.entities.map((e) => `${e.name} (${e.type}${e.year ? `, ${e.year}` : ""})`).join("; ")}` : ""} | intent: ${n.shot.intent} | query: ${n.query}${n.decade ? ` | era ${n.decade}s` : ""}${notes.get(n.shot.id) ? ` | QA REJECTED THE PREVIOUS PICK: ${notes.get(n.shot.id)}` : ""}\n${(cands.get(n.shot.id) ?? []).map((c, i) => `  [${i}] ${describe(c)}`).join("\n")}`)
    .join("\n");
  const { data } = await structured({
    stage,
    model,
    system: [plain(`You are a documentary picture editor choosing B-roll. For each shot pick the candidate that best shows the intent (right subject, right era, believable). Prefer library candidates when they fit about as well as stock. Reject (-1) anything off-topic, anachronistic, text-heavy, or a recognisable actor presented as a real person. ${era ? `The story takes place ${era.min}–${era.max}: reject footage that visibly belongs to another era (e.g. 1920s–1950s clothing, vintage cars, black-and-white newsreel for a 1990s story) unless the shot's era says otherwise.` : ""} A mood shot is fine only if it clearly matches the intent's subject (an office, a trading floor, money, documents) — reject loosely related atmospherics. REENACTMENT: staged stock footage with anonymous actors (executives in a dark boardroom, engineers working late, a hand signing a contract, a worried consumer with a phone) is this channel's main picture type and is WELCOME, including over lines that name a person — it reads as a dramatised scene. Never use a close-up headshot or portrait of a single identifiable stranger over a line that names a real person (it reads as that person) — wide or medium staged scenes, silhouettes, backs, hands and over-the-shoulder shots are fine. Reject a recognisable real celebrity or politician who is not the person the line is about, or footage of a specific real-world event (ceremony, speech, keynote) the narration does not name. Reject title cards, slates, credits, intertitles, watermarks and ad overlays. Reject devices that do not exist yet at the beat's date (touchscreen phones/tablets before 2007, modern iPhones/iPads in a 2000s beat) and a rival brand's product or logo when the line is about a different company. ${era && era.min >= 1985 ? `PERIOD PROPS: this is a ${era.min}–${era.max} story — reject typewriters, dip/fountain pens, quills, rotary or candlestick phones, vinyl records, gramophones, telegraphs, film reels and other props that date the scene before ${era.min - 5}.` : ""} Reject candidates that are mostly blank, white, out of focus or abstract, and footage whose legible text (newspapers, signs, screens) is unrelated to the story or in an unrelated language. ${entityMode ? "ENTITY SHOTS: a candidate is acceptable only if its title/description shows it really depicts the named entity (that person, that company's building or logo, that place) — never a look-alike or generic stand-in." : ""} Output is ${aspect}.`)],
    user: text,
    schema: PickSchema,
    effort: "medium",
  });
  return new Map(data.picks.map((p) => [p.shot, p.choice]));
}

async function ffmpeg(args: string[]) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
}

const exists = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;

/** Props that date a scene before ~1985; rejected outright for post-1985 stories. */
const PERIOD_PROPS = /\b(typewriter|typewriting|typist|dip pen|quill|fountain pen|inkwell|rotary (?:tele)?phone|candlestick phone|switchboard|vinyl|phonograph|record player|gramophone|turntable|telegraph|telegram|film reel|projector|cassette|floppy|abacus)\b/i;
export const anachronistic = (text: string, era: { min: number } | null) => Boolean(era && era.min >= 1985 && PERIOD_PROPS.test(text));

/** Title slates, credits, intertitles and branded openers are never B-roll. */
const SLATE = /\b(title card|title slate|intertitle|opening titles?|end credits|credits roll|presents a selection|film preservation|foundation presents|logo (animation|reveal|intro)|countdown leader|test pattern|watermark)\b/i;
const BRANDS = ["apple", "iphone", "ipad", "ipod", "samsung", "galaxy", "google", "pixel", "android", "microsoft", "windows", "blackberry", "motorola", "sony", "huawei", "xiaomi", "facebook", "amazon", "tesla", "nokia", "lumia"];
/** Year the beat is set in: the latest year spoken in the line, else the shot's decade. */
const beatYear = (line: string, decade: number | null) => {
  const ys = [...line.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)].map((m) => Number(m[1]));
  return ys.length ? Math.max(...ys) : decade;
};
/**
 * Visual-mismatch filter: slates/credits; touchscreen devices over a pre-2007 beat (iPads before 2010, numbered
 * iPhone models before 2012); and a competitor's brand when the line does not name that brand.
 */
export function mismatch(text: string, line: string, decade: number | null): string | null {
  const t = text.toLowerCase();
  if (SLATE.test(text)) return "slate";
  const y = beatYear(line, decade);
  if (y !== null) {
    if (y < 2007 && /\b(iphone|ipad|touchscreen|smartphone|android phone|tablet)\b/.test(t)) return "device-era";
    if (y < 2010 && /\bipad\b/.test(t)) return "device-era";
    if (y < 2012 && /\b(iphone ?(5|6|7|8|x|1\d)|ipad pro|airpods|apple watch)\b/.test(t)) return "device-era";
  }
  const l = line.toLowerCase();
  const named = BRANDS.filter((b) => new RegExp(`\\b${b}\\b`).test(l));
  const shown = BRANDS.filter((b) => new RegExp(`\\b${b}\\b`).test(t));
  if (shown.length && named.length && !shown.some((b) => named.includes(b))) return "competitor-brand";
  return null;
}

/** Does a candidate's own metadata name the entity? (person → surname; others → first distinctive word) */
export function namesEntity(text: string, e: { name: string; type: string }): boolean {
  const toks = e.name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !["the", "inc", "corp", "corporation", "company", "group", "and"].includes(t));
  if (!toks.length) return false;
  const key = e.type === "person" ? toks[toks.length - 1]! : toks[0]!;
  return new RegExp(`\\b${key}`, "i").test(text);
}

/** True when a trimmed clip contains ≥ 0.3 s of (near) black — e.g. a fade-out or lights-off shot. */
async function hasBlack(file: string): Promise<boolean> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vf", "blackdetect=d=0.3:pix_th=0.08", "-an", "-f", "null", "-"], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return /black_start/.test(r.stderr);
}

/** Trim/transcode one picture source into the job's public dir (fast seeking, small, muted). */
export async function materialize(src: string, kind: "video" | "image", out: string, inS: number, durationS: number, srcHasAlpha: boolean, cropBanner = false) {
  if (await exists(out)) return;
  if (kind === "video") {
    // Broadcaster graphics (lower third, ticker, channel bug) are cropped away: bottom 22 %, a little off each side and the top.
    await ffmpeg(["-ss", inS.toFixed(3), "-stream_loop", "-1", "-i", src, "-t", (durationS + 0.8).toFixed(3), "-an", "-vf", (cropBanner ? "crop=iw*0.9:ih*0.74:iw*0.05:ih*0.04," : "") + "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=" + PLATFORM_FPS + ",format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out]);
  } else {
    await ffmpeg(["-i", src, "-vf", "scale='min(2400,iw)':-2", ...(srcHasAlpha ? [] : ["-q:v", "3"]), "-frames:v", "1", out]);
  }
}

export interface ResolveOptions {
  storyboard: Storyboard;
  index: LibraryIndex;
  libraryRoot: string;
  jobDir: string;
  /** Narration text, used to infer the story era. */
  narration?: string;
  /** Timed narration words, so the rerank sees exactly what is said over each shot. */
  words?: Array<{ word: string; startS: number; endS: number }>;
  /** ProductionMemory: asset refs earlier films rejected (library key or provider:externalId) — never offered again. */
  blocked?: Set<string>;
  /** Cited sources per narration segment (TimedScript.segments[].claims): real article screenshots for scenes. */
  sources?: Map<string, Array<{ text: string; sourceUrl: string }>>;
  /** Verified fact text: used to tell the vision check how the sources refer to a named person (he/she). */
  factText?: string;
  /** Story era from the fact sheet (more reliable than years spoken in the narration). */
  era?: StoryEra | null;
  /** Candidates the director already found and rated when it probed for footage (shot id → candidates). */
  probes?: Map<string, StockCandidate[]>;
  /** Build list 3, item 21: footage whose sharpest tenth is below this (the channel's softest tenth of frames,
   * `senses:measureCraft().sharpTop`) is not placed — the same measure the preflight gate uses. */
  softBelow?: number;
  /** Build list 5, item 16: the most idle stock (people doing nothing in particular) the channel's films carry, as a
   * share of shots (data/picture-profile/<channel>.json `idleCap`). Absent: read from the job's channel profile if it
   * has been built; null: no cap. */
  idleCap?: number | null;
  /** Folder for the stock-search memo (results kept 20 h, so re-runs and films on one subject do not spend API quota twice). */
  cacheDir?: string;
  /** Fair-use press sourcing (YouTube news/interview excerpts, Wikipedia photos and logos). Default on. */
  press?: boolean;
  log?: (s: string) => void;
}

/** The channel's idle-stock cap, from the job's channel (job.json) and its picture band, if that band has been built. */
export async function channelIdleCap(jobDir: string): Promise<number | null> {
  const job = await readFile(path.join(jobDir, "job.json"), "utf8").then((t) => JSON.parse(t) as { channel?: string }, () => null);
  if (!job?.channel) return null;
  const data = process.env.OPUMIA_DATA_DIR ? path.resolve(process.env.OPUMIA_DATA_DIR) : path.join(jobDir, "..", "..", "data");
  const band = await readFile(path.join(data, "picture-profile", `${job.channel}.json`), "utf8").then((t) => JSON.parse(t) as { idleCap?: number }, () => null);
  return typeof band?.idleCap === "number" ? band.idleCap : null;
}

const isBlocked = (blocked: Set<string> | undefined, ref: string) => !!blocked && (blocked.has(ref) || blocked.has(ref.split("#")[0]!));

export async function resolveAssets(o: ResolveOptions): Promise<ResolutionReport> {
  const log = o.log ?? (() => {});
  // Where the stage's time goes (written to sourcing.json): one lap per phase.
  const laps: Array<{ phase: string; s: number }> = [];
  let lapT = Date.now();
  const lap = (phase: string) => {
    laps.push({ phase, s: Math.round((Date.now() - lapT) / 100) / 10 });
    lapT = Date.now();
  };
  const pub = path.join(o.jobDir, "public");
  const mediaDir = path.join(pub, "media");
  const dlDir = path.join(o.jobDir, "downloads");
  await mkdir(mediaDir, { recursive: true });
  const byId = new Map(o.index.assets.map((a) => [a.id, a]));
  const bm = new Bm25(buildDocs(o.index));
  const orientation = o.storyboard.aspect === "9:16" ? "portrait" : "landscape";

  const era = o.era !== undefined ? o.era : o.narration ? storyEraOf(o.narration) : null;
  if (era) log(`  resolver: story era ${era.min}–${era.max}`);
  const needs = o.storyboard.shots.map((sh) => needOf(sh, era)).filter((n): n is Need => n !== null);
  for (const n of needs) n.line = (o.words ?? []).filter((w) => w.startS >= n.shot.startS - 0.05 && w.startS < n.shot.endS).map((w) => w.word).join(" ");
  // Footage much older than the story is out of period unless the shot asks for that era.
  const tooOld = (doc: LocalDoc, n: Need) => Boolean(era && era.min >= 1960 && doc.decade !== null && doc.decade < era.min - 15 && !(n.decade !== null && n.decade < era.min - 15));
  const usedLocal = new Set<string>();
  const usedStock = new Set<string>();
  const chosen = new Map<string, Cand>();
  // Build list 5, item 16: idle stock is capped at the channel's share; item 17: story-specific pictures come first.
  const idleCap = o.idleCap !== undefined ? o.idleCap : await channelIdleCap(o.jobDir);
  const idleMax = idleCap === null ? Infinity : Math.max(1, Math.floor(idleCap * Math.max(1, o.storyboard.shots.length)));
  let idleChosen = 0;
  const idleKeys = new Set<string>();
  if (idleCap !== null) log(`  resolver: idle stock capped at ${Math.round(idleCap * 100)} % of shots (${idleMax} of ${o.storyboard.shots.length}), the channel's share`);

  // The film's named subjects, most-mentioned first (the first is the film's main subject).
  const subjects = (() => {
    const count = new Map<string, number>();
    for (const sh of o.storyboard.shots) for (const nm of [...(sh.entities ?? []).map((e) => e.name), ...(sh.source.kind === "designed" ? ((sh.source.props.layers ?? []) as Array<{ name?: string }>).map((l) => l.name ?? "") : [])].map((x) => x.trim()).filter((x) => x.length > 1)) count.set(nm, (count.get(nm) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  })();
  const pressDir = path.join(o.jobDir, "downloads", "press");
  const eraLabel = era ? `${era.min}–${era.max}` : "unspecified";
  const planP = planSourcing({ shots: needs.map((n) => ({ id: n.shot.id, line: n.line, intent: n.shot.intent, query: n.query, entities: (n.shot.entities ?? []).map((e) => e.name) })), subjects, era: eraLabel });
  const hasScenes = o.storyboard.shots.some((sh) => sh.source.kind === "designed" && sh.source.designed === "scene");
  const webP = o.press !== false && hasScenes ? planP.then((pl) => webPictures({ kit: pl.kit, subjects, pages: [...new Set([...(o.sources?.values() ?? [])].flat().map((c) => c.sourceUrl).filter((u) => /^https?:\/\//.test(u)))], dlDir: path.join(pressDir, "web"), log })).catch(() => []) : Promise.resolve([]);
  const wikiMemo = new Map<string, Promise<PressCandidate[]>>();
  const wikiOnce = (e: { name: string; type: string }, limit: number) => {
    const k = `${e.name.toLowerCase()}|${e.type}|${limit}`;
    if (!wikiMemo.has(k)) wikiMemo.set(k, wikipediaImages(e, pressDir, limit).catch(() => []));
    return wikiMemo.get(k)!;
  };
  const ytMemo = new Map<string, Promise<PressCandidate[]>>();
  const usedVideos = new Set<string>();
  const pressStills: Array<{ shotId: string; c: PressCandidate; q: number }> = [];
  const usedWiki = new Set<string>();
  const wantsImage = (n: Need) => n.kind === "image";
  // Phase P — fair-use press first for named entities: the real person/company/product/event, checked by eye.
  if (o.press !== false) {
    const pressNeeds = needs.filter((n) => n.shot.entities?.length);
    if (pressNeeds.length) log(`  resolver: press sourcing for ${pressNeeds.length} entity shot(s) (Wikipedia + YouTube excerpts, vision-checked)…`);
    const pool = new Map<string, PressCandidate[]>();
    // How the sources refer to a person: a clip of somebody else (a relative, a reporter) must not pass as them.
    const refersTo = (name: string) => {
      const sn = name.split(/\s+/).at(-1) ?? name;
      const sents = (o.factText ?? "").split(/(?<=[.!?])\s+/).filter((t) => t.includes(sn));
      const he = sents.join(" ").match(/\b(he|his|him)\b/gi)?.length ?? 0;
      const she = sents.join(" ").match(/\b(she|her|hers)\b/gi)?.length ?? 0;
      return he >= 2 && he > she * 2 ? ', referred to as "he" in the sources — a woman on screen is NOT this person' : she >= 2 && she > he * 2 ? ', referred to as "she" in the sources — a man on screen is NOT this person' : "";
    };
    const wiki = (e: { name: string; type: string }) => wikiOnce(e, 4);
    const world = subjects.filter((x) => !o.storyboard.shots.some((sh) => sh.entities?.some((en) => en.name === x && en.type === "person")));
    // Clips are fetched at the longest allowed length once per subject and trimmed per shot.
    const press = (e: { name: string; type: string; year?: number }) => {
      const k = e.name.toLowerCase();
      if (!ytMemo.has(k)) ytMemo.set(k, youtubePress({ entity: e, context: e.type === "person" ? "interview" : e.type === "event" ? "footage" : "", dlDir: pressDir, usedVideos: new Set(), videos: 3, perVideo: 2, clipS: 6, world }).catch(() => []));
      return ytMemo.get(k)!;
    };
    const lim = 8;
    for (let i = 0; i < pressNeeds.length; i += lim) {
      await Promise.all(
        pressNeeds.slice(i, i + lim).map(async (n) => {
          const e = n.shot.entities![0]!;
          const list: PressCandidate[] = [];
          if (e.type !== "event") list.push(...(await wiki(e)).map((c) => ({ ...c })));
          // Each shot gets its own copy of the candidate record (the vision note differs per line).
          if (!wantsImage(n) && ["person", "company", "event", "product"].includes(e.type)) list.push(...(await press(e)).map((c) => ({ ...c })));
          if (e.type === "person") for (const c of list) if (!c.depicts.includes("referred to as")) c.depicts = `${c.depicts}${refersTo(e.name)}`;
          pool.set(n.shot.id, list.filter((c) => !isBlocked(o.blocked, `${c.provider}:${c.externalId}`)));
        }),
      );
    }
    // Vision check in batches of 12 frames (Haiku).
    const flat = pressNeeds.flatMap((n) => (pool.get(n.shot.id) ?? []).map((c) => ({ n, c })));
    const verdicts: Array<{ shows: boolean; quality: number; note: string; banner?: boolean }> = [];
    for (let i = 0; i < flat.length; i += 12) verdicts.push(...(await visionCheck(flat.slice(i, i + 12).map(({ n, c }) => ({ frameFile: c.frameFile, depicts: c.depicts, line: n.line }))).catch(() => flat.slice(i, i + 12).map(() => ({ shows: false, quality: 0, note: "check failed" })))));
    let placed = 0;
    for (const n of pressNeeds) {
      const ok = flat.map((x, k) => ({ ...x, v: verdicts[k]! })).filter((x) => x.n === n && x.v.shows && x.v.quality >= 5);
      const pref = wantsImage(n) ? "image" : "video";
      const pickP = ok
        .filter((x) => !(x.c.provider === "youtube" ? usedVideos.has(x.c.externalId.split("@")[0]!) : usedWiki.has(x.c.externalId)))
        .sort((a, b) => Number(b.c.kind === pref) - Number(a.c.kind === pref) || b.v.quality - a.v.quality)[0];
      if (!pickP) continue;
      if (pickP.c.provider === "youtube") usedVideos.add(pickP.c.externalId.split("@")[0]!);
      else usedWiki.add(pickP.c.externalId);
      pickP.c.banner = Boolean(pickP.v.banner);
      const isScene = n.shot.source.kind === "designed" && n.shot.source.designed === "scene";
      if (isScene && pickP.c.kind === "image") pressStills.push({ shotId: n.shot.id, c: pickP.c, q: pickP.v.quality });
      else chosen.set(n.shot.id, { src: "press", p: pickP.c, score: pickP.v.quality / 10 });
      placed++;
    }
    if (pressNeeds.length) log(`  resolver: ${placed}/${pressNeeds.length} entity shot(s) placed from press (${flat.length} candidates checked)`);
  }

  lap("press by name");
  // Phase 0 — archive first for named entities: Commons, NARA, Europeana with name + year.
  const entityNeeds = needs.filter((n) => n.shot.entities?.length && !chosen.has(n.shot.id));
  const ent = new Map<string, Cand[]>();
  if (entityNeeds.length) {
    await pooled(entityNeeds, 4, async (n) => {
      const list: Cand[] = [];
      const seen = new Set<string>();
      for (const e of n.shot.entities!.slice(0, 2)) {
        // Name + year first, then the bare name (archive search engines rarely index years).
        for (const q of [...new Set([`${e.name}${e.year ? ` ${e.year}` : ""}`, e.name])])
        for (const kind of ["image", "video"] as const) {
          const found = await searchStock(q, { kind, orientation, perPage: 6, providers: kind === "image" ? ["commons", "nara", "europeana"] : ["commons", "nara"] });
          for (const c of found) {
            const k = `${c.provider}:${c.externalId}`;
            if (seen.has(k) || usedStock.has(k)) continue;
            if (!namesEntity(`${c.title} ${c.tags.join(" ")} ${c.attributionText ?? ""}`, e)) continue; // must literally be that entity
            if (anachronistic(`${c.title} ${c.tags.join(" ")}`, era) || mismatch(`${c.title} ${c.tags.join(" ")}`, n.line, n.decade) || isBlocked(o.blocked, k)) continue;
            seen.add(k);
            list.push({ src: "stock", c, score: 2 });
          }
        }
        // A library asset can also carry the entity's name (e.g. a captioned film shot).
        for (const r of bm.search(e.name, { kind: "any", decade: n.decade, limit: 10 }).filter((r) => namesEntity(r.doc.text, e) && !r.doc.asset.bugSpots?.length)) {
          if (!seen.has(r.doc.key)) list.push({ src: "local", doc: r.doc, score: r.score }), seen.add(r.doc.key);
        }
      }
      ent.set(n.shot.id, list.slice(0, 10));
    });
    log(`  resolver: archives searched by name for ${entityNeeds.length} entity shot(s); ${entityNeeds.filter((n) => (ent.get(n.shot.id) ?? []).length).length} have candidates that name the subject (rated by eye with the rest)`);
  }

  lap("archives by name");
  // The sourcing plan: for every shot, what must be seen, what kind of picture that is, and the right search for
  // each kind of source — plus the film's kit (the real things it must have pictures of).
  const plan = await planP;
  const briefOf = (n: Need): ShotBrief => plan.briefs.get(n.shot.id)!;
  {
    const c = (k: string) => needs.filter((n) => briefOf(n).need === k).length;
    log(`  resolver: sourcing plan — ${c("real")} real, ${c("period")} period, ${c("staged")} staged, ${c("object")} object, ${c("none")} designed without a picture; kit: ${plan.kit.slice(0, 4).join("; ")}${plan.kit.length > 4 ? "…" : ""}`);
  }

  lap("sourcing plan");
  // Phase 1 — every source for every shot, judged by eye before anything is downloaded. Library, all stock and
  // archive sources and (for real subjects) YouTube are asked together; each candidate's preview picture is
  // rated against the line; the best-fitting picture wins, whatever source it came from.
  const refOf = (c: Cand) => (c.src === "local" ? c.doc.key : c.src === "press" ? `${c.p.provider}:${c.p.externalId}` : `${c.c.provider}:${c.c.externalId}`);
  const namedPerson = (n: Need) => n.shot.entities?.find((e) => e.type === "person")?.name ?? (/\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(n.line) && n.shot.lineLink === "literal" ? "a named person" : null);
  const titledAs = (c: Cand, n: Need) => {
    const who = n.shot.entities?.find((e) => e.type === "person");
    return Boolean(who && c.src === "press" && namesEntity(c.p.title, who));
  };
  const pending = needs.filter((n) => !chosen.has(n.shot.id) && briefOf(n).need !== "none");
  const local = new Map<string, Cand[]>();
  const stock = new Map<string, Cand[]>();
  const offered = new Map<string, { n: number; best: number }>();
  const ratedSeen = new Map<string, { fit: number; face: boolean; banner: boolean; note: string }>();
  const looked = new Map<string, Array<{ source: string; ref: string; fit: number; wrongEra: boolean; banner: boolean; face: boolean; synthetic: boolean; shows: string }>>();
  // Approved pictures no shot took: the re-plan may give one to another line.
  const spares: Array<{ c: Cand; key: string; thumb: string; shows: string }> = [];
  // Search memo on disk and a count of what each source was asked and returned (a silent source is reported).
  const cacheFile = o.cacheDir ? path.join(o.cacheDir, "stock-search.json") : null;
  const disk: Record<string, { at: number; hits: StockCandidate[] }> = cacheFile ? await readFile(cacheFile, "utf8").then((t) => JSON.parse(t) as Record<string, { at: number; hits: StockCandidate[] }>, () => ({})) : {};
  const yieldBy = new Map<string, { asked: number; got: number }>();
  const saveDisk = async () => {
    if (!cacheFile) return;
    const now = Date.now();
    for (const k of Object.keys(disk)) if (now - disk[k]!.at > 20 * 3600_000) delete disk[k];
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(`${cacheFile}.tmp`, JSON.stringify(disk));
    await rename(`${cacheFile}.tmp`, cacheFile);
  };
  const askSource = async (p: string, q: string, kind: "video" | "image", perPage: number): Promise<StockCandidate[]> => {
    const k = `${p}|${kind}|${orientation}|${perPage}|${q.toLowerCase()}`;
    const hit = disk[k];
    if (hit && Date.now() - hit.at < 20 * 3600_000) return hit.hits;
    const hits = await searchStock(q, { kind, orientation, perPage, providers: [p] }).catch(() => [] as StockCandidate[]);
    const y = yieldBy.get(p) ?? { asked: 0, got: 0 };
    yieldBy.set(p, { asked: y.asked + 1, got: y.got + hits.length });
    if (hits.length) disk[k] = { at: Date.now(), hits };
    return hits;
  };
  const replans = new Map<string, { asked: string; action: string; why: string }>();
  const sourceRound = async (pending: Need[], extra: Map<string, Array<{ c: Cand; thumb: string }>> = new Map()) => {
    if (!pending.length) return;
    const thumbDir = path.join(dlDir, "thumbs");
    const memo = new Map<string, Promise<StockCandidate[]>>();
    // Measured on real plans: Pexels supplies most of the usable stock, so it is asked for more per search.
    const search = (q: string, kind: "video" | "image", providers: string[]): Promise<StockCandidate[]> => {
      const k = `${kind}|${providers.join(",")}|${q.toLowerCase()}`;
      if (!memo.has(k)) memo.set(k, Promise.all(providers.map((pv) => askSource(pv, q, kind, pv === "pexels" ? 6 : 3))).then((r) => r.flat().filter((c) => !c.aiGenerated && sharpEnough(c))));
      return memo.get(k)!;
    };
    type Offer = { n: Need; c: Cand; key: string; thumb: string };
    const offers: Offer[] = [];
    await pooled(pending, 8, async (n) => {
      const b = briefOf(n);
      const kind = n.kind === "image" ? "image" : "video";
      const period = n.period || b.need === "period";
      const list: Cand[] = [];
      const seen = new Set<string>();
      const push = (c: Cand) => {
        const k = refOf(c);
        if (seen.has(k) || isBlocked(o.blocked, k)) return;
        seen.add(k);
        list.push(c);
      };
      for (const c of ent.get(n.shot.id) ?? []) push(c);
      for (const c of o.probes?.get(n.shot.id) ?? []) if (!usedStock.has(`${c.provider}:${c.externalId}`)) push({ src: "stock", c, score: 2 });
      for (const q of [n.query, ...b.stock])
        for (const r of bm.search(q, { kind: n.kind, decade: n.decade, limit: 12 }).filter((r) => !usedLocal.has(r.doc.key) && !tooOld(r.doc, n) && !r.doc.asset.bugSpots?.length && !anachronistic(r.doc.text, era) && !mismatch(r.doc.text, n.line, n.decade)).slice(0, 3)) push({ src: "local", doc: r.doc, score: r.score });
      const found = (
        await Promise.all([
          ...b.stock.map((q) => search(q, kind, allProviders({ kind, period }))),
          ...(b.archive ? [search(b.archive, "image", allProviders({ kind: "image", period: true })), ...(kind === "video" ? [search(b.archive, "video", ["commons", "nara", "archive"])] : [])] : []),
        ])
      ).flat();
      for (const c of found) {
        const text = `${c.title} ${c.tags.join(" ")}`;
        if (usedStock.has(`${c.provider}:${c.externalId}`) || anachronistic(text, era) || mismatch(text, n.line, n.decade)) continue;
        push({ src: "stock", c, score: 1 });
      }
      if (o.press !== false && b.need === "real" && b.youtube) for (const yp of await youtubeFootage({ query: b.youtube, about: `${b.must} ${n.line}`, must: b.must, subjects, people: subjects.filter((x) => o.storyboard.shots.some((sh) => sh.entities?.some((en) => en.name === x && en.type === "person"))), dlDir: pressDir, clipS: n.durationS, videos: 4 }).catch(() => [])) push({ src: "press", p: yp, score: 1 });
      // At most 16 per shot, taken in turns from each source so no single library crowds the others out.
      const bySource = new Map<string, Cand[]>();
      for (const c of list) {
        const k = c.src === "local" ? "library" : c.src === "press" ? "youtube" : c.c.provider;
        bySource.set(k, [...(bySource.get(k) ?? []), c]);
      }
      const turn: Cand[] = [];
      for (let r = 0; turn.length < 22 && [...bySource.values()].some((v) => v.length > r); r++) for (const [k, v] of bySource) if (v[r] && turn.length < 22 && (r < 3 || k === "pexels" || k === "youtube")) turn.push(v[r]!);
      await Promise.all(
        turn.map(async (c) => {
          const key = refOf(c);
          let thumb = path.join(thumbDir, `${createHash("sha1").update(key).digest("hex").slice(0, 14)}.jpg`);
          let ok = false;
          if (c.src === "press") (thumb = c.p.frameFile), (ok = true);
          else if (c.src === "local") ok = await thumbOf({ file: await ensureLocal(o.libraryRoot, c.doc.asset.relPath, "library"), video: c.doc.kind === "video", atS: c.doc.inS + 1 }, thumb);
          // A whole archive film: the preview is the very moment that would be used, not the item's poster.
          else if (c.c.provider === "archive" && c.c.fileUrl) {
            // H31: find the moment in the whole film that shows the wanted picture (its own thumbnails, one look);
            // a film with no such moment is not offered.
            if (c.c.moments?.length) {
              const m = await archiveMoment(c.c, briefOf(n).must || n.query, path.dirname(thumbDir)).catch(() => null);
              if (m) { c.c.atS = m.atS; ok = await thumbOf({ url: m.thumbUrl }, thumb); }
            } else ok = await thumbOf({ url: c.c.fileUrl, video: true, atS: archiveAt(c.c) + 1.2 }, thumb);
          }
          else if (c.c.thumbUrl) ok = await thumbOf({ url: c.c.thumbUrl }, thumb);
          else if (c.c.fileUrl) ok = await thumbOf(c.c.kind === "image" ? { url: c.c.fileUrl } : { url: c.c.fileUrl, video: true, atS: 1 }, thumb);
          if (ok) offers.push({ n, c, key, thumb });
        }),
      );
      for (const e of extra.get(n.shot.id) ?? []) if (!offers.some((x) => x.n === n && x.key === refOf(e.c))) offers.push({ n, c: e.c, key: refOf(e.c), thumb: e.thumb });
    });
    log(`  resolver: ${offers.length} candidate picture(s) gathered for ${pending.length} shot(s) from ${new Set(offers.map((x) => (x.c.src === "local" ? "library" : x.c.src === "press" ? "youtube" : x.c.c.provider))).size} source(s); rating each by eye (${MODELS.haiku})…`);
    // One shot's candidates are rated side by side (steadier scores than a mixed batch), at most 11 per call.
    const chunks: Offer[][] = [];
    for (const n of pending) {
      const mine = offers.filter((x) => x.n === n).sort((a, b) => a.key.localeCompare(b.key));
      for (let k = 0; k < mine.length; k += 11) chunks.push(mine.slice(k, k + 11));
    }
    const rated = (await pooled(chunks, 8, async (part) => (await reviewPictures(part.map((x) => ({ frameFile: x.thumb, intent: `${briefOf(x.n).must} — ${x.n.shot.intent}`, line: x.n.line, era: briefOf(x.n).when || eraLabel }))).catch(() => part.map(() => null))).map((r, k) => ({ ...part[k]!, r })))).flat();
    const good = rated
      .filter((x): x is typeof x & { r: NonNullable<typeof x.r> } => Boolean(x.r) && x.r!.shows !== "not reviewed")
      .map((x) => {
        const cur = offered.get(x.n.shot.id) ?? { n: 0, best: 0 };
        offered.set(x.n.shot.id, { n: cur.n + 1, best: Math.max(cur.best, x.r.fit) });
        looked.set(x.n.shot.id, [...(looked.get(x.n.shot.id) ?? []), { source: x.c.src === "local" ? "library" : x.c.src === "press" ? "youtube" : x.c.c.provider, ref: x.key, fit: x.r.fit, wrongEra: x.r.wrongEra, banner: x.r.banner, face: x.r.face, synthetic: x.r.synthetic, shows: x.r.idle ? `${x.r.shows} [idle stock]` : x.r.specific ? `${x.r.shows} [story-specific]` : x.r.shows }]);
        return x;
      })
      // Burned-in captions or graphics mark someone else's edit: never taken. A face under a line naming a person is
      // accepted only from footage whose own title names that person.
      .filter((x) => x.r.fit >= MEANING_BAR && !x.r.wrongEra && !x.r.synthetic && !x.r.banner && !(namedPerson(x.n) && x.r.face && !titledAs(x.c, x.n)))
      // story-specific pictures (this story's people, company, products, places, archive) first; idle stock last
      .map((x) => ({ ...x, score: x.r.fit + (x.r.specific ? 1 : 0) - (x.r.idle ? 0.5 : 0) + (x.c.src === "press" ? 0.6 : x.c.src === "local" ? 0.3 : x.c.c.archival && briefOf(x.n).need !== "staged" ? 0.3 : 0) }))
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    // Period: for lines set before 2009, the three best candidates of each shot are dated by a dedicated check
    // and anything later than the line is taken out before a pick is made.
    {
      const toDate = pending.flatMap((n) => {
        const y = yearOf(briefOf(n).when);
        return y !== null && y <= 2008 ? good.filter((x) => x.n === n && x.c.src !== "press").slice(0, 3).map((x) => ({ x, y })) : [];
      });
      if (toDate.length) {
        const dated = await periodCheck(toDate.map((t) => ({ frameFile: t.x.thumb, year: t.y })));
        const late = new Set(toDate.filter((_, k) => !dated[k]!.ok).map((t) => t.x));
        for (const [k, t] of toDate.entries()) if (!dated[k]!.ok) (looked.get(t.x.n.shot.id) ?? []).filter((c) => c.ref === t.x.key).forEach((c) => ((c.wrongEra = true), (c.shows = `${c.shows} [dated ${dated[k]!.earliestYear}+: ${dated[k]!.evidence}]`)));
        // Undated runners-up of a period shot are not trusted either: only dated candidates may be picked for it.
        const datedOk = new Set(toDate.filter((_, k) => dated[k]!.ok).map((t) => t.x));
        const periodShots = new Set(toDate.map((t) => t.x.n));
        for (let k = good.length - 1; k >= 0; k--) {
          const g = good[k]!;
          if (late.has(g) || (periodShots.has(g.n) && g.c.src !== "press" && !datedOk.has(g))) good.splice(k, 1);
        }
        if (late.size) log(`  resolver: period check — ${late.size} of ${toDate.length} leading candidate(s) under period lines were too modern and were taken out`);
      }
    }
    for (const x of good) ratedSeen.set(`${x.n.shot.id}|${x.key}`, { fit: x.r.fit, face: x.r.face, banner: x.r.banner, note: x.r.shows });
    const takenKeys = new Set<string>();
    for (const x of good) {
      if (chosen.has(x.n.shot.id) || takenKeys.has(x.key)) continue;
      if (x.r.idle && idleChosen >= idleMax) continue;
      if (x.c.src === "press") {
        // One clip per source video per film.
        const vid = x.c.p.externalId.split("@")[0]!;
        if (usedVideos.has(vid)) continue;
        usedVideos.add(vid);
        const who = x.n.shot.entities?.find((e) => e.type === "person");
        x.c.p.depicts = who && x.r.face && titledAs(x.c, x.n) ? `${who.name} (person) — ${x.r.shows}` : x.r.shows;
        x.c.p.banner = x.r.banner;
      } else if (x.c.src === "local") usedLocal.add(x.key);
      else usedStock.add(x.key);
      chosen.set(x.n.shot.id, { ...x.c, score: x.r.fit / 10 });
      takenKeys.add(x.key);
      if (x.r.idle) idleChosen++, idleKeys.add(x.key);
    }
    // Rated runners-up (licensed sources only) stand by in case the chosen clip fails on the full frame.
    for (const n of pending) stock.set(n.shot.id, good.filter((x) => x.n === n && x.c.src !== "press" && !takenKeys.has(x.key)).map((x) => x.c));
    for (const x of good) if (x.c.src !== "press" && !takenKeys.has(x.key) && !spares.some((sp) => sp.key === x.key)) spares.push({ c: x.c, key: x.key, thumb: x.thumb, shows: x.r.shows });
    const src = (k: Cand["src"]) => pending.filter((n) => chosen.get(n.shot.id)?.src === k).length;
    log(`  resolver: ${pending.filter((n) => chosen.has(n.shot.id)).length}/${pending.length} shot(s) placed by eye — ${src("local")} library, ${src("stock")} stock/archive, ${src("press")} real footage`);
    await saveDisk();
    const silent = [...yieldBy.entries()].filter(([, y]) => y.asked >= 6 && y.got === 0).map(([k, y]) => `${k} (${y.asked} searches)`);
    if (Object.keys(providerHealth()).length) log(`  ! resolver: sources down for this run (the others took over their searches): ${Object.entries(providerHealth()).map(([p, w]) => `${p} — ${w}`).join("; ")}`);
    if (refused.size) log(`  ! resolver: searches refused by rate limit — ${[...refused.entries()].map(([h, n]) => `${h} ${n}`).join(", ")}; coverage below is understated`);
    if (silent.length) log(`  ! resolver: no results at all from ${silent.join(", ")} — rate limit or outage; coverage below is understated`);
  };
  await sourceRound(pending);

  lap("pooled search and rating");
  // The re-plan: a real production cuts to the footage it has. Every shot the first search could not fill goes
  // back to the director with what the sources actually returned; it is given a spare approved picture, a
  // different findable picture that tells the same line, or becomes a designed scene. Then one more search.
  {
    const missing = pending.filter((n) => !chosen.has(n.shot.id));
    if (missing.length) {
      const usedKeys = new Set([...chosen.values()].map(refOf));
      const free = spares.filter((sp) => !usedKeys.has(sp.key));
      const placed = [...chosen.entries()].map(([id, c]) => ratedSeen.get(`${id}|${refOf(c)}`)?.note ?? (c.src === "press" ? c.p.depicts : "")).filter(Boolean);
      const plans = await replanShots({ shots: missing.map((n) => ({ id: n.shot.id, line: `${n.line}${briefOf(n).when ? ` [set in ${briefOf(n).when}]` : ""}`, need: briefOf(n).need, must: briefOf(n).must, seen: (looked.get(n.shot.id) ?? []).sort((a, b) => b.fit - a.fit).map((c) => ({ fit: c.fit, shows: c.shows })) })), spares: free.map((sp) => sp.shows), placed, subjects, era: eraLabel });
      const extra = new Map<string, Array<{ c: Cand; thumb: string }>>();
      const again: Need[] = [];
      for (const r of plans) {
        const n = missing.find((x) => x.shot.id === r.shot);
        if (!n) continue;
        replans.set(n.shot.id, { asked: briefOf(n).must, action: r.action, why: r.why });
        if (r.action === "design") {
          plan.briefs.set(n.shot.id, { ...briefOf(n), need: "none", must: r.must || briefOf(n).must });
          continue;
        }
        const sp = r.action === "spare" ? free[r.spare] : undefined;
        if (sp) extra.set(n.shot.id, [{ c: sp.c, thumb: sp.thumb }]);
        plan.briefs.set(n.shot.id, { shot: n.shot.id, need: r.need === "none" ? "object" : r.need, must: r.must, stock: r.stock, archive: r.archive, youtube: r.youtube, ...(briefOf(n).when ? { when: briefOf(n).when } : {}) });
        if (r.stock[0]) n.query = r.stock[0];
        again.push(n);
      }
      const c = (k: string) => plans.filter((r) => r.action === k).length;
      log(`  resolver: re-plan — ${missing.length} shot(s) without a picture went back to the director: ${c("search")} given a different findable picture, ${c("spare")} a spare approved picture, ${c("design")} a designed scene`);
      await sourceRound(again, extra);
    }
  }

  lap("re-plan and second search");
  // Materialize, screening each clip for black frames and falling back to the next candidate.
  const media: ResolvedMedia[] = [];
  const unresolved: ResolutionReport["unresolved"] = [];
  const keyOf = refOf;
  const taken = new Set([...chosen.values()].map(keyOf));
  let fallbacks = 0;
  for (const n of needs) {
    const first = chosen.get(n.shot.id);
    // Only the reranker's accepted pick is ever used; anything it rejected is never forced in.
    const queue = first ? [first, ...(stock.get(n.shot.id) ?? []).filter((c) => !taken.has(keyOf(c)))] : [];
    if (!queue.length) {
      if (briefOf(n).need !== "none") unresolved.push({ shotId: n.shot.id, query: n.query, reason: (offered.get(n.shot.id)?.n ?? 0) ? `no candidate fitted (best ${offered.get(n.shot.id)!.best}/10 of ${offered.get(n.shot.id)!.n} seen)` : "no source returned a candidate" });
      continue;
    }
    let placed = false;
    let lastErr = "";
    for (const c of queue.slice(0, 4)) {
      try {
        const m = await materializeCand(c, n);
        if (m.kind === "video" && (await hasBlack(m.localPath))) {
          lastErr = `${keyOf(c)} contains black frames`;
          await unlink(m.localPath).catch(() => {});
          fallbacks++;
          continue;
        }
        if (await marked(m)) {
          lastErr = `${keyOf(c)} carries a watermark or channel bug`;
          await unlink(m.localPath).catch(() => {});
          fallbacks++;
          continue;
        }
        if (await tooSoft(m)) {
          lastErr = `${keyOf(c)} is softer than the channel's softest frames`;
          await unlink(m.localPath).catch(() => {});
          fallbacks++;
          continue;
        }
        const rs = ratedSeen.get(`${n.shot.id}|${keyOf(c)}`);
        if (rs) (m.seen = rs), (m.depicts ??= rs.note);
        media.push(m);
        taken.add(keyOf(c));
        placed = true;
        break;
      } catch (err) {
        lastErr = (err as Error).message.slice(0, 200);
      }
    }
    if (!placed) unresolved.push({ shotId: n.shot.id, query: n.query, reason: lastErr || "all candidates failed" });
  }
  if (fallbacks) log(`  resolver: ${fallbacks} candidate(s) rejected for black frames; fell back`);

  lap("downloads");
  // Review EVERY library/stock/archive pick by eye (press picks were already checked): the picture must fit the
  // line, carry no burned-in graphics, match the period, and — when the line names a person — must not put a
  // stand-in face on screen. A rejected pick gets one alternate; failing that the shot has NO footage and the
  // scene designer builds it on the film's colour world instead of a weak picture.
  {
    const eraText = era ? `${era.min}–${era.max}` : "unspecified";
    const person = (n: Need) => n.shot.entities?.find((e) => e.type === "person")?.name ?? (/\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(n.line) && n.shot.lineLink === "literal" ? "a named person" : null);
    let rejected = 0;
    let replaced = 0;
    let idleSeen = 0;
    for (let round = 0; round < 3; round++) {
      const todo = media.filter((m) => m.role === "primary" && m.origin !== "press" && !m.seen);
      if (!todo.length) break;
      const items: Array<{ m: ResolvedMedia; n: Need; frame: string }> = [];
      for (const m of todo) {
        const n = needs.find((x) => x.shot.id === m.shotId);
        const frame = `${m.localPath}.review.jpg`;
        if (n && (await reviewFrame(m.localPath, frame, m.kind === "video" ? Math.min(1.2, n.durationS / 2) : 0))) items.push({ m, n, frame });
        else m.seen = { fit: 5, face: false, banner: false, note: "not reviewed" };
      }
      const reviews = await reviewPictures(items.map((x) => ({ frameFile: x.frame, intent: `${briefOf(x.n).must} — ${x.n.shot.intent}`, line: x.n.line, era: eraText })));
      for (const [k, x] of items.entries()) {
        const r = reviews[k]!;
        x.m.seen = { fit: r.fit, face: r.face, banner: r.banner, note: r.shows };
        if (!x.m.depicts) x.m.depicts = r.shows;
        const idleOver = r.idle && ++idleSeen > idleMax;
        const why = r.fit < MEANING_BAR ? `poor fit (${r.fit}/10 for meaning, the gate needs ${MEANING_BAR}): shows ${r.shows}` : idleOver ? `idle stock over the channel's share (${idleMax} of ${o.storyboard.shots.length} shots): ${r.shows}` : r.banner ? "burned-in graphics" : r.synthetic ? "looks generated, not photographed" : r.wrongEra ? "wrong period" : person(x.n) && r.face ? `a stand-in face under a line naming ${person(x.n)}` : null;
        if (!why) continue;
        rejected++;
        media.splice(media.indexOf(x.m), 1);
        if (false as boolean) {
          // Widen the search: stock/archival for the query, and for the concrete nouns of the line itself.
          const kind = x.n.kind === "image" ? "image" : "video";
          const nouns = x.n.line.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 4 && !/^(their|there|which|would|could|about|after|before|because|every|other|these|those|being|where|while)$/i.test(w)).slice(0, 4).join(" ");
          const found = (await Promise.all([x.n.query, nouns].filter((q) => q.length > 5).map((q) => searchStock(q, { kind, orientation, perPage: 5, providers: providersFor({ kind, period: x.n.period }) }).catch(() => [])))).flat();
          stock.set(x.n.shot.id, found.filter((c) => !usedStock.has(`${c.provider}:${c.externalId}`) && !isBlocked(o.blocked, `${c.provider}:${c.externalId}`) && !anachronistic(`${c.title} ${c.tags.join(" ")}`, era) && !mismatch(`${c.title} ${c.tags.join(" ")}`, x.n.line, x.n.decade)).slice(0, 8).map((c) => ({ src: "stock" as const, c, score: 1 })));
        }
        const pool = [...(stock.get(x.n.shot.id) ?? []), ...(local.get(x.n.shot.id) ?? [])].filter((c) => !taken.has(keyOf(c)));
        let ok = false;
        if (round < 2) {
          for (const alt of pool.slice(0, 2)) {
            try {
              const m2 = await materializeCand(alt, x.n);
              if (m2.kind === "video" && (await hasBlack(m2.localPath))) continue;
              if ((await tooSoft(m2)) || (await marked(m2))) continue;
              const rs = ratedSeen.get(`${x.n.shot.id}|${keyOf(alt)}`);
              if (rs) (m2.seen = rs), (m2.depicts ??= rs.note);
              media.push(m2);
              taken.add(keyOf(alt));
              replaced++;
              ok = true;
              break;
            } catch {
              /* try the next alternate */
            }
          }
        }
        if (!ok) unresolved.push({ shotId: x.n.shot.id, query: x.n.query, reason: `review: ${why}` });
      }
    }
    log(`  resolver: every pick reviewed by eye — ${rejected} rejected (${replaced} replaced, ${rejected - replaced > 0 ? `${unresolved.filter((u) => u.reason.startsWith("review:")).length} shot(s) left for a designed scene` : "none left without a picture"})`);
  }

  // Build list 3, item 21: every placed pick under a line set before 2009 is dated on its own footage with the same
  // check the preflight gate runs (the candidates were dated on preview thumbnails; the footage can differ).
  {
    let late = 0, fixed = 0;
    const items: Array<{ m: ResolvedMedia; n: Need; frame: string; year: number }> = [];
    for (const m of media.filter((x) => x.role === "primary" && x.origin !== "press")) {
      const n = needs.find((x) => x.shot.id === m.shotId);
      const year = n ? yearOf(briefOf(n).when) : null;
      if (!n || year === null || year > 2008) continue;
      const frame = `${m.localPath}.period.jpg`;
      if (await reviewFrame(m.localPath, frame, m.kind === "video" ? 1 : 0)) items.push({ m, n, frame, year });
    }
    const dated = items.length ? await periodCheck(items.map((x) => ({ frameFile: x.frame, year: x.year }))) : [];
    for (const [k, x] of items.entries()) {
      if (dated[k]!.ok) continue;
      late++;
      media.splice(media.indexOf(x.m), 1);
      let ok = false;
      for (const alt of [...(stock.get(x.n.shot.id) ?? []), ...(local.get(x.n.shot.id) ?? [])].filter((c) => !taken.has(keyOf(c))).slice(0, 2)) {
        try {
          const m2 = await materializeCand(alt, x.n);
          const f2 = `${m2.localPath}.period.jpg`;
          if (!(await reviewFrame(m2.localPath, f2, m2.kind === "video" ? 1 : 0)) || !(await periodCheck([{ frameFile: f2, year: x.year }]))[0]!.ok || (await tooSoft(m2)) || (await marked(m2))) continue;
          const rs = ratedSeen.get(`${x.n.shot.id}|${keyOf(alt)}`);
          if (rs) (m2.seen = rs), (m2.depicts ??= rs.note);
          media.push(m2);
          taken.add(keyOf(alt));
          fixed++;
          ok = true;
          break;
        } catch {
          /* next */
        }
      }
      if (!ok) unresolved.push({ shotId: x.n.shot.id, query: x.n.query, reason: `period: ${dated[k]!.evidence.slice(0, 120)}` });
    }
    if (items.length) log(`  resolver: ${items.length} period pick(s) dated on their footage — ${late} looked too late (${fixed} replaced)`);
  }

  /** Build list 5, item 18: a watermark or channel bug in a corner (pixels + one look by eye) — never placed. */
  async function marked(m: ResolvedMedia): Promise<boolean> {
    if (m.role !== "primary") return false;
    const v = await watermarkCheck(m.localPath).catch(() => null);
    if (v?.marked) log(`  resolver: ${m.ref} refused — ${v.note}`);
    return Boolean(v?.marked);
  }

  /** The preflight gate's softness measure, run at placement (press footage is exempt, as in the gate). */
  async function tooSoft(m: ResolvedMedia): Promise<boolean> {
    if (!o.softBelow || m.origin === "press") return false;
    const c = await measureCraft(m.localPath, m.kind === "video" ? Math.min(1, (m.durationS ?? 2) / 2) : undefined).catch(() => null);
    return Boolean(c && c.sharpTop < o.softBelow);
  }

  async function materializeCand(c: Cand, n: Need): Promise<ResolvedMedia> {
    if (c.src === "press") {
      const p = c.p;
      if (p.fetch && !(await exists(p.localFile)) && !(await p.fetch())) throw new Error(`press clip ${p.externalId} could not be downloaded`);
      const alpha = /\.png$/i.test(p.localFile);
      const ext = p.kind === "video" ? "mp4" : alpha ? "png" : "jpg";
      const file = `${n.shot.id}_${createHash("sha1").update(`${p.provider}:${p.externalId}`).digest("hex").slice(0, 8)}.${ext}`;
      await materialize(p.localFile, p.kind, path.join(mediaDir, file), 0, Math.min(n.durationS, p.durationS ?? n.durationS), alpha, Boolean(p.banner));
      return { shotId: n.shot.id, role: "primary", origin: "press", ref: `${p.provider}:${p.externalId}`, provider: p.provider, kind: p.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, ...(p.width ? { width: p.width, height: p.height } : {}), license: p.license, attributionRequired: p.attributionRequired, ...(p.attributionText ? { attributionText: p.attributionText } : {}), sourceUrl: p.pageUrl, aiGenerated: false, score: c.score, query: n.query, depicts: p.depicts, fairUse: { ...p.fairUse, usedS: p.kind === "video" ? Math.round(Math.min(n.durationS + 0.8, p.durationS ?? n.durationS) * 10) / 10 : 0 } };
    }
    if (c.src === "local") {
      const a = c.doc.asset;
      const alpha = a.ext === "png";
      const ext = c.doc.kind === "video" ? "mp4" : alpha ? "png" : "jpg";
      const file = `${n.shot.id}_${createHash("sha1").update(c.doc.key).digest("hex").slice(0, 8)}.${ext}`;
      const inS = c.doc.inS + (c.doc.outS && c.doc.outS - c.doc.inS > n.durationS + 1 ? 0.4 : 0);
      await materialize(await ensureLocal(o.libraryRoot, a.relPath, "library"), c.doc.kind, path.join(mediaDir, file), inS, n.durationS, alpha);
      return { shotId: n.shot.id, role: "primary", origin: "library", ref: c.doc.key, provider: "library", kind: c.doc.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, ...(a.probe?.width ? { width: a.probe.width, height: a.probe.height } : {}), license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: Math.round(c.score * 100) / 100, query: n.query };
    }
    const dl = await downloadCandidate(c.c, dlDir);
    const ext = c.c.kind === "video" ? "mp4" : "jpg";
    const file = `${n.shot.id}_${createHash("sha1").update(`${c.c.provider}:${c.c.externalId}`).digest("hex").slice(0, 8)}.${ext}`;
    await materialize(dl, c.c.kind, path.join(mediaDir, file), 0, n.durationS, false);
    return { shotId: n.shot.id, role: "primary", origin: c.c.archival ? "archival" : "stock", ref: `${c.c.provider}:${c.c.externalId}`, provider: c.c.provider, kind: c.c.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, ...(c.c.width ? { width: c.c.width, height: c.c.height } : {}), license: c.c.license, attributionRequired: c.c.attributionRequired, ...(c.c.attributionText ? { attributionText: c.c.attributionText } : {}), sourceUrl: c.c.pageUrl, aiGenerated: false, score: 1, query: n.query };
  }

  lap("final review");
  // Composed scenes: one picture per named layer (portrait for a person, logo/product/building otherwise),
  // from Wikipedia then Commons, vision-checked. The scene designer only places slots that resolved.
  const sceneShots = o.storyboard.shots.filter((sh) => sh.source.kind === "designed" && sh.source.designed === "scene");
  if (sceneShots.length) {
    const items: Array<{ sh: StoryboardShot; slot: number; name: string; type: string; c: PressCandidate }> = [];
    const perScene = await pooled(sceneShots, 6, async (sh) => {
      const layers = (((sh.source as { props: Record<string, unknown> }).props.layers ?? []) as Array<{ name?: string; type?: string }>).filter((l) => l.name && l.name.trim().length > 1).slice(0, 4);
      return (
        await Promise.all(
          layers.map(async (l, slot) => {
            const e = { name: l.name!.trim(), type: l.type ?? "company" };
            return (await wikiOnce(e, 3)).filter((c) => !isBlocked(o.blocked, `${c.provider}:${c.externalId}`)).map((c) => ({ sh, slot, name: e.name, type: e.type, c: { ...c } }));
          }),
        )
      ).flat();
    });
    items.push(...perScene.flat());
    const line = (sh: StoryboardShot) => (o.words ?? []).filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
    const verdicts: Array<{ shows: boolean; quality: number }> = [];
    for (let i = 0; i < items.length; i += 12) verdicts.push(...(await visionCheck(items.slice(i, i + 12).map((x) => ({ frameFile: x.c.frameFile, depicts: x.c.depicts, line: line(x.sh) }))).catch(() => items.slice(i, i + 12).map(() => ({ shows: false, quality: 0 })))));
    let n = 0;
    for (const sh of sceneShots) {
      const slots = [...new Set(items.filter((x) => x.sh === sh).map((x) => x.slot))].sort((a, b) => a - b);
      for (const slot of slots) {
        const best = items.map((x, k) => ({ ...x, v: verdicts[k]! })).filter((x) => x.sh === sh && x.slot === slot && x.v.shows && x.v.quality >= 4).sort((a, b) => Number(/logo/i.test(b.c.title) && b.type !== "person") - Number(/logo/i.test(a.c.title) && a.type !== "person") || b.v.quality - a.v.quality)[0];
        if (!best) continue;
        const alpha = /\.png$/i.test(best.c.localFile);
        const file = `layer_${sh.id}_${slot}_${createHash("sha1").update(best.c.externalId).digest("hex").slice(0, 8)}.${alpha ? "png" : "jpg"}`;
        try {
          await materialize(best.c.localFile, "image", path.join(mediaDir, file), 0, 1, alpha);
          media.push({ shotId: sh.id, role: "layer", slot, origin: "press", ref: `${best.c.provider}:${best.c.externalId}`, provider: best.c.provider, kind: "image", localPath: path.join(mediaDir, file), publicPath: `media/${file}`, ...(best.c.width ? { width: best.c.width, height: best.c.height } : {}), license: best.c.license, attributionRequired: best.c.attributionRequired, ...(best.c.attributionText ? { attributionText: best.c.attributionText } : {}), sourceUrl: best.c.pageUrl, aiGenerated: false, score: best.v.quality / 10, query: best.name, depicts: `${best.name} — ${alpha ? "transparent logo/cutout" : best.type === "person" ? "photo of the person" : "photo"}`, fairUse: best.c.fairUse });
          n++;
        } catch {
          /* unreadable image: slot stays empty */
        }
      }
    }
    log(`  resolver: composed scenes — ${n} layer picture(s) placed across ${sceneShots.length} scene(s)`);
  }

  lap("scene layer pictures");
  // Real article screenshots: for up to 4 scene shots whose line reports something a source published, the
  // cited page itself becomes picture slot 6 (vision-checked: a readable article, not a cookie wall or error).
  if (o.press !== false && o.sources) {
    const REPORT = /\b(report|reported|according|investigat|article|newspaper|journal|magazine|headline|published|wrote|revealed|exposed|filing|lawsuit|sued|charged|convicted|announced|press)\b/i;
    const usedUrls = new Set<string>();
    const picks: Array<{ sh: StoryboardShot; url: string; text: string }> = [];
    for (const sh of sceneShots) {
      if (picks.length >= 4) break;
      const line = (o.words ?? []).filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
      if (!REPORT.test(`${line} ${sh.intent}`)) continue;
      const src = (o.sources.get(sh.scriptSegmentId) ?? []).find((c) => !usedUrls.has(c.sourceUrl) && !/wikipedia\.org|youtube\.com/.test(c.sourceUrl));
      if (!src) continue;
      usedUrls.add(src.sourceUrl);
      picks.push({ sh, url: src.sourceUrl, text: src.text });
    }
    const shots = await Promise.all(
      picks.map(async (p) => {
        const out = path.join(pressDir, `web_${createHash("sha1").update(p.url).digest("hex").slice(0, 10)}.jpg`);
        return (await screenshotPage(p.url, out)) ? { ...p, out } : null;
      }),
    );
    const got = shots.filter((x): x is NonNullable<typeof x> => x !== null);
    const ok = got.length ? await visionCheck(got.map((g) => ({ frameFile: g.out, depicts: `a readable published article or official page whose headline is about: ${g.text.slice(0, 140)} (NOT a cookie/consent wall, paywall, login, error or blank page)`, line: g.text }))).catch(() => got.map(() => ({ shows: false, quality: 0, note: "" }))) : [];
    let n = 0;
    for (const [k, g] of got.entries()) {
      if (!ok[k]?.shows || (ok[k]?.quality ?? 0) < 5) continue;
      const file = `layer_${g.sh.id}_6_${path.basename(g.out)}`;
      try {
        await materialize(g.out, "image", path.join(mediaDir, file), 0, 1, false);
        const host = new URL(g.url).hostname.replace(/^www\./, "");
        media.push({ shotId: g.sh.id, role: "layer", slot: 6, origin: "press", ref: `web:${g.url}`, provider: "web", kind: "image", localPath: path.join(mediaDir, file), publicPath: `media/${file}`, width: 1280, height: 900, license: "Fair use (screenshot of the cited source)", attributionRequired: true, attributionText: host, sourceUrl: g.url, aiGenerated: false, score: (ok[k]?.quality ?? 5) / 10, query: host, depicts: `screenshot of the real article on ${host} (1.42:1) — ${g.text.slice(0, 90)}`, fairUse: { sourceTitle: g.text.slice(0, 120), channel: host, usedS: 0, reason: "screenshot of the cited source shown as evidence under commentary" } });
        n++;
      } catch {
        /* skip */
      }
    }
    await closeBrowser();
    if (picks.length) log(`  resolver: article screenshots — ${n}/${picks.length} cited source page(s) captured and approved`);
  }

  // Press stills picked for scene shots become picture slot 5 of that scene.
  for (const ps of pressStills) {
    if (media.some((m) => m.shotId === ps.shotId && m.role === "layer" && m.ref === `${ps.c.provider}:${ps.c.externalId}`)) continue;
    const alpha = /\.png$/i.test(ps.c.localFile);
    const file = `layer_${ps.shotId}_5_${createHash("sha1").update(ps.c.externalId).digest("hex").slice(0, 8)}.${alpha ? "png" : "jpg"}`;
    try {
      await materialize(ps.c.localFile, "image", path.join(mediaDir, file), 0, 1, alpha);
      media.push({ shotId: ps.shotId, role: "layer", slot: 5, origin: "press", ref: `${ps.c.provider}:${ps.c.externalId}`, provider: ps.c.provider, kind: "image", localPath: path.join(mediaDir, file), publicPath: `media/${file}`, ...(ps.c.width ? { width: ps.c.width, height: ps.c.height } : {}), license: ps.c.license, attributionRequired: ps.c.attributionRequired, ...(ps.c.attributionText ? { attributionText: ps.c.attributionText } : {}), sourceUrl: ps.c.pageUrl, aiGenerated: false, score: ps.q / 10, query: ps.c.depicts, depicts: `${ps.c.depicts} — ${alpha ? "transparent logo/cutout" : "photo"}`, fairUse: ps.c.fairUse });
    } catch {
      /* unreadable still: no slot */
    }
  }

  lap("article screenshots and press stills");
  // Web pictures: real photographs of the film's kit, from the cited sources and from pages found by web search.
  // Each is checked by eye against the lines it could sit under and becomes picture slot 7 of one scene.
  if (o.press !== false && sceneShots.length) {
    const pics = await webP;
    const toks = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
    const lineOf = (sh: StoryboardShot) => (o.words ?? []).filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
    const shotText = sceneShots.map((sh) => ({ sh, line: lineOf(sh), must: plan.briefs.get(sh.id)?.must ?? sh.intent, t: toks(`${lineOf(sh)} ${sh.intent} ${plan.briefs.get(sh.id)?.must ?? ""}`) }));
    const pairs = pics.flatMap((pic) => {
      const pt = toks(`${pic.alt} ${pic.pageTitle}`);
      return shotText.map((x) => ({ pic, x, overlap: [...pt].filter((w) => x.t.has(w)).length })).filter((y) => y.overlap > 0).sort((a, b) => b.overlap - a.overlap).slice(0, 2);
    });
    const chunks: (typeof pairs)[] = [];
    for (let k = 0; k < pairs.length; k += 12) chunks.push(pairs.slice(k, k + 12));
    const rated = (await pooled(chunks, 6, async (part) => (await reviewPictures(part.map((y) => ({ frameFile: y.pic.thumb, intent: y.x.must, line: y.x.line, era: eraLabel }))).catch(() => part.map(() => null))).map((r, k) => ({ ...part[k]!, r })))).flat();
    const hasPrimary = new Set(media.filter((m) => m.role === "primary").map((m) => m.shotId));
    const usedPic = new Set<string>();
    const usedShot = new Set<string>();
    let n = 0;
    for (const y of rated.filter((z) => z.r && z.r.shows !== "not reviewed" && z.r.fit >= MEANING_BAR && !z.r.banner && !z.r.wrongEra && !z.r.synthetic).sort((a, b) => b.r!.fit + (hasPrimary.has(b.x.sh.id) ? 0 : 1) - (a.r!.fit + (hasPrimary.has(a.x.sh.id) ? 0 : 1)))) {
      if (n >= 10 || usedPic.has(y.pic.url) || usedShot.has(y.x.sh.id) || isBlocked(o.blocked, `web:${y.pic.url}`)) continue;
      const file = `layer_${y.x.sh.id}_7_${path.basename(y.pic.file)}`;
      try {
        await materialize(y.pic.file, "image", path.join(mediaDir, file), 0, 1, false);
        media.push({ shotId: y.x.sh.id, role: "layer", slot: 7, origin: "press", ref: `web:${y.pic.url}`, provider: "web", kind: "image", localPath: path.join(mediaDir, file), publicPath: `media/${file}`, width: y.pic.width, height: y.pic.height, license: "Fair use (photograph shown under commentary)", attributionRequired: true, attributionText: y.pic.host, sourceUrl: y.pic.pageUrl, aiGenerated: false, score: y.r!.fit / 10, query: y.x.must, depicts: `${y.r!.shows} — photo (${(y.pic.width / y.pic.height).toFixed(2)}:1)`, fairUse: { sourceTitle: y.pic.pageTitle || y.pic.host, channel: y.pic.host, usedS: 0, reason: "photograph of the subject discussed, shown inside a designed scene under commentary; not from a photo agency" } });
        usedPic.add(y.pic.url);
        usedShot.add(y.x.sh.id);
        n++;
      } catch {
        /* unreadable picture */
      }
    }
    if (pics.length) log(`  resolver: web pictures — ${n} placed as scene pictures (${pairs.length} picture/line pairs checked by eye)`);
  }

  lap("web pictures");
  // Coverage report: what every shot needed, what was looked at, what it got — written before any design or render.
  {
    const rows = needs.map((n) => {
      const b = briefOf(n);
      const pm = media.find((m) => m.shotId === n.shot.id && m.role === "primary");
      const layers = media.filter((m) => m.shotId === n.shot.id && m.role === "layer").length;
      return { shotId: n.shot.id, line: n.line, need: b.need, must: b.must, ...(b.when ? { when: b.when } : {}), searches: { stock: b.stock, archive: b.archive, youtube: b.youtube }, candidatesSeen: offered.get(n.shot.id)?.n ?? 0, bestFit: offered.get(n.shot.id)?.best ?? null, footage: pm ? { ref: pm.ref, origin: pm.origin, provider: pm.provider, fit: pm.seen?.fit ?? Math.round(pm.score * 10), shows: pm.depicts ?? "" } : null, scenePictures: layers, missing: b.need !== "none" && !pm && !layers, ...(replans.has(n.shot.id) ? { replanned: replans.get(n.shot.id) } : {}), candidates: (looked.get(n.shot.id) ?? []).sort((a, b) => b.fit - a.fit) };
    });
    const wanted = rows.filter((r) => r.need !== "none");
    const real = rows.filter((r) => r.need === "real");
    const report = { seconds: Object.fromEntries(laps.map((l) => [l.phase, l.s])), kit: plan.kit, refusedByRateLimit: Object.fromEntries(refused), providersDown: providerHealth(), sources: Object.fromEntries([...yieldBy.entries()].map(([k, y]) => [k, { searches: y.asked, results: y.got }])), shots: rows.length, needPicture: wanted.length, withFootage: wanted.filter((r) => r.footage).length, withScenePictureOnly: wanted.filter((r) => !r.footage && r.scenePictures).length, missing: wanted.filter((r) => r.missing).map((r) => r.shotId), realNeeded: real.length, realMet: real.filter((r) => r.footage?.origin === "press" || r.footage?.origin === "archival" || r.scenePictures).length, rows };
    const file = path.join(o.jobDir, "sourcing.json");
    await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2));
    await rename(`${file}.tmp`, file);
    log(`  resolver: time — ${laps.map((l) => `${l.phase} ${l.s} s`).join(", ")}`);
    log(`  resolver: coverage — ${report.withFootage}/${report.needPicture} shots that need a picture have footage, ${report.withScenePictureOnly} more have a real still; real-subject needs met ${report.realMet}/${report.realNeeded}; ${report.missing.length} missing${report.missing.length ? ` (${report.missing.slice(0, 8).join(", ")})` : ""} → sourcing.json`);
  }

  // Overlays, paper for documents, SFX and music — all from the licensed library.
  const addLib = async (shotId: string, role: ResolvedMedia["role"], a: AssetRecord, durationS?: number) => {
    const isAudio = a.kind === "audio";
    const file = `${role}_${shotId}_${a.id}.${isAudio ? "mp3" : a.kind === "video" ? "mp4" : a.ext === "png" ? "png" : "jpg"}`;
    const out = path.join(isAudio ? path.join(o.jobDir, "audio") : mediaDir, file);
    if (isAudio) {
      await mkdir(path.dirname(out), { recursive: true });
      if (!(await exists(out))) await ffmpeg(["-i", await ensureLocal(o.libraryRoot, a.relPath, "library"), "-c:a", "libmp3lame", "-q:a", "2", out]);
    } else await materialize(await ensureLocal(o.libraryRoot, a.relPath, "library"), a.kind === "video" ? "video" : "image", out, 0, durationS ?? 5, a.ext === "png");
    media.push({ shotId, role, origin: "library", ref: a.id, provider: "library", kind: isAudio ? "audio" : a.kind === "video" ? "video" : "image", localPath: out, publicPath: isAudio ? `../audio/${file}` : `media/${file}`, ...(a.probe?.durationS ? { durationS: a.probe.durationS } : {}), license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: 1, query: role });
  };
  const papers = o.index.assets.filter((a) => isUsable(a) && a.category === "overlays" && a.kind === "image" && /old_paper|parchment|paper_white|paper_kraft|paper_manila|card_grey/.test(a.relPath) && !/newsprint/.test(a.relPath)).sort((a, b) => a.id.localeCompare(b.id));
  let paperI = 0;
  for (const s of o.storyboard.shots) {
    for (const ov of s.overlays) {
      const a = byId.get(ov.assetId);
      if (a && isUsable(a)) await addLib(s.id, "overlay", a, s.endS - s.startS);
    }
    if (s.source.kind === "designed" && s.source.designed === "document" && papers.length) await addLib(s.id, "overlay", papers[paperI++ % papers.length]!, s.endS - s.startS);
    for (const fx of s.sfx) {
      const a = byId.get(fx.assetId);
      if (a && isUsable(a)) await addLib(s.id, "sfx", a);
    }
  }
  for (const m of o.storyboard.music) {
    const a = byId.get(m.assetId);
    if (a && isUsable(a)) await addLib("music", "music", a);
  }

  const designed = o.storyboard.shots.filter((s) => s.source.kind === "designed").length;
  const primaries = media.filter((m) => m.role === "primary");
  log(`  resolver: ${primaries.filter((m) => m.origin === "library").length} library, ${primaries.filter((m) => m.origin === "stock").length} stock, ${primaries.filter((m) => m.origin === "archival").length} archival, ${designed} designed, ${unresolved.length} unresolved`);
  return ResolutionReport.parse({
    schemaVersion: 1,
    storyboardId: o.storyboard.id,
    media,
    unresolved,
    stats: { library: primaries.filter((m) => m.origin === "library").length, stock: primaries.filter((m) => m.origin === "stock").length, archival: primaries.filter((m) => m.origin === "archival").length, designed },
    generatedAt: new Date().toISOString(),
  });
}


export interface RepairOptions extends ResolveOptions {
  resolution: ResolutionReport;
  /** shotId → QA note explaining why the current picture was rejected. */
  repairs: Map<string, string>;
}

/**
 * Targeted repair after QA: re-resolve only the flagged shots, excluding every picture already used,
 * with Sonnet 5.5 doing the (stricter) pick and the QA note in its brief. Other shots are untouched.
 */
const RewriteSchema = z.object({ shots: z.array(z.object({ shot: z.string(), queries: z.array(z.string()) })) });

export async function repairShots(o: RepairOptions): Promise<ResolutionReport> {
  const log = o.log ?? (() => {});
  const mediaDir = path.join(o.jobDir, "public", "media");
  const dlDir = path.join(o.jobDir, "downloads");
  const bm = new Bm25(buildDocs(o.index));
  const orientation = o.storyboard.aspect === "9:16" ? "portrait" : "landscape";
  const era = o.narration ? storyEraOf(o.narration) : null;
  const used = new Set(o.resolution.media.filter((m) => m.role === "primary").map((m) => m.ref));
  const needs = o.storyboard.shots.filter((s) => o.repairs.has(s.id)).map((sh) => needOf(sh, era)).filter((n): n is Need => n !== null);
  for (const n of needs) n.line = (o.words ?? []).filter((w) => w.startS >= n.shot.startS - 0.05 && w.startS < n.shot.endS).map((w) => w.word).join(" ");
  // Repairs are stricter about period: within 5 years of the story's start.
  const offEra = (doc: LocalDoc, n: Need) => Boolean(era && era.min >= 1960 && doc.decade !== null && doc.decade < era.min - 5 && !(n.decade !== null && n.decade < era.min - 5));

  // 1) Sonnet rewrites the search: two concrete, filmable queries per shot, informed by the QA note.
  log(`  repair: rewriting queries for ${needs.length} shot(s) (${MODELS.sonnet})…`);
  const { data: rw } = await structured({
    stage: "resolve.repair.queries",
    model: MODELS.sonnet,
    system: [plain(`You are a documentary researcher. For each rejected shot write two stock-footage search queries (3-6 words, concrete and filmable, ${era ? `set ${era.min}–${era.max}` : "period-appropriate"}) that would illustrate the narration: prefer cinematic staged reenactment (anonymous actors: executives in a dark boardroom, engineers at monitors at night, a hand signing a contract, a worried consumer) or real places, objects and documents of the right era. Never a recognisable celebrity or politician.`)],
    user: needs.map((n) => `${n.shot.id}: narration "${n.line}" | intent ${n.shot.intent} | rejected because: ${o.repairs.get(n.shot.id)}`).join("\n"),
    schema: RewriteSchema,
    effort: "medium",
  });
  const queriesFor = new Map(rw.shots.map((x) => [x.shot, x.queries.slice(0, 2)]));

  // 2) Search library + stock with the new queries.
  const cands = new Map<string, Cand[]>();
  for (const n of needs) {
    const qs = [...(queriesFor.get(n.shot.id) ?? []), n.query];
    const kind = n.kind === "image" ? "image" : "video";
    const seen = new Set<string>();
    const list: Cand[] = [];
    for (const q of qs) {
      for (const r of bm.search(q, { kind: n.kind, decade: n.decade, limit: 30 }).filter((r) => !used.has(r.doc.key) && !offEra(r.doc, n) && !r.doc.asset.bugSpots?.length).slice(0, 3)) {
        if (!seen.has(r.doc.key)) list.push({ src: "local", doc: r.doc, score: r.score }), seen.add(r.doc.key);
      }
      for (const c of (await searchStock(q, { kind, orientation, perPage: 4, providers: providersFor({ kind, period: n.period }) })).slice(0, 5)) {
        const k = `${c.provider}:${c.externalId}`;
        if (!used.has(k) && !seen.has(k)) list.push({ src: "stock", c, score: 1 }), seen.add(k);
      }
    }
    cands.set(n.shot.id, list.slice(0, 14));
  }

  // 3) Sonnet picks; a rejection (-1) means hold the previous picture instead of forcing a bad match.
  log(`  repair: re-picking ${needs.length} shot(s) with ${MODELS.sonnet}…`);
  const picks = await pick("resolve.repair", needs, cands, o.storyboard.aspect, era, MODELS.sonnet, o.repairs);
  let media = [...o.resolution.media];
  const unresolved = [...o.resolution.unresolved.filter((u) => !o.repairs.has(u.shotId))];
  for (const n of needs) {
    const list = cands.get(n.shot.id) ?? [];
    const first = list[picks.get(n.shot.id) ?? -1];
    let placed = false;
    for (const c of first ? [first] : []) {
      try {
        let m: ResolvedMedia;
        if (c.src === "local") {
          const a = c.doc.asset;
          const alpha = a.ext === "png";
          const file = `${n.shot.id}_${createHash("sha1").update(c.doc.key).digest("hex").slice(0, 8)}.${c.doc.kind === "video" ? "mp4" : alpha ? "png" : "jpg"}`;
          await materialize(await ensureLocal(o.libraryRoot, a.relPath, "library"), c.doc.kind, path.join(mediaDir, file), c.doc.inS, n.durationS, alpha);
          m = { shotId: n.shot.id, role: "primary", origin: "library", ref: c.doc.key, provider: "library", kind: c.doc.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: Math.round(c.score * 100) / 100, query: n.query };
        } else if (c.src === "stock") {
          const dl = await downloadCandidate(c.c, dlDir);
          const file = `${n.shot.id}_${createHash("sha1").update(`${c.c.provider}:${c.c.externalId}`).digest("hex").slice(0, 8)}.${c.c.kind === "video" ? "mp4" : "jpg"}`;
          await materialize(dl, c.c.kind, path.join(mediaDir, file), 0, n.durationS, false);
          m = { shotId: n.shot.id, role: "primary", origin: c.c.archival ? "archival" : "stock", ref: `${c.c.provider}:${c.c.externalId}`, provider: c.c.provider, kind: c.c.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, ...(c.c.width ? { width: c.c.width, height: c.c.height } : {}), license: c.c.license, attributionRequired: c.c.attributionRequired, ...(c.c.attributionText ? { attributionText: c.c.attributionText } : {}), sourceUrl: c.c.pageUrl, aiGenerated: false, score: 1, query: n.query };
        } else continue;
        if (m.kind === "video" && (await hasBlack(m.localPath))) continue;
        media = media.filter((x) => !(x.shotId === n.shot.id && x.role === "primary"));
        media.push(m);
        placed = true;
        log(`    ${n.shot.id}: → ${m.origin}:${m.provider} "${(queriesFor.get(n.shot.id) ?? [n.query])[0]}"`);
      } catch {
        /* fall through to hold */
      }
    }
    if (!placed) {
      const isDesigned = n.shot.source.kind === "designed";
      media = media.filter((x) => !(x.shotId === n.shot.id && x.role === "primary"));
      unresolved.push({ shotId: n.shot.id, query: n.query, reason: isDesigned ? "repair: no fitting background; graphic shown on its own" : "repair: no fitting candidate; holding previous shot" });
      log(`    ${n.shot.id}: no candidate passed review → ${isDesigned ? "graphic without background plate" : "hold previous shot"}`);
    }
  }
  const primaries = media.filter((m) => m.role === "primary");
  return ResolutionReport.parse({ ...o.resolution, media, unresolved, stats: { ...o.resolution.stats, library: primaries.filter((m) => m.origin === "library").length, stock: primaries.filter((m) => m.origin === "stock").length, archival: primaries.filter((m) => m.origin === "archival").length }, generatedAt: new Date().toISOString() });
}

/**
 * Replace a resolution's sound (effects and music) with what the storyboard now asks for — used after the
 * timeline sound designer has placed sounds on the finished scenes. Pictures are untouched.
 */
export async function resolveAudio(o: { storyboard: Storyboard; index: LibraryIndex; libraryRoot: string; jobDir: string; resolution: ResolutionReport }): Promise<ResolutionReport> {
  const byId = new Map(o.index.assets.map((a) => [a.id, a]));
  const media = o.resolution.media.filter((m) => m.role !== "sfx" && m.role !== "music");
  const audioDir = path.join(o.jobDir, "audio");
  await mkdir(audioDir, { recursive: true });
  const add = async (shotId: string, role: "sfx" | "music", id: string) => {
    const a = byId.get(id);
    if (!a || !isUsable(a) || media.some((m) => m.shotId === shotId && m.role === role && m.ref === id)) return;
    const file = `${role}_${shotId}_${a.id}.mp3`;
    const out = path.join(audioDir, file);
    // synthesised accents (craft inventory: tonal plucks) live outside the library, at an absolute path
    if (!(await exists(out))) await ffmpeg(["-i", path.isAbsolute(a.relPath) ? a.relPath : await ensureLocal(o.libraryRoot, a.relPath, "library"), "-c:a", "libmp3lame", "-q:a", "2", out]);
    media.push({ shotId, role, origin: "library", ref: a.id, provider: "library", kind: "audio", localPath: out, publicPath: `../audio/${file}`, ...(a.probe?.durationS ? { durationS: a.probe.durationS } : {}), license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: 1, query: role });
  };
  for (const s of o.storyboard.shots) for (const fx of s.sfx) await add(s.id, "sfx", fx.assetId);
  for (const m of o.storyboard.music) await add("music", "music", m.assetId);
  return ResolutionReport.parse({ ...o.resolution, media });
}


/**
 * Craft inventory: the scene designer's atmospheres (smoke, embers, dust, scratches, film burn, sprocket gate, light
 * leak) become real filmed overlays from Library/overlays on their shots — licensed, logged as media, screen-blended by
 * the manifest. Picked deterministically per film, never the same file twice in a row.
 */
export async function resolveAtmosphere(o: { storyboard: Storyboard; scenes: Array<{ shotId: string; atmos?: { kind: string; opacity: number } }>; index: LibraryIndex; libraryRoot: string; jobDir: string; resolution: ResolutionReport; seed: string }): Promise<{ storyboard: Storyboard; resolution: ResolutionReport; placed: number }> {
  const RE: Record<string, RegExp> = { smoke: /smoke_(drift|white|faint)/, embers: /embers|sparks/, dust: /dust_particles|dust_pool|grain_loop/, scratches: /scratches|8mm/, burn: /burn_/, sprocket: /sprocket|film_frame/, leak: /leak_/, money: /money_banknotes/ };
  // hand film 1: atmospheres are screen-blended, so a clip filmed on white ("…_on_white_…") turns the whole shot white
  const all = o.index.assets.filter((a) => isUsable(a) && a.category === "overlays" && a.kind === "video" && !/_on_white/i.test(a.relPath));
  const media = o.resolution.media.filter((m) => !(m.role === "overlay" && m.origin === "library" && /^atmos_/.test(path.basename(m.localPath))));
  const mediaDir = path.join(o.jobDir, "public", "media");
  await mkdir(mediaDir, { recursive: true });
  const h = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16);
  let last = "";
  let placed = 0;
  const shots = o.storyboard.shots.map((s) => ({ ...s, overlays: s.overlays.filter((ov) => !all.some((a) => a.id === ov.assetId && Object.values(RE).some((re) => re.test(a.relPath)))) }));
  // cover transitions: a real smoke or film-burn clip over the first 1.2 s of the shot
  for (const sh of shots) {
    const kind = sh.transitionIn === "smoke_cover" ? "smoke" : sh.transitionIn === "fire_cover" ? "burn" : null;
    if (!kind || sh.overlays.some((ov) => ov.durS !== undefined)) continue;
    const pool = all.filter((a) => RE[kind]!.test(a.relPath)).sort((a, b) => h(o.seed + sh.id + a.id) - h(o.seed + sh.id + b.id));
    const a = pool[0];
    if (!a) continue;
    const file = `atmos_cover_${sh.id}_${a.id}.mp4`;
    const out = path.join(mediaDir, file);
    if (!(await exists(out))) await materialize(await ensureLocal(o.libraryRoot, a.relPath, "library"), "video", out, 0, 1.6, false);
    media.push({ shotId: sh.id, role: "overlay", origin: "library", ref: a.id, provider: "library", kind: "video", localPath: out, publicPath: `media/${file}`, license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: 1, query: `${kind} cover transition` });
    sh.overlays = [...sh.overlays, { assetId: a.id, blend: "screen", opacity: 0.95, durS: 1.2 }];
    placed++;
  }
  for (const sc of o.scenes) {
    if (!sc.atmos) continue;
    const re = RE[sc.atmos.kind];
    const pool = re ? all.filter((a) => re.test(a.relPath)) : [];
    if (!pool.length) continue;
    const sorted = [...pool].sort((a, b) => h(o.seed + a.id) - h(o.seed + b.id));
    const a = sorted.find((x) => x.id !== last) ?? sorted[0]!;
    last = a.id;
    const sh = shots.find((x) => x.id === sc.shotId);
    if (!sh) continue;
    const file = `atmos_${sh.id}_${a.id}.mp4`;
    const out = path.join(mediaDir, file);
    if (!(await exists(out))) await materialize(await ensureLocal(o.libraryRoot, a.relPath, "library"), "video", out, 0, Math.max(1, sh.endS - sh.startS), false);
    media.push({ shotId: sh.id, role: "overlay", origin: "library", ref: a.id, provider: "library", kind: "video", localPath: out, publicPath: `media/${file}`, license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: 1, query: `atmosphere ${sc.atmos.kind}` });
    sh.overlays = [...sh.overlays, { assetId: a.id, blend: "screen", opacity: sc.atmos.opacity }];
    placed++;
  }
  return { storyboard: { ...o.storyboard, shots }, resolution: ResolutionReport.parse({ ...o.resolution, media }), placed };
}


/**
 * Craft inventory: paper worlds stand on a real paper scan from the library (aged, folded, foxed, crumpled, newsprint)
 * instead of drawn grain — laid in as a picture slot of the shot (slot 90+), licensed and logged like any layer.
 */
export async function resolvePaperTextures(o: { scenes: Array<{ shotId: string; world?: { kind: string; texture?: number } }>; index: LibraryIndex; libraryRoot: string; jobDir: string; resolution: ResolutionReport; seed: string }): Promise<{ resolution: ResolutionReport; placed: number }> {
  const papers = o.index.assets.filter((a) => isUsable(a) && a.category === "overlays" && a.kind === "image" && /paper|parchment|newsprint|card_/.test(a.relPath));
  if (!papers.length) return { resolution: o.resolution, placed: 0 };
  const media = [...o.resolution.media];
  const mediaDir = path.join(o.jobDir, "public", "media");
  await mkdir(mediaDir, { recursive: true });
  const h = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16);
  let placed = 0;
  for (const sc of o.scenes) {
    if (sc.world?.kind !== "paper") continue;
    if (sc.world.texture !== undefined && media.some((m) => m.shotId === sc.shotId && m.role === "layer" && m.slot === sc.world!.texture)) continue;
    const a = [...papers].sort((x, y) => h(o.seed + sc.shotId + x.id) - h(o.seed + sc.shotId + y.id))[0]!;
    const slot = 90;
    const file = `paper_${sc.shotId}_${a.id}.${a.ext === "png" ? "png" : "jpg"}`;
    const out = path.join(mediaDir, file);
    if (!(await exists(out))) await materialize(await ensureLocal(o.libraryRoot, a.relPath, "library"), "image", out, 0, 5, a.ext === "png");
    for (let k = media.length - 1; k >= 0; k--) if (media[k]!.shotId === sc.shotId && media[k]!.role === "layer" && media[k]!.slot === slot) media.splice(k, 1);
    media.push({ shotId: sc.shotId, role: "layer", slot, origin: "library", ref: a.id, provider: "library", kind: "image", localPath: out, publicPath: `media/${file}`, license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: 1, query: "paper texture" });
    sc.world.texture = slot;
    placed++;
  }
  return { resolution: ResolutionReport.parse({ ...o.resolution, media }), placed };
}
