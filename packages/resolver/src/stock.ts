import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StockProvider } from "@opumia/contracts";

export interface StockCandidate {
  provider: StockProvider;
  externalId: string;
  kind: "video" | "image";
  title: string;
  tags: string[];
  pageUrl: string;
  /** Direct file URL, or null when it must be requested at download time (vecteezy). */
  fileUrl: string | null;
  /** Small preview picture, so a candidate can be judged by eye before anything is downloaded. */
  thumbUrl?: string;
  width?: number;
  height?: number;
  durationS?: number;
  license: string;
  attributionRequired: boolean;
  attributionText?: string;
  aiGenerated: boolean;
  archival: boolean;
}

export interface SearchOpts {
  kind: "video" | "image";
  orientation: "landscape" | "portrait";
  perPage: number;
}

const UA = "Opumia/0.1 (documentary pipeline)";
/** Searches a source refused (HTTP 429: rate limit), by host — reported, never silently counted as "nothing found". */
export const refused = new Map<string, number>();
const get = async <T>(url: string, headers: Record<string, string> = {}): Promise<T | null> => {
  try {
    let r = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 2000));
      r = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 429) {
        const h = new URL(url).hostname;
        refused.set(h, (refused.get(h) ?? 0) + 1);
      }
    }
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
};
const env = (k: string) => process.env[k] ?? "";
const stripHtml = (s?: string) => (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const AI_TAG = /\b(ai[- ]?generated|generative ai|midjourney|stable diffusion|dall-?e|ai art)\b/i;

/* ---------------- Pexels ---------------- */
async function pexels(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("PEXELS_API_KEY")) return [];
  const h = { Authorization: env("PEXELS_API_KEY") };
  const qs = `query=${encodeURIComponent(q)}&per_page=${o.perPage}&orientation=${o.orientation}`;
  if (o.kind === "video") {
    const j = await get<{ videos: Array<{ id: number; url: string; width: number; height: number; duration: number; image?: string; tags?: string[]; user: { name: string }; video_files: Array<{ link: string; width: number; height: number; file_type: string }> }> }>(`https://api.pexels.com/videos/search?${qs}`, h);
    return (j?.videos ?? []).map((v) => {
      const files = v.video_files.filter((f) => f.file_type === "video/mp4").sort((a, b) => Math.abs(Math.max(a.width, a.height) - 1920) - Math.abs(Math.max(b.width, b.height) - 1920));
      const f = files[0];
      return { provider: "pexels" as const, externalId: String(v.id), kind: "video" as const, title: v.url.split("/").filter(Boolean).pop()?.replace(/-\d+$/, "").replace(/-/g, " ") ?? "", tags: v.tags ?? [], pageUrl: v.url, fileUrl: f?.link ?? null, ...(v.image ? { thumbUrl: v.image } : {}), width: f?.width, height: f?.height, durationS: v.duration, license: "Pexels License", attributionRequired: false, attributionText: `Video by ${v.user.name} on Pexels`, aiGenerated: false, archival: false };
    }).filter((c) => c.fileUrl);
  }
  const j = await get<{ photos: Array<{ id: number; url: string; width: number; height: number; alt: string; photographer: string; src: { large2x: string; original: string; medium?: string } }> }>(`https://api.pexels.com/v1/search?${qs}`, h);
  return (j?.photos ?? []).map((p) => ({ provider: "pexels" as const, externalId: String(p.id), kind: "image" as const, title: p.alt, tags: [], pageUrl: p.url, fileUrl: p.src.large2x, ...(p.src.medium ? { thumbUrl: p.src.medium } : {}), width: p.width, height: p.height, license: "Pexels License", attributionRequired: false, attributionText: `Photo by ${p.photographer} on Pexels`, aiGenerated: false, archival: false }));
}

