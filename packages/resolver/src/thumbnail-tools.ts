/**
 * Picture tools for the packaging agent's thumbnail work. Every picture is real: a photo or logo found in the
 * sources (rated by eye before it is kept), a frame of the film's own footage (press clips give real expressions),
 * a licensed library object or overlay (fire, smoke, sparks, light filmed on black), or a cut-out of one of these.
 * Nothing is generated. Each picture keeps its source and licence for the credits.
 *
 * Pictures live in their own small public folder (out/<job>/thumb-public/) so a thumbnail render bundles in
 * seconds instead of snapshotting the film's media.
 */
import { sharpEnough as _sharp } from "./stock.js";
/** Thumbnails are seen full-frame at 1280×720: stills need ≥ 1280 px on the long side (archival ≥ 900). */
const thumbSharp = (c: { kind: "video" | "image"; width?: number; height?: number; archival: boolean }) => !c.width || !c.height || (c.kind === "video" ? _sharp(c) : Math.max(c.width, c.height) >= (c.archival ? 900 : 1280));
import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isUsable } from "@opumia/agents";
import type { FactSheet, LibraryIndex, ResolutionReport, ResolvedMedia, Storyboard } from "@opumia/contracts";
import { ensureLocal } from "@opumia/ingest";
import { removeBackground, run } from "@opumia/senses";
import { MODELS, plain, structured } from "@opumia/agents";
import * as z from "zod/v4";
import { reviewPictures, visionCheck, wikipediaImages, youtubeStills, type PressStill } from "./press.js";
import { downloadCandidate, searchStock, type StockCandidate } from "./stock.js";
import { thumbOf } from "./widen.js";

const sha = (s: string, n = 10) => createHash("sha1").update(s).digest("hex").slice(0, n);
/** Never taken: pictures credited to photo agencies. */
const AGENCY = /\b(getty|associated press|\bap photo|reuters|alamy|shutterstock|afp|epa|corbis|bloomberg via|wireimage)\b/i;

export interface ThumbCredit { origin: ResolvedMedia["origin"] | "film"; provider: string; ref: string; license: string; attributionRequired: boolean; attributionText?: string; sourceUrl?: string; fairUse?: string }
export interface ThumbPicture {
  slot: number;
  /** Path relative to the thumbnail public folder (what the renderer reads). */
  pub: string;
  file: string;
  depicts: string;
  kind: "photo" | "cutout" | "logo" | "object" | "icon" | "overlay";
  aspect: number;
  /** Pixel width of the stored picture (a picture shown much wider than this looks soft). */
  width?: number;
  /** Shows a face (from the eye check); a face that is not the named subject must never stand in for them. */
  face: boolean;
  /** The picture is verifiably of a named subject of the film (its own source names them). */
  named: boolean;
  fit?: number;
  /** Average colour (#rrggbb): what a cut-out placed in front of this picture should be lit with. */
  mean?: string;
  credit: ThumbCredit;
}
export type Fail = { ok: false; why: string };

export interface ThumbToolsOptions {
  jobDir: string;
  dataDir: string;
  libraryRoot: string;
  index: LibraryIndex;
  resolution: ResolutionReport;
  facts: FactSheet;
  board: Storyboard;
  /** Refs that may not be used (rejected earlier). */
  blocked?: Set<string>;
  log?: (s: string) => void;
}

