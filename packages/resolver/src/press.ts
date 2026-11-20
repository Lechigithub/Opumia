import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MODELS, plain, structured } from "@opumia/agents";
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
export const PRESS_MAX_CLIP_S = 6.5;

/** Channels whose finished documentaries we never lift footage from (we'd be copying their edit). */
const NO_LIFT = /\b(magnates ?media|how money works|logically answered|modern mba|moon|big company|business casual|company man|cold fusion|coldfusion|wendover|polymatter|johnny harris|vox|bloomberg originals? documentary)\b/i;
const NO_LIFT_TITLE = /\b(documentary|full movie|explained|the rise and fall|the untold story|compilation|reaction|tiktok|shorts?|#shorts|top \d+|ranking|podcast)\b/i;

export interface PressCandidate extends StockCandidate {
  /** Local file (already materialised) used for the vision check and the edit. */
  localFile: string;
  /** Frame used for the vision check. */
  frameFile: string;
  depicts: string;
  fairUse: { sourceTitle: string; channel?: string; atS?: number; usedS: number; reason: string };
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
    // Normalise: muted, 30 fps, H.264, exact length.
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-t", lenS.toFixed(2), "-an", "-vf", "scale='min(1920,iw)':-2,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", out], { timeout: 120_000 });
    return exists(out);
  } catch {
    return false;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const namesAll = (title: string, name: string) => {
  const toks = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !["the", "inc", "corp", "company", "and"].includes(t));
  const key = toks.at(-1);
  return Boolean(key && new RegExp(`\\b${key}`, "i").test(title));
};

/**
 * Up to `perVideo` short sections from each of the top `videos` press videos naming the entity.
 * Sections sit away from the intro/outro (where anchors and logos live).
 */
export async function youtubePress(o: { entity: { name: string; type: string; year?: number }; context?: string; dlDir: string; usedVideos: Set<string>; videos?: number; perVideo?: number; clipS: number }): Promise<PressCandidate[]> {
  const year = o.entity.year ? ` ${o.entity.year}` : "";
  const queries = [`${o.entity.name}${year} news`, `${o.entity.name} ${o.context ?? "interview"}`.trim()];
  const seen = new Set<string>();
  const hits: YtEntry[] = [];
  for (const q of queries) {
    for (const e of await ytSearch(q, 8)) {
      if (seen.has(e.id) || o.usedVideos.has(e.id)) continue;
      seen.add(e.id);
      const ch = `${e.channel ?? ""} ${e.uploader ?? ""}`;
      if (NO_LIFT.test(ch) || NO_LIFT_TITLE.test(e.title)) continue;
      if (!e.duration || e.duration < 25 || e.duration > 2400) continue;
      if (!namesAll(e.title, o.entity.name)) continue;
      hits.push(e);
    }
    if (hits.length >= (o.videos ?? 2)) break;
  }
  const len = Math.min(PRESS_MAX_CLIP_S, Math.max(2.5, o.clipS + 0.6));
  const jobs = hits.slice(0, o.videos ?? 2).flatMap((e) => {
    const d = e.duration!;
    const spots = [0.32, 0.58].slice(0, o.perVideo ?? 2).map((f) => Math.max(8, Math.min(d - len - 8, d * f)));
    return spots.map((at) => ({ e, at }));
  });
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
// Vision check: does the picture really show the subject the line is about?

const VisionPick = z.object({ verdicts: z.array(z.object({ index: z.number(), shows: z.boolean().describe("true only if the picture clearly shows the named subject (the person, the company's logo/building/product, the event)"), quality: z.number().describe("0–10 as a documentary shot: sharp, well-framed, no burned-in lower thirds/tickers covering the subject"), note: z.string() })) });

export async function visionCheck(items: Array<{ frameFile: string; depicts: string; line: string }>): Promise<Array<{ shows: boolean; quality: number; note: string }>> {
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
    system: [plain("You are a documentary picture researcher checking candidate frames. For each, say whether it clearly shows the named subject (a recognisable person's face or figure when a person is named; the company's real logo, building, store, product or staff when a company is named; the actual event when an event is named) and rate it as a shot. A news anchor in a studio, a title card, a thumbnail collage, a talking head of someone else, or a frame mostly covered by tickers and lower thirds does NOT show the subject.")],
    user: blocks,
    schema: VisionPick,
    effort: "low",
    maxTokens: 3000,
  });
  return items.map((_, i) => {
    const v = data.verdicts.find((x) => x.index === i);
    return v ? { shows: v.shows, quality: v.quality, note: v.note } : { shows: false, quality: 0, note: "no verdict" };
  });
}
