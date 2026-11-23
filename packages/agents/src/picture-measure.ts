/**
 * Build list 5, items 16–18: what a picture MEANS, measured the same way on the channel's real shots and on ours.
 *
 *  - **idle**: stock people doing nothing in particular (hands on a phone, someone typing, an empty office, a person
 *    looking at a screen) — the Nokia proof film's weakest pictures. A measured category with the reference's share as
 *    the cap (`data/picture-profile/<channel>.json`).
 *  - **specific**: the picture is of THIS story — its named people, company, products, places, documents, or archive
 *    and press material of its events — rather than a generic picture of the kind. Story-specific pictures come first;
 *    their share is measured against the reference.
 *  - **meaning** (0–10): does the picture carry the IDEA of the line, not its nouns.
 *  - **watermark**: a channel bug, logo or burned-in mark in a corner of footage (`watermarkCheck`).
 *
 * The rules are shared text: the resolver's picture review (resolver/press.ts:reviewPictures) asks the same questions
 * with the same words, so a candidate is judged like the reference was labelled.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { cornerMarks, type Corner, type CornerMarks } from "@opumia/senses";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";
import { loadReferenceIndex } from "./reference-index.js";

export const MEANING_RULE =
  "Rate MEANING, not literal fit: does the picture carry the IDEA of the line (the stakes, the turn, the feeling, what the line is really saying), the way a strong documentary editor would cut it? A picture that only matches a noun of the line (the line mentions phones, the picture shows a phone in someone's hand) but says nothing of its idea is at most 5. A picture that shows the line's idea, even without its nouns, can be 8–10.";
export const IDLE_RULE =
  "idle = true when the picture is stock of people doing nothing in particular: hands holding or scrolling a phone, someone typing at a laptop, a person staring at a screen, people walking past, an empty office or meeting room, a handshake or a team at a table with no story moment. False for anything showing a specific event, a named subject, an action that matters to the story, an object or place that carries meaning, or designed graphics.";
export const SPECIFIC_RULE =
  "specific = true when the picture is of THIS story: its named people, company, brand, products, buildings, places, documents, or press/archive material of its actual events. False for a generic picture of the kind (any office, any phone, any factory, an actor standing in).";

const Label = z.object({ items: z.array(z.object({ index: z.number(), idle: z.boolean(), specific: z.boolean(), meaning: z.number().describe("0–10"), shows: z.string().describe("5–10 words") })) });
export interface PictureLabel { idle: boolean; specific: boolean; meaning: number; shows: string }

const imageBlock = async (f: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(f) ? "image/png" : "image/jpeg", data: (await readFile(f)).toString("base64") } });

/** Label frames for idle / specific / meaning — the same function on the reference and on ours. */
export async function labelPictures(items: Array<{ frameFile: string; line: string; subjects: string }>): Promise<Array<PictureLabel | null>> {
  const out: Array<PictureLabel | null> = [];
  for (let i = 0; i < items.length; i += 10) {
    const part = items.slice(i, i + 10);
    const user: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const [k, it] of part.entries()) {
      if (!existsSync(it.frameFile)) continue;
      user.push({ type: "text", text: `[${k}] film about: ${it.subjects.slice(0, 140)} | narration over it: "${it.line.slice(0, 220)}"` }, await imageBlock(it.frameFile));
    }
    const r = user.length
      ? await structured({ stage: "pictures.label", model: MODELS.haiku, system: [plain(`You label frames of documentary films, one verdict per frame, judging only what is visible.\n${IDLE_RULE}\n${SPECIFIC_RULE}\n${MEANING_RULE}`)], user, schema: Label, effort: "low", maxTokens: 2500 }).catch(() => null)
      : null;
    for (let k = 0; k < part.length; k++) {
      const v = r?.data.items.find((x) => x.index === k);
      out.push(v ? { idle: v.idle, specific: v.specific, meaning: v.meaning, shows: v.shows } : null);
    }
  }
  return out;
}

