import { ScenePlan, type FilmDesignSystem, type ResolutionReport, type SceneElement, type SceneSpec, type Storyboard, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { cached, MODELS, plain, structured } from "./llm.js";
import type { StylePack } from "./style-pack.js";

/**
 * Scene designer: writes a layered, keyframed composition for every `scene` shot — one Sonnet call per film.
 * Asset-aware (only slots that really resolved can be placed), palette-token based (the film's design system),
 * and conditioned on the reference channel's labelled designed shots (layout, motion, elements). Output is
 * sanitised in code: coordinates clamped, missing slots dropped, on-screen figures kept only when spoken.
 */

const ENTER = ["fade", "slide_left", "slide_right", "slide_up", "slide_down", "pop", "stamp", "type", "draw", "wipe", "zoom"] as const;
const COLORS = ["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"] as const;
const El = z.object({
  type: z.enum(["photo", "cutout", "text", "shape", "texture"]),
  slot: z.number().describe("picture slot index for photo/cutout, else -1"),
  text: z.string().describe("on-screen words for text, else empty"),
  role: z.enum(["display", "headline", "body", "label", "stamp", "kicker"]),
  shape: z.enum(["none", "underline", "circle", "arrow", "bar", "line", "rect", "bracket", "cross"]),
  frame: z.enum(["none", "print", "torn", "circle", "tv", "polaroid"]),
  grade: z.enum(["natural", "mono", "duotone"]),
  texture: z.enum(["none", "paper", "halftone", "grid", "scanlines", "noise", "stripes"]),
  x: z.number().describe("left edge 0..1"),
  y: z.number().describe("top edge 0..1"),
  w: z.number().describe("width 0..1"),
  h: z.number().describe("height 0..1 for shapes/photos (0 = auto)"),
  x2: z.number().describe("arrow/line end x (0..1), else 0"),
  y2: z.number().describe("arrow/line end y (0..1), else 0"),
  rot: z.number().describe("degrees, -12..12"),
  z: z.number().describe("depth 0 (far) .. 1 (near) — near layers move more with the camera"),
  at: z.number().describe("seconds after the shot starts when it enters"),
  enter: z.enum(ENTER),
  size: z.number().describe("text cap height as a fraction of frame height (0.03 label … 0.22 slam)"),
  align: z.enum(["left", "center", "right"]),
  color: z.enum(COLORS),
  box: z.enum([...COLORS, "none"]).describe("solid box behind text, or none"),
  highlightWord: z.string().describe("one word of the text drawn in the accent, or empty"),
  opacity: z.number().describe("for textures 0..1, else 1"),
});
const Plan = z.object({
  scenes: z.array(
    z.object({
      shotId: z.string(),
      idea: z.string(),
      backdrop: z.enum(["footage", "surface", "paper", "split"]),
      dim: z.number().describe("how much the footage backdrop is darkened, 0.2..0.7"),
      camera: z.object({ fromScale: z.number(), toScale: z.number(), fromX: z.number(), toX: z.number(), fromY: z.number(), toY: z.number() }),
      elements: z.array(El),
    }),
  ),
});

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

export async function designScenes(o: { storyboard: Storyboard; script: TimedScript; resolution: ResolutionReport; design: FilmDesignSystem | null; pack: StylePack; log?: (s: string) => void }): Promise<ScenePlan> {
  const log = o.log ?? (() => {});
  const scenes = o.storyboard.shots.filter((s) => s.source.kind === "designed" && s.source.designed === "scene");
  const empty = ScenePlan.parse({ schemaVersion: 1, storyboardId: o.storyboard.id, scenes: [], generatedAt: new Date().toISOString() });
  if (!scenes.length) return empty;
  const words = o.script.segments.flatMap((s) => s.words);
  const lineOf = (a: number, b: number) => words.filter((w) => w.startS >= a - 0.05 && w.startS < b).map((w) => w.word).join(" ");
  const portrait = o.storyboard.aspect === "9:16";
  const briefs = scenes.map((s) => {
    const p = (s.source as { props: Record<string, unknown> }).props;
    const media = o.resolution.media.filter((m) => m.shotId === s.id);
    const slots = media.filter((m) => m.role === "layer").sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const hasFootage = media.some((m) => m.role === "primary");
    return `SHOT ${s.id} (${(s.endS - s.startS).toFixed(1)} s, starts ${s.startS.toFixed(1)} s)\n  narration: "${lineOf(s.startS, s.endS)}"\n  director's brief: ${String(p.brief ?? s.intent)}\n  on-screen words offered: ${JSON.stringify(p.words ?? [])}\n  footage backdrop: ${hasFootage ? "yes (sharp footage of the line)" : "NO — use surface or paper"}\n  picture slots: ${slots.length ? slots.map((m) => `[${m.slot}] ${m.depicts ?? m.query}${m.width && m.height ? ` (${(m.width / m.height).toFixed(2)}:1)` : ""}`).join("; ") : "none — design with type, shapes and textures only"}`;
  });
  const examples = o.pack.grammar
    .filter((r) => r.designed && r.quality >= 3)
    .slice(0, 40)
    .map((r) => `- "${r.line.slice(0, 90)}" → ${r.kind}: ${r.layout}; motion: ${r.motion}; elements: ${r.elements.join(", ")}`)
    .join("\n");
  const ds = o.design;
  const task = `You are the motion designer of the channel in the style pack. Design one COMPOSED SCENE per shot below: a layered layout drawn by a generic renderer from your spec. Every scene must be specific to its line and different from the others — vary layout, scale, position, entrances and camera; never a centred-title template.

How the real channel designs (labelled reference shots):
${examples}

Renderer vocabulary:
- backdrop: "footage" (the shot's own sharp footage, darkened by dim), "surface" (the film's dark design surface with texture), "paper" (warm paper), "split" (footage left half, surface right half).
- elements (drawn in order, later on top): photo (a picture slot, with frame print/torn/circle/tv/polaroid/none and grade), cutout (a transparent logo/cutout slot, no frame), text (role display/headline/body/label/stamp/kicker; size = cap height as a fraction of frame height; optional solid box; optional highlightWord in the accent), shape (underline, circle, arrow from x,y to x2,y2, bar, line, rect, bracket, cross; draw-on with enter "draw"), texture (paper, halftone, grid, scanlines, noise, stripes over everything, with opacity).
- coordinates are fractions of the ${portrait ? "1080×1920 vertical" : "1920×1080"} frame: x,y = top-left, w = width (h for photos/shapes, 0 = auto). Keep everything inside 0.04..0.96. ${portrait ? "Keep important content in the top two-thirds." : "Keep the bottom 12 % clear."}
- entrance "at" in seconds from the shot start, staggered 0.1–0.6 s apart and synced to when the word is spoken; enter is how it arrives. z = depth for the 2.5D camera.
- camera: a slow move over the whole scene (scale 1.0–1.25, x/y focus 0.4–0.6).
- colours are design tokens of this film: ${ds ? `primary ${ds.palette.primary}, accent ${ds.palette.accent}, surface ${ds.palette.surface}, paper ${ds.palette.paper}, text ${ds.palette.text}; display type ${ds.typography.display}, casing ${ds.typography.casing}; concept "${ds.concept}"` : "primary, accent, surface, paper, text"}.

Rules: on-screen text is 1–4 words (labels up to 6), only words the narrator says or the names on the slots; never a number unless that exact figure is spoken in the shot; never repeat the subtitle. Use only the picture slots listed for that shot (no slot → no photo/cutout). One focal element per scene; contrast must stay readable.`;
  log(`  scene designer: ${scenes.length} composed scene(s) (${MODELS.sonnet})…`);
  const { data } = await structured({ stage: "scenes.design", model: MODELS.sonnet, system: [cached(o.pack.text), plain(task)], user: briefs.join("\n\n"), schema: Plan, effort: "medium", maxTokens: 16000 });

  const specs: SceneSpec[] = [];
  let dropped = 0;
  for (const sh of scenes) {
    const d = data.scenes.find((x) => x.shotId === sh.id);
    if (!d) continue;
    const media = o.resolution.media.filter((m) => m.shotId === sh.id);
    const slots = new Set(media.filter((m) => m.role === "layer").map((m) => m.slot ?? -1));
    const hasFootage = media.some((m) => m.role === "primary");
    const line = lineOf(sh.startS - 1, sh.endS + 1).toLowerCase();
    const dur = sh.endS - sh.startS;
    const els: SceneElement[] = [];
    for (const e of d.elements) {
      const box = { x: clamp(e.x, 0.02, 0.95), y: clamp(e.y, 0.02, 0.95), w: clamp(e.w, 0.03, 0.94), rot: clamp(e.rot, -14, 14), z: clamp(e.z, 0, 1), at: clamp(e.at, 0, Math.max(0, dur - 0.4)), enter: e.enter };
      if ((e.type === "photo" || e.type === "cutout") && !slots.has(e.slot)) {
        dropped++;
        continue;
      }
      if (e.type === "photo") els.push({ type: "photo", slot: e.slot, ...box, frame: e.frame, grade: e.grade, ...(e.h > 0 ? { h: clamp(e.h, 0.05, 0.95) } : {}) });
      else if (e.type === "cutout") els.push({ type: "cutout", slot: e.slot, ...box, shadow: true });
      else if (e.type === "text") {
        const t = e.text.trim().slice(0, 90);
        // Figures on screen only when spoken in (or right around) this shot.
        const nums = t.match(/\d[\d.,]*/g) ?? [];
        if (!t || nums.some((n) => !line.includes(n.replace(/[.,]$/, "")))) {
          dropped++;
          continue;
        }
        els.push({ type: "text", text: t, role: e.role, ...box, size: clamp(e.size, 0.02, 0.24), align: e.align, color: e.color, ...(e.box !== "none" ? { box: e.box } : {}), ...(e.highlightWord.trim() ? { highlightWord: e.highlightWord.trim() } : {}) });
      } else if (e.type === "shape" && e.shape !== "none") els.push({ type: "shape", shape: e.shape, ...box, h: clamp(e.h || 0.008, 0.003, 0.9), color: e.color, ...(e.shape === "arrow" || e.shape === "line" ? { x2: clamp(e.x2, 0.02, 0.98), y2: clamp(e.y2, 0.02, 0.98) } : {}) });
      else if (e.type === "texture" && e.texture !== "none") els.push({ type: "texture", texture: e.texture, opacity: clamp(e.opacity, 0.05, 0.6), at: 0 });
    }
    if (!els.some((e) => e.type !== "texture")) continue; // nothing focal survived → the shot falls back to footage
    specs.push({
      shotId: sh.id,
      idea: d.idea.slice(0, 200),
      backdrop: !hasFootage && (d.backdrop === "footage" || d.backdrop === "split") ? "surface" : d.backdrop,
      dim: clamp(d.dim, 0.15, 0.75),
      camera: { fromScale: clamp(d.camera.fromScale, 1, 1.3), toScale: clamp(d.camera.toScale, 1, 1.3), fromX: clamp(d.camera.fromX, 0.35, 0.65), toX: clamp(d.camera.toX, 0.35, 0.65), fromY: clamp(d.camera.fromY, 0.35, 0.65), toY: clamp(d.camera.toY, 0.35, 0.65) },
      elements: els.slice(0, 12),
    });
  }
  log(`  scene designer: ${specs.length}/${scenes.length} scene(s) designed${dropped ? `; ${dropped} element(s) dropped (missing slot or unspoken figure)` : ""}`);
  return ScenePlan.parse({ schemaVersion: 1, storyboardId: o.storyboard.id, scenes: specs, generatedAt: new Date().toISOString() });
}
