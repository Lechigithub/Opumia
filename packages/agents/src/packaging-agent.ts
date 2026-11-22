/**
 * The packaging agent: it chooses a film's title and designs its thumbnail from real pictures only — it studies
 * the channel's real thumbnails, gathers the pictures its idea needs (sources, the film's own footage, library
 * objects and overlays), cuts them out, renders, looks at the result full size and at phone size, measures it
 * against the channel, tests it blind among real thumbnails, and revises — until it submits.
 *
 *  skill    packages/agents/skills/packaging.md
 *  tools    view_reference_thumbnails, list_pictures, find_picture, film_footage, use_film_frame, cut_out,
 *           search_library, add_library, test_titles, render_thumbnail, imposter_test, submit_package, note_lesson
 *  memory   <memoryDir>/<channel>.md (its lessons + a log of every package), owner-notes.md
 *  band     data/thumbnail-profile/<channel>.json (thumbnail-measure.ts)
 */
import { readMemory } from "./lessons.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { FactSheet, FilmDesignSystem, SceneElement, TimedScript } from "@opumia/contracts";
import { craftIssues, designIssues, measureCraft, measureDesign, measureLook, run } from "@opumia/senses";
import type { QualityBand } from "./quality-band.js";
import * as z from "zod/v4";
import { agentLoop, MODELS, plain, type AgentTool } from "./llm.js";
import { testTitles, thumbnailImposter } from "./publishing.js";
import { fitLayout } from "./scene-designer.js";
import { critiqueConcepts, critiqueThumbnail, deconText, emptyShare, nearestRefsByMeaning, type ConceptScore, type ThumbConcept, type ThumbCraft, type ThumbCritique } from "./thumbnail-craft.js";
import { labelThumbnails, THUMB_BACKGROUNDS, THUMB_HEROES, THUMB_MARKS, thumbIssues, type ThumbBand, type ThumbIssue } from "./thumbnail-measure.js";

/** The picture tools (resolver/thumbnail-tools.ts), handed in as functions. */
export interface PackagingPicture { slot: number; pub: string; file: string; depicts: string; kind: "photo" | "cutout" | "logo" | "object" | "icon" | "overlay"; aspect: number; width?: number; face: boolean; named: boolean; fit?: number; mean?: string }
type Fail = { ok: false; why: string };
export interface PackagingPictureTools {
  pics: PackagingPicture[];
  brief: (p: PackagingPicture) => string;
  findPicture: (i: { want: string; subject?: string; type: "person" | "company" | "product" | "object" | "place" | "texture" }) => Promise<{ ok: true; added: PackagingPicture[]; previews: string[]; looked: number } | Fail>;
  findOverlay: (i: { want: string }) => Promise<{ ok: true; added: PackagingPicture[] } | Fail>;
  findExpression: (i: { subject: string; mood?: string }) => Promise<{ ok: true; sheet: string; frames: Array<{ id: string; expression: string; score: number }> } | Fail>;
  usePressStill: (i: { id: string }) => Promise<{ ok: true; pic: PackagingPicture } | Fail>;
  findTexture: (i: { want: string }) => Promise<{ ok: true; added: PackagingPicture[] } | Fail>;
  findIllustration: (i: { want: string; style?: "illustration" | "vector" }) => Promise<{ ok: true; added: PackagingPicture[] } | Fail>;
  stylise: (i: { slot: number; style: "painterly" | "posterise" | "ink" | "halftone" | "sharpen" }) => Promise<{ ok: true; pic: PackagingPicture } | Fail>;
  findProductShot: (i: { want: string }) => Promise<{ ok: true; added: PackagingPicture[] } | Fail>;
  filmShots: () => Array<{ shotId: string; kind: string; origin: string; depicts: string; seconds: number }>;
  filmStrip: (i: { shotId: string }) => Promise<{ ok: true; strip: string; times: number[] } | Fail>;
  useFilmFrame: (i: { shotId: string; atS: number }) => Promise<{ ok: true; pic: PackagingPicture } | Fail>;
  cutOut: (i: { slot: number }) => Promise<{ ok: true; pic: PackagingPicture; coverage: number } | Fail>;
  searchLibrary: (i: { query: string; kind: "object" | "icon" | "overlay" }) => Array<{ id: string; name: string; tags: string[] }>;
  addLibrary: (i: { assetId: string; color?: string }) => Promise<{ ok: true; pic: PackagingPicture } | Fail>;
  slotMap: () => Record<string, string>;
  takeDirty: () => boolean;
}

export interface ThumbRender {
  id: string;
  file: string;
  phone: string;
  concept: string;
  spec: unknown;
  finish: unknown;
  design: FilmDesignSystem;
  slots: number[];
  issues: ThumbIssue[];
  colourfulness: number;
  conceptId?: string;
  empty?: number;
  imposter?: { spotted: boolean; confidence: number; tells: string[]; runs?: number; spottedRuns?: number };
  critique?: ThumbCritique;
}
export interface PackagingReport {
  pass: boolean;
  title: string;
  titles: Array<{ title: string; risk: number; ok: boolean; why: string }>;
  thumbnail: ThumbRender | null;
  renders: number;
  agent: { turns: number; calls: Record<string, number>; usd: number };
}
export interface PackagingAgentOptions {
  channel: string;
  jobDir: string;
  facts: FactSheet;
  script: TimedScript;
  design: FilmDesignSystem;
  band: ThumbBand;
  /** Deconstructions of the channel's reachable thumbnails and its measured emptiness (thumbnail-craft.ts). */
  craft?: ThumbCraft | null;
  /** The reference's pixel-level bar (sharpness, detail, contrast, grain). */
  quality?: QualityBand | null;
  references: Array<{ title: string; views: number | null }>;
  pictures: PackagingPictureTools;
  /** Renders a thumbnail spec + finish with the film's scene engine into `out` (1280×720 jpg). */
  render: (i: { spec: unknown; finish: unknown; design: FilmDesignSystem; slots: Record<string, string>; fresh: boolean; out: string; grain: number; sharpen: number }) => Promise<void>;
  avoidConcepts?: string[];
  memoryDir?: string;
  onReport?: (r: PackagingReport) => void;
  log?: (s: string) => void;
}

