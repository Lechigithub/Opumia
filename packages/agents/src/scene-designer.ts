import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { ScenePlan, type FilmDesignSystem, type ResolutionReport, type SceneElement, type SceneSpec, type Storyboard, type StoryboardShot, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

/**
 * Scene designer: every shot of the film gets a composed scene — the way the reference channel treats nearly
 * every shot — written as a layered, timed spec for the motion renderer.
 *
 *  - It LOOKS before it designs: real reference frames of labelled designed shots are shown with every batch.
 *  - It works inside the film's own treatment (text styles, label and photo style, colour world, motif), so a
 *    film is coherent and no two films share a look.
 *  - It is asset-aware: only picture slots that really resolved can be placed.
 *  - It can be shown previews of its own scenes with a critic's notes and asked to fix them (`issues`).
 *
 * Shots are designed in parallel batches; output is sanitised in code (coordinates clamped, missing slots dropped,
 * phrases must be words actually spoken in the shot, figures only when spoken).
 */

const ENTER = ["fade", "slide_left", "slide_right", "slide_up", "slide_down", "pop", "stamp", "type", "draw", "wipe", "zoom"] as const;
const COLORS = ["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"] as const;
const El = z.object({
  type: z.enum(["phrase", "text", "photo", "cutout", "card3d", "text3d", "shape", "texture"]),
  slot: z.number().describe("picture slot index for photo/cutout/card3d, else -1"),
  text: z.string().describe("words for phrase/text/text3d, else empty"),
  role: z.enum(["display", "headline", "body", "label", "stamp", "kicker"]).describe("for text"),
  shape: z.enum(["none", "underline", "circle", "arrow", "bar", "line", "rect", "bracket", "cross"]),
  texture: z.enum(["none", "paper", "halftone", "grid", "scanlines", "noise", "stripes"]),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number().describe("height 0..1 for shapes/photos (0 = auto)"),
  x2: z.number().describe("arrow/line end x, else 0"),
  y2: z.number().describe("arrow/line end y, else 0"),
  rot: z.number().describe("degrees, -10..10"),
  z: z.number().describe("depth 0 far .. 1 near"),
  at: z.number().describe("seconds after the shot starts"),
  enter: z.enum(ENTER),
  size: z.number().describe("text cap height as a fraction of frame height (0.03 label … 0.2 slam)"),
  align: z.enum(["left", "center", "right"]),
  color: z.enum(COLORS),
  word: z.string().describe("one word to emphasise in the accent colour (phrase/text), or empty"),
  outline: z.boolean().describe("white sticker outline for cutouts"),
  spin: z.number().describe("degrees the 3D element turns over the shot (card3d/text3d), else 0"),
});
const Plan = z.object({
  scenes: z.array(
    z.object({
      shotId: z.string(),
      idea: z.string().describe("one line: what the viewer sees and why it fits the line"),
      backdrop: z.enum(["footage", "world", "paper", "split"]),
      wash: z.boolean().describe("colour this shot's footage into the film's palette (use on roughly half of the footage shots: mood, reenactment and generic footage; leave real press footage and photos natural)"),
      dim: z.number().describe("how much the footage is darkened under the design, 0.1..0.6"),
      camera: z.object({ fromScale: z.number(), toScale: z.number(), fromX: z.number(), toX: z.number(), fromY: z.number(), toY: z.number() }),
      elements: z.array(El),
    }),
  ),
});
type PlanScene = z.infer<typeof Plan>["scenes"][number];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s$%€£.]/gu, "").replace(/\s+/g, " ").trim();

export interface SceneExemplar { path: string; caption: string }
export interface DesignScenesOptions {
  storyboard: Storyboard;
  script: TimedScript;
  resolution: ResolutionReport;
  design: FilmDesignSystem | null;
  channel: string;
  /** Real reference frames with their labels, shown to the designer with every batch. */
  exemplars?: SceneExemplar[];
  /** Every real person the film names (research dossier characters), for the name-over-face guard. */
  people?: string[];
  /** Redesign only these shots (after a preview critique), with the critic's notes per shot. */
  issues?: Map<string, string[]>;
  previous?: ScenePlan;
  log?: (s: string) => void;
}

const isScene = (s: StoryboardShot) => s.source.kind === "designed" && s.source.designed === "scene";

