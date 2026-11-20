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
const get = async <T>(url: string, headers: Record<string, string> = {}): Promise<T | null> => {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(20_000) });
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
    const j = await get<{ videos: Array<{ id: number; url: string; width: number; height: number; duration: number; tags?: string[]; user: { name: string }; video_files: Array<{ link: string; width: number; height: number; file_type: string }> }> }>(`https://api.pexels.com/videos/search?${qs}`, h);
    return (j?.videos ?? []).map((v) => {
      const files = v.video_files.filter((f) => f.file_type === "video/mp4").sort((a, b) => Math.abs(Math.max(a.width, a.height) - 1920) - Math.abs(Math.max(b.width, b.height) - 1920));
      const f = files[0];
      return { provider: "pexels" as const, externalId: String(v.id), kind: "video" as const, title: v.url.split("/").filter(Boolean).pop()?.replace(/-\d+$/, "").replace(/-/g, " ") ?? "", tags: v.tags ?? [], pageUrl: v.url, fileUrl: f?.link ?? null, width: f?.width, height: f?.height, durationS: v.duration, license: "Pexels License", attributionRequired: false, attributionText: `Video by ${v.user.name} on Pexels`, aiGenerated: false, archival: false };
    }).filter((c) => c.fileUrl);
  }
  const j = await get<{ photos: Array<{ id: number; url: string; width: number; height: number; alt: string; photographer: string; src: { large2x: string; original: string } }> }>(`https://api.pexels.com/v1/search?${qs}`, h);
  return (j?.photos ?? []).map((p) => ({ provider: "pexels" as const, externalId: String(p.id), kind: "image" as const, title: p.alt, tags: [], pageUrl: p.url, fileUrl: p.src.large2x, width: p.width, height: p.height, license: "Pexels License", attributionRequired: false, attributionText: `Photo by ${p.photographer} on Pexels`, aiGenerated: false, archival: false }));
}

/* ---------------- Pixabay ---------------- */
async function pixabay(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("PIXABAY_API_KEY")) return [];
  const base = `key=${env("PIXABAY_API_KEY")}&q=${encodeURIComponent(q.slice(0, 100))}&per_page=${Math.max(3, o.perPage)}&safesearch=true`;
  if (o.kind === "video") {
    const j = await get<{ hits: Array<{ id: number; pageURL: string; tags: string; duration: number; user: string; videos: Record<string, { url: string; width: number; height: number }> }> }>(`https://pixabay.com/api/videos/?${base}&video_type=film`);
    return (j?.hits ?? []).map((v) => {
      const f = v.videos.large?.url ? v.videos.large : v.videos.medium;
      return { provider: "pixabay" as const, externalId: String(v.id), kind: "video" as const, title: v.tags, tags: v.tags.split(",").map((t) => t.trim()), pageUrl: v.pageURL, fileUrl: f?.url || null, width: f?.width, height: f?.height, durationS: v.duration, license: "Pixabay Content License", attributionRequired: false, attributionText: `Video by ${v.user} on Pixabay`, aiGenerated: AI_TAG.test(v.tags), archival: false };
    }).filter((c) => c.fileUrl && !c.aiGenerated);
  }
  const j = await get<{ hits: Array<{ id: number; pageURL: string; tags: string; user: string; largeImageURL: string; imageWidth: number; imageHeight: number }> }>(`https://pixabay.com/api/?${base}&image_type=photo&orientation=${o.orientation === "portrait" ? "vertical" : "horizontal"}`);
  return (j?.hits ?? []).map((p) => ({ provider: "pixabay" as const, externalId: String(p.id), kind: "image" as const, title: p.tags, tags: p.tags.split(",").map((t) => t.trim()), pageUrl: p.pageURL, fileUrl: p.largeImageURL, width: p.imageWidth, height: p.imageHeight, license: "Pixabay Content License", attributionRequired: false, attributionText: `Image by ${p.user} on Pixabay`, aiGenerated: AI_TAG.test(p.tags), archival: false })).filter((c) => !c.aiGenerated);
}