/* ---------------- Pixabay ---------------- */
async function pixabay(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("PIXABAY_API_KEY")) return [];
  const base = `key=${env("PIXABAY_API_KEY")}&q=${encodeURIComponent(q.slice(0, 100))}&per_page=${Math.max(3, o.perPage)}&safesearch=true`;
  if (o.kind === "video") {
    const j = await get<{ hits: Array<{ id: number; pageURL: string; tags: string; duration: number; user: string; videos: Record<string, { url: string; width: number; height: number; thumbnail?: string }> }> }>(`https://pixabay.com/api/videos/?${base}&video_type=film`);
    return (j?.hits ?? []).map((v) => {
      const f = v.videos.large?.url ? v.videos.large : v.videos.medium;
      return { provider: "pixabay" as const, externalId: String(v.id), kind: "video" as const, title: v.tags, tags: v.tags.split(",").map((t) => t.trim()), pageUrl: v.pageURL, fileUrl: f?.url || null, ...(f?.thumbnail ?? v.videos.tiny?.thumbnail ? { thumbUrl: (f?.thumbnail ?? v.videos.tiny?.thumbnail)! } : {}), width: f?.width, height: f?.height, durationS: v.duration, license: "Pixabay Content License", attributionRequired: false, attributionText: `Video by ${v.user} on Pixabay`, aiGenerated: AI_TAG.test(v.tags), archival: false };
    }).filter((c) => c.fileUrl && !c.aiGenerated);
  }
  const j = await get<{ hits: Array<{ id: number; pageURL: string; tags: string; user: string; largeImageURL: string; webformatURL?: string; imageWidth: number; imageHeight: number }> }>(`https://pixabay.com/api/?${base}&image_type=photo&orientation=${o.orientation === "portrait" ? "vertical" : "horizontal"}`);
  return (j?.hits ?? []).map((p) => ({ provider: "pixabay" as const, externalId: String(p.id), kind: "image" as const, title: p.tags, tags: p.tags.split(",").map((t) => t.trim()), pageUrl: p.pageURL, fileUrl: p.largeImageURL, ...(p.webformatURL ? { thumbUrl: p.webformatURL } : {}), width: p.imageWidth, height: p.imageHeight, license: "Pixabay Content License", attributionRequired: false, attributionText: `Image by ${p.user} on Pixabay`, aiGenerated: AI_TAG.test(p.tags), archival: false })).filter((c) => !c.aiGenerated);
}

/* ---------------- Coverr ---------------- */
async function coverr(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("COVERR_API_KEY") || o.kind !== "video") return [];
  const j = await get<{ hits: Array<{ id: string; title: string; slug: string; tags: string[]; duration: string; max_width: number; max_height: number; is_ai_generated?: boolean; is_premium?: boolean; thumbnail?: string; poster?: string; urls: { mp4_download?: string; mp4?: string } }> }>(`https://api.coverr.co/videos?query=${encodeURIComponent(q)}&page_size=${o.perPage}&urls=true`, { Authorization: `Bearer ${env("COVERR_API_KEY")}` });
  return (j?.hits ?? []).filter((v) => !v.is_ai_generated && !v.is_premium).map((v) => ({ provider: "coverr" as const, externalId: v.id, kind: "video" as const, title: v.title, tags: v.tags ?? [], pageUrl: `https://coverr.co/videos/${v.slug}`, fileUrl: v.urls.mp4_download ?? v.urls.mp4 ?? null, ...(v.poster ?? v.thumbnail ? { thumbUrl: (v.poster ?? v.thumbnail)! } : {}), width: v.max_width, height: v.max_height, durationS: Number(v.duration), license: "Coverr License", attributionRequired: false, attributionText: "Video from Coverr", aiGenerated: false, archival: false })).filter((c) => c.fileUrl);
}

