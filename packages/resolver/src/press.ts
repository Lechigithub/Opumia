import { execFile } from "node:child_process";
import { PLATFORM_FPS } from "@opumia/contracts";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IDLE_RULE, MEANING_RULE, MODELS, plain, SPECIFIC_RULE, structured } from "@opumia/agents";
import * as z from "zod/v4";
import { downloadCandidate, type StockCandidate } from "./stock.js";

/**
 * Fair-use press sourcing: the real people, companies, products and events the narration names.
 *
 * - Wikipedia: the article's lead image (portrait for a person, logo for a company) and its other files that
 *   name the entity (logos, headquarters, products). Free licences are recorded as such; non-free files are
 *   recorded as fair use.
 * - YouTube: news, interview and keynote footage found by name + year. Only short sections (≤ 6.5 s) are
 *   downloaded, audio is never used, and every use is logged (source, channel, in-point, seconds used).
 *
 * Defensibility rules applied here: short clips, muted, one clip per source video per film, never from
 * documentary channels whose edit we would be copying (reference channels and compilations), and every
 * picture is checked by eye (Haiku vision) to really show the named subject before it is offered.
 */

const run = promisify(execFile);
const UA = "Opumia/0.1 (documentary pipeline)";
/** Fair use as the channel practises it (owner, 2026-11-26: "match what the channel does in fair use"), measured on
 *  37 MagnatesMedia films (reference index): real news footage clips median 2.1 s, p90 8.5 s; real footage 4 % of a
 *  film's runtime typically, 17 % at p90, 27 % at most. Several clips from one source, film and TV clips as performed
 *  footage, every use logged. */
export const PRESS_MAX_CLIP_S = 8.5;
export const PRESS_MAX_SHARE = 0.27;

/** Channels whose finished documentaries we never lift footage from (we'd be copying their edit). */
const NO_LIFT = /\b(magnates ?media|how money works|logically answered|modern mba|moon|big company|business casual|company man|cold fusion|coldfusion|wendover|polymatter|johnny harris|vox|bloomberg originals? documentary)\b/i;
/** Scripted dramas, films and trailers: actors playing real people are never documentary footage. */
const DRAMA_CHANNEL = /\b(hulu|netflix|hbo|max|prime video|amazon prime|apple tv|disney|paramount|peacock|showtime|starz|movieclips|rotten tomatoes|ign|fandango|lionsgate|universal pictures|warner bros|sony pictures|a24|searchlight|still watching)\b/i;
const DRAMA_TITLE = /\b(the dropout|scene|trailer|teaser|episode|season \d|s\d+e\d+|official clip|movie clip|film clip|full movie|series|miniseries|starring|cast|behind the scenes|bloopers|recap|ending explained|biopic|portrayed by|played by)\b/i;
const NO_LIFT_TITLE = /\b(documentary|full movie|explained|the rise and fall|rise and fall|downfall|the untold story|untold|compilation|reaction|tiktok|shorts?|#shorts|top \d+|ranking|podcast|video essay|case study|(still )?went bankrupt|what went wrong|what happened to|why .{2,40} (failed|died|collapsed|lost)|how .{2,40} (failed|died|collapsed|lost|killed|destroyed|invented)|the (story|history|fall|death|collapse|tragedy) of)\b/i;

export interface PressCandidate extends StockCandidate {
  /** Local file (already materialised) used for the vision check and the edit. */
  localFile: string;
  /** Frame used for the vision check. */
  frameFile: string;
  depicts: string;
  /** Broadcaster graphics visible (set by the vision check): the clip is cropped before use. */
  banner?: boolean;
  fairUse: { sourceTitle: string; channel?: string; atS?: number; usedS: number; reason: string };
  /** Set when only a preview frame exists yet: downloads the clip itself (called once the candidate is chosen). */
  fetch?: () => Promise<boolean>;
}

const getJson = async <T>(url: string): Promise<T | null> => {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
};
const stripHtml = (s?: string) => (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const exists = async (p: string) => ((await stat(p).catch(() => null))?.size ?? 0) > 0;
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

async function frameOf(src: string, out: string, atS: number) {
  if (await exists(out)) return;
  // No seek for stills (a seek before a JPEG input can yield no frame at all).
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...(atS > 0 ? ["-ss", atS.toFixed(2)] : []), "-i", src, "-frames:v", "1", "-update", "1", "-vf", "scale=512:-2", "-q:v", "4", out], { timeout: 60_000 });
}

// ---------------------------------------------------------------------------------------------------------
// Wikipedia

interface WikiPage { title: string; pageimage?: string; original?: { source: string; width: number; height: number }; images?: Array<{ title: string }> }

