import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
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
      if (NO_LIFT.test(ch) || NO_LIFT_TITLE.test(e.title)) continue;
      // A title crediting two or more performers ("| Amanda Seyfried, Laurie Metcalf") is a drama clip.
      if (DRAMA_CHANNEL.test(ch) || DRAMA_TITLE.test(e.title) || /[|–-]\s*[A-Z][a-z]+ [A-Z][a-z]+,\s*[A-Z][a-z]+ [A-Z][a-z]+/.test(e.title)) continue;
      if (!e.duration || e.duration < 25 || e.duration > 2400) continue;
      if (!namesAll(e.title, o.entity.name)) continue;
      // A namesake is not the person: the title or channel must also name another subject of the film.
      if (o.entity.type === "person" && world.length && !world.some((w) => namesAll(`${e.title} ${ch}`, w))) continue;
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

const Moments = z.object({ picks: z.array(z.object({ sheet: z.number(), cell: z.number(), what: z.string() })) });

/** Where in the video the wanted picture is: the model looks at the video's thumbnail strip and names the cells. */
async function ytMoments(info: YtInfo, must: string, dlDir: string): Promise<number[]> {
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
    system: [plain("Each image is a grid of small frames from one video, in time order, numbered from 0 left-to-right then top-to-bottom. Pick up to 3 cells that clearly show the wanted picture. Never a talking head, an interview, a presenter, a title card, text or graphics. If no cell shows it, return no picks.")],
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
export async function youtubeFootage(o: { query: string; about: string; must?: string; subjects: string[]; dlDir: string; clipS: number; videos?: number }): Promise<PressCandidate[]> {
  const hits = (await ytSearch(o.query, 8))
    .filter((e) => {
      const ch = `${e.channel ?? ""} ${e.uploader ?? ""}`;
      if (NO_LIFT.test(ch) || NO_LIFT_TITLE.test(e.title) || DRAMA_CHANNEL.test(ch) || DRAMA_TITLE.test(e.title)) return false;
      if (/[|–-]\s*[A-Z][a-z]+ [A-Z][a-z]+,\s*[A-Z][a-z]+ [A-Z][a-z]+/.test(e.title)) return false;
      if (!e.duration || e.duration < 25 || e.duration > 3600) return false;
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
      const seenAt = o.must ? await ytMoments(info, o.must, o.dlDir).catch(() => []) : [];
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
            tags: ["press", "footage"],
            pageUrl: `https://www.youtube.com/watch?v=${e.id}&t=${at}s`,
            fileUrl: null,
            durationS: len,
            license: "Fair use (press footage, muted excerpt)",
            attributionRequired: true,
            attributionText: `${info.channel} — "${info.title.slice(0, 80)}"`,
            aiGenerated: false,
            archival: true,
            localFile: file,
            frameFile: frame,
            depicts: "",
            fairUse: { sourceTitle: info.title, channel: info.channel, atS: at, usedS: len, reason: "short muted excerpt of coverage of the subject, reframed and graded under commentary" },
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
      fit: z.number().describe("0–10: how well this picture shows what the line and intent are about (10 = exactly the thing; 5 = same general world; 2 = unrelated)"),
      face: z.boolean().describe("true if one identifiable person's face is prominent (a close-up or medium shot a viewer would take to be a specific person)"),
      banner: z.boolean().describe("true if burned-in text, captions, watermarks, title cards or broadcaster graphics are visible"),
      wrongEra: z.boolean().describe("true if clothing, cars, devices or film stock clearly belong to a different period than stated"),
      shows: z.string().describe("5–10 words: what the picture literally shows"),
    }),
  ),
});
export interface PictureReview { fit: number; face: boolean; banner: boolean; wrongEra: boolean; shows: string }

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
      system: [plain("You are a strict documentary picture editor reviewing the frame chosen for each shot. Judge only what is visible. A generic stand-in (a random person, an unrelated office, a different country, a different industry) is a poor fit even if it matches a keyword. Be accurate about faces: say face=true only when a specific person's face is clearly the subject. When the intent asks for a specific named thing (that company's factory, that product, that document) and the picture shows only a generic one of its kind, fit is at most 5. wrongEra=true only when something clearly LATER than the story period is visible (a calendar dated after it, a smartphone or flat screen in a 1970s scene); older or timeless things are not a wrong era. A title card, name slate, presenter graphic, subscribe button, watermark or burned-in caption means banner=true and fit at most 3.")],
      user: blocks,
      schema: Review,
      effort: "low",
      maxTokens: 3000,
    }).catch(() => null);
    for (let k = 0; k < part.length; k++) {
      const v = res?.data.verdicts.find((x) => x.index === k);
      out.push(v ? { fit: v.fit, face: v.face, banner: v.banner, wrongEra: v.wrongEra, shows: v.shows } : { fit: 5, face: false, banner: false, wrongEra: false, shows: "not reviewed" });
    }
  }
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