const COLORS = ["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"] as const;
const HEX = z.string().describe("#RRGGBB");
const Element = z.object({
  type: z.enum(["cutout", "photo", "card3d", "pile", "text", "shape", "texture"]).describe("card3d = a picture (a logo, a product, a document) as a lit card in real 3D perspective — depth for flat logos; pile = many copies of one cut-out picture (cash, coins, bottles, logos) heaped across an area, smaller at the back"),
  h: z.number().optional().describe("pile: height of the area (0–1); photo: height"),
  count: z.number().optional().describe("pile: 6–40 copies"),
  itemW: z.number().optional().describe("pile: width of one copy, 0.05–0.4 of the frame"),
  slot: z.number().optional().describe("picture number for cutout/photo/card3d"),
  tilt: z.number().optional().describe("card3d: -40…40 degrees"),
  spin: z.number().optional().describe("card3d: -40…40 degrees of turn"),
  matchBackground: z.boolean().optional().describe("cut-out: light it with the background photo's colour so it sits in the scene"),
  contactShadow: z.number().optional().describe("cut-out: 0–1, a soft shadow on the ground under it, so it stands IN the background photo"),
  soften: z.number().optional().describe("cut-out: 0–2 px, softens a hard cut edge"),
  turnX: z.number().optional().describe("cut-out: -25…25 degrees perspective tilt"),
  turnY: z.number().optional().describe("cut-out: -35…35 degrees perspective turn"),
  textureSlot: z.number().optional().describe("cut-out: a texture picture (blood, cracks, burns, dirt) laid on the subject only"),
  textureBlend: z.enum(["multiply", "screen", "overlay", "darken", "normal"]).optional().describe("normal = the texture picture fills the subject's shape (fire inside a logo)"),
  fillSlot: z.number().optional().describe("text: a picture seen through the letters (fire, money, footage)"),
  textureOpacity: z.number().optional(),
  brightness: z.number().optional().describe("cut-out: 0.7–1.4"),
  x: z.number().describe("left edge, 0–1 of the frame width"),
  y: z.number().describe("top edge, 0–1 of the frame height"),
  w: z.number().describe("width, 0–1 of the frame width (a hero is 0.4–0.8)"),
  rot: z.number().optional(),
  // cut-out finishing (real pixels)
  outline: z.boolean().optional().describe("sticker outline"),
  outlineColor: HEX.optional(),
  glowColor: HEX.optional().describe("coloured glow / rim light around the cut-out"),
  glowSize: z.number().optional().describe("0.5–3"),
  tint: HEX.optional().describe("colour the cut-out into one hue"),
  tintStrength: z.number().optional().describe("0–1"),
  look: z.enum(["natural", "punch", "mono", "glitch"]).optional(),
  half: z.enum(["left", "right", "top", "bottom"]).optional().describe("show only one half (two halves of two faces make one)"),
  flip: z.boolean().optional(),
  shadow: z.boolean().optional(),
  // photo
  frame: z.enum(["none", "print", "torn", "circle", "tv", "polaroid"]).optional(),
  grade: z.enum(["natural", "mono", "duotone"]).optional(),

  // text
  text: z.string().optional(),
  role: z.enum(["display", "headline", "stamp", "label"]).optional(),
  size: z.number().optional().describe("cap height, 0–1 of the frame height (thumbnail text is big: 0.12–0.28)"),
  align: z.enum(["left", "center", "right"]).optional(),
  color: z.enum(COLORS).optional(),
  box: z.enum(COLORS).optional().describe("a solid box behind the text"),
  word: z.string().optional().describe("one word drawn in the accent colour"),
  font: z.enum(["heavy_sans", "wide_heavy", "condensed", "tall_condensed", "narrow", "slab", "serif"]).optional().describe("typeface: heavy_sans (Montserrat Black), wide_heavy (Archivo Black), condensed (Anton), tall_condensed (Bebas Neue), narrow (Oswald Bold), slab (Roboto Slab Black), serif (Playfair Black)"),
  letter: z.enum(["label_box", "outlined", "plain", "glow", "gradient"]).optional().describe("how the letters are drawn: label_box = letters on a solid colour box"),
  fill: HEX.optional().describe("letter colour"),
  boxFill: HEX.optional().describe("box colour for label_box (or the gradient's end colour)"),
  strokeColor: HEX.optional(),
  highlightFill: HEX.optional().describe("colour of `word`"),
  italic: z.boolean().optional(),
  // shape
  shape: z.enum(["underline", "circle", "arrow", "bar", "rect", "cross"]).optional(),
  x2: z.number().optional(),
  y2: z.number().optional(),
  // texture
  texture: z.enum(["paper", "halftone", "grid", "scanlines", "noise", "stripes"]).optional(),
  opacity: z.number().optional(),
});
const Finish = z.object({
  background: z.object({ slot: z.number(), blur: z.number().optional().describe("0–24 px"), dim: z.number().optional().describe("0–0.85"), tint: HEX.optional(), tintStrength: z.number().optional(), x: z.number().optional().describe("focus 0–1"), y: z.number().optional(), scale: z.number().optional().describe("1–2") }).optional().describe("a real photo filling the frame behind everything"),
  split: z.object({ a: HEX, b: HEX, angle: z.number().optional(), at: z.number().optional() }).optional().describe("two-colour split background (when there is no background photo)"),
  rays: z.object({ color: HEX, x: z.number(), y: z.number(), opacity: z.number().optional(), count: z.number().optional() }).optional().describe("light burst behind the hero"),
  overlays: z.array(z.object({ slot: z.number(), blend: z.enum(["screen", "lighten", "multiply", "overlay"]).optional(), opacity: z.number().optional(), under: z.boolean().optional().describe("behind the composition"), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional() })).optional().describe("fire, smoke, sparks or light filmed on black (library overlays), blended with screen"),
  vignette: z.number().optional(),
  grain: z.number().optional().describe("0–1 film grain over the whole picture (the channel's thumbnails are textured; default 0.5)"),
  sharpen: z.number().optional().describe("0–1 final sharpening (default 0.5)"),
  pattern: z.object({ slot: z.number(), size: z.number().optional().describe("0.04–0.5 of the frame width per tile"), opacity: z.number().optional(), rot: z.number().optional(), tint: HEX.optional(), tintStrength: z.number().optional() }).optional().describe("a logo, monogram, icon or object repeated edge to edge as the background wallpaper — the subject's own world"),
  grade: z.object({ contrast: z.number().optional().describe("0.8–1.6"), saturation: z.number().optional().describe("0.6–2"), brightness: z.number().optional().describe("0.7–1.4"), warmth: z.number().optional().describe("-1 cold … 1 warm") }).optional().describe("whole-image grade (default: saturation 1.35, contrast 1.08)"),
});
const Draft = z.object({
  conceptId: z.string().describe("the id of the critiqued concept this builds (propose_concepts)"),
  concept: z.string().describe("one sentence: the idea"),
  palette: z.object({ primary: HEX, accent: HEX, surface: HEX }).describe("this thumbnail's own loud palette, from the subject's real colours"),
  world: z.enum(["nebula", "blueprint", "paper", "halftone", "smoke", "stripes", "spotlight"]).describe("procedural colour background, used only when there is no background photo or split"),
  headlineStyle: z.enum(["neon_glow", "solid_stroke", "boxed", "gradient", "paper_cut"]),
  elements: z.array(Element).max(10).describe("drawn in order: later on top"),
  finish: Finish.optional(),
});

