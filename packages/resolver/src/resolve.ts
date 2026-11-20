import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ResolutionReport, type AssetRecord, type LibraryIndex, type ResolvedMedia, type Storyboard, type StoryboardShot } from "@opumia/contracts";
import { isUsable, MODELS, plain, structured } from "@opumia/agents";
import * as z from "zod/v4";
import { Bm25, buildDocs, type LocalDoc } from "./local-search.js";
import { downloadCandidate, providersFor, searchStock, type StockCandidate } from "./stock.js";

const run = promisify(execFile);

type Cand = { src: "local"; doc: LocalDoc; score: number } | { src: "stock"; c: StockCandidate; score: number };

const PickSchema = z.object({ picks: z.array(z.object({ shot: z.string(), choice: z.number().describe("candidate index, or -1 if none fits") })) });

const describe = (c: Cand) =>
  c.src === "local"
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
  const years = [...text.matchAll(/\b(1[89]\d\d|20[0-4]\d)\b/g)].map((m) => Number(m[1]));
  return years.length ? { min: Math.min(...years), max: Math.max(...years) } : null;
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

async function pick(stage: string, needs: Need[], cands: Map<string, Cand[]>, aspect: string, era: StoryEra | null, model: (typeof MODELS)[keyof typeof MODELS] = MODELS.haiku, notes: Map<string, string> = new Map()): Promise<Map<string, number>> {
  const rows = needs.filter((n) => (cands.get(n.shot.id) ?? []).length);
  if (!rows.length) return new Map();
  const text = rows
    .map((n) => `SHOT ${n.shot.id} (${n.durationS.toFixed(1)} s) narration: "${n.line}" | intent: ${n.shot.intent} | query: ${n.query}${n.decade ? ` | era ${n.decade}s` : ""}${notes.get(n.shot.id) ? ` | QA REJECTED THE PREVIOUS PICK: ${notes.get(n.shot.id)}` : ""}\n${(cands.get(n.shot.id) ?? []).map((c, i) => `  [${i}] ${describe(c)}`).join("\n")}`)
    .join("\n");
  const { data } = await structured({
    stage,
    model,
    system: [plain(`You are a documentary picture editor choosing B-roll. For each shot pick the candidate that best shows the intent (right subject, right era, believable). Prefer library candidates when they fit about as well as stock. Reject (-1) anything off-topic, anachronistic, text-heavy, or a recognisable actor presented as a real person. ${era ? `The story takes place ${era.min}–${era.max}: reject footage that visibly belongs to another era (e.g. 1920s–1950s clothing, vintage cars, black-and-white newsreel for a 1990s story) unless the shot's era says otherwise.` : ""} A mood shot is fine only if it clearly matches the intent's subject (an office, a trading floor, money, documents) — reject loosely related atmospherics. REAL PEOPLE: if the narration over a shot names or refers to a real person, reject any candidate showing an identifiable person's face (viewers would take them for that person) — prefer buildings, documents, hands, screens, objects. Always reject footage of identifiable public figures, politicians or specific real-world events (ceremonies, speeches) that the narration does not name. Output is ${aspect}.`)],
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
  log?: (s: string) => void;
}

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

  // Phase 1 — local library first.
  const local = new Map<string, Cand[]>();
  for (const n of needs) local.set(n.shot.id, bm.search(n.query, { kind: n.kind, decade: n.decade, limit: 24 }).filter((r) => !tooOld(r.doc, n) && !r.doc.asset.bugSpots?.length).slice(0, 6).map((r) => ({ src: "local" as const, doc: r.doc, score: r.score })));
  log(`  resolver: local candidates for ${[...local.values()].filter((c) => c.length).length}/${needs.length} shots; reranking (${MODELS.haiku})…`);
  const p1 = await pick("resolve.local", needs, local, o.storyboard.aspect, era);
  for (const n of needs) {
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
      stock.set(n.shot.id, found.filter((c) => !usedStock.has(`${c.provider}:${c.externalId}`)).slice(0, 8).map((c) => ({ src: "stock" as const, c, score: 1 })));
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
  const keyOf = (c: Cand) => (c.src === "local" ? c.doc.key : `${c.c.provider}:${c.c.externalId}`);
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
    if (c.src === "local") {
      const a = c.doc.asset;
      const alpha = a.ext === "png";
      const ext = c.doc.kind === "video" ? "mp4" : alpha ? "png" : "jpg";
      const file = `${n.shot.id}_${createHash("sha1").update(c.doc.key).digest("hex").slice(0, 8)}.${ext}`;
      const inS = c.doc.inS + (c.doc.outS && c.doc.outS - c.doc.inS > n.durationS + 1 ? 0.4 : 0);
      await materialize(path.join(o.libraryRoot, a.relPath), c.doc.kind, path.join(mediaDir, file), inS, n.durationS, alpha);
      return { shotId: n.shot.id, role: "primary", origin: "library", ref: c.doc.key, provider: "library", kind: c.doc.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, ...(a.probe?.width ? { width: a.probe.width, height: a.probe.height } : {}), license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: Math.round(c.score * 100) / 100, query: n.query };
    }
    const dl = await downloadCandidate(c.c, dlDir);
    const ext = c.c.kind === "video" ? "mp4" : "jpg";
    const file = `${n.shot.id}_${createHash("sha1").update(`${c.c.provider}:${c.c.externalId}`).digest("hex").slice(0, 8)}.${ext}`;
    await materialize(dl, c.c.kind, path.join(mediaDir, file), 0, n.durationS, false);
    return { shotId: n.shot.id, role: "primary", origin: c.c.archival ? "archival" : "stock", ref: `${c.c.provider}:${c.c.externalId}`, provider: c.c.provider, kind: c.c.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, ...(c.c.width ? { width: c.c.width, height: c.c.height } : {}), license: c.c.license, attributionRequired: c.c.attributionRequired, ...(c.c.attributionText ? { attributionText: c.c.attributionText } : {}), sourceUrl: c.c.pageUrl, aiGenerated: false, score: 1, query: n.query };
  }

  // Overlays, paper for documents, SFX and music — all from the licensed library.
  const addLib = async (shotId: string, role: ResolvedMedia["role"], a: AssetRecord, durationS?: number) => {
    const isAudio = a.kind === "audio";
    const file = `${role}_${shotId}_${a.id}.${isAudio ? "mp3" : a.kind === "video" ? "mp4" : a.ext === "png" ? "png" : "jpg"}`;
    const out = path.join(isAudio ? path.join(o.jobDir, "audio") : mediaDir, file);
    if (isAudio) {
      await mkdir(path.dirname(out), { recursive: true });
      if (!(await exists(out))) await ffmpeg(["-i", path.join(o.libraryRoot, a.relPath), "-c:a", "libmp3lame", "-q:a", "2", out]);
    } else await materialize(path.join(o.libraryRoot, a.relPath), a.kind === "video" ? "video" : "image", out, 0, durationS ?? 5, a.ext === "png");
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
    system: [plain(`You are a documentary researcher. For each rejected shot write two stock-footage search queries (3-6 words, concrete and filmable, ${era ? `set ${era.min}–${era.max}` : "period-appropriate"}) that would illustrate the narration without showing an identifiable person's face when a real person is named. Prefer places, objects, documents, screens, buildings, hands, crowds seen from afar.`)],
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
          await materialize(path.join(o.libraryRoot, a.relPath), c.doc.kind, path.join(mediaDir, file), c.doc.inS, n.durationS, alpha);
          m = { shotId: n.shot.id, role: "primary", origin: "library", ref: c.doc.key, provider: "library", kind: c.doc.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: Math.round(c.score * 100) / 100, query: n.query };
        } else {
          const dl = await downloadCandidate(c.c, dlDir);
          const file = `${n.shot.id}_${createHash("sha1").update(`${c.c.provider}:${c.c.externalId}`).digest("hex").slice(0, 8)}.${c.c.kind === "video" ? "mp4" : "jpg"}`;
          await materialize(dl, c.c.kind, path.join(mediaDir, file), 0, n.durationS, false);
          m = { shotId: n.shot.id, role: "primary", origin: c.c.archival ? "archival" : "stock", ref: `${c.c.provider}:${c.c.externalId}`, provider: c.c.provider, kind: c.c.kind, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: n.durationS, ...(c.c.width ? { width: c.c.width, height: c.c.height } : {}), license: c.c.license, attributionRequired: c.c.attributionRequired, ...(c.c.attributionText ? { attributionText: c.c.attributionText } : {}), sourceUrl: c.c.pageUrl, aiGenerated: false, score: 1, query: n.query };
        }
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