/* ---------------- Coverr ---------------- */
async function coverr(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("COVERR_API_KEY") || o.kind !== "video") return [];
  const j = await get<{ hits: Array<{ id: string; title: string; slug: string; tags: string[]; duration: string; max_width: number; max_height: number; is_ai_generated?: boolean; is_premium?: boolean; urls: { mp4_download?: string; mp4?: string } }> }>(`https://api.coverr.co/videos?query=${encodeURIComponent(q)}&page_size=${o.perPage}&urls=true`, { Authorization: `Bearer ${env("COVERR_API_KEY")}` });
  return (j?.hits ?? []).filter((v) => !v.is_ai_generated && !v.is_premium).map((v) => ({ provider: "coverr" as const, externalId: v.id, kind: "video" as const, title: v.title, tags: v.tags ?? [], pageUrl: `https://coverr.co/videos/${v.slug}`, fileUrl: v.urls.mp4_download ?? v.urls.mp4 ?? null, width: v.max_width, height: v.max_height, durationS: Number(v.duration), license: "Coverr License", attributionRequired: false, attributionText: "Video from Coverr", aiGenerated: false, archival: false })).filter((c) => c.fileUrl);
}

/* ---------------- Vecteezy ---------------- */
async function vecteezy(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  if (!env("VECTEEZY_API_KEY") || !env("VECTEEZY_ACCOUNT_ID")) return [];
  const j = await get<{ resources: Array<{ id: number; title: string; tags: string[]; ai_generated: boolean | null; content_type: string; file_metadata?: { available_download_sizes?: Array<{ width: number; height: number }> } }> }>(`https://api.vecteezy.com/v2/${env("VECTEEZY_ACCOUNT_ID")}/resources?term=${encodeURIComponent(q)}&content_type=${o.kind === "video" ? "video" : "photo"}&per_page=${o.perPage}`, { Authorization: `Bearer ${env("VECTEEZY_API_KEY")}` });
  return (j?.resources ?? []).filter((r) => r.ai_generated !== true && !AI_TAG.test((r.tags ?? []).join(" "))).map((r) => {
    const big = r.file_metadata?.available_download_sizes?.[0];
    return { provider: "vecteezy" as const, externalId: String(r.id), kind: o.kind, title: r.title, tags: r.tags ?? [], pageUrl: `https://www.vecteezy.com/${o.kind === "video" ? "video" : "photo"}/${r.id}`, fileUrl: null, width: big?.width, height: big?.height, license: "Vecteezy License (API account)", attributionRequired: true, attributionText: "Stock media from Vecteezy.com", aiGenerated: false, archival: false };
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
  const j = await get<{ items?: Array<{ id: string; title?: string[]; rights?: string[]; edmIsShownBy?: string[]; guid: string; dataProvider?: string[]; year?: string[] }> }>(`https://api.europeana.eu/record/v2/search.json?wskey=${env("EUROPEANA_API_KEY")}&query=${encodeURIComponent(q)}&rows=${o.perPage}&reusability=open&media=true&qf=TYPE:IMAGE`);
  return (j?.items ?? []).flatMap((it) => {
    const r = it.rights?.[0] ?? "";
    const m = OPEN_RIGHTS.find(([re]) => re.test(r));
    const file = it.edmIsShownBy?.[0];
    if (!m || !file) return [];
    return [{ provider: "europeana" as const, externalId: it.id, kind: "image" as const, title: it.title?.[0] ?? "", tags: it.year ?? [], pageUrl: it.guid.split("?")[0]!, fileUrl: file, license: m[1], attributionRequired: m[2], attributionText: `${it.title?.[0] ?? "Untitled"} — ${it.dataProvider?.[0] ?? "Europeana"} (${m[1]})`, aiGenerated: false, archival: true }];
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
let commonsTokenRejected = false;
async function commons(q: string, o: SearchOpts): Promise<StockCandidate[]> {
  const ft = o.kind === "video" ? "filetype:video" : "filetype:bitmap";
  const h: Record<string, string> = env("WIKIMEDIA_ACCESS_TOKEN") && !commonsTokenRejected ? { Authorization: `Bearer ${env("WIKIMEDIA_ACCESS_TOKEN")}` } : {};
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${o.perPage}&gsrsearch=${encodeURIComponent(`${q} ${ft}`)}&prop=imageinfo&iiprop=url|extmetadata|size|mime`;
  // The read API is public: if the token is rejected (expired/revoked), continue anonymously.
  if (h.Authorization) {
    const probe = await fetch(url, { headers: { "user-agent": UA, ...h }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (probe && (probe.status === 401 || probe.status === 403)) {
      commonsTokenRejected = true;
      console.warn("  ! WIKIMEDIA_ACCESS_TOKEN rejected (HTTP " + probe.status + "); using anonymous Commons access — renew the token");
      delete h.Authorization;
    }
  }
  const j = await get<{ query?: { pages?: Record<string, { title: string; imageinfo?: Array<{ url: string; descriptionurl: string; width: number; height: number; mime: string; duration?: number; extmetadata?: Record<string, { value: string }> }> }> } }>(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${o.perPage}&gsrsearch=${encodeURIComponent(`${q} ${ft}`)}&prop=imageinfo&iiprop=url|extmetadata|size|mime`,
    h,
  );
  return Object.values(j?.query?.pages ?? {}).flatMap((p) => {
    const ii = p.imageinfo?.[0];
    const md = ii?.extmetadata ?? {};
    const lic = stripHtml(md.LicenseShortName?.value);
    if (!ii || !lic || /fair use|non-free/i.test(lic)) return [];
    const artist = stripHtml(md.Artist?.value) || "unknown";
    return [{ provider: "commons" as const, externalId: p.title, kind: o.kind, title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "), tags: stripHtml(md.Categories?.value).split("|").filter(Boolean), pageUrl: ii.descriptionurl, fileUrl: ii.url, width: ii.width, height: ii.height, ...(ii.duration ? { durationS: ii.duration } : {}), license: lic, attributionRequired: md.AttributionRequired?.value === "true" || /BY/.test(lic), attributionText: `${p.title.replace(/^File:/, "")} by ${artist}, ${lic}, via Wikimedia Commons`, aiGenerated: /AI-generated/i.test(stripHtml(md.Categories?.value)), archival: true }];
  }).filter((c) => !c.aiGenerated);
}

export const PROVIDERS: Record<string, (q: string, o: SearchOpts) => Promise<StockCandidate[]>> = { pexels, pixabay, coverr, vecteezy, vimeo, europeana, nara, commons };

/** Modern footage → stock providers; period → archival first. */
export function providersFor(o: { kind: "video" | "image"; period: boolean }): string[] {
  if (o.period) return o.kind === "video" ? ["commons", "nara", "pixabay"] : ["commons", "europeana", "nara", "pixabay"];
  return o.kind === "video" ? ["pexels", "pixabay", "coverr", "vecteezy", "vimeo"] : ["pexels", "pixabay", "vecteezy", "commons"];
}

export async function searchStock(q: string, o: SearchOpts & { providers: string[] }): Promise<StockCandidate[]> {
  const res = await Promise.all(o.providers.map((p) => PROVIDERS[p]!(q, o).catch(() => [] as StockCandidate[])));
  return res.flat().filter((c) => !c.aiGenerated);
}

/** Download a candidate's file (never into Library/). Vecteezy URLs are requested on demand. */
export async function downloadCandidate(c: StockCandidate, destDir: string): Promise<string> {
  let url = c.fileUrl;
  if (c.provider === "vecteezy") {
    const j = await get<{ url: string }>(`https://api.vecteezy.com/v2/${env("VECTEEZY_ACCOUNT_ID")}/resources/${c.externalId}/download?file_type=${c.kind === "video" ? "mp4" : "jpg"}${c.kind === "video" ? "&size=medium" : ""}`, { Authorization: `Bearer ${env("VECTEEZY_API_KEY")}` });
    url = j?.url ?? null;
  }
  if (!url) throw new Error(`no download URL for ${c.provider}:${c.externalId}`);
  const ext = (path.extname(new URL(url).pathname).toLowerCase() || (c.kind === "video" ? ".mp4" : ".jpg")).slice(0, 6);
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${c.provider}_${c.externalId.replace(/[^\w.-]+/g, "_").slice(0, 60)}${ext}`);
  try {
    if ((await stat(dest)).size > 0) return dest; // idempotent
  } catch {
    /* not yet downloaded */
  }
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(180_000) });
  if (!r.ok || !r.body) throw new Error(`download ${r.status} for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(tmp));
  await rename(tmp, dest).catch(async (e) => {
    await unlink(tmp).catch(() => {});
    throw e;
  });
  return dest;
}