const validHex = (h?: string) => Boolean(h && /^#[0-9a-fA-F]{6}$/.test(h));
const clamp = (v: number | undefined, a: number, b: number, d = a) => Math.max(a, Math.min(b, Number.isFinite(v) ? (v as number) : d));
const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
const pc = (x: number) => `${Math.round(x * 100)} %`;
const STOP = new Set("the a an of and to in on for by with is was are be it this that how why what who his her their its from at as".split(" "));
const content = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Turn a draft into the renderer's spec, finish and design; report what had to be dropped. */
function build(d: z.infer<typeof Draft>, base: FilmDesignSystem, pics: PackagingPicture[]) {
  const dropped: string[] = [];
  const pic = (n?: number) => (n === undefined ? undefined : pics[n]);
  const els: Array<Record<string, unknown>> = [];
  const used = new Set<number>();
  for (const e of d.elements) {
    const box = { x: clamp(e.x, -0.2, 0.98, 0.1), y: clamp(e.y, -0.2, 0.98, 0.1), w: clamp(e.w, 0.03, 1.4, 0.4), rot: clamp(e.rot, -20, 20, 0), z: 0.5, at: 0, enter: "fade" };
    if (e.type === "pile") {
      const p = pic(e.slot);
      if (!p) {
        dropped.push(`pile with no picture ${e.slot}`);
        continue;
      }
      used.add(p.slot);
      // Deterministic heap: rows from the back (small, darker) to the front (large), jittered.
      const n = Math.round(clamp(e.count, 4, 40, 18));
      const area = { x: clamp(e.x, -0.2, 1, 0), y: clamp(e.y, -0.2, 1, 0.6), w: clamp(e.w, 0.1, 1.4, 1), h: clamp(e.h, 0.05, 1, 0.4) };
      const iw = clamp(e.itemW, 0.05, 0.4, 0.16);
      const rnd = (k: number) => {
        const v = Math.sin(k * 91.7 + n * 13.3 + p.slot * 7.1) * 43758.5453;
        return v - Math.floor(v);
      };
      for (let k = 0; k < n; k++) {
        const depth = k / Math.max(1, n - 1); // 0 = back row, 1 = front
        const s = iw * (0.7 + 0.45 * depth) * (0.9 + 0.2 * rnd(k + 3));
        els.push({ type: "cutout", slot: p.slot, x: area.x + rnd(k) * Math.max(0.01, area.w - s), y: area.y + depth * area.h * 0.85 + (rnd(k + 7) - 0.5) * 0.04, w: s, rot: (rnd(k + 11) - 0.5) * 50, z: 0.5, at: 0, enter: "fade", shadow: true, ...(depth < 0.4 ? { brightness: 0.75 + depth * 0.5 } : {}), ...(e.flip && k % 2 ? { flip: true } : {}) });
      }
      continue;
    }
    if (e.type === "card3d") {
      const p = pic(e.slot);
      if (!p) {
        dropped.push(`card3d with no picture ${e.slot}`);
        continue;
      }
      used.add(p.slot);
      els.push({ type: "card3d", slot: p.slot, ...box, tilt: clamp(e.tilt, -40, 40, -12), spin: clamp(e.spin, -40, 40, 10) });
      continue;
    }
    if (e.type === "cutout" || e.type === "photo") {
      const p = pic(e.slot);
      if (!p) {
        dropped.push(`${e.type} with no picture ${e.slot}`);
        continue;
      }
      used.add(p.slot);
      // A photo with a transparent background drawn as "photo" loses its point; a jpg as "cutout" keeps its box.
      const bgMean = d.finish?.background ? pics[d.finish.background.slot]?.mean : undefined;
      const light = e.matchBackground && bgMean ? { matchColor: bgMean, matchStrength: 0.55 } : {};
      const tex = e.textureSlot !== undefined && pic(e.textureSlot) ? (used.add(e.textureSlot), { textureSlot: e.textureSlot, textureBlend: e.textureBlend ?? "multiply", textureOpacity: clamp(e.textureOpacity, 0, 1, 0.8) }) : {};
      const comp = { ...(e.contactShadow ? { contactShadow: clamp(e.contactShadow, 0, 1, 0.5) } : {}), ...(e.soften ? { soften: clamp(e.soften, 0, 2, 0.6) } : {}), ...(e.turnX ? { turnX: clamp(e.turnX, -25, 25, 0) } : {}), ...(e.turnY ? { turnY: clamp(e.turnY, -35, 35, 0) } : {}) };
      if (e.type === "cutout" || p.kind !== "photo")
        els.push({ type: "cutout", slot: p.slot, ...box, ...light, ...tex, ...comp, ...(e.brightness ? { brightness: clamp(e.brightness, 0.7, 1.4, 1) } : {}), shadow: e.shadow ?? true, outline: e.outline ?? false, ...(validHex(e.outlineColor) ? { outlineColor: e.outlineColor } : {}), ...(validHex(e.glowColor) ? { glowColor: e.glowColor, glowSize: clamp(e.glowSize, 0.3, 3, 1) } : {}), ...(validHex(e.tint) ? { tint: e.tint, tintStrength: clamp(e.tintStrength, 0, 1, 0.6) } : {}), ...(e.look ? { look: e.look } : {}), ...(e.half ? { half: e.half } : {}), ...(e.flip ? { flip: true } : {}) });
      else els.push({ type: "photo", slot: p.slot, ...box, frame: e.frame ?? "none", grade: e.grade ?? "natural", ...(e.h ? { h: clamp(e.h, 0.05, 1.2, 0.5) } : {}) });
    } else if (e.type === "text") {
      const t = (e.text ?? "").trim();
      if (!t) continue;
      if (t.length > 40) {
        dropped.push(`text "${t.slice(0, 30)}…" (too long for a thumbnail)`);
        continue;
      }
      els.push({ type: "text", text: t, role: e.role === "label" ? "label" : e.role === "stamp" ? "stamp" : "display", ...box, size: clamp(e.size, 0.05, 0.3, 0.16), align: e.align ?? "center", color: e.color ?? "text", ...(e.box ? { box: e.box } : {}), ...(e.word?.trim() ? { highlightWord: e.word.trim() } : {}), ...(e.font ? { font: e.font } : {}), ...(e.letter ? { letter: e.letter } : {}), ...(validHex(e.fill) ? { fill: e.fill } : {}), ...(validHex(e.boxFill) ? { boxFill: e.boxFill } : {}), ...(validHex(e.strokeColor) ? { strokeColor: e.strokeColor } : {}), ...(validHex(e.highlightFill) ? { highlightFill: e.highlightFill } : {}), ...(e.italic ? { italic: true } : {}), ...(e.fillSlot !== undefined && pic(e.fillSlot) ? (used.add(e.fillSlot), { fillSlot: e.fillSlot }) : {}) });
    } else if (e.type === "shape" && e.shape) els.push({ type: "shape", shape: e.shape, ...box, h: clamp(e.h, 0.005, 0.6, 0.014), color: e.color ?? "accent", ...(e.shape === "arrow" ? { x2: clamp(e.x2, 0, 1, 0.5), y2: clamp(e.y2, 0, 1, 0.5) } : {}) });
    else if (e.type === "texture" && e.texture) els.push({ type: "texture", texture: e.texture, opacity: clamp(e.opacity, 0, 1, 0.3), at: 0 });
  }
  const texts = els.filter((e) => e.type === "text") as unknown as SceneElement[];
  fitLayout(texts, false);
  const f = d.finish;
  const finish: Record<string, unknown> = {};
  if (f?.background) {
    const p = pic(f.background.slot);
    if (p && p.kind !== "overlay") {
      used.add(p.slot);
      finish.background = { ...f.background, slot: p.slot };
    } else dropped.push(`background picture ${f.background.slot}`);
  }
  if (f?.split && validHex(f.split.a) && validHex(f.split.b)) finish.split = f.split;
  if (f?.rays && validHex(f.rays.color)) finish.rays = f.rays;
  if (f?.overlays?.length) {
    finish.overlays = f.overlays.filter((ov) => {
      const p = pic(ov.slot);
      if (p) used.add(p.slot);
      else dropped.push(`overlay ${ov.slot}`);
      return Boolean(p);
    });
  }
  if (f?.vignette) finish.vignette = clamp(f.vignette, 0, 1, 0.4);
  if (f?.grade) finish.grade = f.grade;
  if (f?.pattern && pic(f.pattern.slot)) {
    used.add(f.pattern.slot);
    finish.pattern = f.pattern;
  }
  const p = base.palette;
  const design: FilmDesignSystem = {
    ...base,
    palette: { ...p, primary: validHex(d.palette.primary) ? d.palette.primary : p.primary, accent: validHex(d.palette.accent) ? d.palette.accent : p.accent, surface: validHex(d.palette.surface) ? d.palette.surface : p.surface },
    treatment: { ...(base.treatment ?? { phrase: "boxed", label: "tag", photo: "none", particles: "none", wash: "none", washStrength: 0.3, glow: 0.7, motif: "", transition: "whip" as const }), headline: d.headlineStyle, world: d.world, particles: "none", photo: "none", wash: "none", washStrength: 0.3, glow: Math.max(0.6, base.treatment?.glow ?? 0.6) } as FilmDesignSystem["treatment"],
  };
  const spec = { shotId: "thumbnail", idea: d.concept.slice(0, 200), backdrop: "world", dim: 0.3, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: els };
  // A picture blown up well past its own pixels looks soft next to the channel's crisp composites.
  const soft = els
    .filter((e) => (e.type === "cutout" || e.type === "photo" || e.type === "card3d") && typeof e.slot === "number")
    .map((e) => ({ p: pics[e.slot as number], shown: (e.w as number) * 1280 }))
    .filter((x): x is { p: PackagingPicture; shown: number } => Boolean(x.p?.width && x.p.kind !== "logo" && x.p.kind !== "icon" && x.shown / x.p.width! > 1.7))
    .map((x) => `picture ${x.p.slot} is ${x.p.width} px wide but shown ${Math.round(x.shown)} px wide (${(x.shown / x.p.width!).toFixed(1)}×)`);
  return { spec, finish, design, used: [...used], dropped, soft, texts: texts.map((t) => (t as { text: string }).text) };
}

export async function packagingAgent(o: PackagingAgentOptions): Promise<PackagingReport> {
  const log = o.log ?? (() => {});
  const skill = await readFile(new URL("../skills/packaging.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const narration = o.script.segments.map((s) => s.text).join(" ");
  const spoken = narration.toLowerCase();
  const verified = o.facts.claims.map((c) => c.text).join(" ");
  const b = o.band;
  const outDir = path.join(o.jobDir, "thumbs");
  await mkdir(outDir, { recursive: true });

  const titles: PackagingReport["titles"] = [];
  const renders: ThumbRender[] = [];
  const seenRefs = new Set<string>();
  let accepted: { title: string; render: ThumbRender } | null = null;
  let noteSaved = false;
  let imposterRound = 0;
  const concepts = new Map<string, ThumbConcept & { score?: ConceptScore }>();
  let conceptRounds = 0;
  let studied = 0;
  const craft = o.craft ?? null;

  const bandText = [
    `## This channel's thumbnails, measured on ${b.count} real ones`,
    `- hero: ${Object.entries(b.hero).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${pc(v)}`).join(", ")}; covering ${pc(b.heroShare.p10)}–${pc(b.heroShare.p90)} of the frame (median ${pc(b.heroShare.median)}); cut out of its background on ${pc(b.cutoutShare)}`,
    `- background: ${Object.entries(b.background).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k.replace("_", " ")} ${pc(v)}`).join(", ")}`,
    `- marks: ${Object.entries(b.marks).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pc(v)}`).join(", ")}`,
    `- faces on ${pc(b.faceShare)}; a strong expression on ${pc(b.strongExpressionShare)} of those`,
    `- words: median ${b.words.median}, nine in ten use ≤ ${b.words.p90}, ${pc(b.words.noTextShare)} have none; biggest text ${pc(b.textHeight.median)} of the frame height (median)`,
    `- text drawn as: ${Object.entries(b.textStyle).filter(([k, v]) => k !== "none" && v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k.replace("_", " ")} ${pc(v)}`).join(", ")}; looks like: ${b.textLooks.slice(0, 8).join("; ")}`,
    `- focal elements: median ${b.elements.median}, never more than ${b.elements.max}`,
    `- colourfulness ${Math.round(b.colourfulness.p25)}–${Math.round(b.colourfulness.p90)} (median ${Math.round(b.colourfulness.median)}); brightness ${b.luma.p10.toFixed(2)}–${b.luma.p90.toFixed(2)}`,
    ...(craft ? [`- emptiness (flat, dim or blurred share of the frame): median ${pc(craft.emptyShare.median)}, nine in ten ≤ ${pc(craft.emptyShare.p90)} — the channel fills its frames`, `\n## How the channel's best thumbnails work (taken apart)\n${craft.items.slice(0, 12).map((d) => `- ${deconText(d)}`).join("\n")}`] : []),
    `- made of: real pictures only ${pc(b.makeable.real_pictures)}, retouched ${pc(b.makeable.needs_retouch)}, composited scenes ${pc(b.makeable.needs_invention)}, illustration ${pc(b.makeable.illustration)}; reachable with your tools ${pc(b.reach.reachable)} (the rest alter a real face ${pc(b.reach.face_alteration)} or need new painting ${pc(b.reach.new_painting)} — never do those)`,
  ].join("\n");
  const refTitles = [...o.references].sort((x, y) => (y.views ?? 0) - (x.views ?? 0)).slice(0, 30).map((r) => `- ${r.title} [${r.views ?? "?"}]`).join("\n");
  const system = [
    plain(`${skill}\n\n${bandText}\n\n## The channel's titles, most viewed first\n${refTitles}${o.avoidConcepts?.length ? `\n\n## Recent thumbnails of ours — do something different\n${o.avoidConcepts.map((c) => `- ${c}`).join("\n")}` : ""}${notes.trim() ? `\n\n## Your own notes from earlier packages\n${notes}` : ""}${owner.trim() ? `\n\n## The owner's notes on your work (take these seriously)\n${tail(owner, 30)}` : ""}`),
  ];

  const bestTitle = () => titles.filter((t) => t.ok).sort((x, y) => x.risk - y.risk)[0]?.title;
  const textChecks = (texts: string[], used: number[]): ThumbIssue[] => {
    const out: ThumbIssue[] = [];
    const all = texts.join(" ");
    const words = all.split(/\s+/).filter(Boolean).length;
    if (words > Math.max(b.words.max, 4)) out.push({ kind: "too_many_words", detail: `${words} words in total — the channel never uses more than ${b.words.max}` });
    const nums = (all.match(/\d[\d,.]*/g) ?? []).filter((n) => !spoken.includes(n.replace(/[.,]$/, "").toLowerCase()));
    if (nums.length) out.push({ kind: "unspoken_figure", detail: `the figure(s) ${nums.join(", ")} are never said in the film` });
    const names = (all.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).filter((w) => !spoken.includes(w.toLowerCase()) && !STOP.has(w.toLowerCase()));
    if (names.length) out.push({ kind: "unknown_name", detail: `the word(s) ${names.join(", ")} do not appear in the narration` });
    const t = bestTitle();
    if (t && texts.length) {
      const tw = new Set(content(t));
      const cw = content(all);
      if (cw.length && cw.filter((w) => tw.has(w)).length / cw.length >= 0.6) out.push({ kind: "repeats_title", detail: `the thumbnail words "${all}" mostly repeat the title "${t}" — add what the title does not say, or use no words` });
    }
    const stand = used.map((s) => o.pictures.pics[s]).filter((p): p is PackagingPicture => Boolean(p && p.face && !p.named));
    if (stand.length) out.push({ kind: "stand_in_face", detail: `picture(s) ${stand.map((p) => p.slot).join(", ")} show a face that is not a verified subject of the film; a stranger's face would read as the person this film is about. Use it only blurred as part of a background, or not at all.` });
    return out;
  };
  const BLOCKERS = new Set(["stand_in_face", "unspoken_figure", "unknown_name", "repeats_title"]);

  const tools: AgentTool[] = [
    {
      name: "view_reference_thumbnails",
      description: "Real thumbnails of the channel with how each is made (hero, background, marks, words, makeable), most viewed first. Filter by what you are planning. Returns up to 6 images.",
      schema: z.object({ hero: z.enum(THUMB_HEROES).optional(), background: z.enum(THUMB_BACKGROUNDS).optional(), mark: z.enum(THUMB_MARKS).optional(), realOnly: z.boolean().optional().describe("only those your tools can reach without generation"), max: z.number().optional() }),
      run: async (i: { hero?: string; background?: string; mark?: string; realOnly?: boolean; max?: number }) => {
        const hits = b.items.filter((x) => (!i.hero || x.label.hero === i.hero) && (!i.background || x.label.background === i.background) && (!i.mark || x.label.marks.includes(i.mark as never)) && (!i.realOnly || x.label.reach === "reachable")).sort((x, y) => (y.views ?? 0) - (x.views ?? 0));
        const fresh = [...hits.filter((x) => !seenRefs.has(x.file)), ...hits.filter((x) => seenRefs.has(x.file))].slice(0, clamp(i.max, 1, 6, 4));
        if (!fresh.length) return "no real thumbnail matches that filter — widen it";
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const x of fresh) {
          seenRefs.add(x.file);
          const l = x.label;
          out.push({ type: "text", text: `"${x.title}" — ${x.views ?? "?"} views. hero ${l.hero} ${pc(l.heroShare)}${l.heroCutout ? " cut out" : ""}; background ${l.background}; ${l.words} word(s)${l.words ? ` drawn ${l.textStyle.replace("_", " ")} (${l.textLook})` : ""}; marks ${l.marks.join(", ") || "none"}; ${l.makeable.replace("_", " ")}${l.reach && l.reach !== "reachable" ? ` — NOT for you (${l.reach.replace("_", " ")})` : ""}: ${l.why}` }, await img(x.file));
        }
        return out;
      },
    },
    {
      name: "study_reference_ideas",
      description: "Real thumbnails of the channel taken apart by a designer: the one idea, how subject and twist are fused, the layer stack, how the frame is filled, the lettering, and a recipe to rebuild it from real pictures. Filter by words of what you are planning. Returns up to 4 with their images.",
      schema: z.object({ about: z.string().optional().describe("words of your idea: fire, money, logo, person, pattern…"), max: z.number().optional() }),
      run: async (i: { about?: string; max?: number }) => {
        if (!craft) return "no deconstructions available";
        const pick = i.about ? await nearestRefsByMeaning(craft, i.about, clamp(i.max, 1, 4, 3)) : craft.items.slice(studied, studied + clamp(i.max, 1, 4, 3));
        studied += pick.length;
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const d of pick) out.push({ type: "text", text: `${deconText(d)}\nRECIPE: ${d.recipe}` }, await img(d.file));
        return out.length ? out : "nothing more to study";
      },
    },
    {
      name: "propose_concepts",
      description: "Before rendering anything: write 8–12 thumbnail concepts, each ONE visual idea that fuses the subject and the twist into a single image filling the frame. A creative director scores them against the channel's best thumbnails (fused, instant, surprising, the channel's kind of idea, makeable) and names the ones to build. You may propose again with better ones.",
      schema: z.object({ concepts: z.array(z.object({ id: z.string(), idea: z.string(), hero: z.string(), twist: z.string(), fusion: z.string().describe("how hero and twist become one image"), background: z.string(), fill: z.string().describe("what fills the frame edge to edge"), lettering: z.string(), pictures: z.string().describe("the real pictures it needs") })).min(6).max(14) }),
      run: async (i: { concepts: ThumbConcept[] }) => {
        if (!craft) return "no deconstructions available — render directly";
        const ids = new Set<string>();
        const list = i.concepts.map((c) => ({ ...c, id: ids.has(c.id) || concepts.has(c.id) ? `${c.id}_${conceptRounds + 1}` : c.id })).map((c) => (ids.add(c.id), c));
        const r = await critiqueConcepts({ channel: o.channel, craft, film: `${o.script.title}: ${o.facts.summary}`, pictures: o.pictures.pics.map((p) => o.pictures.brief(p)).join("; ").slice(0, 2500), concepts: list });
        conceptRounds++;
        for (const c of list) concepts.set(c.id, { ...c, score: r.scores.find((s) => s.id === c.id) });
        log(`    concepts round ${conceptRounds}: best ${r.best.join(", ")} (${r.scores.slice(0, 3).map((s) => `${s.id} ${s.total}`).join(", ")})`);
        return `SCORES (fused ×1.5, instant, surprise, channel ×1.5, makeable → total of 10):\n${r.scores.map((s) => `[${s.id}] ${s.total} — fused ${s.fused}, instant ${s.instant}, surprise ${s.surprise}, channel ${s.channel}, makeable ${s.makeable}; nearest: ${s.nearest}; to make it stronger: ${s.note}`).join("\n")}\nBUILD: ${r.best.join(", ")}. Gather the pictures these need, then render with conceptId.`;
      },
    },
    {
      name: "list_pictures",
      description: "Every picture you have so far (its number is what elements and the finish refer to).",
      schema: z.object({}),
      run: async () => (o.pictures.pics.length ? o.pictures.pics.map((p) => o.pictures.brief(p)).join("\n") : "no pictures yet"),
    },
    {
      name: "find_picture",
      description: "Find a new real picture. With `subject` and type person/company/product: photos and logos of that subject (Wikipedia, Commons; checked to really show them). Otherwise a place, scene, object or texture from stock and archives. Previews are rated by eye; the best one or two are kept. Returns their previews.",
      schema: z.object({ want: z.string().describe("what the picture shows, in a few plain words"), subject: z.string().optional(), type: z.enum(["person", "company", "product", "object", "place", "texture"]) }),
      run: async (i: { want: string; subject?: string; type: "person" | "company" | "product" | "object" | "place" | "texture" }) => {
        const r = await o.pictures.findPicture(i);
        if (!r.ok) return r.why;
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [{ type: "text", text: `looked at ${r.looked}; kept:\n${r.added.map((p) => o.pictures.brief(p)).join("\n")}` }];
        for (const f of r.previews.slice(0, 2)) out.push(await img(f));
        return out;
      },
    },
    {
      name: "find_overlay",
      description: "Drama from stock VIDEO filmed on black: fire, flames, inferno, explosion, smoke plume, sparks, embers, light. Several moments of each clip are measured and the densest frames are kept as overlays (blend with screen, under or over the composition).",
      schema: z.object({ want: z.string() }),
      run: async (i: { want: string }) => {
        const r = await o.pictures.findOverlay(i);
        if (!r.ok) return r.why;
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [{ type: "text", text: r.added.map((p) => o.pictures.brief(p)).join("\n") }];
        for (const p of r.added) out.push(await img(p.file));
        return out;
      },
    },
    {
      name: "find_expression",
      description: "Real expressions of a named person of the film: frames from press videos about them (interviews, news, speeches), checked to be them, face large, no captions over it, rated for how strong the expression is. Returns a numbered sheet; keep one with use_press_frame, then cut_out.",
      schema: z.object({ subject: z.string(), mood: z.string().optional().describe("what the thumbnail needs the face to say: shock, anger, worry, triumph…") }),
      run: async (i: { subject: string; mood?: string }) => {
        const r = await o.pictures.findExpression(i);
        if (!r.ok) return r.why;
        return [{ type: "text", text: `frames in reading order on the sheet (left to right, top row first) — number: expression, score, id:\n${r.frames.map((f) => `${f.expression} — score ${f.score} — id ${f.id}`).join("\n")}` }, await img(r.sheet)];
      },
    },
    {
      name: "find_product_shot",
      description: "A crisp, high-resolution studio picture of a product or object (≥ 1600 px), rated by eye and cut out — a sharp hero or a pile item (cash, coins, bottles, shoes, phones…).",
      schema: z.object({ want: z.string() }),
      run: async (i: { want: string }) => {
        const r = await o.pictures.findProductShot(i);
        if (!r.ok) return r.why;
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [{ type: "text", text: r.added.map((p) => o.pictures.brief(p)).join("\n") }];
        for (const p of r.added) out.push(await img(p.file));
        return out;
      },
    },
    {
      name: "find_texture",
      description: "Photographs of a real texture to lay over a subject (textureSlot on a cut-out) or the frame (finish overlay): blood splatter, cracked glass, burn marks, dirt, scratches, torn paper, rust.",
      schema: z.object({ want: z.string() }),
      run: async (i: { want: string }) => {
        const r = await o.pictures.findTexture(i);
        if (!r.ok) return r.why;
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [{ type: "text", text: r.added.map((p) => o.pictures.brief(p)).join("\n") }];
        for (const p of r.added) out.push(await img(p.file));
        return out;
      },
    },
    {
      name: "find_illustration",
      description: "Human-made, licensed illustrations or vector art from stock (Pixabay, Vecteezy) — a mascot, an icon scene, a drawn object. Anything AI-made is excluded. Cut it out if it sits on a plain ground.",
      schema: z.object({ want: z.string(), style: z.enum(["illustration", "vector"]).optional() }),
      run: async (i: { want: string; style?: "illustration" | "vector" }) => {
        const r = await o.pictures.findIllustration(i);
        if (!r.ok) return r.why;
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [{ type: "text", text: r.added.map((p) => o.pictures.brief(p)).join("\n") }];
        for (const p of r.added) out.push(await img(p.file));
        return out;
      },
    },
    {
      name: "stylise",
      description: "A fixed filter on one of your pictures (no model; transparency kept): painterly (oil-paint look), posterise (flat colour bands), ink (comic outlines), halftone (print dots), sharpen. Returns a new picture.",
      schema: z.object({ slot: z.number(), style: z.enum(["painterly", "posterise", "ink", "halftone", "sharpen"]) }),
      run: async (i: { slot: number; style: "painterly" | "posterise" | "ink" | "halftone" | "sharpen" }) => {
        const r = await o.pictures.stylise(i);
        return r.ok ? [{ type: "text", text: o.pictures.brief(r.pic) }, await img(r.pic.file)] : r.why;
      },
    },
    {
      name: "use_press_frame",
      description: "Keep one frame found by find_expression (by its id) as a picture.",
      schema: z.object({ id: z.string() }),
      run: async (i: { id: string }) => {
        const r = await o.pictures.usePressStill(i);
        return r.ok ? [{ type: "text", text: o.pictures.brief(r.pic) }, await img(r.pic.file)] : r.why;
      },
    },
    {
      name: "compare",
      description: "Two of your renders side by side, full size and at phone size, to choose between ideas by eye.",
      schema: z.object({ a: z.string(), b: z.string() }),
      run: async (i: { a: string; b: string }) => {
        const ra = renders.find((x) => x.id === i.a);
        const rb = renders.find((x) => x.id === i.b);
        if (!ra || !rb) return "both ids must be renders";
        const out = path.join(outDir, `cmp_${ra.id}_${rb.id}.jpg`);
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", ra.file, "-i", rb.file, "-filter_complex", "[0]scale=640:-2[a];[1]scale=640:-2[b];[0]scale=168:-2[c];[1]scale=168:-2[d];[a][b]hstack=inputs=2[top];[c][d]hstack=inputs=2,pad=1280:120:0:13:0x202020[bot];[top][bot]vstack=inputs=2", "-frames:v", "1", "-update", "1", out]);
        return [{ type: "text", text: `left ${ra.id} ("${ra.concept.slice(0, 60)}"), right ${rb.id} ("${rb.concept.slice(0, 60)}"); bottom row at phone size` }, await img(out)];
      },
    },
    {
      name: "film_footage",
      description: "The film's own footage. Without shotId: a list of its shots (press clips of the real people first). With shotId: six frames of that shot side by side, each with its time — choose the strongest moment (a real expression) and call use_film_frame.",
      schema: z.object({ shotId: z.string().optional() }),
      run: async (i: { shotId?: string }) => {
        if (!i.shotId) return o.pictures.filmShots().map((s) => `${s.shotId} ${s.kind} ${s.origin}${s.seconds ? ` ${s.seconds.toFixed(1)}s` : ""}: ${s.depicts}`).join("\n") || "the film has no footage";
        const r = await o.pictures.filmStrip({ shotId: i.shotId });
        if (!r.ok) return r.why;
        return [{ type: "text", text: `six frames, left to right, top row first, at ${r.times.join(", ")} s` }, await img(r.strip)];
      },
    },
    {
      name: "use_film_frame",
      description: "Take one frame of the film's footage at `atS` seconds into the shot as a picture (then cut_out the person if you want them lifted off).",
      schema: z.object({ shotId: z.string(), atS: z.number() }),
      run: async (i: { shotId: string; atS: number }) => {
        const r = await o.pictures.useFilmFrame(i);
        return r.ok ? [{ type: "text", text: o.pictures.brief(r.pic) }, await img(r.pic.file)] : r.why;
      },
    },
    {
      name: "cut_out",
      description: "Lift the subject of a photo off its background (only source pixels are kept). Returns the cut-out as a new picture.",
      schema: z.object({ slot: z.number() }),
      run: async (i: { slot: number }) => {
        const r = await o.pictures.cutOut(i);
        return r.ok ? [{ type: "text", text: `${o.pictures.brief(r.pic)} (subject covers ${pc(r.coverage)} of the photo)` }, await img(r.pic.file)] : r.why;
      },
    },
    {
      name: "search_library",
      description: "The licensed library: cut-out objects (money, coins, everyday objects…), line icons, or overlays filmed on black (fire, flames, embers, smoke, sparks, light leaks — blend with screen).",
      schema: z.object({ query: z.string(), kind: z.enum(["object", "icon", "overlay"]) }),
      run: async (i: { query: string; kind: "object" | "icon" | "overlay" }) => {
        const r = o.pictures.searchLibrary(i);
        return r.length ? r.map((x) => `${x.id} — ${x.name}${x.tags.length ? ` (${x.tags.join(", ")})` : ""}`).join("\n") : "nothing in the library for that";
      },
    },
    {
      name: "add_library",
      description: "Add a library object, icon (drawn in `color`) or overlay as a picture.",
      schema: z.object({ assetId: z.string(), color: HEX.optional() }),
      run: async (i: { assetId: string; color?: string }) => {
        const r = await o.pictures.addLibrary(i);
        return r.ok ? [{ type: "text", text: o.pictures.brief(r.pic) }, await img(r.pic.file)] : r.why;
      },
    },
    {
      name: "test_titles",
      description: "Test title candidates: figures must be in the film, ≤ 70 characters, and each is hidden among real titles of the channel for a judge to pick out. Lower risk = reads as the channel's own.",
      schema: z.object({ titles: z.array(z.string()).min(1).max(8) }),
      run: async (i: { titles: string[] }) => {
        const r = await testTitles({ channel: o.channel, references: o.references, titles: i.titles, narration, verified });
        for (const x of r.results) {
          const k = titles.findIndex((t) => t.title === x.title);
          if (k >= 0) titles[k] = x;
          else titles.push(x);
        }
        return r.results.map((x) => `${x.ok ? (x.risk === 0 ? "PASS" : `risk ${x.risk.toFixed(2)}`) : "FAIL"}  "${x.title}" (${x.title.length} chars) — ${x.why}`).join("\n");
      },
    },
    {
      name: "render_thumbnail",
      description: "Render a thumbnail design with the film's scene engine (1280×720) and measure it against the channel. Returns it full size, at phone size (360 and 168 px wide), and what is outside the channel's band.",
      schema: Draft,
      run: async (d: z.infer<typeof Draft>) => {
        // Cost cap: twelve renders. Polishing one weak idea does not reach the channel; a better concept does.
        if (renders.length >= 12) return "NOT RENDERED: twelve renders is the limit. Submit the best one you have.";
        // A weak idea is not built: until a concept scores 7+, propose better ones (at most three rounds).
        const best = Math.max(0, ...[...concepts.values()].map((c) => c.score?.total ?? 0));
        if (craft && best < 8 && conceptRounds < 3) return `NOT RENDERED: the best concept so far scores ${best}/10 (8 needed). Study more real ideas and propose better concepts first (round ${conceptRounds + 1} of 3) — fused, instant, surprising.`;
        if (craft && !concepts.has(d.conceptId)) return `NOT RENDERED: conceptId "${d.conceptId}" is not a critiqued concept. Propose concepts first (propose_concepts) and build one of the best.`;
        const built = build(d, o.design, o.pictures.pics);
        const id = `r${renders.length + 1}`;
        const file = path.join(outDir, `${id}.jpg`);
        await o.render({ spec: built.spec, finish: built.finish, design: built.design, slots: o.pictures.slotMap(), fresh: o.pictures.takeDirty() || renders.length === 0, out: file, grain: clamp(d.finish?.grain, 0, 1, 0.5), sharpen: clamp(d.finish?.sharpen, 0, 1, 0.5) });
        const phone = path.join(outDir, `${id}.phone.jpg`);
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-filter_complex", "[0]scale=360:-2[a];[0]scale=168:-2,pad=168:202:0:0:0x202020[b];[a]pad=376:202:0:0:0x202020[a2];[a2][b]hstack=inputs=2", "-frames:v", "1", "-update", "1", phone]);
        const [label] = await labelThumbnails([file]);
        const look = await measureLook(file, { fps: 1 });
        const empty = await emptyShare(file).catch(() => 0);
        const px = await measureCraft(file).catch(() => null);
        const dz = o.quality?.design ? await measureDesign(file).catch(() => null) : null;
        const pxIssues = [...(px && o.quality ? craftIssues(px, o.quality.thumbs, "thumbnail", { grain: true }) : []), ...(dz && o.quality?.design ? designIssues(dz, o.quality.design.thumbs, "thumbnail") : [])];
        const emptyLimit = craft ? Math.max(0.08, craft.emptyShare.p90) : 0.3;
        const issues = [...pxIssues, ...(empty > emptyLimit ? [{ kind: "empty_frame", detail: `${pc(empty)} of the frame is flat, dim or blurred; the channel's thumbnails stay at or under ${pc(emptyLimit)} (median ${pc(craft?.emptyShare.median ?? 0)}). Fill it: a pile, a pattern of the subject's own marks, a sharp background, fire, the hero bigger.` }] : []),...textChecks(built.texts, built.used), ...(built.soft.length ? [{ kind: "soft_subject", detail: `${built.soft.join("; ")} — it will look soft. Use a larger source (another photo or a sharper frame), show it smaller, or stylise it so softness reads as a look.` }] : []), ...(label ? thumbIssues(label, look, b) : [{ kind: "unmeasured", detail: "the measurement failed; look at it yourself" }])];
        const r: ThumbRender = { id, file, phone, concept: d.concept, conceptId: d.conceptId, empty, spec: built.spec, finish: built.finish, design: built.design, slots: built.used, issues, colourfulness: look.colourfulness };
        renders.push(r);
        log(`    ${id}: "${d.concept.slice(0, 70)}" — ${issues.length ? issues.map((x) => x.kind).join(", ") : "inside the band"}`);
        const head = `${id}: ${label ? `measured — hero ${label.hero} ${pc(label.heroShare)}, background ${label.background}, ${label.words} word(s)${label.words ? ` drawn ${label.textStyle.replace("_", " ")} (${label.textLook})` : ""}, text ${pc(label.textHeight)} high, ${label.elements} focal elements, marks ${label.marks.join(", ") || "none"}, face ${label.expression}; ` : ""}colourfulness ${Math.round(look.colourfulness)}, brightness ${look.luma.toFixed(2)}, empty ${pc(empty)}${px ? `; detail: sharpest ${Math.round(px.sharpTop)}, typical ${Math.round(px.sharpMedian)}, grain ${px.grain}${o.quality ? ` (channel medians ${Math.round(o.quality.thumbs.sharpTop.median)} / ${Math.round(o.quality.thumbs.sharpMedian.median)} / ${o.quality.thumbs.grain.median})` : ""}` : ""}.${built.dropped.length ? `\nDropped: ${built.dropped.join("; ")}.` : ""}\n${issues.length ? `OUTSIDE THE CHANNEL'S BAND:\n${issues.map((x) => `- [${x.kind}] ${x.detail}`).join("\n")}` : "Inside the channel's band. Now compare it with the real ones (critique_thumbnail) and test it blind (imposter_test)."}`;
        return [{ type: "text", text: head }, await img(file), { type: "text", text: "At phone size (home feed 360 px, suggested 168 px):" }, await img(phone)];
      },
    },
    {
      name: "imposter_test",
      description: "Hide a render among four real thumbnails of the channel, three times with different real ones; a judge who knows the channel picks the imitation each time and says what gave it away. One lucky pass does not count: the result is how often it was picked out.",
      schema: z.object({ id: z.string() }),
      run: async (i: { id: string }) => {
        const r = renders.find((x) => x.id === i.id);
        if (!r) return `no render ${i.id}`;
        // Fair: hidden among the channel's thumbnails made from real pictures alone (the only kind we may make);
        // topped up with others when there are too few.
        const pool = [...b.items].sort((x, y) => (y.views ?? 0) - (x.views ?? 0));
        const ok = (x: (typeof pool)[number]) => (x.label.reach ? x.label.reach === "reachable" : x.label.makeable === "real_pictures");
        const realOnes = pool.filter(ok);
        const runs = await Promise.all(
          [0, 1, 2].map(async (k) => {
            const round = imposterRound * 3 + k;
            const rot = (xs: typeof pool) => xs.map((_, j) => xs[(j + round * 4) % xs.length]!);
            const real = [...rot(realOnes), ...rot(pool.filter((x) => !ok(x)))].slice(0, 4).map((x) => x.file);
            return thumbnailImposter({ channel: o.channel, candidate: r.file, real, seed: round * 2 + 1 });
          }),
        );
        imposterRound++;
        const spotted = runs.filter((t) => t.spotted);
        const conf = spotted.length ? spotted.reduce((t, x) => t + x.confidence, 0) / runs.length : 0;
        const tells = [...new Set(spotted.flatMap((t) => t.tells))].slice(0, 8);
        r.imposter = { spotted: spotted.length >= 2, confidence: Math.round(conf * 100) / 100, tells, runs: runs.length, spottedRuns: spotted.length };
        log(`    imposter ${r.id}: picked out ${spotted.length}/3 (avg ${conf.toFixed(2)})`);
        return `${spotted.length >= 2 ? "PICKED OUT" : "PASSED"} — picked out as the imitation in ${spotted.length} of 3 blind tests (average confidence ${conf.toFixed(2)}).${tells.length ? `\nWhat gave it away:\n${tells.map((x) => `- ${x}`).join("\n")}` : ""}`;
      },
    },
    {
      name: "critique_thumbnail",
      description: "A creative director puts your render next to the three real thumbnails whose ideas are nearest and says: fused idea or collage, whether the idea reads in one second, what is empty, what each real one does that yours does not, craft faults, a score out of 10 against them (7 = sits among them unnoticed) and the three fixes that matter most.",
      schema: z.object({ id: z.string() }),
      run: async (i: { id: string }) => {
        const r = renders.find((x) => x.id === i.id);
        if (!r) return `no render ${i.id}`;
        if (!craft) return "no deconstructions available";
        const c = r.conceptId ? concepts.get(r.conceptId) : undefined;
        const refs = await nearestRefsByMeaning(craft, `${r.concept}. ${c?.idea ?? ""} ${c?.fusion ?? ""} ${c?.background ?? ""}`, 3);
        const { critique } = await critiqueThumbnail({ channel: o.channel, file: r.file, concept: c?.idea ?? r.concept, refs });
        r.critique = critique;
        log(`    critique ${r.id}: ${critique.score}/10, ${critique.fused}${critique.ideaReads ? "" : ", idea does not read"}`);
        const sheet = path.join(outDir, `crit_${r.id}.jpg`);
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", r.file, ...refs.flatMap((x) => ["-i", x.file]), "-filter_complex", `${[r.file, ...refs].map((_, k) => `[${k}]scale=640:360[s${k}]`).join(";")};${[r.file, ...refs].map((_, k) => `[s${k}]`).join("")}xstack=inputs=${refs.length + 1}:layout=0_0|640_0|0_360|640_360:fill=black`, "-frames:v", "1", "-update", "1", sheet]).catch(() => {});
        const text = `${r.id}: ${critique.score}/10 — ${critique.fused.replace("_", " ")}; idea ${critique.ideaReads ? "reads at a glance" : "does NOT read at a glance"}; empty: ${critique.empty}\nWhat the real ones do that yours does not:\n${critique.perReference.map((x) => `- real ${x.ref}: ${x.doesThatOursDoesNot}`).join("\n")}\nCraft faults: ${critique.craft.join("; ") || "none"}\nFIX FIRST:\n${critique.fixes.map((x, k) => `${k + 1}. ${x}`).join("\n")}\n(sheet: yours top left, then the three real ones)`;
        try {
          return [{ type: "text", text }, await img(sheet)];
        } catch {
          return text;
        }
      },
    },
    {
      name: "submit_package",
      description: "Submit the title and the thumbnail render that go together. Refused until the title was tested and the render was tested blind and carries no blocking issue.",
      schema: z.object({ title: z.string(), id: z.string(), why: z.string() }),
      run: async (i: { title: string; id: string; why: string }) => {
        const t = titles.find((x) => x.title === i.title.trim());
        const r = renders.find((x) => x.id === i.id);
        const refuse: string[] = [];
        if (!t) refuse.push("test this exact title first (test_titles)");
        else if (!t.ok) refuse.push(`the title failed: ${t.why}`);
        if (!r) refuse.push(`no render ${i.id}`);
        else {
          if (!r.imposter) refuse.push(`test ${r.id} blind first (imposter_test)`);
          if (craft && !r.critique) refuse.push(`compare ${r.id} with the real ones first (critique_thumbnail)`);
          const block = r.issues.filter((x) => BLOCKERS.has(x.kind));
          const tw = new Set(content(i.title));
          const texts = (r.spec as { elements: Array<{ type: string; text?: string }> }).elements.filter((e) => e.type === "text").map((e) => e.text ?? "").join(" ");
          const cw = content(texts);
          if (cw.length && cw.filter((w) => tw.has(w)).length / cw.length >= 0.6) refuse.push(`the thumbnail words "${texts}" repeat this title`);
          if (block.length) refuse.push(`blocking: ${block.map((x) => x.detail).join(" | ")}`);
          const soft = r.issues.filter((x) => !BLOCKERS.has(x.kind));
          // Keep working while it is below the channel's level: at least seven renders and two different concepts
          // before a thumbnail that the critique scores under 7, calls a collage, or the blind test picks out may be submitted.
          const ideas = new Set(renders.filter((x) => x.imposter).map((x) => x.conceptId ?? x.concept.slice(0, 40))).size;
          const weak = (r.critique && (r.critique.score < 8 || r.critique.fused === "collage")) || r.imposter?.spotted || soft.length;
          if (weak && renders.length < 12 && (renders.length < 7 || ideas < 2)) refuse.push(`not yet at the channel's level (${[...(r.critique ? [`critique ${r.critique.score}/10, ${r.critique.fused}`] : []), ...(r.imposter?.spotted ? [`picked out ${r.imposter.spottedRuns}/3`] : [])].join(", ")}). Apply the critique's fixes or build another of the best concepts — ${renders.length} render(s), ${ideas} concept(s) tested so far.`);
        }
        if (refuse.length) return `NOT ACCEPTED:\n${refuse.map((x) => `- ${x}`).join("\n")}`;
        accepted = { title: i.title.trim(), render: r! };
        log(`    submitted "${accepted.title}" + ${r!.id} — ${i.why.slice(0, 100)}`);
        return "ACCEPTED. If this package taught you something, call note_lesson once; then stop.";
      },
    },
    {
      name: "note_lesson",
      description: "Save one lesson for future packages (what worked or failed and why). Kept in your memory.",
      schema: z.object({ lesson: z.string() }),
      run: async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LESSON (${o.script.title.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      },
    },
  ];

  const people = (o.facts.story?.characters ?? []).map((c) => `${c.name} (${c.role})`).join("; ");
  const user = `Package this film.\n\nWORKING TITLE: ${o.script.title}\nSTORY: ${o.facts.summary}\nPEOPLE: ${people || "—"}\nFILM COLOURS: primary ${o.design.palette.primary}, accent ${o.design.palette.accent} (the thumbnail may take its own palette)\n\nNARRATION:\n${narration}\n\nPICTURES YOU START WITH:\n${o.pictures.pics.map((p) => o.pictures.brief(p)).join("\n") || "none yet"}\n\nStart by looking at real thumbnails of the channel.`;
  let grace = 1;
  const runRes = await agentLoop({ stage: "publish.agent", model: MODELS.sonnet, system, user, tools, effort: "medium", maxTurns: 56, maxTokens: 24000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "The package is not submitted yet. Render, test blind and submit the title and thumbnail.", log });

  // Not submitted: the best render that carries no blocking issue (least confidently picked out), with the best title.
  const fallback = (): ThumbRender | null => {
    const ok = renders.filter((r) => !r.issues.some((x) => BLOCKERS.has(x.kind)));
    return [...ok].sort((x, y) => (y.critique?.score ?? 0) - (x.critique?.score ?? 0) || (x.imposter?.confidence ?? 0.9) - (y.imposter?.confidence ?? 0.9) || x.issues.length - y.issues.length)[0] ?? null;
  };
  const final = accepted as { title: string; render: ThumbRender } | null;
  const report: PackagingReport = { pass: final !== null, title: final?.title ?? bestTitle() ?? o.script.title, titles, thumbnail: final?.render ?? fallback(), renders: renders.length, agent: { turns: runRes.turns, calls: runRes.calls, usd: runRes.usd } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    const th = report.thumbnail;
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.script.title.slice(0, 60)}": ${report.pass ? "accepted" : "not accepted"} after ${renders.length} render(s); title "${report.title}"${th ? `; thumbnail "${th.concept.slice(0, 90)}" — ${th.imposter ? (th.imposter.spotted ? `picked out ${th.imposter.confidence.toFixed(2)}` : "passed blind") : "not tested"}, ${th.issues.length ? th.issues.map((x) => x.kind).join(", ") : "inside the band"}` : ""}\n`);
  }
  o.onReport?.(report);
  return report;
}