/* ---------------- Vecteezy ---------------- */
async function vecteezy(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("VECTEEZY_API_KEY") || !env("VECTEEZY_ACCOUNT_ID")) return [];
  const j = await get<{ resources: Array<{ id: number; title: string; tags: string[]; ai_generated: boolean | null; content_type: string; thumbnail_url?: string; preview_url?: string; file_metadata?: { available_download_sizes?: Array<{ width: number; height: number }> } }> }>(`https://api.vecteezy.com/v2/${env("VECTEEZY_ACCOUNT_ID")}/resources?term=${encodeURIComponent(q)}&content_type=${o.kind === "video" ? "video" : "photo"}&per_page=${o.perPage}`, { Authorization: `Bearer ${env("VECTEEZY_API_KEY")}` });
  return (j?.resources ?? []).filter((r) => r.ai_generated !== true && !AI_TAG.test((r.tags ?? []).join(" "))).map((r) => {
    const big = r.file_metadata?.available_download_sizes?.[0];
    return { provider: "vecteezy" as const, externalId: String(r.id), kind: o.kind, title: r.title, tags: r.tags ?? [], pageUrl: `https://www.vecteezy.com/${o.kind === "video" ? "video" : "photo"}/${r.id}`, fileUrl: null, ...(r.thumbnail_url ?? r.preview_url ? { thumbUrl: (r.thumbnail_url ?? r.preview_url)! } : {}), width: big?.width, height: big?.height, license: "Vecteezy License (API account)", attributionRequired: true, attributionText: "Stock media from Vecteezy.com", aiGenerated: false, archival: false };
  });
}

/* ---------------- Vimeo (Creative Commons, downloadable only) ---------------- */
async function vimeo(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("VIMEO_ACCESS_TOKEN") || o.kind !== "video") return [];
  const j = await get<{ data: Array<{ uri: string; name: string; link: string; duration: number; width: number; height: number; license: string | null; user?: { name: string }; download?: Array<{ link: string; width: number; type: string }> }> }>(`https://api.vimeo.com/videos?query=${encodeURIComponent(q)}&filter=CC&per_page=${o.perPage}&fields=uri,name,link,duration,width,height,license,user.name,download`, { Authorization: `bearer ${env("VIMEO_ACCESS_TOKEN")}` });
  return (j?.data ?? []).filter((v) => v.license && v.download?.length && !/nc/.test(v.license)).map((v) => {
    const f = [...v.download!].filter((d) => d.type === "video/mp4").sort((a, b) => Math.abs(a.width - 1920) - Math.abs(b.width - 1920))[0];
    return { provider: "vimeo" as const, externalId: v.uri.split("/").pop()!, kind: "video" as const, title: v.name, tags: [], pageUrl: v.link, fileUrl: f?.link ?? null, width: v.width, height: v.height, durationS: v.duration, license: `CC ${v.license!.toUpperCase()}`, attributionRequired: v.license !== "cc0", attributionText: `"${v.name}" by ${v.user?.name ?? "unknown"} (Vimeo, CC ${v.license})`, aiGenerated: false, archival: false };
  }).filter((c) => c.fileUrl);
}