export interface PictureShares { shots: number; footageShots: number; idle: number; idleOfFootage: number; specific: number; specificOfFootage: number; meaningMedian: number }
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Shares over a film's shots; `footage` marks shots that show a real picture (not a designed card). */
export function pictureShares(rows: Array<{ label: PictureLabel | null; footage: boolean }>): PictureShares {
  const ok = rows.filter((x): x is { label: PictureLabel; footage: boolean } => x.label !== null);
  const foot = ok.filter((x) => x.footage);
  const m = ok.map((x) => x.label.meaning).sort((a, b) => a - b);
  return {
    shots: ok.length, footageShots: foot.length,
    idle: r3(ok.filter((x) => x.label.idle).length / Math.max(1, ok.length)), idleOfFootage: r3(foot.filter((x) => x.label.idle).length / Math.max(1, foot.length)),
    specific: r3(ok.filter((x) => x.label.specific).length / Math.max(1, ok.length)), specificOfFootage: r3(foot.filter((x) => x.label.specific).length / Math.max(1, foot.length)),
    meaningMedian: m.length ? m[Math.floor(m.length / 2)]! : 0,
  };
}

interface Band { p10: number; median: number; p90: number }
export interface PictureBand { channel: string; shots: number; films: number; pooled: PictureShares; perFilm: Record<"idle" | "idleOfFootage" | "specific" | "specificOfFootage" | "meaningMedian", Band>; /** The cap on idle stock: the channel's pooled share or its upper-quartile film, whichever is higher. */ idleCap: number; /** Per-shot meaning of the channel's real footage shots (the reference rates itself 4–5 for meaning: a literal 6 is not the bar). */ meaningOfFootage: Band; /** A footage shot under this meaning is weak (the channel's lowest tenth). */ meaningFloor: number; /** The share of real footage shots under the floor. */ weakShare: number; /** The floor on story-specific pictures: the channel's lowest tenth across films. */ specificFloor: number; builtAt: string }

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]! : 0;
};
const bandOf = (xs: number[]): Band => ({ p10: r3(pct(xs, 0.1)), median: r3(pct(xs, 0.5)), p90: r3(pct(xs, 0.9)) });

/** The channel's band, labelled once on its real exemplar shots (data/exemplars/<channel>/, frame a of each shot). */
export async function ensurePictureBand(o: { data: string; channelId: string; fresh?: boolean; log?: (s: string) => void }): Promise<PictureBand | null> {
  const f = path.join(o.data, "picture-profile", `${o.channelId}.json`);
  if (!o.fresh && existsSync(f)) return JSON.parse(await readFile(f, "utf8")) as PictureBand;
  const exDir = path.join(o.data, "exemplars", o.channelId);
  const ex = await readFile(path.join(exDir, "index.json"), "utf8").then((t) => JSON.parse(t) as { shots: Array<{ id: string; film: string; designed: boolean; kind: string; line: string; frames: string[] }> }, () => null);
  if (!ex?.shots.length) return null;
  const ix = await loadReferenceIndex(o.data);
  const titles = new Map((ix?.manifest.films ?? []).map((x) => [x.id, x.title]));
  const shots = ex.shots.filter((s) => s.frames[0]);
  o.log?.(`  picture band: labelling ${shots.length} real ${o.channelId} shots (idle stock, story-specific, meaning)…`);
  const labels = await labelPictures(shots.map((s) => ({ frameFile: path.join(exDir, s.frames[0]!), line: s.line, subjects: titles.get(s.film) ?? s.film })));
  const rows = shots.map((s, k) => ({ film: s.film, label: labels[k] ?? null, footage: !s.designed }));
  const films = [...new Set(rows.map((x) => x.film))];
  const per = films.map((fm) => pictureShares(rows.filter((x) => x.film === fm))).filter((x) => x.shots >= 8);
  const pooled = pictureShares(rows);
  const key = <K extends keyof PictureShares>(k: K) => bandOf(per.map((x) => x[k] as number));
  const band: PictureBand = {
    channel: o.channelId, shots: pooled.shots, films: per.length, pooled,
    perFilm: { idle: key("idle"), idleOfFootage: key("idleOfFootage"), specific: key("specific"), specificOfFootage: key("specificOfFootage"), meaningMedian: key("meaningMedian") },
    idleCap: r3(Math.max(pooled.idle, pct(per.map((x) => x.idle), 0.75))),
    meaningOfFootage: bandOf(rows.filter((x) => x.footage && x.label).map((x) => x.label!.meaning)),
    meaningFloor: pct(rows.filter((x) => x.footage && x.label).map((x) => x.label!.meaning), 0.1),
    weakShare: r3(rows.filter((x) => x.footage && x.label && x.label.meaning < pct(rows.filter((y) => y.footage && y.label).map((y) => y.label!.meaning), 0.1)).length / Math.max(1, rows.filter((x) => x.footage && x.label).length)),
    specificFloor: r3(pct(per.map((x) => x.specific), 0.1)),
    builtAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify(band, null, 1) + "\n");
  await rename(f + ".tmp", f);
  return band;
}