export async function wikipediaImages(entity: { name: string; type: string }, dlDir: string, limit = 4): Promise<PressCandidate[]> {
  const s = await getJson<{ query?: { search?: Array<{ title: string }> } }>(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(entity.name)}&srlimit=1&format=json`);
  const title = s?.query?.search?.[0]?.title;
  if (!title) return [];
  const p = await getJson<{ query?: { pages?: Record<string, WikiPage> } }>(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages|images&piprop=original|name&imlimit=60&format=json`);
  const page = Object.values(p?.query?.pages ?? {})[0];
  if (!page) return [];
  const toks = entity.name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2);
  const files = new Set<string>();
  if (page.pageimage) files.add(`File:${page.pageimage}`);
  for (const im of page.images ?? []) {
    const n = im.title.toLowerCase();
    if (!/\.(jpe?g|png|svg|webp)$/.test(n) || /(icon|flag|symbol|commons-logo|wiki|edit-clear|question|padlock|ambox|crystal|nuvola|disambig|portal|stub|map of|locator)/.test(n)) continue;
    if (toks.some((t) => n.includes(t))) files.add(im.title);
  }
  if (!files.size) return [];
  const info = await getJson<{ query?: { pages?: Record<string, { title: string; imageinfo?: Array<{ url: string; thumburl?: string; descriptionurl: string; width: number; height: number; mime: string; extmetadata?: Record<string, { value: string }> }> }> } }>(
    `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent([...files].slice(0, 20).join("|"))}&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1600&format=json`,
  );
  const out: PressCandidate[] = [];
  const lead = page.pageimage ? `File:${page.pageimage}`.toLowerCase().replace(/_/g, " ") : "";
  const pages = Object.values(info?.query?.pages ?? {}).sort((a, b) => (a.title.toLowerCase().replace(/_/g, " ") === lead ? -1 : b.title.toLowerCase().replace(/_/g, " ") === lead ? 1 : a.title.localeCompare(b.title)));
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0];
    if (!ii || ii.width < 200) continue;
    const md = ii.extmetadata ?? {};
    const lic = stripHtml(md.LicenseShortName?.value) || "unknown";
    const nonFree = /fair use|non-free/i.test(lic) || md.NonFree?.value === "true" || !md.LicenseShortName;
    const fileUrl = ii.mime === "image/svg+xml" ? (ii.thumburl ?? ii.url) : ii.width > 2400 ? (ii.thumburl ?? ii.url) : ii.url;
    const isLogo = /logo|wordmark/i.test(pg.title);
    const c: StockCandidate = { provider: "wikipedia", externalId: pg.title, kind: "image", title: `${pg.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, "").replace(/_/g, " ")} (Wikipedia: ${title})`, tags: [entity.name, isLogo ? "logo" : "photo"], pageUrl: ii.descriptionurl, fileUrl, width: ii.width, height: ii.height, license: nonFree ? "Fair use (non-free, via Wikipedia)" : lic, attributionRequired: !nonFree && /BY/.test(lic), attributionText: `${pg.title.replace(/^File:/, "")}${stripHtml(md.Artist?.value) ? ` by ${stripHtml(md.Artist?.value).slice(0, 60)}` : ""}, ${nonFree ? "fair use" : lic}, via Wikipedia`, aiGenerated: false, archival: true };
    try {
      const file = await downloadCandidate(c, dlDir);
      // SVG thumbs come back as PNG; normalise the frame for the vision check.
      const frame = path.join(dlDir, `wf_${sha(pg.title)}.jpg`);
      await frameOf(file, frame, 0).catch(() => {});
      if (!(await exists(frame))) continue;
      out.push({ ...c, localFile: file, frameFile: frame, depicts: `${entity.name} (${isLogo ? "logo" : entity.type})`, fairUse: { sourceTitle: `Wikipedia — ${title}: ${pg.title}`, usedS: 0, reason: nonFree ? "identifying image of the subject discussed (logo/portrait), shown with commentary" : "freely licensed" } });
    } catch {
      /* skip unreadable files */
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// YouTube

interface YtEntry { id: string; title: string; duration?: number; channel?: string; uploader?: string; view_count?: number }

async function ytSearch(query: string, n: number): Promise<YtEntry[]> {
  try {
    const { stdout } = await run("yt-dlp", ["--no-warnings", "--flat-playlist", "-J", `ytsearch${n}:${query}`], { timeout: 45_000, maxBuffer: 16 << 20 });
    return ((JSON.parse(stdout) as { entries?: YtEntry[] }).entries ?? []).filter((e) => e && e.id);
  } catch {
    return [];
  }
}

async function ytSection(id: string, atS: number, lenS: number, out: string): Promise<boolean> {
  if (await exists(out)) return true;
  const tmp = `${out}.part.mp4`;
  try {
    await run("yt-dlp", ["-q", "--no-warnings", "--no-playlist", "-f", "bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]", "--download-sections", `*${atS.toFixed(1)}-${(atS + lenS).toFixed(1)}`, "-o", tmp, `https://www.youtube.com/watch?v=${id}`], { timeout: 120_000 });
    // Normalise: muted, the platform frame rate, H.264, exact length.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-t", lenS.toFixed(2), "-an", "-vf", "scale='min(1920,iw)':-2,fps=" + PLATFORM_FPS + ",format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", out], { timeout: 120_000 });
    return exists(out);
  } catch {
    return false;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Proof film 1 (2026-11-26): Reuters' "Former Wirecard CEO arrested" names Braun's role and company, not his surname, and
 *  was dropped. A person's press may name them, or their role together with another subject of the film. */
const ROLE = /\b(ceo|chief executive|founder|co-?founder|boss|chief operating officer|coo|cfo|chairman|chairwoman|president|executive|director|manager|banker|reporter|journalist|fugitive)\b/i;
/** Wire services and broadcasters first: their reports carry the real places and moments (proof film 1). */
const NEWS = /\b(reuters|bloomberg(?! originals)|associated press|\bap\b|afp|agence france|dw news|deutsche welle|cnbc|bbc news|sky news|euronews|al jazeera|financial times|wall street journal|cnn|abc news|nbc news|cbs news|tagesschau|zdf|ard|welt|spiegel|die zeit|zeit online|handelsblatt|faz)\b/i;
const PARODY = /\b(risitas|parody|meme|satire|satirical|reaction|reacts|funny|comedy|prank|ai voice)\b/i;
const PRIMARY = /\b(interview|interviewed|speech|keynote|conference|panel|statement|press conference|testimony|testifies|trial|court|hearing|agm|annual general meeting|shareholder meeting|investor day|earnings call|dld\d*|summit|forum|q&a|im interview|rede|pressekonferenz|prozess|hauptversammlung|vor gericht)\b/i;
const newsFirst = <T extends { channel?: string; uploader?: string }>(xs: T[]) => [...xs].sort((a, b) => Number(NEWS.test(`${b.channel ?? ""} ${b.uploader ?? ""}`)) - Number(NEWS.test(`${a.channel ?? ""} ${a.uploader ?? ""}`)));
const namesAll = (title: string, name: string) => {
  const toks = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !["the", "inc", "corp", "company", "and"].includes(t));
  const key = toks.at(-1);
  return Boolean(key && new RegExp(`\\b${key}`, "i").test(title));
};
/** Whether a search hit may be press of the entity (no essay, documentary, drama or reference channel; the title names
 *  it — or, for a person, names their role and another subject of the film; a namesake must name another subject). */
export function pressTitleOk(e: { title: string; channel?: string; uploader?: string; duration?: number }, entity: { name: string; type: string }, world: string[]): boolean {
  const ch = `${e.channel ?? ""} ${e.uploader ?? ""}`;
  if (NO_LIFT.test(ch) || NO_LIFT_TITLE.test(e.title)) return false;
  // A title crediting two or more performers ("| Amanda Seyfried, Laurie Metcalf") is a drama clip.
  if (DRAMA_CHANNEL.test(ch) || DRAMA_TITLE.test(e.title) || /[|–-]\s*[A-Z][a-z]+ [A-Z][a-z]+,\s*[A-Z][a-z]+ [A-Z][a-z]+/.test(e.title)) return false;
  if (!e.duration || e.duration < 25 || e.duration > 2400) return false;
  if (PARODY.test(e.title)) return false;
  // Outside the broadcasters, only primary footage: the person's own interview, speech, conference, statement, trial —
  // never a channel retelling the story (proof film 1's probe: "Hollow Money", "ExhibitCapital" passed the old filter).
  if (!NEWS.test(ch) && !PRIMARY.test(e.title)) return false;
  const byRole = entity.type === "person" && ROLE.test(e.title) && world.some((w) => namesAll(e.title, w));
  if (!namesAll(e.title, entity.name) && !byRole) return false;
  if (entity.type === "person" && world.length && !world.some((w) => namesAll(`${e.title} ${ch}`, w))) return false;
  return true;
}
export const isNewsChannel = (ch: string) => NEWS.test(ch);

/**
 * Up to `perVideo` short sections from each of the top `videos` press videos naming the entity.
 * Sections sit away from the intro/outro (where anchors and logos live).
 */
export async function youtubePress(o: { entity: { name: string; type: string; year?: number }; context?: string; dlDir: string; usedVideos: Set<string>; videos?: number; perVideo?: number; clipS: number; world?: string[] }): Promise<PressCandidate[]> {
  const world = (o.world ?? []).filter((w) => w.toLowerCase() !== o.entity.name.toLowerCase());
  const year = o.entity.year ? ` ${o.entity.year}` : "";
  const anchor = o.entity.type === "person" && world[0] ? ` ${world[0]}` : "";
  const queries = [`${o.entity.name}${anchor}${year} news`, `${o.entity.name}${anchor} ${o.context ?? "interview"}`.trim()];
  const seen = new Set<string>();
  const hits: YtEntry[] = [];
  for (const q of queries) {
    for (const e of await ytSearch(q, 8)) {
      if (seen.has(e.id) || o.usedVideos.has(e.id)) continue;
      seen.add(e.id);
      const ch = `${e.channel ?? ""} ${e.uploader ?? ""}`;
      if (!pressTitleOk(e, o.entity, world)) continue;
      hits.push(e);
    }
    if (hits.length >= (o.videos ?? 2)) break;
  }
  const len = Math.min(PRESS_MAX_CLIP_S, Math.max(2.5, o.clipS + 0.6));
  // Where in each report the subject is actually on screen, found on the video's own thumbnail strip (a report's
  // 32 % and 58 % points were often its anchor at a desk — proof film 1 found 1 of 7); fixed points only as a fallback.
  const must = o.entity.type === "person" ? `${o.entity.name} himself or herself on camera: speaking, on a stage, arriving, being interviewed` : `${o.entity.name}: the real place, building, logo, product or event itself`;
  const picked = newsFirst(hits).slice(0, o.videos ?? 3);
  const jobs = (await Promise.all(picked.map(async (e) => {
    const d = e.duration!;
    const info = await ytInfo(e.id).catch(() => null);
    const seen = info ? await ytMoments(info, must, o.dlDir, o.entity.type === "person" ? o.entity.name : undefined).catch(() => []) : [];
    const spots = seen.length ? seen.map((t) => Math.max(2, Math.min(d - len - 2, t - len / 3))) : [0.32, 0.58].map((f) => Math.max(8, Math.min(d - len - 8, d * f)));
    return spots.slice(0, o.perVideo ?? 2).map((at) => ({ e, at }));
  }))).flat();
  await mkdir(o.dlDir, { recursive: true });
  const res = await Promise.all(
    jobs.map(async ({ e, at }) => {
      const file = path.join(o.dlDir, `yt_${e.id}_${Math.round(at)}.mp4`);
      if (!(await ytSection(e.id, at, len, file))) return null;
      const frame = path.join(o.dlDir, `yt_${e.id}_${Math.round(at)}.jpg`);
      await frameOf(file, frame, Math.min(1.5, len / 2)).catch(() => {});
      if (!(await exists(frame))) return null;
      const c: PressCandidate = {
        provider: "youtube",
        externalId: `${e.id}@${Math.round(at)}`,
        kind: "video",
        title: `${e.title} — ${e.channel ?? e.uploader ?? "YouTube"}`,
        tags: [o.entity.name, "press", "news"],
        pageUrl: `https://www.youtube.com/watch?v=${e.id}&t=${Math.round(at)}s`,
        fileUrl: null,
        durationS: len,
        license: "Fair use (press footage, muted excerpt)",
        attributionRequired: true,
        attributionText: `${e.channel ?? e.uploader ?? "YouTube"} — "${e.title.slice(0, 80)}"`,
        aiGenerated: false,
        archival: true,
        localFile: file,
        frameFile: frame,
        depicts: `${o.entity.name} (${o.entity.type})`,
        fairUse: { sourceTitle: e.title, ...(e.channel ? { channel: e.channel } : {}), atS: Math.round(at), usedS: len, reason: "short muted excerpt of press coverage of the subject, reframed and graded under commentary" },
      };
      return c;
    }),
  );
  return res.filter((x): x is PressCandidate => x !== null);
}

// ---------------------------------------------------------------------------------------------------------
// Real stills of a named person from press video (interviews, news, talks): for a thumbnail's expression.
// Frames are grabbed straight from the stream at a few moments — no clip is downloaded. The same filters as press
// footage apply: the title names the person, a namesake must also name another subject of the film, and no
// documentary/essay channel, drama, trailer or reference channel is ever used.

export interface PressStill { id: string; file: string; videoId: string; atS: number; title: string; channel: string; url: string }

export async function youtubeStills(o: { name: string; world: string[]; dlDir: string; videos?: number; frames?: number; queries?: string[] }): Promise<PressStill[]> {
  const world = o.world.filter((w) => w.toLowerCase() !== o.name.toLowerCase());
  const queries = o.queries?.length ? o.queries : [`${o.name} interview`, `${o.name} news`, `${o.name} speech`];
  const seen = new Set<string>();
  const hits: YtEntry[] = [];
  for (const q of queries) {
    for (const e of await ytSearch(q, 8)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const ch = `${e.channel ?? ""} ${e.uploader ?? ""}`;
      if (NO_LIFT.test(ch) || NO_LIFT_TITLE.test(e.title) || DRAMA_CHANNEL.test(ch) || DRAMA_TITLE.test(e.title)) continue;
      if (!e.duration || e.duration < 30 || e.duration > 5400) continue;
      if (!namesAll(e.title, o.name)) continue;
      if (world.length && !world.some((w) => namesAll(`${e.title} ${ch}`, w)) && o.name.split(/\s+/).length < 2) continue;
      hits.push(e);
    }
    if (hits.length >= (o.videos ?? 3)) break;
  }
  await mkdir(o.dlDir, { recursive: true });
  const n = o.frames ?? 8;
  const out = await Promise.all(
    hits.slice(0, o.videos ?? 3).map(async (e) => {
      let stream: string | null = null;
      try {
        const { stdout } = await run("yt-dlp", ["--no-warnings", "--no-playlist", "-g", "-f", "bv*[height<=1080][ext=mp4]/bv*[height<=1080]/b[height<=1080]", `https://www.youtube.com/watch?v=${e.id}`], { timeout: 60_000 });
        stream = stdout.trim().split("\n")[0] ?? null;
      } catch {
        return [];
      }
      if (!stream) return [];
      const d = e.duration!;
      const times = Array.from({ length: n }, (_, k) => Math.round(Math.max(6, Math.min(d - 6, d * (0.08 + (0.84 * k) / Math.max(1, n - 1)))) * 10) / 10);
      const frames: PressStill[] = [];
      for (const t of times) {
        const file = path.join(o.dlDir, `ys_${e.id}_${Math.round(t * 10)}.jpg`);
        if (!(await exists(file))) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(1), "-i", stream, "-frames:v", "1", "-update", "1", "-q:v", "2", file], { timeout: 45_000 }).catch(() => {});
        if (await exists(file)) frames.push({ id: `${e.id}@${t}`, file, videoId: e.id, atS: t, title: e.title, channel: e.channel ?? e.uploader ?? "YouTube", url: `https://www.youtube.com/watch?v=${e.id}&t=${Math.round(t)}s` });
      }
      return frames;
    }),
  );
  return out.flat();
}