/* ---------------- Europeana (open reuse only) ---------------- */
const OPEN_RIGHTS: Array<[RegExp, string, boolean]> = [
  [/publicdomain\/zero/, "CC0", false],
  [/publicdomain\/mark/, "Public Domain Mark", false],
  [/licenses\/by-sa\//, "CC BY-SA", true],
  [/licenses\/by\//, "CC BY", true],
];
async function europeana(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("EUROPEANA_API_KEY") || o.kind !== "image") return [];
  const j = await get<{ items?: Array<{ id: string; title?: string[]; rights?: string[]; edmIsShownBy?: string[]; edmPreview?: string[]; guid: string; dataProvider?: string[]; year?: string[] }> }>(`https://api.europeana.eu/record/v2/search.json?query=${encodeURIComponent(q)}&rows=${o.perPage}&reusability=open&media=true&qf=TYPE:IMAGE`, { "X-Api-Key": env("EUROPEANA_API_KEY").trim() });
  return (j?.items ?? []).flatMap((it) => {
    const r = it.rights?.[0] ?? "";
    const m = OPEN_RIGHTS.find(([re]) => re.test(r));
    const file = it.edmIsShownBy?.[0];
    if (!m || !file) return [];
    return [{ provider: "europeana" as const, externalId: it.id, kind: "image" as const, title: it.title?.[0] ?? "", tags: it.year ?? [], pageUrl: it.guid.split("?")[0]!, fileUrl: file, ...(it.edmPreview?.[0] ? { thumbUrl: it.edmPreview[0] } : {}), license: m[1], attributionRequired: m[2], attributionText: `${it.title?.[0] ?? "Untitled"} — ${it.dataProvider?.[0] ?? "Europeana"} (${m[1]})`, aiGenerated: false, archival: true }];
  });
}

/* ---------------- NARA (unrestricted only) ---------------- */
async function nara(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("NARA_API_KEY")) return [];
  const j = await get<{ body?: { hits?: { hits?: Array<{ _source: { record: { naId: number; title: string; useRestriction?: { status?: string }; digitalObjects?: Array<{ objectUrl: string; objectType: string; objectId: string }> } } }> } } }>(`https://catalog.archives.gov/api/v2/records/search?q=${encodeURIComponent(q)}&limit=${o.perPage}&availableOnline=true`, { "x-api-key": env("NARA_API_KEY") });
  const want = o.kind === "video" ? /mp4/i : /jpe?g|png|tiff?/i;
  return (j?.body?.hits?.hits ?? []).flatMap((h) => {
    const r = h._source.record;
    if (r.useRestriction?.status !== "Unrestricted") return [];
    const d = (r.digitalObjects ?? []).find((x) => want.test(x.objectType) || want.test(x.objectUrl));
    if (!d) return [];
    return [{ provider: "nara" as const, externalId: String(r.naId), kind: o.kind, title: r.title, tags: [], pageUrl: `https://catalog.archives.gov/id/${r.naId}`, fileUrl: d.objectUrl, license: "Public domain (US National Archives, unrestricted use)", attributionRequired: false, attributionText: `National Archives (NAID ${r.naId})`, aiGenerated: false, archival: true }];
  });
}

/* ---------------- Wikimedia Commons ---------------- */
async function commons(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  // Anonymous: the Commons read API needs no token (a stored token that is malformed breaks every request).
  const ft = o.kind === "video" ? "filetype:video" : "filetype:bitmap";
  const j = await get<{ query?: { pages?: Record<string, { title: string; imageinfo?: Array<{ url: string; thumburl?: string; descriptionurl: string; width: number; height: number; mime: string; duration?: number; extmetadata?: Record<string, { value: string }> }> }> } }>(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${o.perPage}&gsrsearch=${encodeURIComponent(`${q} ${ft}`)}&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=480`,
    {},
  );
  return Object.values(j?.query?.pages ?? {}).flatMap((p) => {
    const ii = p.imageinfo?.[0];
    const md = ii?.extmetadata ?? {};
    const lic = stripHtml(md.LicenseShortName?.value);
    if (!ii || !lic || /fair use|non-free/i.test(lic)) return [];
    const artist = stripHtml(md.Artist?.value) || "unknown";
    return [{ provider: "commons" as const, externalId: p.title, kind: o.kind, title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "), tags: stripHtml(md.Categories?.value).split("|").filter(Boolean), pageUrl: ii.descriptionurl, fileUrl: ii.url, ...(ii.thumburl ? { thumbUrl: ii.thumburl } : {}), width: ii.width, height: ii.height, ...(ii.duration ? { durationS: ii.duration } : {}), license: lic, attributionRequired: md.AttributionRequired?.value === "true" || /BY/.test(lic), attributionText: `${p.title.replace(/^File:/, "")} by ${artist}, ${lic}, via Wikimedia Commons`, aiGenerated: /AI-generated/i.test(stripHtml(md.Categories?.value)), archival: true }];
  }).filter((c) => !c.aiGenerated);
}

/* ---------------- Openverse (keyless; openly licensed images) ---------------- */
async function openverse(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (o.kind !== "image") return [];
  const j = await get<{ results?: Array<{ id: string; title?: string; url: string; foreign_landing_url: string; creator?: string; thumbnail?: string; license: string; license_version?: string; width?: number; height?: number; tags?: Array<{ name: string }>; source?: string }> }>(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${o.perPage}&license_type=commercial,modification&mature=false`);
  return (j?.results ?? []).filter((r) => r.url && (r.width ?? 0) >= 600).map((r) => {
    const lic = `CC ${r.license.toUpperCase()}${r.license_version ? ` ${r.license_version}` : ""}`.replace("CC CC0", "CC0").replace("CC PDM", "Public Domain Mark");
    return { provider: "openverse" as const, externalId: r.id, kind: "image" as const, title: r.title ?? "", tags: (r.tags ?? []).slice(0, 8).map((t) => t.name), pageUrl: r.foreign_landing_url, fileUrl: r.url, ...(r.thumbnail ? { thumbUrl: r.thumbnail } : {}), ...(r.width ? { width: r.width, height: r.height! } : {}), license: lic, attributionRequired: !/^(CC0|Public Domain)/.test(lic), attributionText: `${r.title ?? "Untitled"}${r.creator ? ` by ${r.creator}` : ""}, ${lic}, via ${r.source ?? "Openverse"}`, aiGenerated: false, archival: true };
  });
}

