import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ResolutionReport, type AssetRecord, type LibraryIndex, type ResolvedMedia, type Storyboard, type StoryboardShot } from "@opumia/contracts";
import { isUsable, MODELS, plain, structured } from "@opumia/agents";
import { ensureLocal } from "@opumia/ingest";
import * as z from "zod/v4";
import { Bm25, buildDocs, type LocalDoc } from "./local-search.js";
import { downloadCandidate, providersFor, searchStock, type StockCandidate } from "./stock.js";
import { visionCheck, wikipediaImages, youtubePress, type PressCandidate } from "./press.js";

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
async function materialize(src: string, kind: "video" | "image", out: string, inS: number, durationS: number, srcHasAlpha: boolean) {
  if (await exists(out)) return;
  if (kind === "video") {
    await ffmpeg(["-ss", inS.toFixed(3), "-stream_loop", "-1", "-i", src, "-t", (durationS + 0.8).toFixed(3), "-an", "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out]);
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
  /** Fair-use press sourcing (YouTube news/interview excerpts, Wikipedia photos and logos). Default on. */
  press?: boolean;
  log?: (s: string) => void;
}

const isBlocked = (blocked: Set<string> | undefined, ref: string) => !!blocked && (blocked.has(ref) || blocked.has(ref.split("#")[0]!));

export async function resolveAssets(o: ResolveOptions): Promise<ResolutionReport> {
  const log = o.log ?? (() => {});
  const pub = path.join(o.jobDir, "public");
  const mediaDir = path.join(pub, "media");
  const dlDir = path.join(o.jobDir, "downloads");
  await mkdir(mediaDir, { recursive: true });
  const byId = new Map(o.index.assets.map((a) => [a.id, a]));
  const bm = new Bm25(buildDocs(o.index));
  const orientation = o.storyboard.aspect === "9:16" ? "portrait" : "landscape";

  const era = o.narration ? storyEraOf(o.narration) : null;
  if (era) log(`  resolver: story era ${era.min}–${era.max}`);
  const needs = o.storyboard.shots.map((sh) => needOf(sh, era)).filter((n): n is Need => n !== null);
  for (const n of needs) n.line = (o.words ?? []).filter((w) => w.startS >= n.shot.startS - 0.05 && w.startS < n.shot.endS).map((w) => w.word).join(" ");
  // Footage much older than the story is out of period unless the shot asks for that era.
  const tooOld = (doc: LocalDoc, n: Need) => Boolean(era && era.min >= 1960 && doc.decade !== null && doc.decade < era.min - 15 && !(n.decade !== null && n.decade < era.min - 15));
  const usedLocal = new Set<string>();
  const usedStock = new Set<string>();
  const chosen = new Map<string, Cand>();

  const pressDir = path.join(o.jobDir, "downloads", "press");
  const usedVideos = new Set<string>();
  const usedWiki = new Set<string>();
  const wantsImage = (n: Need) => n.kind === "image" || (n.shot.source.kind === "designed" && ["hero_face", "cutout_collage"].includes(n.shot.source.designed));
  // Phase P — fair-use press first for named entities: the real person/company/product/event, checked by eye.
  if (o.press !== false) {
    const pressNeeds = needs.filter((n) => n.shot.entities?.length);
    if (pressNeeds.length) log(`  resolver: press sourcing for ${pressNeeds.length} entity shot(s) (Wikipedia + YouTube excerpts, vision-checked)…`);
    const pool = new Map<string, PressCandidate[]>();
    const wikiCache = new Map<string, Promise<PressCandidate[]>>();
    const wiki = (e: { name: string; type: string }) => {
      const k = e.name.toLowerCase();
      if (!wikiCache.has(k)) wikiCache.set(k, wikipediaImages(e, pressDir, 4).catch(() => []));
      return wikiCache.get(k)!;
    };
    const lim = 4;
    for (let i = 0; i < pressNeeds.length; i += lim) {
      await Promise.all(
        pressNeeds.slice(i, i + lim).map(async (n) => {
          const e = n.shot.entities![0]!;
          const list: PressCandidate[] = [];
          if (e.type !== "event") list.push(...(await wiki(e)));
          if (!wantsImage(n) && ["person", "company", "event", "product"].includes(e.type)) list.push(...(await youtubePress({ entity: e, context: e.type === "person" ? "interview" : e.type === "event" ? "footage" : "", dlDir: pressDir, usedVideos: new Set(), videos: 2, perVideo: 2, clipS: n.durationS }).catch(() => [])));
          pool.set(n.shot.id, list.filter((c) => !isBlocked(o.blocked, `${c.provider}:${c.externalId}`)));
        }),
      );
    }
    // Vision check in batches of 12 frames (Haiku).
    const flat = pressNeeds.flatMap((n) => (pool.get(n.shot.id) ?? []).map((c) => ({ n, c })));
    const verdicts: Array<{ shows: boolean; quality: number; note: string }> = [];
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
      chosen.set(n.shot.id, { src: "press", p: pickP.c, score: pickP.v.quality / 10 });
      placed++;
    }
    if (pressNeeds.length) log(`  resolver: ${placed}/${pressNeeds.length} entity shot(s) placed from press (${flat.length} candidates checked)`);
  }

  // Phase 0 — archive first for named entities: Commons, NARA, Europeana with name + year.
  const entityNeeds = needs.filter((n) => n.shot.entities?.length && !chosen.has(n.shot.id));
  if (entityNeeds.length) {
    const ent = new Map<string, Cand[]>();
    for (const n of entityNeeds) {
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
    }
    const withCands = entityNeeds.filter((n) => (ent.get(n.shot.id) ?? []).length);
    log(`  resolver: archive-first for ${entityNeeds.length} entity shot(s); ${withCands.length} have named archival candidates`);
    if (withCands.length) {
      const pe = await pick("resolve.entity", withCands, ent, o.storyboard.aspect, era, MODELS.sonnet, new Map(), true);
      for (const n of withCands) {
        const c = ent.get(n.shot.id)?.[pe.get(n.shot.id) ?? -1];
        if (!c) continue;
        chosen.set(n.shot.id, c);
        if (c.src === "local") usedLocal.add(c.doc.key);
        else if (c.src === "stock") usedStock.add(`${c.c.provider}:${c.c.externalId}`);
      }
      log(`  resolver: ${withCands.filter((n) => chosen.has(n.shot.id)).length} entity shot(s) placed from archives`);
    }
  }

  // Phase 1 — local library first (for everything not already placed from archives).
  const pending = needs.filter((n) => !chosen.has(n.shot.id));
  const local = new Map<string, Cand[]>();
  for (const n of pending) local.set(n.shot.id, bm.search(n.query, { kind: n.kind, decade: n.decade, limit: 24 }).filter((r) => !tooOld(r.doc, n) && !r.doc.asset.bugSpots?.length && !anachronistic(r.doc.text, era) && !mismatch(r.doc.text, n.line, n.decade) && !isBlocked(o.blocked, r.doc.key)).slice(0, 6).map((r) => ({ src: "local" as const, doc: r.doc, score: r.score })));
  log(`  resolver: local candidates for ${[...local.values()].filter((c) => c.length).length}/${pending.length} shots; reranking (${MODELS.haiku})…`);
  const p1 = await pick("resolve.local", pending, local, o.storyboard.aspect, era);
  for (const n of pending) {
    const i = p1.get(n.shot.id) ?? -1;
    const c = local.get(n.shot.id)?.[i];
    if (c && c.src === "local" && !usedLocal.has(c.doc.key)) {
      chosen.set(n.shot.id, c);
      usedLocal.add(c.doc.key);
    }
  }

  // Phase 2 — stock/archival fallback for the rest.
  const rest = needs.filter((n) => !chosen.has(n.shot.id));
  const stock = new Map<string, Cand[]>();
  if (rest.length) {
    log(`  resolver: ${rest.length} shots → stock/archival search…`);
    for (const n of rest) {
      const kind = n.kind === "image" ? "image" : "video";
      const found = await searchStock(n.query, { kind, orientation, perPage: 4, providers: providersFor({ kind, period: n.period }) });
      stock.set(n.shot.id, found.filter((c) => !usedStock.has(`${c.provider}:${c.externalId}`) && !anachronistic(`${c.title} ${c.tags.join(" ")}`, era) && !mismatch(`${c.title} ${c.tags.join(" ")}`, n.line, n.decade) && !isBlocked(o.blocked, `${c.provider}:${c.externalId}`)).slice(0, 8).map((c) => ({ src: "stock" as const, c, score: 1 })));
    }
    const p2 = await pick("resolve.stock", rest, stock, o.storyboard.aspect, era);
    for (const n of rest) {
      const c = stock.get(n.shot.id)?.[p2.get(n.shot.id) ?? -1];
      if (c && c.src === "stock") {
        chosen.set(n.shot.id, c);
        usedStock.add(`${c.c.provider}:${c.c.externalId}`);
      }
      // Rejected by both reranks: leave unresolved so the previous picture holds (never force a bad match).
    }
  }

  // Materialize, screening each clip for black frames and falling back to the next candidate.
  const media: ResolvedMedia[] = [];
  const unresolved: ResolutionReport["unresolved"] = [];
  const keyOf = (c: Cand) => (c.src === "local" ? c.doc.key : c.src === "press" ? `${c.p.provider}:${c.p.externalId}` : `${c.c.provider}:${c.c.externalId}`);
  const taken = new Set([...chosen.values()].map(keyOf));
  let fallbacks = 0;
  for (const n of needs) {
    const first = chosen.get(n.shot.id);
    // Only the reranker's accepted pick is ever used; anything it rejected is never forced in.
    const queue = first ? [first] : [];
    if (!queue.length) {
      unresolved.push({ shotId: n.shot.id, query: n.query, reason: "no candidate passed review; holding previous shot" });
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

  async function materializeCand(c: Cand, n: Need): Promise<ResolvedMedia> {
    if (c.src === "press") {
      const p = c.p;
      const alpha = /\.png$/i.test(p.localFile);
      const ext = p.kind === "video" ? "mp4" : alpha ? "png" : "jpg";
      const file = `${n.shot.id}_${createHash("sha1").update(`${p.provider}:${p.externalId}`).digest("hex").slice(0, 8)}.${ext}`;
      await materialize(p.localFile, p.kind, path.join(mediaDir, file), 0, Math.min(n.durationS, p.durationS ?? n.durationS), alpha);
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

  // Composed scenes: one picture per named layer (portrait for a person, logo/product/building otherwise),
  // from Wikipedia then Commons, vision-checked. The scene designer only places slots that resolved.
  const sceneShots = o.storyboard.shots.filter((sh) => sh.source.kind === "designed" && sh.source.designed === "scene");
  if (sceneShots.length) {
    const items: Array<{ sh: StoryboardShot; slot: number; name: string; type: string; c: PressCandidate }> = [];
    for (const sh of sceneShots) {
      const layers = (((sh.source as { props: Record<string, unknown> }).props.layers ?? []) as Array<{ name?: string; type?: string }>).filter((l) => l.name && l.name.trim().length > 1).slice(0, 4);
      await Promise.all(
        layers.map(async (l, slot) => {
          const e = { name: l.name!.trim(), type: l.type ?? "company" };
          const cands = (await wikipediaImages(e, pressDir, 3).catch(() => [] as PressCandidate[])).filter((c) => !isBlocked(o.blocked, `${c.provider}:${c.externalId}`));
          for (const c of cands) items.push({ sh, slot, name: e.name, type: e.type, c });
        }),
      );
    }
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