export async function designScenes(o: DesignScenesOptions): Promise<ScenePlan> {
  const log = o.log ?? (() => {});
  const all = o.storyboard.shots.filter(isScene);
  const todo = o.issues ? all.filter((s) => o.issues!.has(s.id)) : all;
  const keep = o.issues && o.previous ? o.previous.scenes.filter((x) => !o.issues!.has(x.shotId)) : [];
  if (!todo.length) return ScenePlan.parse({ schemaVersion: 1, storyboardId: o.storyboard.id, scenes: keep, generatedAt: new Date().toISOString() });
  const words = o.script.segments.flatMap((s) => s.words);
  const lineOf = (a: number, b: number) => words.filter((w) => w.startS >= a - 0.05 && w.startS < b).map((w) => w.word).join(" ");
  const portrait = o.storyboard.aspect === "9:16";
  const ds = o.design;
  const tr = ds?.treatment;
  const mediaOf = (id: string) => o.resolution.media.filter((m) => m.shotId === id);

  const brief = (s: StoryboardShot) => {
    const p = (s.source as { props: Record<string, unknown> }).props;
    const media = mediaOf(s.id);
    const slots = media.filter((m) => m.role === "layer").sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const primary = media.find((m) => m.role === "primary");
    const prevSpec = o.previous?.scenes.find((x) => x.shotId === s.id);
    return [
      `SHOT ${s.id} (${(s.endS - s.startS).toFixed(1)} s) — line type: ${s.lineLink}`,
      `  narration: "${lineOf(s.startS, s.endS)}"`,
      `  brief: ${String(p.brief ?? s.intent)}`,
      `  footage backdrop: ${primary ? `yes — ${primary.kind} of ${primary.depicts ?? primary.query} (${primary.origin})` : "NO footage — use backdrop world or paper"}`,
      `  picture slots: ${slots.length ? slots.map((m) => `[${m.slot}] ${m.depicts ?? m.query}${m.width && m.height ? ` (${(m.width / m.height).toFixed(2)}:1)` : ""}`).join("; ") : "none"}`,
      ...(o.issues?.get(s.id)?.length ? [`  YOUR PREVIOUS DESIGN WAS REVIEWED ON A RENDERED PREVIEW. Problems to fix: ${o.issues.get(s.id)!.join("; ")}`, `  previous spec: ${JSON.stringify(prevSpec ?? {}).slice(0, 1400)}`] : []),
    ].join("\n");
  };

  const task = `You are the motion designer of the YouTube documentary channel ${o.channel}. Design ONE composed scene for EVERY shot listed — the real channel puts designed treatment on nearly every shot; a plain stock clip with a slow zoom is a failure. The reference frames above show how the real channel designs (study layout, scale, type treatment and how pictures are cut out and layered — then compose your own, never copy).

THIS FILM'S DESIGN LANGUAGE (already chosen for its topic — stay inside it so the film is coherent):
- concept: ${ds?.concept ?? "—"}
- colours (tokens): primary ${ds?.palette.primary}, accent ${ds?.palette.accent}, surface ${ds?.palette.surface}, paper ${ds?.palette.paper}, text ${ds?.palette.text}
- type: ${ds?.typography.display} display, ${ds?.typography.casing} case. Headlines are drawn "${tr?.headline ?? "solid_stroke"}", kinetic narration phrases "${tr?.phrase ?? "neon_glow"}", labels "${tr?.label ?? "tag"}", photos "${tr?.photo ?? "print"}" (the renderer applies these styles; you place and time the elements).
- backdrop world when there is no footage: "${tr?.world ?? "smoke"}" in the film's colours; footage is washed into the palette automatically.
- recurring motif of this film: ${tr?.motif ?? "—"} — work it in where it fits (shapes, textures, layout), a few times across the film.

ELEMENTS (drawn in order, later on top; every element keeps moving on its own):
- phrase: a run of words THE NARRATOR SAYS IN THIS SHOT (3–9 consecutive words, copied exactly from the narration), revealed word by word in sync with the voice. This is the channel's signature and the right choice for most footage shots. Put it where the footage is calm; vary position and size shot to shot (top band, lower third, left column, right column, centred); "word" = the one word to hit in the accent colour.
- text: headline / display (1–4 words, a name, a verdict, a title), label or kicker (≤ 6 words: who or what a picture is), stamp (1–2 words).
- photo: a picture slot in the film's photo style. cutout: a transparent logo/object slot; outline=true gives the sticker outline. Only slots listed for that shot exist.
- card3d: a picture slot as a real 3D card turning in perspective (spin 15–35°) — for the key picture reveals (at most 3 in the film).
- text3d: ONE short word (≤ 12 letters) as real extruded 3D type, slowly turning (spin 12–24°) — for the 1–2 biggest moments of the film only.
- shape: underline, circle, arrow (x,y → x2,y2), bar, line, rect, bracket, cross — draw-on with enter "draw"; use them to point at, strike through or connect things.
- texture: paper, halftone, grid, scanlines, noise, stripes over the scene.

LAYOUT RULES:
- Coordinates are fractions of the ${portrait ? "1080×1920 vertical" : "1920×1080"} frame; x,y = top-left corner, w = width. Keep everything inside 0.04–0.96${portrait ? "; important content in the top two-thirds" : ""}. Text height ≈ size × number of lines: make sure elements do not overlap each other (leave ≥ 0.03 between boxes) and do not cover a face or the main subject of the footage.
- One focal idea per shot, 1–4 elements. Sizes with intent: a slam is big (0.12–0.2), a phrase medium (0.055–0.09), a label small (0.03–0.045).
- Entrances: "at" in seconds, timed to when the word or thing is spoken, staggered ≥ 0.15 s; vary the enter type.
- Camera: a clear move across the whole scene (scale travels at least 0.08 between 1.0 and 1.2; focus 0.4–0.6), direction alternating shot to shot — the picture is never static.
- No two consecutive shots share a layout. Across the batch use at least 5 clearly different layouts, and at most HALF of the shots may be "phrase over footage" — the rest are picture compositions, headlines, labels on real footage, shapes that point at things, or 3D moments. Vary phrase colour (text, primary, primarySoft) and size too.
- On-screen words are words the narrator says (or the name of what a slot shows). Never a number unless that exact figure is spoken in the shot. Never invent facts.
- backdrop: "footage" when the shot has footage (dim 0.15–0.45, lower when the design is light); "world" or "paper" when it has none or when a picture composition needs a clean stage; "split" = footage left, world right.`;

  const exemplarBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const ex = (o.exemplars ?? []).slice(0, 12);
  for (const [i, e] of ex.entries()) {
    exemplarBlocks.push({ type: "text", text: `REFERENCE FRAME ${i + 1}: ${e.caption}` });
    const img: Anthropic.Beta.BetaImageBlockParam = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(e.path)).toString("base64") } };
    // Cache the exemplar prefix so parallel batches and revisions reuse it.
    if (i === ex.length - 1) img.cache_control = { type: "ephemeral" };
    exemplarBlocks.push(img);
  }

  const BATCH = 8;
  const batches: StoryboardShot[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  log(`  scene designer: ${todo.length} scene(s) in ${batches.length} batch(es)${o.issues ? " (revision after preview)" : ""}, ${ex.length} reference frames (${MODELS.sonnet})…`);
  const results: PlanScene[] = [];
  // First batch alone (writes the cache), the rest in parallel (read it).
  const runBatch = async (b: StoryboardShot[], k: number) => {
    const neighbours = k > 0 ? `\n(The previous batch ended on a ${results.at(-1)?.backdrop ?? "footage"} scene: start differently.)` : "";
    const { data } = await structured({ stage: o.issues ? "scenes.revise" : "scenes.design", model: MODELS.sonnet, system: [plain(task)], user: [...exemplarBlocks, { type: "text", text: `${b.map(brief).join("\n\n")}${neighbours}` }], schema: Plan, effort: "medium", maxTokens: 16000 });
    return data.scenes;
  };
  if (batches.length) results.push(...(await runBatch(batches[0]!, 0)));
  const rest = await Promise.all(batches.slice(1).map((b, k) => runBatch(b, k + 1).catch(() => [] as PlanScene[])));
  for (const r of rest) results.push(...r);

  const specs: SceneSpec[] = [...keep];
  // Surnames of every person the film names (shot entities of type person).
  const people = [...new Set([...(o.people ?? []), ...o.storyboard.shots.flatMap((s) => (s.entities ?? []).filter((e) => e.type === "person").map((e) => e.name))].map((n) => n.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase().split(/\s+/).at(-1)!.replace(/[^a-z]/g, "")))].filter((x) => x.length >= 3);
  let nameGuarded = 0;
  let dropped = 0;
  let three = 0;
  for (const sh of todo) {
    const d = results.find((x) => x.shotId === sh.id);
    if (!d) continue;
    const media = mediaOf(sh.id);
    const slots = new Set(media.filter((m) => m.role === "layer").map((m) => m.slot ?? -1));
    const hasFootage = media.some((m) => m.role === "primary");
    const spoken = norm(lineOf(sh.startS, sh.endS));
    const around = norm(lineOf(sh.startS - 1, sh.endS + 1));
    const dur = sh.endS - sh.startS;
    const els: SceneElement[] = [];
    for (const e of d.elements) {
      const box = { x: clamp(e.x, 0.02, 0.95), y: clamp(e.y, 0.02, 0.95), w: clamp(e.w, 0.03, 0.94), rot: clamp(e.rot, -12, 12), z: clamp(e.z, 0, 1), at: clamp(e.at, 0, Math.max(0, dur - 0.4)), enter: e.enter };
      if (box.x + box.w > 0.98) box.w = Math.max(0.05, 0.98 - box.x);
      const t = e.text.trim();
      const numsOk = (s: string) => (s.match(/\d[\d.,]*/g) ?? []).every((n) => around.includes(n.replace(/[.,]$/, "")));
      if ((e.type === "photo" || e.type === "cutout" || e.type === "card3d") && !slots.has(e.slot)) {
        dropped++;
        continue;
      }
      if (e.type === "photo") els.push({ type: "photo", slot: e.slot, ...box, frame: tr?.photo ?? "print", grade: "natural", ...(e.h > 0 ? { h: clamp(e.h, 0.05, 0.95) } : {}) });
      else if (e.type === "cutout") els.push({ type: "cutout", slot: e.slot, ...box, shadow: true, outline: e.outline });
      else if (e.type === "card3d") {
        if (three >= 4) els.push({ type: "photo", slot: e.slot, ...box, frame: tr?.photo ?? "print", grade: "natural" });
        else (three++, els.push({ type: "card3d", slot: e.slot, ...box, tilt: e.spin >= 0 ? -14 : 14, spin: clamp(e.spin || 22, -40, 40) }));
      } else if (e.type === "phrase") {
        // A phrase must be words actually spoken in this shot (so it can sync to the voice).
        const run = norm(t);
        if (!run || run.split(" ").length < 2 || run.split(" ").length > 10 || !spoken.includes(run)) {
          dropped++;
          continue;
        }
        els.push({ type: "phrase", text: t.slice(0, 120), ...box, size: clamp(e.size, 0.04, 0.14), align: e.align, color: e.color, ...(e.word.trim() ? { emphasis: e.word.trim() } : {}) });
      } else if (e.type === "text3d") {
        if (!t || t.length > 14 || three >= 4 || !numsOk(t)) {
          dropped++;
          continue;
        }
        three++;
        els.push({ type: "text3d", text: t, ...box, w: Math.max(box.w, 0.4), color: e.color === "text" || e.color === "white" ? "primary" : e.color, spin: clamp(e.spin || 18, -30, 30) });
      } else if (e.type === "text") {
        if (!t || !numsOk(t)) {
          dropped++;
          continue;
        }
        els.push({ type: "text", text: t.slice(0, 90), role: e.role, ...box, size: clamp(e.size, 0.022, 0.22), align: e.align, color: e.color, ...(e.word.trim() ? { highlightWord: e.word.trim() } : {}) });
      } else if (e.type === "shape" && e.shape !== "none") els.push({ type: "shape", shape: e.shape, ...box, h: clamp(e.h || 0.008, 0.003, 0.9), color: e.color, ...(e.shape === "arrow" || e.shape === "line" ? { x2: clamp(e.x2, 0.02, 0.98), y2: clamp(e.y2, 0.02, 0.98) } : {}) });
      else if (e.type === "texture" && e.texture !== "none") els.push({ type: "texture", texture: e.texture, opacity: 0.28, at: 0 });
    }
    fitLayout(els, portrait);
    // Name guard: collect every person named anywhere in the film; if this scene's on-screen text names one and
    // its footage is not verified press of that person, the footage is dropped for the film's colour world.
    const onScreen = els.map((e) => ("text" in e ? e.text : "")).join(" ").toLowerCase();
    const primaryM = media.find((m) => m.role === "primary");
    const named = people.filter((sn) => new RegExp(`\\b${sn}\\b`, "i").test(onScreen));
    const verified = (sn: string) => primaryM?.origin === "press" && (primaryM.depicts ?? "").toLowerCase().includes(sn);
    const unsafeFace = named.length > 0 && Boolean(primaryM) && !named.every(verified);
    if (unsafeFace) nameGuarded++;
    if (!els.some((e) => e.type !== "texture" && e.type !== "shape")) {
      // Nothing focal survived: fall back to the channel's signature — a spoken phrase over the footage.
      const ws = lineOf(sh.startS, sh.endS).split(/\s+/).filter(Boolean);
      if (ws.length >= 3) els.push({ type: "phrase", text: ws.slice(0, Math.min(7, ws.length)).join(" "), x: 0.1, y: 0.68, w: 0.8, rot: 0, z: 0.6, at: 0, enter: "fade", size: 0.07, align: "center", color: "text" });
      else continue;
    }
    specs.push({
      shotId: sh.id,
      idea: d.idea.slice(0, 200),
      backdrop: (!hasFootage || unsafeFace) && (d.backdrop === "footage" || d.backdrop === "split") ? "world" : d.backdrop,
      dim: clamp(d.dim, 0.1, 0.6),
      ...(d.wash && hasFootage && tr && tr.wash !== "none" ? { wash: { color: "primary" as const, strength: tr.washStrength, mode: tr.wash } } : {}),
      camera: (() => {
        // The picture always travels: enforce at least 0.1 of scale movement.
        let a = clamp(d.camera.fromScale, 1, 1.26);
        let b = clamp(d.camera.toScale, 1, 1.26);
        if (Math.abs(a - b) < 0.1) [a, b] = a <= b ? [1.02, 1.16] : [1.16, 1.02];
        return { fromScale: a, toScale: b, fromX: clamp(d.camera.fromX, 0.38, 0.62), toX: clamp(d.camera.toX, 0.38, 0.62), fromY: clamp(d.camera.fromY, 0.38, 0.62), toY: clamp(d.camera.toY, 0.38, 0.62) };
      })(),
      elements: els.slice(0, 12),
    });
  }
  specs.sort((a, b) => a.shotId.localeCompare(b.shotId));
  const kinds = new Map<string, number>();
  for (const s of specs) for (const e of s.elements) kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
  log(`  scene designer: ${specs.length}/${all.length} scene(s) ready — ${[...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(", ")}${dropped ? `; ${dropped} element(s) dropped (missing slot, unspoken phrase or figure)` : ""}${nameGuarded ? `; ${nameGuarded} scene(s) moved off footage (a real name over a face that is not verified as that person)` : ""}`);
  return ScenePlan.parse({ schemaVersion: 1, storyboardId: o.storyboard.id, scenes: specs, generatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------------------------------------
// Layout guard

type Boxed = Extract<SceneElement, { x: number }>;
/** Estimated height of an element as a fraction of the frame height. */
function estHeight(e: Boxed, portrait: boolean): number {
  const k = portrait ? 16 / 9 : 9 / 16; // width of one height-unit in frame-width fractions
  if (e.type === "text" || e.type === "phrase") {
    const boxed = e.type === "phrase" ? 1.5 : 1.25;
    const charW = e.size * 0.62 * k;
    const words = e.text.split(/\s+/);
    let lines = 1;
    let cur = 0;
    for (const w of words) {
      const ww = (w.length + 1) * charW;
      if (cur + ww > e.w && cur > 0) (lines++, (cur = ww));
      else cur += ww;
    }
    return lines * e.size * boxed + 0.01;
  }
  if (e.type === "photo") return e.h ?? (e.w / k) * 0.72;
  if (e.type === "cutout") return (e.w / k) * 0.8;
  if (e.type === "card3d") return (e.w / k) * 0.75;
  if (e.type === "text3d") return (e.w / k) * 0.42;
  return 0;
}

/** Keep focal elements inside the safe area and apart from each other (mutates `els`). */
function fitLayout(els: SceneElement[], portrait: boolean): void {
  const SAFE = { l: 0.05, r: 0.95, t: 0.06, b: portrait ? 0.7 : 0.9 };
  const focal = els.filter((e): e is Boxed => e.type !== "texture" && e.type !== "shape");
  const rect = (e: Boxed) => ({ x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + estHeight(e, portrait) });
  const shrink = (e: Boxed) => {
    if (e.type === "text" || e.type === "phrase") e.size = Math.max(0.026, e.size * 0.82);
    else e.w = Math.max(0.12, e.w * 0.85);
  };
  for (const e of focal) {
    e.w = Math.min(e.w, SAFE.r - SAFE.l);
    if (e.x < SAFE.l) e.x = SAFE.l;
    if (e.x + e.w > SAFE.r) e.x = SAFE.r - e.w;
    for (let k = 0; k < 6 && e.y + estHeight(e, portrait) > SAFE.b; k++) {
      const over = e.y + estHeight(e, portrait) - SAFE.b;
      if (e.y - over >= SAFE.t) e.y -= over;
      else (e.y = SAFE.t), shrink(e);
    }
    if (e.y < SAFE.t) e.y = SAFE.t;
  }
  // Separate overlaps: later (on top) element moves below or above the earlier one, else shrinks, else goes.
  const gap = 0.025;
  const drop = new Set<SceneElement>();
  for (let i = 0; i < focal.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = focal[j]!;
      const b = focal[i]!;
      if (drop.has(a) || drop.has(b)) continue;
      for (let k = 0; k < 5; k++) {
        const ra = rect(a);
        const rb = rect(b);
        const overlap = rb.x0 < ra.x1 && rb.x1 > ra.x0 && rb.y0 < ra.y1 && rb.y1 > ra.y0;
        if (!overlap) break;
        const hb = rb.y1 - rb.y0;
        if (ra.y1 + gap + hb <= SAFE.b) b.y = ra.y1 + gap;
        else if (ra.y0 - gap - hb >= SAFE.t) b.y = ra.y0 - gap - hb;
        else if (k < 3) (shrink(b), shrink(a));
        else drop.add(b.type === "phrase" && a.type !== "phrase" ? a : b);
      }
    }
  }
  if (drop.size) for (let i = els.length - 1; i >= 0; i--) if (drop.has(els[i]!)) els.splice(i, 1);
}

// ---------------------------------------------------------------------------------------------------------
// Preview critic: looks at rendered previews of the scenes and says what is wrong.

const Critique = z.object({
  shots: z.array(
    z.object({
      shotId: z.string(),
      ok: z.boolean().describe("true only if a professional editor would ship this shot as is"),
      problems: z.array(z.enum(["text_overlap", "off_frame", "unreadable", "covers_subject", "cluttered", "empty_or_dull", "picture_mismatch", "ugly_layout", "broken"])),
      fix: z.string().describe("one concrete instruction for the designer, or empty"),
    }),
  ),
});

/** Each preview is one image: the same shot at several moments, left to right. */
export async function critiqueScenes(o: { channel: string; previews: Array<{ shotId: string; sheet: string; line: string; idea: string }>; reference?: string[] }): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const img = async (p: string): Promise<Anthropic.Beta.BetaContentBlockParam> => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(p)).toString("base64") } });
  const refBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [i, r] of (o.reference ?? []).slice(0, 4).entries()) refBlocks.push({ type: "text", text: `REAL ${o.channel} frame ${i + 1} (the standard to meet):` }, await img(r));
  for (let i = 0; i < o.previews.length; i += 6) {
    const part = o.previews.slice(i, i + 6);
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [...refBlocks];
    for (const p of part) blocks.push({ type: "text", text: `SHOT ${p.shotId} — narration: "${p.line.slice(0, 160)}" — intended: ${p.idea.slice(0, 140)}. Preview (early, middle, end of the shot):` }, await img(p.sheet));
    const { data } = await structured({
      stage: "scenes.critique",
      model: MODELS.haiku,
      system: [plain(`You are a strict finishing editor for the YouTube documentary channel ${o.channel}, reviewing rendered previews of designed shots before the film is rendered. For each shot say whether it ships. Flag: text overlapping other text or pictures; anything cut off by the frame edge; text that is hard to read against what is behind it; a design covering a face or the main subject; clutter; a shot that is empty, dull or just a stock clip with a little text nobody would notice; a picture that does not show what the line is about; an amateur or unbalanced layout; anything visibly broken. Be specific in the fix (what to move, shrink, remove or replace). Do not flag a shot only because it is simple — a strong phrase over good footage ships.`)],
      user: blocks,
      schema: Critique,
      effort: "low",
      maxTokens: 4000,
    }).catch(() => ({ data: { shots: [] as z.infer<typeof Critique>["shots"] } }));
    for (const s of data.shots) if (!s.ok && part.some((p) => p.shotId === s.shotId)) out.set(s.shotId, [...new Set(s.problems.map(String))].concat(s.fix ? [s.fix] : []));
  }
  return out;
}
