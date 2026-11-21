/**
 * Planned sourcing.
 *
 *  - `planSourcing`: one brief per shot — what must be seen, what kind of picture that is, and the right search
 *    for each kind of source — plus the film's kit (the real things it must have pictures of).
 *  - `thumbOf`: a small preview of any candidate, so it is judged by eye before anything is downloaded.
 *  - `webPictures`: real photographs from the cited sources and from pages found by web search (the model's
 *    built-in search; no search-engine key). Pictures credited to photo agencies are never taken.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MODELS, plain, structured, webResearch } from "@opumia/agents";
import * as z from "zod/v4";

const run = promisify(execFile);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const size = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Run `fn` over `items`, at most `n` at a time, keeping order. */
export async function pooled<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The plan

export type PictureNeed = "real" | "period" | "staged" | "object" | "none";
export interface ShotBrief {
  shot: string;
  need: PictureNeed;
  must: string;
  stock: string[];
  archive: string;
  youtube: string;
  /** The year or decade this line is set in (e.g. "1975", "1990s"), so a picture is judged against its own time. */
  when?: string;
}

const Plan = z.object({
  kit: z.array(z.string()).describe("up to 8 real things this film must have genuine pictures of (a named product, prototype, building, document, event, person at a given time), most important first"),
  shots: z.array(
    z.object({
      shot: z.string(),
      need: z.enum(["real", "period", "staged", "object", "none"]),
      must: z.string().describe("what the viewer must see, in one plain phrase"),
      when: z.string().describe("the year or decade this line is set in, from the narration and the story (e.g. '1975', '1990s', '2012')"),
      stock: z.array(z.string()).describe("2 stock-library searches, 2–4 plain visual words each, no years, no names of people"),
      archive: z.string().describe("one archive search (subject + thing, e.g. 'Kodak factory Rochester'), or empty"),
      youtube: z.string().describe("one YouTube search for real footage of the film's named subject doing/showing this (news report, company film, advert, product demo, keynote, interview), or empty"),
    }),
  ),
});

const PLAN_SYSTEM = `You are the archive producer of a documentary. Before any search you write the sourcing plan: for every shot, the picture the film needs and where a real production would look for it.

need:
- "real": the line is about a named person, company, product, place or event and only the genuine thing will do (the actual prototype, the actual headquarters, the actual advert, the actual person).
- "period": the line needs the look of its time (a 1970s office, a 1990s shop) but not one specific thing.
- "staged": anonymous reenactment fits (executives around a table, an engineer at a bench, hands signing).
- "object": a close-up of an ordinary thing (a roll of film, a calendar, a patent document).
- "none": the line is an abstract idea, a figure or a turn of argument with nothing to film — it will be a designed scene. Use sparingly (at most one shot in seven).

Searches:
- stock: what a stock library would title the clip — concrete, visual, short ("engineer soldering circuit", "boardroom executives arguing"). Never a person's name or a year. For period shots add the look ("vintage", "retro") not the year.
- archive: for "real" and "period" only — the subject and the thing, the way an archive catalogues it.
- youtube: for "real" only, and only when footage of the film's named subject plausibly exists. Name the subject. Never a documentary, a drama or a film about it.
Leave a search empty rather than guess.`;

/** One Haiku call per 40 shots: the sourcing brief for every shot and the film's kit. */
export async function planSourcing(o: { shots: Array<{ id: string; line: string; intent: string; query: string; entities: string[] }>; subjects: string[]; era: string }): Promise<{ briefs: Map<string, ShotBrief>; kit: string[] }> {
  const briefs = new Map<string, ShotBrief>();
  const kit: string[] = [];
  const chunks: (typeof o.shots)[] = [];
  for (let i = 0; i < o.shots.length; i += 40) chunks.push(o.shots.slice(i, i + 40));
  await pooled(chunks, 4, async (part, ci) => {
    const res = await structured({
      stage: "resolve.plan",
      model: MODELS.haiku,
      system: [plain(PLAN_SYSTEM)],
      user: `Story period: ${o.era}. Named subjects of the film: ${o.subjects.slice(0, 20).join("; ") || "none"}.\n\n${part.map((s) => `SHOT ${s.id} | narration: "${s.line.slice(0, 240)}" | director's intent: ${s.intent.slice(0, 160)} | director's search: ${s.query}${s.entities.length ? ` | names: ${s.entities.join(", ")}` : ""}`).join("\n")}`,
      schema: Plan,
      effort: "medium",
      maxTokens: 8000,
    }).catch(() => null);
    for (const b of res?.data.shots ?? []) briefs.set(b.shot, { ...b, stock: b.stock.map((q) => q.trim()).filter((q) => q.length > 3).slice(0, 2), archive: b.archive.trim(), youtube: b.youtube.trim() });
    if (ci === 0) kit.push(...(res?.data.kit ?? []).slice(0, 8));
  });
  // A shot the planner missed keeps the director's search.
  for (const s of o.shots) if (!briefs.has(s.id)) briefs.set(s.id, { shot: s.id, need: "staged", must: s.intent, stock: [s.query.split(/\s+/).slice(0, 4).join(" ")], archive: "", youtube: "" });
  return { briefs, kit };
}

