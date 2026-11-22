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
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { FactSheet, FilmDesignSystem, SceneElement, TimedScript } from "@opumia/contracts";
import { measureLook, run } from "@opumia/senses";
import * as z from "zod/v4";
import { agentLoop, MODELS, plain, type AgentTool } from "./llm.js";
import { testTitles, thumbnailImposter } from "./publishing.js";
import { fitLayout } from "./scene-designer.js";
import { labelThumbnails, THUMB_BACKGROUNDS, THUMB_HEROES, THUMB_MARKS, thumbIssues, type ThumbBand, type ThumbIssue } from "./thumbnail-measure.js";

/** The picture tools (resolver/thumbnail-tools.ts), handed in as functions. */
export interface PackagingPicture { slot: number; pub: string; file: string; depicts: string; kind: "photo" | "cutout" | "logo" | "object" | "icon" | "overlay"; aspect: number; face: boolean; named: boolean; fit?: number }
type Fail = { ok: false; why: string };
export interface PackagingPictureTools {
  pics: PackagingPicture[];
  brief: (p: PackagingPicture) => string;
  findPicture: (i: { want: string; subject?: string; type: "person" | "company" | "product" | "object" | "place" | "texture" }) => Promise<{ ok: true; added: PackagingPicture[]; previews: string[]; looked: number } | Fail>;
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
  imposter?: { spotted: boolean; confidence: number; tells: string[] };
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
  references: Array<{ title: string; views: number | null }>;
  pictures: PackagingPictureTools;
  /** Renders a thumbnail spec + finish with the film's scene engine into `out` (1280×720 jpg). */
  render: (i: { spec: unknown; finish: unknown; design: FilmDesignSystem; slots: Record<string, string>; fresh: boolean; out: string }) => Promise<void>;
  avoidConcepts?: string[];
  memoryDir?: string;
  onReport?: (r: PackagingReport) => void;
  log?: (s: string) => void;
}