export interface PictureIssue { check: "idle_stock" | "generic_pictures" | "weak_meaning"; shots: string[]; measured: string; band: string }

/**
 * The gate's reading (preflight): ours labelled with the same function, against the channel's band.
 * idle_stock — idle stock above the channel's cap; generic_pictures — story-specific share below its lowest tenth;
 * weak_meaning — more footage under the channel's lowest tenth for meaning than the channel has (the shots named).
 */
export function pictureIssues(rows: Array<{ shotId: string; label: PictureLabel | null; footage: boolean }>, band: PictureBand): PictureIssue[] {
  const s = pictureShares(rows);
  const out: PictureIssue[] = [];
  if (s.idle > band.idleCap + 1e-9) out.push({ check: "idle_stock", shots: rows.filter((x) => x.label?.idle).map((x) => x.shotId), measured: `${Math.round(s.idle * 100)} % idle stock`, band: `≤ ${Math.round(band.idleCap * 100)} %` });
  // measured over all shots (designed previews included) as on the reference; footage alone has no floor (its p10 is 0)
  const allShots = rows.some((x) => !x.footage);
  if (allShots && s.specific < band.specificFloor - 1e-9) out.push({ check: "generic_pictures", shots: rows.filter((x) => x.footage && x.label && !x.label.specific).map((x) => x.shotId), measured: `${Math.round(s.specific * 100)} % story-specific`, band: `≥ ${Math.round(band.specificFloor * 100)} %` });
  // weak meaning: footage under the channel's own lowest tenth, in a larger share of shots than the channel has
  const foot = rows.filter((x) => x.footage && x.label);
  const weak = foot.filter((x) => x.label!.meaning < band.meaningFloor);
  if (weak.length && weak.length / Math.max(1, foot.length) > band.weakShare + 0.1) out.push({ check: "weak_meaning", shots: weak.map((x) => x.shotId), measured: `${weak.length} of ${foot.length} footage shots under ${band.meaningFloor}/10 for meaning`, band: `≤ ${Math.round((band.weakShare + 0.1) * 100)} % under ${band.meaningFloor}/10` });
  return out;
}

// ---- watermarks (item 18)

const Marks = z.object({ corners: z.array(z.object({ corner: z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]), mark: z.boolean(), confidence: z.number().describe("0–1: how sure you are it is an ADDED overlay, not part of the scene"), what: z.string().describe("a few words") })) });
export interface WatermarkVerdict { marked: boolean; corners: Corner[]; note: string; pixels: CornerMarks | null; usd: number }
const verdicts = new Map<string, Promise<WatermarkVerdict>>();

/**
 * A watermark, channel bug or burned-in mark in a corner of a picture: the pixel reading (persistent corner edges,
 * senses/watermark.ts) plus one look by eye at the four corner crops (Haiku). Marked footage is never placed.
 * A product logo or sign that is part of the filmed scene is not a mark.
 */