// ---------------------------------------------------------------------------------------------------------
// The re-plan: cutting to the footage that exists

export interface Replan {
  shot: string;
  action: "spare" | "search" | "design";
  spare: number;
  need: PictureNeed;
  must: string;
  stock: string[];
  archive: string;
  youtube: string;
  why: string;
}

const ReplanSchema = z.object({
  shots: z.array(
    z.object({
      shot: z.string(),
      action: z.enum(["spare", "search", "design"]),
      spare: z.number().describe("index of the spare picture to use, else -1"),
      need: z.enum(["real", "period", "staged", "object", "none"]),
      must: z.string().describe("the NEW picture, in one plain phrase"),
      stock: z.array(z.string()).describe("2 stock searches for the new picture, 2–4 plain visual words each"),
      archive: z.string(),
      youtube: z.string(),
      why: z.string().describe("how the new picture tells the same line, in a few words"),
    }),
  ),
});

const REPLAN_SYSTEM = `You are the director of a documentary, re-cutting to the footage you actually have. The narration is recorded and fixed. For the shots below, the first picture you asked for does not exist in any source: you are shown what the searches returned and how badly it fitted.

For each shot choose ONE:
- "spare": a spare picture (already found and approved for another line, unused) tells this line. Give its index.
- "search": a DIFFERENT picture that tells the same line and that libraries really hold. Think like an editor with no budget for a shoot: a hand, an object, a place, a screen, a simple action, a telling detail, a symbol the viewer reads at once. What the failed searches returned shows what exists — move toward it. Avoid what cannot be found: specific period group scenes ("1970s executives arguing"), exact reenactments, anything needing named people.
- "design": nothing filmable tells this line honestly — it becomes a designed scene with no picture.

Rules:
- The new picture must still be TRUE to the line. Never suggest something that would mislead (a different company's product, a different person, the wrong decade's technology).
- Do not repeat a picture the film already uses (listed), and give every shot a different picture.
- stock searches: concrete, visual, 2–4 words, no names of people, no years. archive / youtube only when the new picture is a real named thing; otherwise empty.
- Each line is set in a stated time: the new picture must not show anything later than it (no laptops, flat screens or modern offices under a 1975 line). Timeless close-ups — hands, paper, objects, light, a door, a clock — are the safest.
- At most a third of these shots may be "design".`;

/** One Sonnet call: every shot the first search could not fill is re-planned around what the sources hold. */
export async function replanShots(o: { shots: Array<{ id: string; line: string; need: PictureNeed; must: string; seen: Array<{ fit: number; shows: string }> }>; spares: string[]; placed: string[]; subjects: string[]; era: string }): Promise<Replan[]> {
  if (!o.shots.length) return [];
  const res = await structured({
    stage: "resolve.replan",
    model: MODELS.sonnet,
    system: [plain(REPLAN_SYSTEM)],
    user: `Story period: ${o.era}. Named subjects: ${o.subjects.slice(0, 12).join("; ") || "none"}.

Pictures the film already uses:
${o.placed.map((x) => `- ${x}`).join("\n") || "- none yet"}

Spare pictures (found, approved by eye, unused):
${o.spares.map((x, i) => `[${i}] ${x}`).join("\n") || "none"}

Shots to re-plan:
${o.shots.map((sh) => `SHOT ${sh.id} | narration: "${sh.line.slice(0, 260)}" | asked for (${sh.need}): ${sh.must}\n  the searches returned: ${sh.seen.slice(0, 6).map((c) => `${c.shows.slice(0, 90)} (${c.fit}/10)`).join("; ") || "nothing"}`).join("\n")}`,
    schema: ReplanSchema,
    effort: "medium",
    maxTokens: 6000,
  }).catch(() => null);
  const ids = new Set(o.shots.map((x) => x.id));
  return (res?.data.shots ?? []).filter((r) => ids.has(r.shot)).map((r) => ({ ...r, stock: r.stock.map((q) => q.trim()).filter((q) => q.length > 3).slice(0, 2), archive: r.archive.trim(), youtube: r.youtube.trim() }));
}

