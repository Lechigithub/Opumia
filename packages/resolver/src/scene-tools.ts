/**
 * Tools the scene designer agent calls while it designs (the resolver owns sourcing, so they live here and are
 * handed to the agent as functions):
 *
 *  findPicture    a different or additional picture for one shot — every stock and archive source is asked,
 *                 previews are rated by eye against the line, the best fitting one is fetched; as the shot's
 *                 footage or as a picture slot.
 *  searchObjects  the licensed library's cut-out objects and icons, by keyword.
 *  addObject      one of them as a picture slot of a shot.
 *  cutOut         the subject of a photo slot lifted off its background (BiRefNet; keeps only source pixels).
 *
 * Everything added goes into the job's resolution with its licence and source, like any other picture.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isUsable } from "@opumia/agents";
import type { LibraryIndex, ResolutionReport, ResolvedMedia, Storyboard } from "@opumia/contracts";
import { ensureLocal } from "@opumia/ingest";
import { removeBackground } from "@opumia/senses";
import { periodCheck, reviewPictures, yearOf } from "./press.js";
import { materialize } from "./resolve.js";
import { allProviders, downloadCandidate, searchStock, sharpEnough, type StockCandidate } from "./stock.js";
import { thumbOf } from "./widen.js";

const sha = (s: string, n = 10) => createHash("sha1").update(s).digest("hex").slice(0, n);

export interface SceneToolsOptions {
  jobDir: string;
  dataDir: string;
  libraryRoot: string;
  index: LibraryIndex;
  storyboard: Storyboard;
  /** Mutated in place: new pictures are appended (and a replaced footage entry removed). */
  resolution: ResolutionReport;
  words: Array<{ word: string; startS: number }>;
  era: string;
  /** The year or decade each line is set in (from the sourcing plan), so a picture is judged against its own time. */
  whenOf?: (shotId: string) => string | undefined;
  /** Refs that may not be used (rejected earlier, or used by recent films). */
  blocked?: Set<string>;
  /** Colour for line icons (they are drawn in one colour). */
  iconColor?: string;
}
export interface AddedPicture { ok: true; shotId: string; as: "footage" | "slot"; slot?: number; kind: "video" | "image"; depicts: string; fit?: number; preview: string }
export type ToolFail = { ok: false; why: string };