export function watermarkCheck(file: string, o: { workDir?: string } = {}): Promise<WatermarkVerdict> {
  if (!verdicts.has(file))
    verdicts.set(file, (async () => {
      const tileOut = path.join(o.workDir ?? path.dirname(file), `${path.basename(file)}.corners.jpg`);
      const px = await cornerMarks(file, { tileOut }).catch(() => null);
      if (!px?.tile) return { marked: false, corners: [], note: "not checked", pixels: px, usd: 0 };
      const hint = px.suspects.length ? `The pixels hint at fixed edges in: ${px.suspects.join(", ")}.` : "";
      const r = await structured({
        stage: "pictures.watermark", model: MODELS.haiku,
        system: [plain("You check footage for overlays added after filming: a TV channel bug, a YouTuber's or website's logo or watermark (often semi-transparent, in a corner), a stock-site watermark, a timestamp, a subscribe button, burned-in text. A logo, sign, screen or label that is physically part of the filmed scene (on a product, a building, a box, a stage screen or backdrop, even cut off by the frame edge) is NOT a mark. An added overlay sits flat on top of the picture, ignores the scene's perspective and lighting, and is usually small and tucked into the corner.")],
        user: [{ type: "text", text: `The four corners of one frame, tiled: top-left | top-right on the top row, bottom-left | bottom-right on the bottom row. ${hint} Which corners carry an added overlay?` }, await imageBlock(px.tile)],
        schema: Marks, effort: "low", maxTokens: 800,
      }).catch(() => null);
      // without a pixel hint (no fixed edges in that corner) the eye must be surer: most false alarms are scene signs
      const marked = (r?.data.corners ?? []).filter((c) => c.mark && c.confidence >= (px.suspects.includes(c.corner) ? 0.6 : 0.85));
      return { marked: marked.length > 0, corners: marked.map((c) => c.corner), note: marked.map((c) => `${c.corner}: ${c.what}`).join("; ") || "clean", pixels: px, usd: r?.usage.usd ?? 0 };
    })());
  return verdicts.get(file)!;
}

/**
 * The gate's input (preflight): our film's shots labelled with the reference's labeller. Footage shots are read from
 * their placed primary (a middle frame); designed shots from `designedFrames` (their final previews), which the gate
 * passes so the story-specific share is measured over all shots as it is on the reference.
 */
export async function measureFilmPictures(o: { jobDir: string; subjects: string; designedFrames?: Map<string, string>; frameAt?: (file: string, out: string, atS: number) => Promise<boolean> }): Promise<Array<{ shotId: string; label: PictureLabel | null; footage: boolean }>> {
  const j = <T>(f: string) => readFile(path.join(o.jobDir, f), "utf8").then((t) => JSON.parse(t) as T, () => null);
  const sb = await j<{ shots: Array<{ id: string; startS: number; endS: number }> }>("storyboard.json");
  const res = await j<{ media: Array<{ shotId: string; role: string; kind: string; localPath: string }> }>("resolution.json");
  const ts = await j<{ segments: Array<{ words: Array<{ word: string; startS: number }> }> }>("timed-script.json");
  if (!sb) return [];
  const words = (ts?.segments ?? []).flatMap((s) => s.words);
  const lineOf = (a: number, b: number) => words.filter((w) => w.startS >= a - 0.05 && w.startS < b).map((w) => w.word).join(" ");
  const grab = o.frameAt ?? (async (file: string, out: string, atS: number) => {
    const { run } = await import("@opumia/senses");
    if (/\.(jpe?g|png|webp)$/i.test(file)) return existsSync(file) && (await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", "scale=640:-2", "-frames:v", "1", out]).then(() => true, () => false));
    return run("ffmpeg", ["-v", "error", "-y", "-ss", atS.toFixed(2), "-i", file, "-vf", "scale=640:-2", "-frames:v", "1", out]).then(() => existsSync(out), () => false);
  });
  const rows: Array<{ shotId: string; frame: string; line: string; footage: boolean }> = [];
  for (const sh of sb.shots) {
    const m = res?.media.find((x) => x.shotId === sh.id && x.role === "primary" && (x.kind === "video" || x.kind === "image"));
    if (m && existsSync(m.localPath)) {
      const out = `${m.localPath}.label.jpg`;
      if (await grab(m.localPath, out, m.kind === "video" ? Math.min(1.2, (sh.endS - sh.startS) / 2) : 0)) rows.push({ shotId: sh.id, frame: out, line: lineOf(sh.startS, sh.endS), footage: true });
    } else if (o.designedFrames?.get(sh.id)) rows.push({ shotId: sh.id, frame: o.designedFrames.get(sh.id)!, line: lineOf(sh.startS, sh.endS), footage: false });
  }
  const labels = await labelPictures(rows.map((x) => ({ frameFile: x.frame, line: x.line, subjects: o.subjects })));
  return rows.map((x, k) => ({ shotId: x.shotId, label: labels[k] ?? null, footage: x.footage }));
}