/* ---------------- Internet Archive (public-domain / CC films, newsreels, adverts) ---------------- */
async function archive(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (o.kind !== "video") return [];
  // Public-domain collections only (Prelinger Archives, US government films). Wildcard licence terms make the
  // archive's search backend fail, so the collections are named outright.
  const query = `(${q.replace(/[^\p{L}\p{N}\s]/gu, " ")}) AND mediatype:movies AND (collection:prelinger OR collection:fedflix)`;
  const j = await get<{ response?: { docs?: Array<{ identifier: string; title?: string; licenseurl?: string; collection?: string[]; year?: string | number; subject?: string | string[] }> } }>(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=licenseurl&fl[]=collection&fl[]=year&fl[]=subject&rows=${o.perPage}&output=json`);
  const out: StockCandidate[] = [];
  for (const d of (j?.response?.docs ?? []).slice(0, o.perPage)) {
    // One small H.264 derivative per item (the files list is a second request).
    const meta = await get<{ files?: Array<{ name: string; format?: string; size?: string; length?: string; width?: string; height?: string }>; result?: Array<{ name: string; format?: string; size?: string; length?: string; width?: string; height?: string }> }>(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}/files`);
    const f = (meta?.result ?? meta?.files ?? []).filter((x) => /\.mp4$/i.test(x.name) && /h\.264|MPEG4/i.test(x.format ?? "")).sort((a, b) => Number(a.size ?? 0) - Number(b.size ?? 0))[0];
    if (!f) continue;
    const pd = /publicdomain/.test(d.licenseurl ?? "") || (d.collection ?? []).some((c) => c === "prelinger" || c === "fedflix");
    out.push({ provider: "archive" as const, externalId: `${d.identifier}/${f.name}`, kind: "video" as const, title: d.title ?? d.identifier, tags: [String(d.year ?? ""), ...(Array.isArray(d.subject) ? d.subject : d.subject ? [d.subject] : [])].filter(Boolean).slice(0, 8), pageUrl: `https://archive.org/details/${d.identifier}`, fileUrl: `https://archive.org/download/${d.identifier}/${encodeURIComponent(f.name)}`, thumbUrl: `https://archive.org/services/img/${d.identifier}`, ...(f.width ? { width: Number(f.width), height: Number(f.height) } : {}), ...(f.length ? { durationS: f.length.includes(":") ? f.length.split(":").reduce((t, x) => t * 60 + Number(x), 0) : Number(f.length) } : {}), license: pd ? "Public domain (Internet Archive)" : "CC BY (Internet Archive)", attributionRequired: !pd, attributionText: `${d.title ?? d.identifier} — Internet Archive`, aiGenerated: false, archival: true });
  }
  return out;
}