// ---------------------------------------------------------------------------------------------------------
// YouTube by what a line describes: real footage of the film's named subjects, found by description. Only a
// preview frame is fetched per moment; the ≤ 6.5 s clip is downloaded once the candidate has been chosen.

interface YtInfo { id: string; title: string; channel: string; duration: number; stream: string | null; captions: Array<{ t: number; text: string }>; sheets: Array<{ url: string; startS: number; durS: number; cells: number; cols: number; rows: number }> }
const ytInfoCache = new Map<string, Promise<YtInfo | null>>();

function ytInfo(id: string): Promise<YtInfo | null> {
  if (!ytInfoCache.has(id))
    ytInfoCache.set(
      id,
      (async () => {
        try {
          const { stdout } = await run("yt-dlp", ["--no-warnings", "--no-playlist", "-J", "-f", "bv*[height<=480][protocol=https]/bv*[height<=480]/b[height<=480]", `https://www.youtube.com/watch?v=${id}`], { timeout: 60_000, maxBuffer: 64 << 20 });
          const j = JSON.parse(stdout) as { title?: string; channel?: string; uploader?: string; duration?: number; url?: string; requested_formats?: Array<{ url?: string }>; formats?: Array<{ format_id?: string; width?: number; rows?: number; columns?: number; fragments?: Array<{ url?: string; duration?: number }> }>; automatic_captions?: Record<string, Array<{ ext: string; url: string }>>; subtitles?: Record<string, Array<{ ext: string; url: string }>> };
          const capUrl = [j.subtitles?.en, j.subtitles?.["en-US"], j.automatic_captions?.en, j.automatic_captions?.["en-orig"]].flatMap((x) => x ?? []).find((x) => x.ext === "json3")?.url;
          let captions: YtInfo["captions"] = [];
          if (capUrl) {
            const c = await getJson<{ events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> }>(capUrl);
            captions = (c?.events ?? []).map((e) => ({ t: (e.tStartMs ?? 0) / 1000, text: (e.segs ?? []).map((x) => x.utf8 ?? "").join("").trim() })).filter((e) => e.text);
          }
          // The video's own thumbnail strip (storyboard): the whole film at a glance, a few small sheets.
          const sb = (j.formats ?? []).filter((f) => /^sb\d/.test(f.format_id ?? "") && f.fragments?.length && f.rows && f.columns).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
          const sheets: YtInfo["sheets"] = [];
          let t0 = 0;
          for (const fr of sb?.fragments ?? []) {
            if (fr.url) sheets.push({ url: fr.url, startS: t0, durS: fr.duration ?? 0, cells: sb!.rows! * sb!.columns!, cols: sb!.columns!, rows: sb!.rows! });
            t0 += fr.duration ?? 0;
          }
          return { id, title: j.title ?? "", channel: j.channel ?? j.uploader ?? "YouTube", duration: j.duration ?? 0, stream: j.url ?? j.requested_formats?.[0]?.url ?? null, captions, sheets };
        } catch {
          return null;
        }
      })(),
    );
  return ytInfoCache.get(id)!;
}