export function makeSceneTools(o: SceneToolsOptions) {
  const mediaDir = path.join(o.jobDir, "public", "media");
  const dlDir = path.join(o.jobDir, "downloads");
  const thumbDir = path.join(dlDir, "thumbs");
  const orientation = o.storyboard.aspect === "9:16" ? ("portrait" as const) : ("landscape" as const);
  const shot = (id: string) => o.storyboard.shots.find((s) => s.id === id);
  const lineOf = (id: string) => {
    const sh = shot(id);
    return sh ? o.words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : "";
  };
  const used = () => new Set(o.resolution.media.filter((m) => m.role === "primary" || m.role === "layer").map((m) => m.ref));
  const nextSlot = (id: string) => Math.max(7, ...o.resolution.media.filter((m) => m.shotId === id && m.role === "layer").map((m) => m.slot ?? 0)) + 1;

  /** Ask every source, rate previews against the line, fetch the best. */
  async function findPicture(i: { shotId: string; want: string; as: "footage" | "slot"; kind: "video" | "image" }): Promise<AddedPicture | ToolFail> {
    const sh = shot(i.shotId);
    if (!sh) return { ok: false, why: `no shot ${i.shotId}` };
    const kind = i.as === "slot" ? "image" : i.kind;
    const q = i.want.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    if (q.length < 4) return { ok: false, why: "say what the picture should show in a few plain words" };
    const found: StockCandidate[] = (await Promise.all([searchStock(q, { kind, orientation, perPage: 6, providers: ["pexels"] }).catch(() => []), searchStock(q, { kind, orientation, perPage: 3, providers: allProviders({ kind, period: false }).filter((p) => p !== "pexels") }).catch(() => []), ...(kind === "image" ? [searchStock(q, { kind, orientation, perPage: 3, providers: ["openverse", "europeana"] }).catch(() => [])] : [])])).flat();
    const taken = used();
    const cands = found.filter((c) => !c.aiGenerated && sharpEnough(c) && !taken.has(`${c.provider}:${c.externalId}`) && !o.blocked?.has(`${c.provider}:${c.externalId}`)).slice(0, 18);
    if (!cands.length) return { ok: false, why: `no source returned anything for "${q}" — try other words (what a stock library would call it)` };
    const withThumb = (
      await Promise.all(
        cands.map(async (c) => {
          const thumb = path.join(thumbDir, `${sha(`${c.provider}:${c.externalId}`, 14)}.jpg`);
          const ok = c.thumbUrl ? await thumbOf({ url: c.thumbUrl }, thumb) : c.fileUrl ? await thumbOf(c.kind === "image" ? { url: c.fileUrl } : { url: c.fileUrl, video: true, atS: 1 }, thumb) : false;
          return ok ? { c, thumb } : null;
        }),
      )
    ).filter((x): x is { c: StockCandidate; thumb: string } => x !== null);
    if (!withThumb.length) return { ok: false, why: "candidates were found but none could be previewed" };
    const rated = await reviewPictures(withThumb.map((x) => ({ frameFile: x.thumb, intent: i.want, line: lineOf(i.shotId), era: o.whenOf?.(i.shotId) || o.era })));
    let fits = withThumb.map((x, k) => ({ ...x, r: rated[k]! })).filter((x) => x.r.shows !== "not reviewed" && x.r.fit >= 6 && !x.r.wrongEra && !x.r.banner && !x.r.synthetic).sort((a, b) => b.r.fit - a.r.fit);
    const year = yearOf(o.whenOf?.(i.shotId));
    if (year !== null && year <= 2008 && fits.length) {
      fits = fits.slice(0, 4);
      const dated = await periodCheck(fits.map((x) => ({ frameFile: x.thumb, year })));
      const kept = fits.filter((_, k) => dated[k]!.ok);
      if (!kept.length) return { ok: false, why: `the pictures that fit all look later than ${year} (${dated.map((d) => d.evidence).filter(Boolean).slice(0, 2).join("; ")}). Ask for something timeless: a close-up of hands, an object, paper, a place with nothing modern in it.` };
      fits = kept;
    }
    const best = fits[0];
    if (!best) return { ok: false, why: `${withThumb.length} candidates were looked at and none fitted (best ${Math.max(...rated.map((r) => r.fit))}/10). Ask for something more common or more concrete.` };
    await mkdir(mediaDir, { recursive: true });
    const c = best.c;
    const dl = await downloadCandidate(c, dlDir).catch(() => null);
    if (!dl) return { ok: false, why: "the best candidate could not be downloaded" };
    const ref = `${c.provider}:${c.externalId}`;
    const base: Omit<ResolvedMedia, "role" | "localPath" | "publicPath"> = { shotId: i.shotId, origin: c.archival ? "archival" : "stock", ref, provider: c.provider, kind: c.kind, ...(c.width ? { width: c.width, height: c.height } : {}), license: c.license, attributionRequired: c.attributionRequired, ...(c.attributionText ? { attributionText: c.attributionText } : {}), sourceUrl: c.pageUrl, aiGenerated: false, score: best.r.fit / 10, query: q, depicts: best.r.shows, seen: { fit: best.r.fit, face: best.r.face, banner: best.r.banner, note: best.r.shows } };
    if (i.as === "footage") {
      const file = `${i.shotId}_${sha(ref, 8)}.${c.kind === "video" ? "mp4" : "jpg"}`;
      await materialize(dl, c.kind, path.join(mediaDir, file), 0, sh.endS - sh.startS, false);
      const at = o.resolution.media.findIndex((m) => m.shotId === i.shotId && m.role === "primary");
      if (at >= 0) o.resolution.media.splice(at, 1);
      o.resolution.media.push({ ...base, role: "primary", localPath: path.join(mediaDir, file), publicPath: `media/${file}`, durationS: sh.endS - sh.startS });
      return { ok: true, shotId: i.shotId, as: "footage", kind: c.kind, depicts: best.r.shows, fit: best.r.fit, preview: best.thumb };
    }
    const slot = nextSlot(i.shotId);
    const file = `layer_${i.shotId}_${slot}_${sha(ref, 8)}.jpg`;
    await materialize(dl, "image", path.join(mediaDir, file), 0, 1, false);
    o.resolution.media.push({ ...base, kind: "image", role: "layer", slot, localPath: path.join(mediaDir, file), publicPath: `media/${file}`, depicts: `${best.r.shows} — photo${c.width && c.height ? ` (${(c.width / c.height).toFixed(2)}:1)` : ""}` });
    return { ok: true, shotId: i.shotId, as: "slot", slot, kind: "image", depicts: best.r.shows, fit: best.r.fit, preview: best.thumb };
  }

  /** Licensed cut-out objects (photographs on transparency) and line icons, by keyword. */
  function searchObjects(i: { query: string }): Array<{ id: string; type: "object" | "icon"; name: string; tags: string[] }> {
    const q = i.query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!q.length) return [];
    const pool = o.index.assets.filter((a) => isUsable(a) && ((a.category === "objects" && a.ext === "png") || (a.category === "icons" && a.ext === "svg")));
    return pool
      .map((a) => {
        const name = path.basename(a.relPath, path.extname(a.relPath)).replace(/[_-]+/g, " ");
        const hay = `${name} ${a.tags.join(" ")}`.toLowerCase();
        return { a, name, score: q.filter((w) => hay.includes(w)).length + (q.some((w) => name.split(" ").includes(w)) ? 1 : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || (x.a.category === "objects" ? -1 : 1) || x.a.id.localeCompare(y.a.id))
      .slice(0, 14)
      .map((x) => ({ id: x.a.id, type: x.a.category === "objects" ? ("object" as const) : ("icon" as const), name: x.name, tags: x.a.tags.slice(0, 8) }));
  }

  async function addObject(i: { shotId: string; assetId: string }): Promise<AddedPicture | ToolFail> {
    if (!shot(i.shotId)) return { ok: false, why: `no shot ${i.shotId}` };
    const a = o.index.assets.find((x) => x.id === i.assetId && isUsable(x) && (x.category === "objects" || x.category === "icons"));
    if (!a) return { ok: false, why: `no library object ${i.assetId}; use search_library_objects` };
    await mkdir(mediaDir, { recursive: true });
    const src = await ensureLocal(o.libraryRoot, a.relPath, "library");
    const slot = nextSlot(i.shotId);
    const svg = a.ext === "svg";
    const file = `layer_${i.shotId}_${slot}_${a.id.slice(0, 8)}.${svg ? "svg" : "png"}`;
    const out = path.join(mediaDir, file);
    if (svg) await writeFile(out, (await readFile(src, "utf8")).replace(/currentColor/g, o.iconColor ?? "#ffffff").replace(/width="24"/, 'width="512"').replace(/height="24"/, 'height="512"'));
    else await copyFile(src, out);
    const name = path.basename(a.relPath, path.extname(a.relPath)).replace(/[_-]+/g, " ");
    o.resolution.media.push({ shotId: i.shotId, role: "layer", slot, origin: "library", ref: a.id, provider: "library", kind: "image", localPath: out, publicPath: `media/${file}`, ...(a.probe?.width ? { width: a.probe.width, height: a.probe.height } : svg ? { width: 512, height: 512 } : {}), license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}), aiGenerated: false, score: 1, query: name, depicts: `${name} — ${svg ? "line icon (transparent)" : "cut-out object (transparent)"}` });
    return { ok: true, shotId: i.shotId, as: "slot", slot, kind: "image", depicts: `${name} (${svg ? "icon" : "cut-out object"})`, preview: svg ? "" : out };
  }

  /** Lift the subject of a photo slot off its background; the cut-out becomes a new slot of the same shot. */
  async function cutOut(i: { shotId: string; slot: number }): Promise<AddedPicture | ToolFail> {
    const m = o.resolution.media.find((x) => x.shotId === i.shotId && x.role === "layer" && x.slot === i.slot);
    if (!m) return { ok: false, why: `shot ${i.shotId} has no picture slot ${i.slot}` };
    if (/\.(png|svg)$/i.test(m.localPath)) return { ok: false, why: "that slot is already a transparent cut-out or icon" };
    const slot = nextSlot(i.shotId);
    const file = `layer_${i.shotId}_${slot}_cut_${sha(m.ref, 8)}.png`;
    const out = path.join(mediaDir, file);
    const cut = await removeBackground(m.localPath, out, o.dataDir).catch((e: Error) => e);
    if (cut instanceof Error) return { ok: false, why: `cut-out failed: ${cut.message.slice(0, 120)}` };
    if (cut.coverage < 0.04 || cut.coverage > 0.92) return { ok: false, why: `no clear subject to cut out (the subject would cover ${Math.round(cut.coverage * 100)} % of the picture). Use the photo as it is.` };
    o.resolution.media.push({ ...m, slot, localPath: out, publicPath: `media/${file}`, width: cut.width, height: cut.height, depicts: `${(m.depicts ?? m.query).replace(/ — photo.*$/, "")} — cut-out of the subject (transparent, ${(cut.width / cut.height).toFixed(2)}:1)` });
    return { ok: true, shotId: i.shotId, as: "slot", slot, kind: "image", depicts: "cut-out of the subject", preview: out };
  }

  return { findPicture, searchObjects, addObject, cutOut };
}
export type SceneTools = ReturnType<typeof makeSceneTools>;