const COLORS = ["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"] as const;
const HEX = z.string().describe("#RRGGBB");
const Element = z.object({
  type: z.enum(["cutout", "photo", "text", "shape", "texture"]),
  slot: z.number().optional().describe("picture number for cutout/photo"),
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
  h: z.number().optional().describe("photo height, 0–1 of the frame height"),
  // text
  text: z.string().optional(),
  role: z.enum(["display", "headline", "stamp", "label"]).optional(),
  size: z.number().optional().describe("cap height, 0–1 of the frame height (thumbnail text is big: 0.12–0.28)"),
  align: z.enum(["left", "center", "right"]).optional(),
  color: z.enum(COLORS).optional(),
  box: z.enum(COLORS).optional().describe("a solid box behind the text"),
  word: z.string().optional().describe("one word drawn in the accent colour"),
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
});
const Draft = z.object({
  concept: z.string().describe("one sentence: the hero and the twist"),
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
    if (e.type === "cutout" || e.type === "photo") {
      const p = pic(e.slot);
      if (!p) {
        dropped.push(`${e.type} with no picture ${e.slot}`);
        continue;
      }
      used.add(p.slot);
      // A photo with a transparent background drawn as "photo" loses its point; a jpg as "cutout" keeps its box.
      if (e.type === "cutout" || p.kind !== "photo")
        els.push({ type: "cutout", slot: p.slot, ...box, shadow: e.shadow ?? true, outline: e.outline ?? false, ...(validHex(e.outlineColor) ? { outlineColor: e.outlineColor } : {}), ...(validHex(e.glowColor) ? { glowColor: e.glowColor, glowSize: clamp(e.glowSize, 0.3, 3, 1) } : {}), ...(validHex(e.tint) ? { tint: e.tint, tintStrength: clamp(e.tintStrength, 0, 1, 0.6) } : {}), ...(e.look ? { look: e.look } : {}), ...(e.half ? { half: e.half } : {}), ...(e.flip ? { flip: true } : {}) });
      else els.push({ type: "photo", slot: p.slot, ...box, frame: e.frame ?? "none", grade: e.grade ?? "natural", ...(e.h ? { h: clamp(e.h, 0.05, 1.2, 0.5) } : {}) });
    } else if (e.type === "text") {
      const t = (e.text ?? "").trim();
      if (!t) continue;
      if (t.length > 40) {
        dropped.push(`text "${t.slice(0, 30)}…" (too long for a thumbnail)`);
        continue;
      }
      els.push({ type: "text", text: t, role: e.role === "label" ? "label" : e.role === "stamp" ? "stamp" : "display", ...box, size: clamp(e.size, 0.05, 0.3, 0.16), align: e.align ?? "center", color: e.color ?? "text", ...(e.box ? { box: e.box } : {}), ...(e.word?.trim() ? { highlightWord: e.word.trim() } : {}) });
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
  const p = base.palette;
  const design: FilmDesignSystem = {
    ...base,
    palette: { ...p, primary: validHex(d.palette.primary) ? d.palette.primary : p.primary, accent: validHex(d.palette.accent) ? d.palette.accent : p.accent, surface: validHex(d.palette.surface) ? d.palette.surface : p.surface },
    treatment: { ...(base.treatment ?? { phrase: "boxed", label: "tag", photo: "none", particles: "none", wash: "none", washStrength: 0.3, glow: 0.7, motif: "", transition: "whip" as const }), headline: d.headlineStyle, world: d.world, particles: "none", photo: "none", wash: "none", washStrength: 0.3, glow: Math.max(0.6, base.treatment?.glow ?? 0.6) } as FilmDesignSystem["treatment"],
  };
  const spec = { shotId: "thumbnail", idea: d.concept.slice(0, 200), backdrop: "world", dim: 0.3, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: els };
  return { spec, finish, design, used: [...used], dropped, texts: texts.map((t) => (t as { text: string }).text) };
}

export async function packagingAgent(o: PackagingAgentOptions): Promise<PackagingReport> {
  const log = o.log ?? (() => {});
  const skill = await readFile(new URL("../skills/packaging.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readFile(path.join(o.memoryDir, `${o.channel}.md`), "utf8").catch(() => "") : "";
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
    `- made of: real pictures only ${pc(b.makeable.real_pictures)}, retouched faces/objects ${pc(b.makeable.needs_retouch)}, invented scenes ${pc(b.makeable.needs_invention)}, illustration ${pc(b.makeable.illustration)} — you make only the first kind`,
  ].join("\n");
  const refTitles = [...o.references].sort((x, y) => (y.views ?? 0) - (x.views ?? 0)).slice(0, 30).map((r) => `- ${r.title} [${r.views ?? "?"}]`).join("\n");
  const system = [
    plain(`${skill}\n\n${bandText}\n\n## The channel's titles, most viewed first\n${refTitles}${o.avoidConcepts?.length ? `\n\n## Recent thumbnails of ours — do something different\n${o.avoidConcepts.map((c) => `- ${c}`).join("\n")}` : ""}${notes.trim() ? `\n\n## Your own notes from earlier packages\n${tail(notes, 30)}` : ""}${owner.trim() ? `\n\n## The owner's notes on your work (take these seriously)\n${tail(owner, 30)}` : ""}`),
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
      schema: z.object({ hero: z.enum(THUMB_HEROES).optional(), background: z.enum(THUMB_BACKGROUNDS).optional(), mark: z.enum(THUMB_MARKS).optional(), realOnly: z.boolean().optional().describe("only those made from real pictures alone"), max: z.number().optional() }),
      run: async (i: { hero?: string; background?: string; mark?: string; realOnly?: boolean; max?: number }) => {
        const hits = b.items.filter((x) => (!i.hero || x.label.hero === i.hero) && (!i.background || x.label.background === i.background) && (!i.mark || x.label.marks.includes(i.mark as never)) && (!i.realOnly || x.label.makeable === "real_pictures")).sort((x, y) => (y.views ?? 0) - (x.views ?? 0));
        const fresh = [...hits.filter((x) => !seenRefs.has(x.file)), ...hits.filter((x) => seenRefs.has(x.file))].slice(0, clamp(i.max, 1, 6, 4));
        if (!fresh.length) return "no real thumbnail matches that filter — widen it";
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const x of fresh) {
          seenRefs.add(x.file);
          const l = x.label;
          out.push({ type: "text", text: `"${x.title}" — ${x.views ?? "?"} views. hero ${l.hero} ${pc(l.heroShare)}${l.heroCutout ? " cut out" : ""}; background ${l.background}; ${l.words} word(s)${l.words ? ` drawn ${l.textStyle.replace("_", " ")} (${l.textLook})` : ""}; marks ${l.marks.join(", ") || "none"}; ${l.makeable.replace("_", " ")}: ${l.why}` }, await img(x.file));
        }
        return out;
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
      name: "film_footage",
      description: "The film's own footage. Without shotId: a list of its shots (press clips of the real people first). With shotId: six frames of that shot side by side, each with its time — choose the strongest moment (a real expression) and call use_film_frame.",
      schema: z.object({ shotId: z.string().optional() }),
      run: async (i: { shotId?: string }) => {
        if (!i.shotId) return o.pictures.filmShots().map((s) => `${s.shotId} ${s.kind} ${s.origin}${s.seconds ? ` ${s.seconds.toFixed(1)}s` : ""}: ${s.depicts}`).join("\n") || "the film has no footage";
        const r = await o.pictures.filmStrip({ shotId: i.shotId });
        if (!r.ok) return r.why;
        return [{ type: "text", text: `frames at ${r.times.join(", ")} s (left to right, top row first)` }, await img(r.strip)];
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
        const built = build(d, o.design, o.pictures.pics);
        const id = `r${renders.length + 1}`;
        const file = path.join(outDir, `${id}.jpg`);
        await o.render({ spec: built.spec, finish: built.finish, design: built.design, slots: o.pictures.slotMap(), fresh: o.pictures.takeDirty() || renders.length === 0, out: file });
        const phone = path.join(outDir, `${id}.phone.jpg`);
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-filter_complex", "[0]scale=360:-2[a];[0]scale=168:-2,pad=168:202:0:0:0x202020[b];[a]pad=376:202:0:0:0x202020[a2];[a2][b]hstack=inputs=2", "-frames:v", "1", "-update", "1", phone]);
        const [label] = await labelThumbnails([file]);
        const look = await measureLook(file, { fps: 1 });
        const issues = [...textChecks(built.texts, built.used), ...(label ? thumbIssues(label, look, b) : [{ kind: "unmeasured", detail: "the measurement failed; look at it yourself" }])];
        const r: ThumbRender = { id, file, phone, concept: d.concept, spec: built.spec, finish: built.finish, design: built.design, slots: built.used, issues, colourfulness: look.colourfulness };
        renders.push(r);
        log(`    ${id}: "${d.concept.slice(0, 70)}" — ${issues.length ? issues.map((x) => x.kind).join(", ") : "inside the band"}`);
        const head = `${id}: ${label ? `measured — hero ${label.hero} ${pc(label.heroShare)}, background ${label.background}, ${label.words} word(s)${label.words ? ` drawn ${label.textStyle.replace("_", " ")} (${label.textLook})` : ""}, text ${pc(label.textHeight)} high, ${label.elements} focal elements, marks ${label.marks.join(", ") || "none"}, face ${label.expression}; ` : ""}colourfulness ${Math.round(look.colourfulness)}, brightness ${look.luma.toFixed(2)}.${built.dropped.length ? `\nDropped: ${built.dropped.join("; ")}.` : ""}\n${issues.length ? `OUTSIDE THE CHANNEL'S BAND:\n${issues.map((x) => `- [${x.kind}] ${x.detail}`).join("\n")}` : "Inside the channel's band. Now test it blind (imposter_test)."}`;
        return [{ type: "text", text: head }, await img(file), { type: "text", text: "At phone size (home feed 360 px, suggested 168 px):" }, await img(phone)];
      },
    },
    {
      name: "imposter_test",
      description: "Hide a render among four real thumbnails of the channel; a judge who knows the channel picks the imitation and says what gave it away.",
      schema: z.object({ id: z.string() }),
      run: async (i: { id: string }) => {
        const r = renders.find((x) => x.id === i.id);
        if (!r) return `no render ${i.id}`;
        const real = [...b.items].sort((x, y) => (y.views ?? 0) - (x.views ?? 0)).filter((_, k) => k % 3 === imposterRound % 3).slice(0, 4).map((x) => x.file);
        imposterRound++;
        const t = await thumbnailImposter({ channel: o.channel, candidate: r.file, real, seed: imposterRound * 2 + 1 });
        r.imposter = { spotted: t.spotted, confidence: t.spotted ? t.confidence : 0, tells: t.tells };
        log(`    imposter ${r.id}: ${t.spotted ? `picked out (${t.confidence.toFixed(2)})` : "passed as real"}`);
        return t.spotted ? `PICKED OUT as the imitation (confidence ${t.confidence.toFixed(2)}). What gave it away:\n${t.tells.map((x) => `- ${x}`).join("\n")}` : `PASSED as a real thumbnail of the channel${t.tells.length ? ` (the judge's doubts: ${t.tells.join("; ")})` : ""}.`;
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
          const block = r.issues.filter((x) => BLOCKERS.has(x.kind));
          const tw = new Set(content(i.title));
          const texts = (r.spec as { elements: Array<{ type: string; text?: string }> }).elements.filter((e) => e.type === "text").map((e) => e.text ?? "").join(" ");
          const cw = content(texts);
          if (cw.length && cw.filter((w) => tw.has(w)).length / cw.length >= 0.6) refuse.push(`the thumbnail words "${texts}" repeat this title`);
          if (block.length) refuse.push(`blocking: ${block.map((x) => x.detail).join(" | ")}`);
          const soft = r.issues.filter((x) => !BLOCKERS.has(x.kind));
          if (renders.length < 3 && (soft.length || (r.imposter?.spotted && r.imposter.confidence >= 0.7))) refuse.push(`it is still outside the channel's band or was picked out with confidence (${[...soft.map((x) => x.kind), ...(r.imposter?.spotted ? [`spotted ${r.imposter.confidence.toFixed(2)}`] : [])].join(", ")}). Fix it or try a different idea — you have rendered only ${renders.length}.`);
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
  const runRes = await agentLoop({ stage: "publish.agent", model: MODELS.sonnet, system, user, tools, effort: "medium", maxTurns: 36, maxTokens: 24000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "The package is not submitted yet. Render, test blind and submit the title and thumbnail.", log });

  // Not submitted: the best render that carries no blocking issue (least confidently picked out), with the best title.
  const fallback = (): ThumbRender | null => {
    const ok = renders.filter((r) => !r.issues.some((x) => BLOCKERS.has(x.kind)));
    return [...ok].sort((x, y) => (x.imposter?.confidence ?? 0.9) - (y.imposter?.confidence ?? 0.9) || x.issues.length - y.issues.length)[0] ?? null;
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