const keyTokens = (t: string) => [...new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 4 && !/^(their|there|which|would|could|about|after|before|because|every|other|these|those|being|where|while|first|still|never)$/.test(w)))];

/** The moment the video's own narration talks about the same thing (its b-roll there is the likeliest match). */
function captionMoment(info: YtInfo, words: string[]): number | null {
  if (!info.captions.length || !words.length) return null;
  let best = { t: -1, hits: 1 };
  for (let i = 0; i < info.captions.length; i++) {
    const t0 = info.captions[i]!.t;
    let text = "";
    for (let k = i; k < info.captions.length && info.captions[k]!.t < t0 + 9; k++) text += ` ${info.captions[k]!.text.toLowerCase()}`;
    const hits = words.filter((w) => text.includes(w)).length;
    if (hits > best.hits) best = { t: t0, hits };
  }
  return best.t >= 0 ? best.t + 1 : null;
}

/**
 * The spoken words of a YouTube video (its captions) as text — for the researcher: an interview or a talk is
 * often the primary source of a quotation. Nothing is downloaded but the caption track.
 */
export async function youtubeTranscript(url: string): Promise<{ title: string; channel: string; text: string } | null> {
  const id = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{11})/.exec(url)?.[1];
  if (!id) return null;
  const info = await ytInfo(id);
  if (!info || !info.captions.length) return null;
  // Auto-captions repeat lines as they scroll: keep each new run of words once.
  const out: string[] = [];
  for (const c of info.captions) {
    const t = c.text.replace(/\s+/g, " ").trim();
    if (t && t !== out.at(-1) && !out.at(-1)?.endsWith(t)) out.push(t);
  }
  const text = out.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 200 ? { title: info.title, channel: info.channel, text } : null;
}