export function makeThumbnailTools(o: ThumbToolsOptions) {
  const pubDir = path.join(o.jobDir, "thumb-public");
  const picDir = path.join(pubDir, "pic");
  const dl = path.join(o.jobDir, "downloads", "thumb");
  const pics: ThumbPicture[] = [];
  let dirty = true;
  const subjects = [...new Set(o.board.shots.flatMap((s) => (s.entities ?? []).map((e) => e.name)))];
  const film = `${o.facts.topic}: ${o.facts.summary}`.slice(0, 300);

  async function dims(f: string): Promise<[number, number]> {
    const pr = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", f]);
    const [w, h] = pr.stdout.trim().split(",").map(Number) as [number, number];
    return [w || 1, h || 1];
  }
  /** Normalise any picture (jpg/png/svg/webp or a video frame) into the thumbnail folder. */
  async function add(src: string, p: Omit<ThumbPicture, "slot" | "pub" | "file" | "aspect">, atS?: number): Promise<ThumbPicture> {
    await mkdir(picDir, { recursive: true });
    const slot = pics.length;
    const png = p.kind === "cutout" || p.kind === "logo" || p.kind === "object" || p.kind === "icon" || /\.(png|svg|webp)$/i.test(src);
    const name = `p${slot}_${sha(src + (atS ?? ""), 8)}.${png && p.kind !== "overlay" ? "png" : "jpg"}`;
    const out = path.join(picDir, name);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...(atS !== undefined ? ["-ss", String(atS)] : []), "-i", src, "-vf", "scale='min(1600,iw)':-2", "-frames:v", "1", "-update", "1", ...(name.endsWith(".jpg") ? ["-q:v", "2"] : []), out]);
    const [w, h] = await dims(out);
    const pic: ThumbPicture = { ...p, slot, pub: `pic/${name}`, file: out, aspect: w / h, width: w, ...(p.kind === "photo" || p.kind === "overlay" ? { mean: await meanColour(out) } : {}) };
    pics.push(pic);
    dirty = true;
    return pic;
  }
  const brief = (p: ThumbPicture) => `[${p.slot}] ${p.depicts} — ${p.kind}, ${p.aspect.toFixed(2)}:1${p.width ? `, ${p.width} px wide` : ""}${p.face ? ", face" : ""}${p.named ? ", verified subject" : ""}${p.fit !== undefined ? `, fit ${p.fit}/10` : ""} (${p.credit.origin}, ${p.credit.provider})`;
  const creditOf = (c: StockCandidate, origin: ThumbCredit["origin"]): ThumbCredit => ({ origin, provider: c.provider, ref: `${c.provider}:${c.externalId}`, license: c.license, attributionRequired: c.attributionRequired, ...(c.attributionText ? { attributionText: c.attributionText } : {}), sourceUrl: c.pageUrl });
  const creditOfMedia = (m: ResolvedMedia): ThumbCredit => ({ origin: m.origin, provider: m.provider, ref: m.ref, license: m.license, attributionRequired: m.attributionRequired, ...(m.attributionText ? { attributionText: m.attributionText } : {}), ...(m.sourceUrl ? { sourceUrl: m.sourceUrl } : {}), ...(m.fairUse ? { fairUse: `${m.fairUse.sourceTitle ?? m.ref}${m.fairUse.channel ? ` (${m.fairUse.channel})` : ""}` } : {}) });
  const has = (ref: string) => pics.some((p) => p.credit.ref === ref);

  async function meanColour(f: string): Promise<string | undefined> {
    try {
      const { execFile } = await import("node:child_process");
      const buf = await new Promise<Buffer>((res, rej) => execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "scale=1:1:flags=area", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 16 }, (e, out) => (e ? rej(e) : res(out))));
      return buf.length >= 3 ? `#${[...buf.subarray(0, 3)].map((x) => x.toString(16).padStart(2, "0")).join("")}` : undefined;
    } catch {
      return undefined;
    }
  }
  /** Share of dark and of bright pixels on a small grey version: an overlay filmed on black is mostly dark with a dense bright core. */
  async function darkBright(f: string): Promise<{ dark: number; bright: number }> {
    try {
      const { execFile } = await import("node:child_process");
      const buf = await new Promise<Buffer>((res, rej) => execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "scale=64:36:flags=area,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 16 }, (e, out) => (e ? rej(e) : res(out))));
      const px = [...buf];
      return { dark: px.filter((v) => v < 28).length / Math.max(1, px.length), bright: px.filter((v) => v > 110).length / Math.max(1, px.length) };
    } catch {
      return { dark: 0, bright: 0 };
    }
  }

  /** The film's own verified press stills and the main subjects' Wikipedia photos and logos. */
  async function gather(): Promise<ThumbPicture[]> {
    for (const m of o.resolution.media) {
      if (m.kind !== "image" || m.origin !== "press" || m.provider === "web" || has(m.ref) || AGENCY.test(m.attributionText ?? "")) continue;
      const logo = /logo|wordmark/i.test(`${m.depicts ?? ""} ${m.ref}`);
      await add(m.localPath, { depicts: (m.depicts ?? m.query).replace(/, referred to as.*$/, ""), kind: logo ? "logo" : "photo", face: !logo && Boolean(m.seen?.face ?? /person/i.test(m.depicts ?? "")), named: true, credit: creditOfMedia(m) }).catch(() => null);
      if (pics.length >= 6) break;
    }
    const counts = new Map<string, { n: number; type: string }>();
    for (const s of o.board.shots) for (const e of s.entities ?? []) if (["person", "company", "product"].includes(e.type)) counts.set(e.name, { n: (counts.get(e.name)?.n ?? 0) + 1, type: e.type });
    for (const [name, v] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3)) {
      const last = name.toLowerCase().split(" ").at(-1)!;
      if (pics.filter((p) => p.depicts.toLowerCase().includes(last)).length >= 2) continue;
      await findSubject(name, v.type, 2).catch(() => null);
    }
    return pics;
  }

  async function findSubject(subject: string, type: string, keep: number): Promise<ThumbPicture[]> {
    const found = (await wikipediaImages({ name: subject, type }, path.join(dl, "wiki"), 5).catch(() => [])).filter((c) => !has(`${c.provider}:${c.externalId}`) && !AGENCY.test(c.attributionText ?? ""));
    if (!found.length) return [];
    const ok = await visionCheck(found.map((c) => ({ frameFile: c.frameFile, depicts: c.depicts, line: film }))).catch(() => []);
    const good = found.map((c, k) => ({ c, v: ok[k] })).filter((x) => x.v?.shows && (x.v.quality ?? 0) >= 5 && !x.v.banner).sort((a, b) => (b.v!.quality ?? 0) - (a.v!.quality ?? 0)).slice(0, keep);
    const out: ThumbPicture[] = [];
    for (const x of good) {
      const logo = x.c.tags.includes("logo");
      out.push(await add(x.c.localFile, { depicts: x.c.depicts, kind: logo ? "logo" : "photo", face: !logo && type === "person", named: true, fit: x.v!.quality, credit: { ...creditOf(x.c, "press"), ...(x.c.fairUse ? { fairUse: x.c.fairUse.sourceTitle } : {}) } }));
    }
    return out;
  }

  /** A new real picture: of a named subject (Wikipedia, Commons) or of a thing, place or object (stock and archives). */
  async function findPicture(i: { want: string; subject?: string; type: "person" | "company" | "product" | "object" | "place" | "texture" }): Promise<{ ok: true; added: ThumbPicture[]; previews: string[]; looked: number } | Fail> {
    if (i.subject && ["person", "company", "product"].includes(i.type)) {
      if (!subjects.some((s) => s.toLowerCase() === i.subject!.toLowerCase()) && !`${o.facts.topic} ${o.facts.summary}`.toLowerCase().includes(i.subject.toLowerCase())) return { ok: false, why: `${i.subject} is not a subject of this film (${subjects.slice(0, 8).join(", ")})` };
      const added = await findSubject(i.subject, i.type, 2);
      if (added.length) return { ok: true, added, previews: added.map((p) => p.file), looked: added.length };
      if (i.type === "person") return { ok: false, why: `no usable photo of ${i.subject} found on Wikipedia or Commons. Try film_footage: a real frame of them from the film's own press clips.` };
    }
    const q = i.want.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    if (q.length < 3) return { ok: false, why: "say what the picture should show in a few plain words" };
    const cands = (await Promise.all([searchStock(q, { kind: "image", orientation: "landscape", perPage: 6, providers: ["pexels"] }).catch(() => []), searchStock(q, { kind: "image", orientation: "landscape", perPage: 4, providers: ["pixabay", "commons", "openverse"] }).catch(() => [])]))
      .flat()
      .filter((c) => !c.aiGenerated && thumbSharp(c) && !AGENCY.test(`${c.attributionText ?? ""} ${c.title}`) && !has(`${c.provider}:${c.externalId}`) && !o.blocked?.has(`${c.provider}:${c.externalId}`))
      .slice(0, 14);
    if (!cands.length) return { ok: false, why: `no source returned anything for "${q}" — try the words a stock library would use` };
    const withThumb = (await Promise.all(cands.map(async (c) => {
      const t = path.join(dl, "prev", `${sha(`${c.provider}:${c.externalId}`, 14)}.jpg`);
      return (await thumbOf({ url: c.thumbUrl ?? c.fileUrl ?? "" }, t)) ? { c, t } : null;
    }))).filter((x): x is { c: StockCandidate; t: string } => x !== null);
    if (!withThumb.length) return { ok: false, why: "candidates were found but none could be previewed" };
    const rated = await reviewPictures(withThumb.map((x) => ({ frameFile: x.t, intent: i.want, line: `thumbnail picture for a film about ${film}`, era: "any period" })));
    // A face from stock is allowed only for an anonymous role (a crowd, hands, an employee) — never as a named subject.
    const fits = withThumb.map((x, k) => ({ ...x, r: rated[k]! })).filter((x) => x.r.fit >= 6 && !x.r.banner && !x.r.synthetic && x.r.shows !== "not reviewed").sort((a, b) => b.r.fit - a.r.fit).slice(0, 2);
    if (!fits.length) return { ok: false, why: `${withThumb.length} candidates looked at, none fitted (best ${Math.max(0, ...rated.map((r) => r.fit))}/10). Ask for something more concrete.` };
    const added: ThumbPicture[] = [];
    for (const f of fits) {
      const file = await downloadCandidate(f.c, dl).catch(() => null);
      if (!file) continue;
      added.push(await add(file, { depicts: f.r.shows, kind: i.type === "texture" ? "photo" : "photo", face: f.r.face, named: false, fit: f.r.fit, credit: creditOf(f.c, f.c.archival ? "archival" : "stock") }));
    }
    return added.length ? { ok: true, added, previews: added.map((p) => p.file), looked: withThumb.length } : { ok: false, why: "the pictures that fitted could not be downloaded" };
  }

  /** The film's own footage: what each shot shows (press clips of the real people first). */
  function filmShots(): Array<{ shotId: string; kind: string; origin: string; depicts: string; seconds: number }> {
    return o.resolution.media
      .filter((m) => m.role === "primary" && (m.kind === "video" || m.kind === "image"))
      .map((m) => ({ shotId: m.shotId, kind: m.kind, origin: m.origin, depicts: (m.depicts ?? m.query).slice(0, 90), seconds: m.durationS ?? 0 }))
      .sort((a, b) => (a.origin === "press" ? -1 : 0) - (b.origin === "press" ? -1 : 0));
  }
  /** Six frames of one shot side by side, each labelled with its time, so the strongest moment can be chosen. */
  async function filmStrip(i: { shotId: string }): Promise<{ ok: true; strip: string; times: number[] } | Fail> {
    const m = o.resolution.media.find((x) => x.shotId === i.shotId && x.role === "primary");
    if (!m) return { ok: false, why: `no footage in shot ${i.shotId}` };
    if (m.kind === "image") return { ok: true, strip: m.localPath, times: [0] };
    const len = Math.max(0.5, m.durationS ?? 3);
    const times = Array.from({ length: 6 }, (_, k) => Math.round(((k + 0.5) / 6) * len * 100) / 100);
    const out = path.join(dl, `strip_${i.shotId}.jpg`);
    await mkdir(dl, { recursive: true });
    const fps = 6 / len;
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", m.localPath, "-vf", `fps=${fps.toFixed(4)},scale=420:-2,tile=3x2:padding=4`, "-frames:v", "1", "-update", "1", out]);
    return { ok: true, strip: out, times };
  }
  async function useFilmFrame(i: { shotId: string; atS: number }): Promise<{ ok: true; pic: ThumbPicture } | Fail> {
    const m = o.resolution.media.find((x) => x.shotId === i.shotId && x.role === "primary");
    if (!m) return { ok: false, why: `no footage in shot ${i.shotId}` };
    const at = Math.max(0, Math.min((m.durationS ?? 1) - 0.05, i.atS));
    const pic = await add(m.localPath, { depicts: `frame of the film's footage: ${(m.depicts ?? m.query).slice(0, 80)}`, kind: "photo", face: Boolean(m.seen?.face), named: m.origin === "press", credit: creditOfMedia(m) }, m.kind === "video" ? at : undefined);
    return { ok: true, pic };
  }

  async function cutOut(i: { slot: number }): Promise<{ ok: true; pic: ThumbPicture; coverage: number } | Fail> {
    const p = pics[i.slot];
    if (!p) return { ok: false, why: `no picture ${i.slot}` };
    if (p.kind !== "photo") return { ok: false, why: `picture ${i.slot} is already a ${p.kind}` };
    const out = path.join(picDir, `p${pics.length}_cut_${sha(p.file, 8)}.png`);
    const cut = await removeBackground(p.file, out, o.dataDir).catch((e: Error) => e);
    if (cut instanceof Error) return { ok: false, why: `cut-out failed: ${cut.message.slice(0, 120)}` };
    if (cut.coverage < 0.04 || cut.coverage > 0.92) return { ok: false, why: `no clear subject to cut out (it would cover ${Math.round(cut.coverage * 100)} % of the picture) — use it whole, as a background or a photo` };
    const pic: ThumbPicture = { ...p, slot: pics.length, file: out, pub: `pic/${path.basename(out)}`, kind: "cutout", aspect: cut.width / Math.max(1, cut.height), width: cut.width, depicts: `${p.depicts} — cut out` };
    pics.push(pic);
    dirty = true;
    return { ok: true, pic, coverage: cut.coverage };
  }

  /** Library: cut-out objects (png), line icons (svg) and overlays filmed on black (fire, smoke, sparks, light). */
  function searchLibrary(i: { query: string; kind: "object" | "icon" | "overlay" }): Array<{ id: string; name: string; tags: string[] }> {
    const q = i.query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const pool = o.index.assets.filter((a) => isUsable(a) && (i.kind === "object" ? a.category === "objects" && a.ext === "png" : i.kind === "icon" ? a.category === "icons" && a.ext === "svg" : a.category === "overlays" && ["mp4", "mov", "png", "jpg"].includes(a.ext)));
    return pool
      .map((a) => {
        const name = path.basename(a.relPath, path.extname(a.relPath)).replace(/[_-]+/g, " ");
        const hay = `${a.relPath} ${a.tags.join(" ")}`.toLowerCase();
        return { a, name, score: q.length ? q.filter((w) => hay.includes(w)).length : 1 };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id))
      .slice(0, 14)
      .map((x) => ({ id: x.a.id, name: x.name, tags: x.a.tags.slice(0, 6) }));
  }
  async function addLibrary(i: { assetId: string; color?: string }): Promise<{ ok: true; pic: ThumbPicture } | Fail> {
    const a = o.index.assets.find((x) => x.id === i.assetId && isUsable(x));
    if (!a) return { ok: false, why: `no usable library asset ${i.assetId}` };
    const src = await ensureLocal(o.libraryRoot, a.relPath, "library");
    const kind: ThumbPicture["kind"] = a.category === "overlays" ? "overlay" : a.category === "icons" ? "icon" : "object";
    let from = src;
    if (a.ext === "svg") {
      const { readFile, writeFile } = await import("node:fs/promises");
      from = path.join(dl, `${a.id.slice(0, 10)}.svg`);
      await mkdir(dl, { recursive: true });
      await writeFile(from, (await readFile(src, "utf8")).replace(/currentColor/g, i.color && /^#[0-9a-f]{6}$/i.test(i.color) ? i.color : "#ffffff").replace(/width="24"/, 'width="1024"').replace(/height="24"/, 'height="1024"'));
    }
    const name = path.basename(a.relPath, path.extname(a.relPath)).replace(/[_-]+/g, " ");
    const atS = a.category === "overlays" && /\.(mp4|mov)$/i.test(a.relPath) ? Math.min(3, (a.probe?.durationS ?? 4) / 2) : undefined;
    const pic = await add(from, { depicts: `library ${kind}: ${name}${kind === "overlay" ? " (filmed on black — blend with screen)" : ""}`, kind, face: false, named: false, credit: { origin: "library", provider: "library", ref: a.id, license: a.provenance.license!, attributionRequired: a.provenance.attributionRequired ?? false, ...(a.provenance.attributionText ? { attributionText: a.provenance.attributionText } : {}), ...(a.provenance.sourcePageUrl ? { sourceUrl: a.provenance.sourcePageUrl } : {}) } }, atS);
    return { ok: true, pic };
  }

  /**
   * Drama overlays from stock VIDEO: fire, smoke, sparks, explosions, light filmed on black. Several moments of each
   * clip are measured (mostly black with a dense bright core) and the densest frames are kept, blended with screen.
   */
  async function findOverlay(i: { want: string }): Promise<{ ok: true; added: ThumbPicture[] } | Fail> {
    const base = i.want.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
    if (base.length < 3) return { ok: false, why: "say what the overlay is (fire, smoke, sparks, explosion, light)" };
    const queries = [`${base} black background`, `${base} on black`];
    const found = (await Promise.all(queries.map((q) => searchStock(q, { kind: "video", orientation: "landscape", perPage: 6, providers: ["pexels", "pixabay"] }).catch(() => [])))).flat();
    const uniq = [...new Map(found.filter((c) => !c.aiGenerated && thumbSharp(c) && !has(`${c.provider}:${c.externalId}`)).map((c) => [`${c.provider}:${c.externalId}`, c])).values()].slice(0, 8);
    if (!uniq.length) return { ok: false, why: `no stock video for "${base}" on black` };
    const scored: Array<{ c: StockCandidate; file: string; at: number; frame: string; bright: number }> = [];
    await Promise.all(
      uniq.map(async (c) => {
        const file = await downloadCandidate(c, dl).catch(() => null);
        if (!file) return;
        const len = Math.max(2, c.durationS ?? 8);
        for (const f of [0.25, 0.45, 0.65, 0.85]) {
          const at = Math.round(len * f * 10) / 10;
          const frame = path.join(dl, "ov", `${sha(`${c.provider}:${c.externalId}@${at}`, 14)}.jpg`);
          await mkdir(path.dirname(frame), { recursive: true });
          await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", "-update", "1", "-q:v", "2", frame]).catch(() => {});
          const m = await darkBright(frame);
          if (m.dark >= 0.3 && m.bright >= 0.08) scored.push({ c, file, at, frame, bright: m.bright });
        }
      }),
    );
    const best = [...new Map(scored.sort((a, b) => b.bright - a.bright).map((x) => [x.c.externalId, x])).values()].slice(0, 2);
    if (!best.length) return { ok: false, why: `${uniq.length} clips looked at; none is a dense ${base} on a black background — try other words (flames, inferno, explosion, burning, embers, smoke plume)` };
    const added: ThumbPicture[] = [];
    for (const b of best) added.push(await add(b.file, { depicts: `stock overlay: ${b.c.title.slice(0, 60) || base} (on black — blend with screen; ${Math.round(b.bright * 100)} % bright)`, kind: "overlay", face: false, named: false, credit: creditOf(b.c, "stock") }, b.at));
    return { ok: true, added };
  }

  /**
   * Real expressions of a named person: frames from press videos about them (interviews, news, speeches), rated by
   * eye for whether the person's face is large, sharp, free of on-screen graphics, and what it expresses. Returns a
   * contact sheet; `usePressStill` keeps one.
   */
  const stills = new Map<string, PressStill & { expression: string; score: number }>();
  async function findExpression(i: { subject: string; mood?: string }): Promise<{ ok: true; sheet: string; frames: Array<{ id: string; expression: string; score: number }> } | Fail> {
    if (!subjects.some((s) => s.toLowerCase() === i.subject.toLowerCase())) return { ok: false, why: `${i.subject} is not a named subject of this film (${subjects.slice(0, 8).join(", ")})` };
    const world = subjects.filter((s) => s.toLowerCase() !== i.subject.toLowerCase());
    const got = await youtubeStills({ name: i.subject, world, dlDir: path.join(dl, "yt"), videos: 3, frames: 8 });
    if (!got.length) return { ok: false, why: `no press video naming ${i.subject} could be read` };
    const blocks: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }> = [];
    const { readFile } = await import("node:fs/promises");
    for (const [k, g] of got.entries()) blocks.push({ type: "text", text: `[${k}] from "${g.title.slice(0, 80)}"` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(g.file)).toString("base64") } });
    const res = await structured({
      stage: "publish.expression",
      model: MODELS.haiku,
      system: [plain(`You pick thumbnail frames of ${i.subject}. For each numbered frame: is it clearly ${i.subject} (judge by the video title and what is visible; a different person, an anchor or a crowd is not), is the face large and sharp, is the frame free of on-screen captions, tickers and logos over the face, and what does the face express in a few words. score 0–10: how strong and readable the expression is for a thumbnail${i.mood ? ` that needs "${i.mood}"` : ""} (a calm talking face is 3, a vivid reaction 8+).`)],
      user: blocks,
      schema: z.object({ frames: z.array(z.object({ i: z.number(), isPerson: z.boolean(), faceLarge: z.boolean(), clean: z.boolean(), expression: z.string(), score: z.number() })) }),
      effort: "low",
      maxTokens: 3000,
    }).catch(() => null);
    const good = (res?.data.frames ?? []).filter((f) => f.isPerson && f.faceLarge && f.clean && got[f.i]).sort((a, b) => b.score - a.score).slice(0, 6);
    if (!good.length) return { ok: false, why: `looked at ${got.length} frames of ${i.subject} from press videos; none shows the face large and clean` };
    for (const f of good) stills.set(got[f.i]!.id, { ...got[f.i]!, expression: f.expression, score: f.score });
    const sheet = path.join(dl, `expr_${sha(i.subject + good.map((g) => g.i).join(","), 10)}.jpg`);
    const inputs = good.flatMap((g) => ["-i", got[g.i]!.file]);
    const tiles = good.map((_, k) => `[${k}]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2[t${k}]`).join(";");
    const cols = Math.min(3, good.length);
    const layout = good.map((_, k) => `${(k % cols) * 480}_${Math.floor(k / cols) * 270}`).join("|");
    // No text is drawn on the sheet (not every ffmpeg build has drawtext): frames are numbered in reading order.
    if (good.length === 1) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", got[good[0]!.i]!.file, "-vf", "scale=960:-2", "-frames:v", "1", "-update", "1", sheet]);
    else await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `${tiles};${good.map((_, k) => `[t${k}]`).join("")}xstack=inputs=${good.length}:layout=${layout}:fill=black`, "-frames:v", "1", "-update", "1", sheet]);
    return { ok: true, sheet, frames: good.map((g, k) => ({ id: got[g.i]!.id, expression: `${k + 1}: ${g.expression}`, score: g.score })) };
  }
  async function usePressStill(i: { id: string }): Promise<{ ok: true; pic: ThumbPicture } | Fail> {
    const st = stills.get(i.id);
    if (!st) return { ok: false, why: `no frame ${i.id}; call find_expression first` };
    const pic = await add(st.file, { depicts: `${subjects.find((x) => st.title.toLowerCase().includes(x.toLowerCase().split(" ").at(-1)!)) ?? "subject"} — press frame, ${st.expression}`, kind: "photo", face: true, named: true, credit: { origin: "press", provider: "youtube", ref: `youtube:${st.id}`, license: "Fair use (press still in a thumbnail, with commentary)", attributionRequired: true, attributionText: `${st.channel} — "${st.title.slice(0, 80)}"`, sourceUrl: st.url, fairUse: `${st.title} (${st.channel})` } });
    return { ok: true, pic };
  }

  /**
   * Real textures to lay over a subject or the frame: blood splatter, cracked glass, burn marks, dirt, torn paper,
   * scratches — photographs of the real thing. Each is rated by eye; the blend that fits is suggested from how it
   * is shot (on white → multiply, on black → screen).
   */
  async function findTexture(i: { want: string }): Promise<{ ok: true; added: ThumbPicture[] } | Fail> {
    const base = i.want.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
    if (base.length < 3) return { ok: false, why: "say what the texture is (blood splatter, cracked glass, burn marks, torn paper…)" };
    const found = (await Promise.all([`${base} texture`, `${base} isolated`].map((q) => searchStock(q, { kind: "image", orientation: "landscape", perPage: 6, providers: ["pexels", "pixabay"] }).catch(() => [])))).flat();
    const uniq = [...new Map(found.filter((c) => !c.aiGenerated && thumbSharp(c) && !AGENCY.test(`${c.attributionText ?? ""}`) && !has(`${c.provider}:${c.externalId}`)).map((c) => [`${c.provider}:${c.externalId}`, c])).values()].slice(0, 10);
    if (!uniq.length) return { ok: false, why: `no stock picture for "${base}"` };
    const withThumb = (await Promise.all(uniq.map(async (c) => {
      const t = path.join(dl, "prev", `${sha(`${c.provider}:${c.externalId}`, 14)}.jpg`);
      return (await thumbOf({ url: c.thumbUrl ?? c.fileUrl ?? "" }, t)) ? { c, t } : null;
    }))).filter((x): x is { c: StockCandidate; t: string } => x !== null);
    const rated = await reviewPictures(withThumb.map((x) => ({ frameFile: x.t, intent: `a texture of ${base} filling the frame, on a plain light or dark ground, usable as an overlay`, line: film, era: "any period" })));
    const best = withThumb.map((x, k) => ({ ...x, r: rated[k]! })).filter((x) => x.r.fit >= 6 && !x.r.synthetic && !x.r.face).sort((a, b) => b.r.fit - a.r.fit).slice(0, 2);
    if (!best.length) return { ok: false, why: `${withThumb.length} looked at, none is a clean ${base} texture — try other words` };
    const added: ThumbPicture[] = [];
    for (const b of best) {
      const file = await downloadCandidate(b.c, dl).catch(() => null);
      if (!file) continue;
      const pic = await add(file, { depicts: `texture: ${b.r.shows}`, kind: "overlay", face: false, named: false, fit: b.r.fit, credit: creditOf(b.c, "stock") });
      const m = await darkBright(pic.file);
      pic.depicts += m.dark > 0.5 ? " (on black — blend screen)" : " (on light — blend multiply)";
      added.push(pic);
    }
    return added.length ? { ok: true, added } : { ok: false, why: "the textures could not be downloaded" };
  }

  /**
   * Human-made illustrations and vector art from stock (Pixabay, Vecteezy) — drawn by people, licensed; anything
   * tagged or flagged as AI-made is excluded at the source and pictures that look generated are rejected by eye.
   */
  async function findIllustration(i: { want: string; style?: "illustration" | "vector" }): Promise<{ ok: true; added: ThumbPicture[] } | Fail> {
    const q = i.want.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    if (q.length < 3) return { ok: false, why: "say what the illustration shows" };
    const imageType = i.style ?? "vector";
    const found = (await Promise.all([searchStock(q, { kind: "image", orientation: "landscape", perPage: 8, providers: ["pixabay"], imageType }).catch(() => []), searchStock(q, { kind: "image", orientation: "landscape", perPage: 6, providers: ["vecteezy"], imageType }).catch(() => [])])).flat();
    const uniq = found.filter((c) => !c.aiGenerated && thumbSharp(c) && !/\b(ai[- ]generated|midjourney|stable diffusion|dall-?e|generative)\b/i.test(`${c.title} ${c.tags.join(" ")}`) && !has(`${c.provider}:${c.externalId}`)).slice(0, 12);
    if (!uniq.length) return { ok: false, why: `no human-made ${imageType} for "${q}"` };
    const withThumb = (await Promise.all(uniq.map(async (c) => {
      const t = path.join(dl, "prev", `${sha(`${c.provider}:${c.externalId}`, 14)}.jpg`);
      return (await thumbOf({ url: c.thumbUrl ?? c.fileUrl ?? "" }, t)) ? { c, t } : null;
    }))).filter((x): x is { c: StockCandidate; t: string } => x !== null);
    const rated = await reviewPictures(withThumb.map((x) => ({ frameFile: x.t, intent: `${imageType === "vector" ? "vector art" : "an illustration"} of ${i.want}`, line: film, era: "any period" })));
    const best = withThumb.map((x, k) => ({ ...x, r: rated[k]! })).filter((x) => x.r.fit >= 6 && !x.r.synthetic && !x.r.banner).sort((a, b) => b.r.fit - a.r.fit).slice(0, 2);
    if (!best.length) return { ok: false, why: `${withThumb.length} looked at; none fitted or all looked machine-made` };
    const added: ThumbPicture[] = [];
    for (const b of best) {
      const file = await downloadCandidate(b.c, dl).catch(() => null);
      if (file) added.push(await add(file, { depicts: `${imageType} (human-made, ${b.c.provider}): ${b.r.shows}`, kind: "photo", face: false, named: false, fit: b.r.fit, credit: creditOf(b.c, "stock") }));
    }
    return added.length ? { ok: true, added } : { ok: false, why: "the illustrations could not be downloaded" };
  }

  /**
   * Fixed filters on a real picture (no model): painterly (oil-paint look), posterise (flat colour bands), ink
   * (comic-style outlines), halftone (print dots), sharpen. Transparency is kept. The result is a new picture.
   */
  async function stylise(i: { slot: number; style: "painterly" | "posterise" | "ink" | "halftone" | "sharpen" }): Promise<{ ok: true; pic: ThumbPicture } | Fail> {
    const p = pics[i.slot];
    if (!p) return { ok: false, why: `no picture ${i.slot}` };
    const chain =
      i.style === "painterly" ? "median=radius=3,unsharp=7:7:1.4,eq=saturation=1.35:contrast=1.1"
      : i.style === "posterise" ? "eq=saturation=1.4,lutrgb=r='floor(val/48)*48+24':g='floor(val/48)*48+24':b='floor(val/48)*48+24'"
      : i.style === "ink" ? "split[x][y];[y]edgedetect=mode=wires:high=0.18:low=0.06,negate[e];[x]eq=saturation=1.3,lutrgb=r='floor(val/64)*64+32':g='floor(val/64)*64+32':b='floor(val/64)*64+32'[f];[f][e]blend=all_mode=multiply"
      : i.style === "halftone" ? "eq=contrast=1.25:saturation=1.2,scale=iw/6:ih/6:flags=area,scale=iw*6:ih*6:flags=neighbor"
      : "unsharp=7:7:1.6,eq=contrast=1.08";
    const alpha = p.file.endsWith(".png");
    const out = path.join(picDir, `p${pics.length}_${i.style}_${sha(p.file, 8)}.${alpha ? "png" : "jpg"}`);
    const graph = alpha ? `[0]format=rgba,split[c][al];[al]alphaextract[a];[c]format=rgb24,${chain}[pp];[pp][a]alphamerge` : `[0]format=rgb24,${chain}`;
    try {
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", p.file, "-filter_complex", graph, "-frames:v", "1", "-update", "1", out]);
    } catch (e) {
      return { ok: false, why: `filter failed: ${(e as Error).message.slice(0, 120)}` };
    }
    const pic: ThumbPicture = { ...p, slot: pics.length, file: out, pub: `pic/${path.basename(out)}`, depicts: `${p.depicts} — ${i.style} filter` };
    pics.push(pic);
    dirty = true;
    return { ok: true, pic };
  }

  /**
   * A crisp, high-resolution studio shot of a product or object (isolated on a plain ground), rated by eye and cut
   * out — the sharp hero the channel's thumbnails are built around. Small pictures are skipped.
   */
  async function findProductShot(i: { want: string }): Promise<{ ok: true; added: ThumbPicture[] } | Fail> {
    const base = i.want.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
    if (base.length < 3) return { ok: false, why: "say what the object or product is" };
    const found = (await Promise.all([`${base} isolated white background`, `${base} studio`, `${base} close up`].map((q) => searchStock(q, { kind: "image", orientation: "landscape", perPage: 5, providers: ["pexels", "pixabay"] }).catch(() => [])))).flat();
    const uniq = [...new Map(found.filter((c) => !c.aiGenerated && (c.width ?? 0) >= 1600 && !has(`${c.provider}:${c.externalId}`)).map((c) => [`${c.provider}:${c.externalId}`, c])).values()].slice(0, 12);
    if (!uniq.length) return { ok: false, why: `no sharp studio picture of "${base}" (≥ 1600 px)` };
    const withThumb = (await Promise.all(uniq.map(async (c) => {
      const t = path.join(dl, "prev", `${sha(`${c.provider}:${c.externalId}`, 14)}.jpg`);
      return (await thumbOf({ url: c.thumbUrl ?? c.fileUrl ?? "" }, t)) ? { c, t } : null;
    }))).filter((x): x is { c: StockCandidate; t: string } => x !== null);
    const rated = await reviewPictures(withThumb.map((x) => ({ frameFile: x.t, intent: `a sharp studio picture of ${base}, the object clearly separated from a plain background`, line: film, era: "any period" })));
    const best = withThumb.map((x, k) => ({ ...x, r: rated[k]! })).filter((x) => x.r.fit >= 6 && !x.r.synthetic && !x.r.banner && !x.r.face).sort((a, b) => b.r.fit - a.r.fit).slice(0, 2);
    if (!best.length) return { ok: false, why: `${withThumb.length} looked at; none is a clean, sharp ${base}` };
    const added: ThumbPicture[] = [];
    for (const b of best) {
      const file = await downloadCandidate(b.c, dl).catch(() => null);
      if (!file) continue;
      const pic = await add(file, { depicts: `studio shot: ${b.r.shows}`, kind: "photo", face: false, named: false, fit: b.r.fit, credit: creditOf(b.c, "stock") });
      const cut = await cutOut({ slot: pic.slot });
      added.push(cut.ok ? cut.pic : pic);
    }
    return added.length ? { ok: true, added } : { ok: false, why: "the pictures could not be downloaded" };
  }

  /** Copy a chosen render's pictures' public files are already in place; this returns the renderer's slot map. */
  const slotMap = () => Object.fromEntries(pics.map((p) => [String(p.slot), p.pub]));
  const takeDirty = () => {
    const d = dirty;
    dirty = false;
    return d;
  };
  const copyOut = (slot: number, to: string) => copyFile(pics[slot]!.file, to);

  return { pubDir, pics, brief, gather, findPicture, findOverlay, findExpression, usePressStill, findTexture, findIllustration, stylise, findProductShot, filmShots, filmStrip, useFilmFrame, cutOut, searchLibrary, addLibrary, slotMap, takeDirty, copyOut, subjects };
}
export type ThumbnailTools = ReturnType<typeof makeThumbnailTools>;