// ---------------------------------------------------------------------------------------------------------
// Previews

/** A 512-px JPEG preview of a remote picture, or of one moment of a remote/local clip. False when it cannot be read. */
export async function thumbOf(src: { url?: string; file?: string; atS?: number; video?: boolean }, out: string): Promise<boolean> {
  if ((await size(out)) > 0) return true;
  await mkdir(path.dirname(out), { recursive: true });
  const raw = `${out}.raw`;
  try {
    let input = src.file ?? "";
    if (src.url && !src.video) {
      // Wikimedia asks automated clients to identify themselves honestly.
      const r = await fetch(src.url, { headers: { "user-agent": /wikimedia\.org|wikipedia\.org/.test(src.url) ? "Opumia/0.1 (documentary pipeline)" : UA }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return false;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 800 || buf.length > 12_000_000) return false;
      await writeFile(raw, buf);
      input = raw;
    }
    const seek = (src.atS ?? 0) > 0 ? ["-ss", (src.atS ?? 0).toFixed(2)] : [];
    const head = src.url && src.video ? ["-user_agent", UA, ...seek, "-i", src.url] : [...(src.video ? seek : []), "-i", input];
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...head, "-frames:v", "1", "-update", "1", "-vf", "scale=512:-2", "-q:v", "5", out], { timeout: 45_000 });
    return (await size(out)) > 0;
  } catch {
    return false;
  } finally {
    await unlink(raw).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------
// Web pictures

export interface WebPicture {
  /** Full picture as a local JPEG. */
  file: string;
  /** 512-px preview for the vision check. */
  thumb: string;
  url: string;
  pageUrl: string;
  host: string;
  pageTitle: string;
  alt: string;
  width: number;
  height: number;
}

/** Photo agencies license every use and enforce it: their pictures are never taken, wherever they appear. */
const AGENCY = /getty|shutterstock|alamy|istock|adobe ?stock|depositphotos|dreamstime|\bap photo|associated press|\bap images|reuters|\bafp\b|\bepa\b|imago|zuma ?press|bloomberg via|picture alliance|pa images|magnum photos|corbis|newscom/i;
const NOT_A_PICTURE = /logo|icon|sprite|avatar|favicon|placeholder|tracking|pixel|badge|banner-ad|\/ads?\/|gravatar|emoji|spinner|share|social|\.svg(\?|$)|\.gif(\?|$)/i;
const SKIP_HOST = /(^|\.)(youtube|youtu|facebook|instagram|tiktok|x|twitter|pinterest|reddit|linkedin|wikipedia|wikimedia|amazon|ebay|gettyimages|shutterstock|alamy|istockphoto)\./i;

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1] ?? "";
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function picturesOnPage(pageUrl: string): Promise<Array<{ url: string; alt: string; pageTitle: string }>> {
  try {
    const r = await fetch(pageUrl, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok || !/html/.test(r.headers.get("content-type") ?? "")) return [];
    const html = (await r.text()).slice(0, 1_500_000);
    const pageTitle = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").slice(0, 160);
    const out: Array<{ url: string; alt: string; pageTitle: string }> = [];
    const seen = new Set<string>();
    const add = (u: string, alt: string) => {
      let abs: string;
      try {
        abs = new URL(decode(u), pageUrl).href;
      } catch {
        return;
      }
      const k = abs.split("?")[0]!;
      if (seen.has(k) || !/^https?:/.test(abs) || NOT_A_PICTURE.test(abs) || AGENCY.test(abs) || AGENCY.test(alt)) return;
      seen.add(k);
      out.push({ url: abs, alt: decode(alt).slice(0, 200), pageTitle });
    };
    // The page's lead picture, then pictures inside figures (with their captions), then large described pictures.
    for (const m of html.matchAll(/<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/gi)) add(attr(m[0], "content"), pageTitle);
    for (const m of html.matchAll(/<figure[\s\S]{0,4000}?<\/figure>/gi)) {
      const img = /<img[^>]+>/i.exec(m[0])?.[0];
      const cap = decode(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(m[0])?.[1] ?? "");
      if (img && !AGENCY.test(cap)) add(attr(img, "data-src") || attr(img, "src"), cap || attr(img, "alt"));
    }
    for (const m of html.matchAll(/<img[^>]+>/gi)) {
      const alt = attr(m[0], "alt");
      const w = Number(attr(m[0], "width")) || 0;
      if (alt.length >= 20 || w >= 600) add(attr(m[0], "data-src") || attr(m[0], "src"), alt);
      if (out.length >= 6) break;
    }
    return out.slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * Real photographs for the film's kit: from the pages the research cited and from pages a web search finds.
 * Returned pictures are unreviewed — the caller checks each by eye against the line it would sit under.
 */
export async function webPictures(o: { kit: string[]; subjects: string[]; pages: string[]; dlDir: string; maxPages?: number; log?: (s: string) => void }): Promise<WebPicture[]> {
  const pages = new Set(o.pages.filter((u) => !SKIP_HOST.test(new URL(u).hostname)));
  if (o.kit.length) {
    const ask = {
      stage: "resolve.web",
      model: MODELS.haiku,
      maxSearches: 5,
      maxFetches: 0,
      system: [plain("You are a picture researcher. Search the web for pages that SHOW real photographs of each listed thing: museum and collection pages, the company's own history pages, press rooms, news features, encyclopaedia entries. Not stock-photo shops, not social media, not video sites. Finish with one line per thing naming the best page URL.")],
      user: `Film subjects: ${o.subjects.slice(0, 8).join("; ")}\nFind pages with real photographs of:\n${o.kit.map((k) => `- ${k}`).join("\n")}`,
    };
    // The search tool sometimes fails on the first try: one more attempt when it found almost nothing.
    let found = await webResearch(ask).catch(() => null);
    if ((found?.urls.size ?? 0) < 3) found = (await webResearch(ask).catch(() => null)) ?? found;
    for (const u of found?.urls.keys() ?? []) {
      try {
        if (!SKIP_HOST.test(new URL(u).hostname)) pages.add(u);
      } catch {
        /* not a URL */
      }
    }
  }
  const list = [...pages].slice(0, o.maxPages ?? 18);
  const raw = (await pooled(list, 6, async (p) => (await picturesOnPage(p)).map((x) => ({ ...x, pageUrl: p })))).flat();
  await mkdir(o.dlDir, { recursive: true });
  const seen = new Set<string>();
  const got = await pooled(raw.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))).slice(0, 60), 8, async (x): Promise<WebPicture | null> => {
    const file = path.join(o.dlDir, `web_${sha(x.url)}.jpg`);
    const thumb = path.join(o.dlDir, `web_${sha(x.url)}.thumb.jpg`);
    const tmp = `${file}.raw`;
    try {
      if (!(await size(file))) {
        const r = await fetch(x.url, { headers: { "user-agent": UA, referer: x.pageUrl }, signal: AbortSignal.timeout(20_000) });
        if (!r.ok || !/image\//.test(r.headers.get("content-type") ?? "")) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 25_000 || buf.length > 15_000_000) return null;
        await writeFile(tmp, buf);
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-frames:v", "1", "-update", "1", "-vf", "scale='min(2000,iw)':-2", "-q:v", "3", file], { timeout: 45_000 });
      }
      const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { timeout: 20_000 });
      const [w, h] = stdout.trim().split(",").map(Number) as [number, number];
      if (!w || !h || w < 520 || h < 320 || w / h > 3.2 || h / w > 2.2) return null;
      if (!(await thumbOf({ file }, thumb))) return null;
      return { file, thumb, url: x.url, pageUrl: x.pageUrl, host: new URL(x.pageUrl).hostname.replace(/^www\./, ""), pageTitle: x.pageTitle, alt: x.alt, width: w, height: h };
    } catch {
      return null;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
  const ok = got.filter((x): x is WebPicture => x !== null);
  o.log?.(`  resolver: web pictures — ${list.length} page(s) read, ${ok.length} real picture(s) collected for review`);
  return ok;
}