const Moments = z.object({ picks: z.array(z.object({ sheet: z.number(), cell: z.number(), what: z.string() })) });

/**
 * H31: where in a whole Internet Archive film the wanted picture is. Up to 16 of the item's own thumbnails (about
 * one a minute), tiled in time order into one sheet; the model names the cell that shows the picture, or none.
 * Returns the second to take the clip from and that thumbnail as the preview, or null.
 */
export async function archiveMoment(c: { externalId: string; moments?: Array<{ atS: number; url: string }> }, must: string, dlDir: string): Promise<{ atS: number; thumbUrl: string } | null> {
  const ms = c.moments ?? [];
  if (!ms.length) return null;
  const pick = ms.length <= 16 ? ms : Array.from({ length: 16 }, (_, k) => ms[Math.round((k * (ms.length - 1)) / 15)]!);
  await mkdir(dlDir, { recursive: true });
  const key = createHash("sha1").update(c.externalId).digest("hex").slice(0, 12);
  const files: string[] = [];
  for (const [k, m] of pick.entries()) {
    const f = path.join(dlDir, `iam_${key}_${k}.jpg`);
    if (!(await exists(f))) {
      const r = await fetch(m.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!r?.ok) continue;
      await writeFile(f, Buffer.from(await r.arrayBuffer()));
    }
    files.push(f);
  }
  if (files.length < 2) return null;
  const cols = 4, rows = Math.ceil(files.length / cols);
  const sheet = path.join(dlDir, `iam_${key}_sheet.jpg`);
  if (!(await exists(sheet))) {
    const inputs = files.flatMap((f) => ["-i", f]);
    const scale = files.map((_, k) => `[${k}]scale=240:180:force_original_aspect_ratio=decrease,pad=240:180:(ow-iw)/2:(oh-ih)/2[s${k}]`).join(";");
    const layout = files.map((_, k) => `${(k % cols) * 240}_${Math.floor(k / cols) * 180}`).join("|");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `${scale};${files.map((_, k) => `[s${k}]`).join("")}xstack=inputs=${files.length}:layout=${layout}:fill=black`, "-frames:v", "1", "-q:v", "4", sheet], { timeout: 60_000 }).catch(() => null);
  }
  if (!(await exists(sheet))) return null;
  const res = await structured({
    stage: "resolve.moments",
    model: MODELS.haiku,
    system: [plain("The image is a grid of frames from one old film, in time order, numbered from 0 left-to-right then top-to-bottom. Pick up to 2 cells that clearly show the wanted picture. Never a title card, text, credits, a black or blank frame. If no cell shows it, return no picks.")],
    user: [{ type: "text" as const, text: `Wanted picture: ${must}\n${cols} columns × ${rows} rows, ${files.length} cells` }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: (await readFile(sheet)).toString("base64") } }],
    schema: Moments,
    effort: "low",
    maxTokens: 400,
  }).catch(() => null);
  const cell = res?.data.picks.find((p) => p.cell >= 0 && p.cell < files.length)?.cell;
  if (cell === undefined) return null;
  const m = pick[cell]!;
  return { atS: m.atS, thumbUrl: m.url };
}

/** Where in the video the wanted picture is: the model looks at the video's thumbnail strip and names the cells. */
async function ytMoments(info: YtInfo, must: string, dlDir: string, subject?: string): Promise<number[]> {
  if (!info.sheets.length) return [];
  const n = info.sheets.length;
  const idx = n <= 4 ? info.sheets.map((_, i) => i) : [0, 1, 2, 3].map((k) => Math.round((k * (n - 1)) / 3));
  const got = (
    await Promise.all(
      [...new Set(idx)].map(async (i) => {
        const sh = info.sheets[i]!;
        const file = path.join(dlDir, `ytsb_${info.id}_${i}.jpg`);
        try {
          if (!(await exists(file))) {
            const r = await fetch(sh.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
            if (!r.ok) return null;
            const tmp = `${file}.raw`;
            await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
            await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-frames:v", "1", "-update", "1", "-q:v", "4", file], { timeout: 30_000 }).finally(() => unlink(tmp).catch(() => {}));
          }
          return { sh, data: (await readFile(file)).toString("base64") };
        } catch {
          return null;
        }
      }),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);
  if (!got.length) return [];
  const res = await structured({
    stage: "resolve.moments",
    model: MODELS.haiku,
    system: [plain(subject
      ? `Each image is a grid of small frames from one video, in time order, numbered from 0 left-to-right then top-to-bottom. Pick up to 3 cells that clearly show ${subject} themself — speaking, on a stage, at a press conference, arriving, being interviewed. Never a news anchor or presenter in a studio, a reporter, someone else, a title card, text or graphics. If no cell shows them, return no picks.`
      : "Each image is a grid of small frames from one video, in time order, numbered from 0 left-to-right then top-to-bottom. Pick up to 3 cells that clearly show the wanted picture. Never a talking head, an interview, a presenter, a title card, text or graphics. If no cell shows it, return no picks.")],
    user: [{ type: "text" as const, text: `Wanted picture: ${must}` }, ...got.flatMap((g, k) => [{ type: "text" as const, text: `[sheet ${k}] ${g.sh.cols} columns × ${g.sh.rows} rows` }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: g.data } }])],
    schema: Moments,
    effort: "low",
    maxTokens: 600,
  }).catch(() => null);
  return (res?.data.picks ?? []).flatMap((p) => {
    const g = got[p.sheet];
    return g && p.cell >= 0 && p.cell < g.sh.cells ? [g.sh.startS + ((p.cell + 0.5) * g.sh.durS) / g.sh.cells] : [];
  }).slice(0, 3);
}

/**
 * Real footage found by description. `subjects` are the film's named people/companies/products: a video is
 * only considered when its title names one of them, so every excerpt is coverage of what the film discusses.
 */