export const PROVIDERS: Record<string, (q: string, o: SearchOpts) => Promise<StockCandidate[]>> = { pexels, pixabay, coverr, vecteezy, vimeo, europeana, nara, commons, openverse, archive };

/** Modern footage → stock providers; period → archival first. */
export function providersFor(o: { kind: "video" | "image"; period: boolean }): string[] {
  if (o.period) return o.kind === "video" ? ["commons", "nara", "archive", "pixabay"] : ["commons", "europeana", "nara", "openverse", "pixabay"];
  return o.kind === "video" ? ["pexels", "pixabay", "coverr", "vecteezy", "commons"] : ["pexels", "pixabay", "vecteezy", "commons", "openverse"];
}

/** Every source that can supply this kind of picture: the pooled search asks all of them and judges by eye. */
export function allProviders(o: { kind: "video" | "image"; period: boolean }): string[] {
  if (o.kind === "video") return o.period ? ["commons", "nara", "archive", "pexels", "pixabay"] : ["pexels", "pixabay", "coverr", "vecteezy", "commons", "archive"];
  return o.period ? ["commons", "europeana", "nara", "openverse"] : ["pexels", "pixabay", "commons", "openverse"];
}

export async function searchStock(q: string, o: SearchOpts & { providers: string[] }): Promise<StockCandidate[]> {
  const res = await Promise.all(o.providers.map((p) => PROVIDERS[p]!(q, o).catch(() => [] as StockCandidate[])));
  return res.flat().filter((c) => !c.aiGenerated);
}

/** Where in a whole archive film the 20 s stretch is taken (the preview frame is taken from the same place). */
export const archiveAt = (c: { durationS?: number }) => Math.max(5, Math.min((c.durationS ?? 120) * 0.4, (c.durationS ?? 120) - 25));

/** Download a candidate's file (never into Library/). Vecteezy URLs are requested on demand. */
export async function downloadCandidate(c: StockCandidate, destDir: string): Promise<string> {
  let url = c.fileUrl;
  if (c.provider === "vecteezy") {
    const j = await get<{ url: string }>(`https://api.vecteezy.com/v2/${env("VECTEEZY_ACCOUNT_ID")}/resources/${c.externalId}/download?file_type=${c.kind === "video" ? "mp4" : "jpg"}${c.kind === "video" ? "&size=medium" : ""}`, { Authorization: `Bearer ${env("VECTEEZY_API_KEY")}` });
    url = j?.url ?? null;
  }
  if (!url) throw new Error(`no download URL for ${c.provider}:${c.externalId}`);
  // Commons: a standard-size rendering is served far more readily than the (often huge) original.
  if (c.provider === "commons" && c.kind === "image" && c.thumbUrl?.includes("/480px-") && (c.width ?? 0) > 1920) url = c.thumbUrl.replace("/480px-", "/1920px-");
  const ext = (path.extname(new URL(url).pathname).toLowerCase() || (c.kind === "video" ? ".mp4" : ".jpg")).slice(0, 6);
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${c.provider}_${c.externalId.replace(/[^\w.-]+/g, "_").slice(0, 60)}${ext}`);
  try {
    if ((await stat(dest)).size > 0) return dest; // idempotent
  } catch {
    /* not yet downloaded */
  }
  if (c.provider === "archive") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const at = archiveAt(c);
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(1), "-t", "20", "-i", url, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", `${dest}.part.mp4`], { timeout: 150_000 });
    await rename(`${dest}.part.mp4`, dest);
    return dest;
  }
  let r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(180_000) });
  // Busy archive (HTTP 429/503): wait and try again, twice.
  for (const waitMs of [4000, 12000]) {
    if (r.status !== 429 && r.status !== 503) break;
    await new Promise((res) => setTimeout(res, waitMs));
    r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(180_000) });
  }
  if (!r.ok || !r.body) throw new Error(`download ${r.status} for ${url.split("?")[0]}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(tmp));
  await rename(tmp, dest).catch(async (e) => {
    await unlink(tmp).catch(() => {});
    throw e;
  });
  return dest;
}