// ---------------------------------------------------------------------------------------------------------
// Footage probe for the director: does a picture like this exist? (asked before a shot is committed)

export interface ProbeResult { key: string; found: number; fit: number; shows: string; candidates: StockCandidate[]; /** Preview of the best candidate, for the director to look at. */ thumb?: string }

/**
 * Searches the stock and archive sources for each described picture and rates the previews by eye against the
 * line (and the line's own year). Nothing is downloaded. The best candidates are returned so sourcing can start
 * from them instead of searching blind.
 */
export function makeFootageProbe(o: { jobDir: string; aspect: string; era: string }) {
  const thumbDir = path.join(o.jobDir, "downloads", "thumbs");
  const orientation = o.aspect === "9:16" ? ("portrait" as const) : ("landscape" as const);
  return async function probe(items: Array<{ key: string; want: string; kind: "video" | "image"; line: string; when?: string }>): Promise<ProbeResult[]> {
    return Promise.all(
      items.map(async (it): Promise<ProbeResult> => {
        const q = it.want.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
        if (q.length < 4) return { key: it.key, found: 0, fit: 0, shows: "the request was too short to search", candidates: [] };
        const found = (await Promise.all([searchStock(q, { kind: it.kind, orientation, perPage: 6, providers: ["pexels"] }).catch(() => []), searchStock(q, { kind: it.kind, orientation, perPage: 3, providers: ["pixabay", "commons"] }).catch(() => [])])).flat().filter((c) => !c.aiGenerated && sharpEnough(c)).slice(0, 10);
        const withThumb = (
          await Promise.all(
            found.map(async (c) => {
              const thumb = path.join(thumbDir, `${sha(`${c.provider}:${c.externalId}`, 14)}.jpg`);
              const ok = c.thumbUrl ? await thumbOf({ url: c.thumbUrl }, thumb) : c.fileUrl ? await thumbOf(c.kind === "image" ? { url: c.fileUrl } : { url: c.fileUrl, video: true, atS: 1 }, thumb) : false;
              return ok ? { c, thumb } : null;
            }),
          )
        ).filter((x): x is { c: StockCandidate; thumb: string } => x !== null);
        if (!withThumb.length) return { key: it.key, found: 0, fit: 0, shows: "no source returned anything", candidates: [] };
        const rated = await reviewPictures(withThumb.map((x) => ({ frameFile: x.thumb, intent: it.want, line: it.line, era: it.when || o.era }))).catch(() => []);
        let good = withThumb.map((x, k) => ({ ...x, r: rated[k] })).filter((x) => x.r && x.r.shows !== "not reviewed" && !x.r.wrongEra && !x.r.banner && !x.r.synthetic).sort((a, b) => b.r!.fit - a.r!.fit);
        const year = yearOf(it.when);
        let lateNote = "";
        if (year !== null && year <= 2008 && good.some((x) => x.r!.fit >= 6)) {
          const top = good.filter((x) => x.r!.fit >= 6).slice(0, 3);
          const dated = await periodCheck(top.map((x) => ({ frameFile: x.thumb, year })));
          const late = new Set(top.filter((_, k) => !dated[k]!.ok));
          if (late.size === top.length) lateNote = `what fits looks later than ${year} (${dated.map((d) => d.evidence).filter(Boolean).slice(0, 2).join("; ")})`;
          good = good.filter((x) => !late.has(x) && (x.r!.fit < 6 || top.includes(x)));
        }
        const best = lateNote ? undefined : good[0];
        return { key: it.key, found: withThumb.length, fit: lateNote ? 3 : (best?.r?.fit ?? Math.max(0, ...rated.map((r) => (r.wrongEra ? Math.min(r.fit, 4) : r.fit)))), shows: lateNote || (best?.r?.shows ?? (rated.some((r) => r.wrongEra) ? "only pictures from the wrong period" : "nothing usable")), candidates: lateNote ? [] : good.filter((x) => x.r!.fit >= 6).slice(0, 3).map((x) => x.c), ...(best ? { thumb: best.thumb } : {}) };
      }),
    );
  };
}