export async function youtubeFootage(o: { query: string; about: string; must?: string; subjects: string[]; people?: string[]; dlDir: string; clipS: number; videos?: number; /** film/TV scenes as performed footage (the channel: The Wolf of Wall Street in its Jho Low film) — never press of a real person */ film?: boolean }): Promise<PressCandidate[]> {
  const person = (o.people ?? []).find((p) => namesAll(`${o.must ?? ""} ${o.query}`, p));
  const hits = newsFirst(await ytSearch(o.query, 8))
    .filter((e) => {
      const ch = `${e.channel ?? ""} ${e.uploader ?? ""}`;
      if (o.film) {
        // a film or TV scene: from the studio or a clip channel, never another documentary, essay or parody
        if (NO_LIFT.test(ch) || PARODY.test(e.title) || /\b(documentary|explained|essay|reaction|review|recap|ending explained|trailer)\b/i.test(e.title)) return false;
        if (!(DRAMA_CHANNEL.test(ch) || /\b(movie|film|scene|clip)\b/i.test(e.title))) return false;
        return Boolean(e.duration && e.duration >= 20 && e.duration <= 1200);
      }
      if (NO_LIFT.test(ch) || NO_LIFT_TITLE.test(e.title) || DRAMA_CHANNEL.test(ch) || DRAMA_TITLE.test(e.title)) return false;
      if (/[|–-]\s*[A-Z][a-z]+ [A-Z][a-z]+,\s*[A-Z][a-z]+ [A-Z][a-z]+/.test(e.title)) return false;
      if (!e.duration || e.duration < 25 || e.duration > 3600) return false;
      if (PARODY.test(e.title) || (!NEWS.test(ch) && !PRIMARY.test(e.title))) return false;
      return o.subjects.some((sub) => namesAll(e.title, sub));
    })
    .slice(0, o.videos ?? 2);
  const len = Math.min(PRESS_MAX_CLIP_S, Math.max(2.5, o.clipS + 0.6));
  const words = keyTokens(o.about);
  await mkdir(o.dlDir, { recursive: true });
  const out: PressCandidate[] = [];
  await Promise.all(
    hits.map(async (e) => {
      const info = await ytInfo(e.id);
      if (!info?.stream) return;
      const d = info.duration || e.duration!;
      const cm = captionMoment(info, words);
      const seenAt = o.must ? await ytMoments(info, o.must, o.dlDir, person).catch(() => []) : [];
      // Moments seen in the thumbnail strip first (the clip starts a little before them), then where the video's
      // own narration talks about it, then two spread moments.
      const spots = [...new Set([...seenAt.map((t) => t - Math.min(1, len / 3)), ...(cm !== null ? [cm] : []), ...(seenAt.length >= 2 ? [] : [d * 0.3, d * 0.62])].map((t) => Math.round(Math.max(2, Math.min(d - len - 2, t)))))].slice(0, 4);
      await Promise.all(
        spots.map(async (at) => {
          const frame = path.join(o.dlDir, `ytf_${e.id}_${at}.jpg`);
          if (!(await exists(frame))) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", (at + Math.min(1.5, len / 2)).toFixed(1), "-i", info.stream!, "-frames:v", "1", "-update", "1", "-vf", "scale=512:-2", "-q:v", "4", frame], { timeout: 40_000 }).catch(() => {});
          if (!(await exists(frame))) return;
          const file = path.join(o.dlDir, `yt_${e.id}_${at}.mp4`);
          out.push({
            provider: "youtube",
            externalId: `${e.id}@${at}`,
            kind: "video",
            title: `${info.title} — ${info.channel}`,
            tags: o.film ? ["film clip", "performed"] : ["press", "footage"],
            pageUrl: `https://www.youtube.com/watch?v=${e.id}&t=${at}s`,
            fileUrl: null,
            durationS: len,
            license: o.film ? "Fair use (film/TV scene, short excerpt as metaphor under commentary)" : "Fair use (press footage, muted excerpt)",
            attributionRequired: true,
            attributionText: `${info.channel} — "${info.title.slice(0, 80)}"`,
            aiGenerated: false,
            archival: true,
            localFile: file,
            frameFile: frame,
            depicts: o.film ? "performed film scene (actors — never the real person)" : "",
            fairUse: { sourceTitle: info.title, channel: info.channel, atS: at, usedS: len, reason: o.film ? "short excerpt of a film or TV scene, used as metaphor under commentary, graded and reframed" : "short muted excerpt of coverage of the subject, reframed and graded under commentary" },
            fetch: () => ytSection(e.id, at, len, file),
          });
        }),
      );
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Vision check: does the picture really show the subject the line is about?

const VisionPick = z.object({ verdicts: z.array(z.object({ index: z.number(), shows: z.boolean().describe("true only if the picture clearly shows the named subject (the person, the company's logo/building/product, the event)"), banner: z.boolean().describe("true if broadcaster graphics (lower-third banner, ticker, channel bug, burned-in captions) are visible"), quality: z.number().describe("0–10 as a documentary shot: sharp, well-framed, no burned-in lower thirds/tickers covering the subject"), note: z.string() })) });

export async function visionCheck(items: Array<{ frameFile: string; depicts: string; line: string }>): Promise<Array<{ shows: boolean; quality: number; note: string; banner?: boolean }>> {
  if (!items.length) return [];
  const blocks = (
    await Promise.all(
      items.map(async (it, i) => [
        { type: "text" as const, text: `[${i}] must show: ${it.depicts}. Narration over it: "${it.line.slice(0, 200)}"` },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: (await readFile(it.frameFile)).toString("base64") } },
      ]),
    )
  ).flat();
  const { data } = await structured({
    stage: "resolve.press",
    model: MODELS.haiku,
    system: [plain("You are a documentary picture researcher checking candidate frames. For each, say whether it clearly shows the named subject (a recognisable person's face or figure when a person is named; the company's real logo, building, store, product or staff when a company is named; the actual event when an event is named) and rate it as a shot. A news anchor in a studio, a title card, a thumbnail collage, a talking head of someone else, or a frame mostly covered by tickers and lower thirds does NOT show the subject. A scripted drama, film scene, re-enactment or anything that looks cinematically lit and staged with actors does NOT show a real person — answer shows=false for it even if the title names them.")],
    user: blocks,
    schema: VisionPick,
    effort: "low",
    maxTokens: 3000,
  });
  return items.map((_, i) => {
    const v = data.verdicts.find((x) => x.index === i);
    return v ? { shows: v.shows, quality: v.quality, note: v.note, banner: v.banner } : { shows: false, quality: 0, note: "no verdict" };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Review of EVERY picked picture (library, stock, archive): the editor's eye before anything reaches a scene.

const Review = z.object({
  verdicts: z.array(
    z.object({
      index: z.number(),
      fit: z.number().describe("0–10: how well this picture carries the MEANING of the line and intent — its idea, not its nouns (10 = says exactly what the line means; 5 = same general world, or only a noun matches; 2 = unrelated)"),
      idle: z.boolean().describe("stock people doing nothing in particular (see the rule)"),
      specific: z.boolean().describe("a picture of THIS story (see the rule)"),
      face: z.boolean().describe("true if a person's face is visible clearly enough that a viewer could take them for someone the narration names — close-ups, medium shots, a speaker at a podium all count; silhouettes, backs, hands or a distant crowd do not (proof film 1: a podium speaker was marked false under a line naming Wirecard's CEO)"),
      banner: z.boolean().describe("true if burned-in text, captions, watermarks, title cards or broadcaster graphics are visible"),
      wrongEra: z.boolean().describe("true if clothing, cars, devices or film stock clearly belong to a different period than stated"),
      synthetic: z.boolean().describe("true if the picture looks AI-generated, a 3D render, an illustration or an animation rather than a photograph or filmed footage"),
      shows: z.string().describe("5–10 words: what the picture literally shows"),
    }),
  ),
});
/** Build list 5, item 16–17: `fit` is rated by meaning; `idle` (stock people doing nothing in particular) and `specific`
 * (a picture of this story) use the same rules the reference was labelled with (agents/picture-measure.ts). */
export interface PictureReview { fit: number; face: boolean; banner: boolean; wrongEra: boolean; synthetic: boolean; shows: string; idle: boolean; specific: boolean }

export async function reviewPictures(items: Array<{ frameFile: string; intent: string; line: string; era: string }>): Promise<PictureReview[]> {
  const out: PictureReview[] = [];
  for (let i = 0; i < items.length; i += 12) {
    const part = items.slice(i, i + 12);
    const blocks = (
      await Promise.all(
        part.map(async (it, k) => [
          { type: "text" as const, text: `[${k}] intent: ${it.intent.slice(0, 160)} | narration: "${it.line.slice(0, 200)}" | story period: ${it.era}` },
          { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: (await readFile(it.frameFile)).toString("base64") } },
        ]),
      )
    ).flat();
    const res = await structured({
      stage: "resolve.review",
      model: MODELS.haiku,
      system: [plain(`You are a strict documentary picture editor reviewing the frame chosen for each shot. Judge only what is visible.\n${MEANING_RULE}\n${IDLE_RULE} An idle picture's fit is at most 5 unless the line itself is about such a moment.\n${SPECIFIC_RULE}\n` + "A generic stand-in (a random person, an unrelated office, a different country, a different industry) is a poor fit even if it matches a keyword. Be accurate about faces: face=true whenever a person's face is visible enough that a viewer could take them for someone the line names (a speaker at a podium, a medium shot of a businessman); false for silhouettes, backs, hands and distant crowds. When the intent asks for a specific named thing (that company's factory, that product, that document) and the picture shows only a generic one of its kind, fit is at most 5. wrongEra=true only when something clearly LATER than the story period is visible (a calendar dated after it, a smartphone or flat screen in a 1970s scene); older or timeless things are not a wrong era. Legible text that names a different company, person, product or subject than the line (a document, sign or screen about something else) is misleading: fit at most 3. Be alert to AI-generated imagery (too-perfect, hyper-detailed, impossible objects, melted details): synthetic=true. A title card, name slate, presenter graphic, subscribe button, watermark or burned-in caption means banner=true and fit at most 3.")],
      user: blocks,
      schema: Review,
      effort: "low",
      maxTokens: 3000,
    }).catch(() => null);
    for (let k = 0; k < part.length; k++) {
      const v = res?.data.verdicts.find((x) => x.index === k);
      out.push(v ? { fit: v.fit, face: v.face, banner: v.banner, wrongEra: v.wrongEra, synthetic: v.synthetic, shows: v.shows, idle: v.idle, specific: v.specific } : { fit: 5, face: false, banner: false, wrongEra: false, synthetic: false, shows: "not reviewed", idle: false, specific: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Period check: a dedicated look at what dates a picture. The general picture review above asks about period
// as one of five things and misses it too often (a headset, a tablet or a glass office under a 1975 line);
// this asks only that, of a stronger model.

const Period = z.object({ frames: z.array(z.object({ index: z.number(), earliestYear: z.number().describe("the earliest year this scene could have been filmed as it looks; 1900 if nothing in it dates it"), evidence: z.string().describe("the things that date it, in a few words; empty if nothing does") })) });

/** The year a line is set in, from a phrase like "1975", "1970s" or "mid-1990s" (a decade counts to its end). Null when unknown. */
export function yearOf(when: string | undefined): number | null {
  const m = /(1[89]\d\d|20\d\d)(s)?/.exec(when ?? "");
  return m ? Number(m[1]) + (m[2] ? 9 : 0) : null;
}

/**
 * For each frame: the earliest year the scene could have been filmed, and whether that fits the line's year
 * (three years of tolerance). Sonnet vision, eight frames a call. A frame that cannot be judged passes.
 */
export async function periodCheck(items: Array<{ frameFile: string; year: number }>): Promise<Array<{ ok: boolean; earliestYear: number; evidence: string }>> {
  const out = items.map(() => ({ ok: true, earliestYear: 1900, evidence: "" }));
  const parts: number[][] = [];
  for (let i = 0; i < items.length; i += 8) parts.push(items.slice(i, i + 8).map((_, k) => i + k));
  await Promise.all(
    parts.map(async (idx) => {
      const blocks = (
        await Promise.all(
          idx.map(async (g, k) => {
            const data = await readFile(items[g]!.frameFile).then((b) => b.toString("base64"), () => null);
            return data ? [{ type: "text" as const, text: `[${k}]` }, { type: "image" as const, source: { type: "base64" as const, media_type: (/\.png$/i.test(items[g]!.frameFile) ? "image/png" : "image/jpeg") as "image/png" | "image/jpeg", data } }] : [];
          }),
        )
      ).flat();
      if (!blocks.length) return;
      const res = await structured({
        stage: "resolve.period",
        model: MODELS.sonnet,
        system: [plain("You date pictures for a documentary editor. For each numbered frame, look for what dates the scene: phones, tablets, laptops, flat screens, headsets and earbuds, LED lighting, cars, clothing and hairstyles, office furniture and architecture (glass-walled open offices), signage, packaging, the look of the image itself. Give the earliest year the scene could have been filmed as it looks. Be concrete and unsentimental: a smartphone means 2007 or later, a tablet 2010, a flat monitor about 2002, wireless earbuds 2016, a modern open office about 2005. A close-up with nothing datable (hands, paper, an old object alone, a landscape) is 1900. Ignore designed text or graphics laid over the picture; date what was filmed.")],
        user: blocks,
        schema: Period,
        effort: "low",
        maxTokens: 1200,
      }).catch(() => null);
      for (const f of res?.data.frames ?? []) {
        const g = idx[f.index];
        if (g === undefined) continue;
        out[g] = { ok: f.earliestYear <= items[g]!.year + 3, earliestYear: f.earliestYear, evidence: f.evidence };
      }
    }),
  );
  return out;
}

/** One frame of a local picture or clip for review. */
export async function reviewFrame(src: string, out: string, atS = 0): Promise<boolean> {
  await frameOf(src, out, atS).catch(() => {});
  return exists(out);
}

// ---------------------------------------------------------------------------------------------------------
// Real article screenshots: the cited source itself on screen (headless Chromium, the same one Remotion uses).

/** One shared headless browser (the Chromium Remotion already uses), opened on first use. */
interface CdpPage { setViewport(v: { width: number; height: number; deviceScaleFactor: number }): Promise<void>; goto(o: { url: string; timeout: number }): Promise<unknown>; _client(): { send(m: string, p?: unknown): Promise<{ value: { data: string } }> }; close(): Promise<void> }
let browserP: Promise<{ newPage(o: unknown): Promise<CdpPage>; close(o: { silent: boolean }): Promise<void> }> | null = null;
let pageSeq = 0;
async function browser() {
  if (!browserP) {
    browserP = import("@remotion/renderer").then((r) => r.openBrowser("chrome") as never);
    process.once("beforeExit", () => void browserP?.then((b) => b.close({ silent: true })).catch(() => {}));
  }
  return browserP;
}
export async function closeBrowser(): Promise<void> {
  const b = browserP;
  browserP = null;
  await b?.then((x) => x.close({ silent: true })).catch(() => {});
}

/** Screenshot the top of a web page (1280×900) as JPEG. Returns false when the page cannot be captured. */
/**
 * A page's readable text through the real browser (JavaScript runs, so pages that refuse a plain request or
 * build their text on load can still be read). Nothing is clicked or accepted. Null when it cannot be read.
 */
export async function pageTextViaBrowser(url: string, maxChars = 80_000): Promise<string | null> {
  if (!/^https?:\/\//.test(url) || /youtube\.com|youtu\.be|\.pdf($|\?)/i.test(url)) return null;
  let page: CdpPage | null = null;
  try {
    const b = await browser();
    page = await b.newPage({ context: () => null, logLevel: "error", indent: false, pageIndex: 900 + pageSeq++, onBrowserLog: null, onLog: () => {} });
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await Promise.race([page.goto({ url, timeout: 25_000 }).catch(() => null), new Promise((r) => setTimeout(r, 26_000))]);
    await new Promise((r) => setTimeout(r, 2000));
    const res = (await page._client().send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true })) as unknown as { value?: { result?: { value?: string } } };
    const text = (res.value?.result?.value ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    return text.length > 600 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

export async function screenshotPage(url: string, outJpg: string): Promise<boolean> {
  if (await exists(outJpg)) return true;
  if (!/^https?:\/\//.test(url) || /youtube\.com|youtu\.be|\.pdf($|\?)/i.test(url)) return false;
  await mkdir(path.dirname(outJpg), { recursive: true });
  let page: CdpPage | null = null;
  try {
    const b = await browser();
    page = await b.newPage({ context: () => null, logLevel: "error", indent: false, pageIndex: 900 + pageSeq++, onBrowserLog: null, onLog: () => {} });
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await Promise.race([page.goto({ url, timeout: 25_000 }).catch(() => null), new Promise((r) => setTimeout(r, 26_000))]);
    await new Promise((r) => setTimeout(r, 2500)); // late layout, fonts, lazy hero images
    // Clear the view for the capture only: hide consent/sign-up overlays and sticky bars (nothing is clicked or
    // accepted), collapse empty ad slots, and bring the headline to the top of the frame.
    await page
      ._client()
      .send("Runtime.evaluate", {
        expression: `(() => {
          const vw = innerWidth, vh = innerHeight;
          for (const el of Array.from(document.querySelectorAll('body *'))) {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const modal = el.matches('[role=dialog],[aria-modal=true],dialog') || /consent|cookie|gdpr|onetrust|paywall|newsletter|subscribe-modal|overlay|backdrop/i.test((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : ''));
            const pinned = (cs.position === 'fixed' || cs.position === 'sticky') && (parseInt(cs.zIndex) >= 10 || r.width * r.height > vw * vh * 0.25);
            if ((modal && (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky')) || pinned) el.style.setProperty('display', 'none', 'important');
            if (/^(ad|ads|advert)|[-_ ](ad|ads|advert|banner)([-_ ]|$)/i.test((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')) && r.height > 60) el.style.setProperty('display', 'none', 'important');
          }
          for (const el of [document.documentElement, document.body]) { el.style.setProperty('overflow', 'visible', 'important'); el.style.setProperty('filter', 'none', 'important'); }
          const h = document.querySelector('h1');
          if (h) scrollTo(0, Math.max(0, h.getBoundingClientRect().top + scrollY - 150));
        })()`,
      })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 500));
    const { value } = await page._client().send("Page.captureScreenshot", { format: "jpeg", quality: 86, clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 }, captureBeyondViewport: false });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outJpg, Buffer.from(value.data, "base64"));
  } catch {
    return false;
  } finally {
    await page?.close().catch(() => {});
  }
  return exists(outJpg);
}

/**
 * Build list 5, item 16: the floor a picture's MEANING rating must reach (0–10). Calibrated on the channel's own real
 * footage rated by the same rule (data/picture-profile/magnates-media.json: median 5, top tenth 6): a bar of 6 — set
 * when the rating was literal fit — would refuse most of the channel's own pictures. The best-rated picture still wins.
 */
export const MEANING_BAR = 5;
