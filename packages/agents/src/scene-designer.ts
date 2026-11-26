import type { Preset } from "./technique-grammar.js";
import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { FOOTAGE_SLOT, ScenePlan, WORLD_KINDS, type ResolutionReport, type SceneElement, type SceneSpec, type Storyboard, type StoryboardShot, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, ROLE_MODEL, structured } from "./llm.js";

/**
 * Scene drafts → checked scenes (build list 3, L7): the scene designer AGENT writes every scene (scene-agent.ts);
 * this module only checks and applies its drafts — no model call of its own (the single-prompt designer was removed).
 *
 * A scene is real pictures (photo, cut-out, 3D card) and THIS film's kit components. Every check is in code:
 *  - picture slots must exist; a component must exist in the film's kit;
 *  - every word in a component's props is spoken in the shot (±1 s), every figure is a spoken figure;
 *  - a real name on screen over footage that is not verified press of that person moves the scene to the kit's stage;
 *  - clean footage only on moving video; elements kept inside the safe area and apart.
 * The kit's phrase component is marked `sync` so its words land on the frames they are spoken.
 */

const ENTER = ["fade", "slide_left", "slide_right", "slide_up", "slide_down", "pop", "stamp", "type", "draw", "wipe", "zoom", "settle", "glitch", "swoop"] as const;
const El = z.object({
  type: z.enum(["photo", "cutout", "card3d", "text3d", "prop3d", "component"]),
  prop: z.string().describe("prop3d: what real 3D object to place, in a few words (\"vintage office chair\", \"gold bars\", \"wooden barrel\") — a licensed CC0 model is found and rendered in 3D; else empty"),
  text: z.string().describe("text3d: two to five words the narrator says in this shot, set as real extruded 3D type; else empty"),
  style: z.enum(["none", "silhouette", "outline", "glow", "retouch", "exaggerate"]).describe("cutout: the channel's black silhouette figure, a white outline, a coloured glow; retouch (deterministic: smoothed, sharpened, relit portrait) or exaggerate (retouched with a warp that pushes the expression) — owner allows retouching real faces with deterministic tools; else none"),
  slot: z.number().describe("picture slot index for photo/cutout/card3d, else -1"),
  component: z.string().describe("component: the name of one of THIS film's kit components, else empty"),
  propsJson: z.string().describe("component: its props as a JSON object — words must be words the narrator says in this shot, figures spoken figures, slots existing picture slots; else empty"),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number().describe("height 0..1 for photos and components (0 = auto)"),
  rot: z.number().describe("degrees, -10..10"),
  z: z.number().describe("depth 0 far .. 1 near"),
  at: z.number().describe("seconds after the shot starts"),
  enter: z.enum(ENTER),
  pinX: z.number().describe("to place a caption ON a moving subject in the footage and have it follow the subject: the subject's point x (0–1 of the frame); -1 for none"),
  pinY: z.number().describe("the subject's point y (0–1); -1 for none"),
  exit: z.enum(["none", "slide", "erode"]).describe("how it leaves before the cut: slide off, or erode away (blur, crumble, fade) — the channel's text exits; none for most"),
  spin: z.number().describe("degrees the 3D card turns over the shot (card3d), else 0"),
  frame: z.enum(["none", "polaroid", "neon", "torn", "perspective"]).describe("photo: a white-bordered polaroid print (several swooping in at different depths read as the channel's floating photo cards), a glowing neon frame, ripped paper edges, or a screen/document tilted in 3D perspective; else none"),
  material: z.enum(["paint", "chrome", "gold"]).describe("text3d: paint, or a metallic chrome / gold title"),
  blend: z.enum(["normal", "screen"]).describe("photo: screen = a double exposure (the picture laid over the frame by its light, translucent); else normal"),
  grade: z.enum(["natural", "mono", "duotone", "punch", "sepia", "contrast_bw", "split", "invert", "lowkey", "warm_glow", "thermal", "solarise"]).describe("warm_glow = golden lifted highlights; thermal = false colour; solarise = blown, inverted highlights; contrast_bw = the channel's high-contrast black and white; split = cool shadows and warm light; invert = a negative; lowkey = dark and moody. Photo: its own grade (treatment) — mono, duotone, punch or sepia tie a stock picture into the film; natural for press photos that must stay as they are"),
});
const TOKENS = ["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "black", "white"] as const;
const WorldDraft = z.object({
  kind: z.enum([...WORLD_KINDS, "none"]).describe("backdrop world: mono_accent (a real picture in black and white with one accent bar), duotone (a real picture in two colours), burst (rays behind a cut-out), collage (2–5 real pictures as prints), flat_field (one bold colour field that changes with the idea), paper (paper and print, a real picture printed on it optional), terminal (a terminal / UI window); none for footage backdrops"),
  slot: z.number().describe("the real picture slot the world is made of (mono_accent, duotone, paper, terminal, the first of a collage), else -1"),
  slots: z.array(z.number()).describe("collage: the further picture slots, else []"),
  color: z.enum(TOKENS).describe("the world's main colour — change it with the idea, do not reuse one colour for every shot"),
  accent: z.enum(TOKENS),
});
/** A panel of a continuous journey (hand film v30b–v32): the camera holds on it, drifting, then flies to the next. */
const StopDraft = z.object({
  slot: z.number().describe("the real picture or clip of this panel: a picture slot, or -1 for the shot's own footage"),
  at: z.number().describe("seconds after the shot starts when the camera has arrived (the first panel 0). The camera leaves a panel only after its words have been up long enough to read — later stops are moved later if needed"),
  move: z.enum(["slide", "push", "whip", "rise"]).describe("how the camera reaches this panel: slide to a neighbour, push THROUGH the last picture into this one, whip (fast, motion-blurred, a beat change), rise. Vary them"),
  look: z.enum(["natural", "mono", "contrast", "cool", "warm", "faded", "bright", "duotone"]),
  dof: z.number().describe("0–1: the panel's picture defocused behind a sharp cut-out in front of it; 0 for none"),
  blendSlot: z.number().describe("a second picture double-exposed over this one (screen), or -1"),
  elements: z.array(El).describe("words and pictures ON the panel (they travel with it)"),
  fore: z.array(El).describe("a layer IN FRONT of the panel at its own depth — a cut-out of the subject, so words on the panel sit between the picture and the subject (parallax, text behind the subject); [] for none"),
});
const FinishDraft = z.object({ grain: z.number().describe("0..1 film grain"), vignette: z.number().describe("0..1"), leak: z.number().describe("0..1 light leak sweeping across (sparingly)"), halftone: z.number().describe("0..1 a halftone / grunge print-dot texture; 0 for most") });
const Plan = z.object({
  scenes: z.array(
    z.object({
      shotId: z.string(),
      idea: z.string().describe("one line: what the viewer sees and why it fits the line"),
      techniques: z.array(z.string()).describe("the channel's techniques this shot uses, by id from your brief (see_technique shows how the channel uses each) — their recipes are applied for you; your own fields refine them"),
      backdrop: z.enum(["footage", "world", "journey"]).describe("the shot's own footage, a WORLD built from real pictures (shots without footage, or where a treated picture carries the line better), or a JOURNEY: one continuous camera travelling through 2–6 panels of real pictures with no cut (the channel changes picture by moving three times in four)"),
      journey: z.object({ stops: z.array(StopDraft).max(6) }).describe("backdrop journey: its panels in order (2–6); { stops: [] } otherwise"),
      world: WorldDraft,
      finish: FinishDraft.describe("the treatment over the whole shot; the channel's frames almost all carry one (grain, vignette, a leak)"),
      drift: z.object({ slot: z.number().describe("a picture slot holding a cut-out object (banknotes, coins, papers, leaves) — add one with add_library_object; -1 for none"), mode: z.enum(["fall", "float"]) }).describe("a falling or floating layer of that object over the shot (the channel's falling banknotes, drifting objects)"),
      fx: z.object({ glitch: z.boolean().describe("a glitch burst with RGB split at the shot's start (the channel's glitching text and logo reveals)"), dof: z.number().describe("0–1: shallow depth of field — the backdrop defocused behind the pictures and words on it; 0 for none"), rack: z.boolean().describe("a rack focus: the shot opens out of focus and pulls sharp"), scanlines: z.boolean().describe("scanlines and a flicker over the shot (neon / CRT type)"), grid: z.boolean().describe("a ruler / numeral grid over the picture"), cursorX: z.number().describe("an interface cursor that moves to this x (0–1) and clicks; -1 for none"), cursorY: z.number().describe("its y (0–1)"), twotone: z.boolean().describe("a two-tone complementary grade: cool ground, warm pictures in front") }),
      atmos: z.enum(["none", "smoke", "embers", "dust", "scratches", "burn", "sprocket", "leak", "snow", "confetti", "bokeh"]).describe("a real filmed atmosphere over the shot (the channel's smoke and fog, embers, dust, film scratches, film burns, the sprocket gate of old film, a light leak) — at about the channel's rate; none for most shots"),
      clean: z.boolean().describe("true = let the footage play clean, with NO elements on it — only for a shot whose footage is moving video that shows what the line is about; the real channel leaves about four shots in ten this way"),
      wash: z.boolean().describe("colour this shot's footage into the film's palette (mood, reenactment and generic footage; leave real press footage and photos natural)"),
      dim: z.number().describe("how much the footage is darkened under the design, 0.1..0.6"),
      camera: z.object({ fromScale: z.number(), toScale: z.number(), fromX: z.number(), toX: z.number(), fromY: z.number(), toY: z.number() }),
      elements: z.array(El),
    }),
  ),
});
type PlanScene = z.infer<typeof Plan>["scenes"][number];
/** The scene agent's tool input, checked by the guards below. */
export const SceneDraftSchema = Plan;
export type SceneDraftScene = PlanScene;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s$%€£.]/gu, "").replace(/\s+/g, " ").trim();

/** The film's kit as the scene designer sees it (design/film/meta.json). */
export interface FilmKitMeta { concept: string; components: Record<string, { use: string; props: string; role?: string }>; roles?: Record<string, string> }
export interface DesignScenesOptions {
  storyboard: Storyboard;
  script: TimedScript;
  resolution: ResolutionReport;
  channel: string;
  /** Every real person the film names (research dossier characters), for the name-over-face guard. */
  people?: string[];
  previous?: ScenePlan;
  kit: FilmKitMeta;
  /** The scene agent's drafts, checked and applied here. */
  raw: SceneDraftScene[];
  /** Craft inventory: each technique's recipe in the scene format (technique id → preset). */
  presets?: Record<string, Preset>;
  log?: (s: string) => void;
}

const isScene = (s: StoryboardShot) => s.source.kind === "designed" && s.source.designed === "scene";

const FUNCTION_END = /\b(from|of|to|the|and|a|an|with|for|in|on|by|at|that|which|its|their|his|her|as|or|but|into|than|was|were|is|are|be)$/i;
/**
 * Why on-screen text is not a phrase (null when it is): a broken fragment ending on a function word, or one common word
 * that is neither a name (written with a capital inside the narration), a figure nor an acronym. Exported for tests.
 */
export function loneText(text: string, line: string): string | null {
  const t = text.replace(/[^\p{L}\p{N}$%€£'\s-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (FUNCTION_END.test(t)) return "a broken fragment (it ends on a function word)";
  const ws = t.split(" ");
  if (ws.length > 1) return null;
  const w = ws[0]!;
  if (/\d/.test(w) || (w.length >= 2 && w.length <= 5 && w === w.toUpperCase() && new RegExp(`\\b${w}\\b`).test(line))) return null; // a figure, or an acronym said as one
  // a name: written with a capital in the narration somewhere that is not the first word of a sentence
  const toks = line.split(/\s+/);
  const seen = toks.map((tok, i) => ({ bare: tok.replace(/[^\p{L}\p{N}'-]/gu, "").replace(/'s$/i, ""), start: i === 0 || /[.!?]["”']?$/.test(toks[i - 1] ?? "") })).filter((x) => x.bare.toLowerCase() === w.toLowerCase());
  // capitalised mid-sentence, or capitalised every time it is said (a brand that opens sentences: "Kodak")
  const named = seen.some((x) => !x.start && /^\p{Lu}/u.test(x.bare)) || (seen.length > 0 && seen.every((x) => /^\p{Lu}/u.test(x.bare)) && seen.some((x) => x.bare.length > 3));
  return named ? null : "one common word, not a phrase";
}

export async function designScenes(o: DesignScenesOptions): Promise<ScenePlan> {
  const log = o.log ?? (() => {});
  const all = o.storyboard.shots.filter(isScene);
  const rawIds = new Set(o.raw.map((x) => x.shotId));
  const todo = all.filter((s) => rawIds.has(s.id));
  const keep = (o.previous?.scenes ?? []).filter((x) => !rawIds.has(x.shotId));
  const words = o.script.segments.flatMap((s) => s.words);
  const lineOf = (a: number, b: number) => words.filter((w) => w.startS >= a - 0.05 && w.startS < b).map((w) => w.word).join(" ");
  const portrait = o.storyboard.aspect === "9:16";
  const mediaOf = (id: string) => o.resolution.media.filter((m) => m.shotId === id);
  const phraseRole = o.kit.roles?.phrase;
  const specs: SceneSpec[] = [...keep];
  const people = [...new Set([...(o.people ?? []), ...o.storyboard.shots.flatMap((s) => (s.entities ?? []).filter((e) => e.type === "person").map((e) => e.name))].map((n) => n.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase().split(/\s+/).at(-1)!.replace(/[^a-z]/g, "")))].filter((x) => x.length >= 3);
  let nameGuarded = 0;
  let dropped = 0;
  const refusals: string[] = [];
  let three = 0;
  let threeText = 0;
  let threeProps = 0;
  for (const sh of todo) {
    const d = o.raw.find((x) => x.shotId === sh.id);
    if (!d) continue;
    // craft inventory: the techniques the designer named bring their recipes (the designer's own fields refine them)
    if (o.presets && (d as { techniques?: string[] }).techniques?.length) applyPresets(d as never, (d as { techniques: string[] }).techniques.map((id) => o.presets![id]).filter((p): p is Preset => Boolean(p)));
    const media = mediaOf(sh.id);
    const slots = new Set(media.filter((m) => m.role === "layer").map((m) => m.slot ?? -1));
    const primaryM = media.find((m) => m.role === "primary");
    const hasFootage = Boolean(primaryM);
    const around = norm(lineOf(sh.startS - 1, sh.endS + 1));
    const said = new Set(around.split(" "));
    const numsOk = (s: string) => (s.match(/\d[\d.,]*/g) ?? []).every((n) => around.includes(n.replace(/[.,]$/, "")));
    const wordsOk = (v: string) => { const ws = norm(v).split(" ").filter((x) => x.length > 2); return !ws.length || ws.filter((x) => said.has(x)).length / ws.length >= 0.7; };
    const dur = sh.endS - sh.startS;
    const convert = (list: Array<z.infer<typeof El>>): SceneElement[] => {
    const els: SceneElement[] = [];
    for (const e of list) {
      const box = { x: clamp(e.x, 0, 0.95), y: clamp(e.y, 0, 0.95), w: clamp(e.w, 0.03, 1), rot: clamp(e.rot, -12, 12), z: clamp(e.z, 0, 1), at: clamp(e.at, 0, Math.max(0, dur - 0.4)), enter: e.enter , ...(e.exit && e.exit !== "none" ? { exit: e.exit } : {}), ...(e.pinX >= 0 && e.pinY >= 0 && hasFootage ? { track: { x: clamp(e.pinX, 0, 1), y: clamp(e.pinY, 0, 1) } } : {}) };
      if (e.type === "photo" || e.type === "cutout" || e.type === "card3d") {
        if (!slots.has(e.slot)) { dropped++; continue; }
        if (e.type === "photo") els.push({ type: "photo", slot: e.slot, ...box, grade: e.grade ?? "natural", ...(e.h > 0 ? { h: clamp(e.h, 0.05, 1) } : {}), ...(e.blend === "screen" ? { blend: "screen" as const } : {}), ...(e.frame && e.frame !== "none" ? { frame: e.frame } : {}) });
        else if (e.type === "cutout") els.push({ type: "cutout", slot: e.slot, ...box, shadow: true, ...(e.style === "silhouette" ? { silhouette: true } : e.style === "outline" ? { outline: true } : e.style === "glow" ? { glow: "accent" as const } : e.style === "retouch" ? { retouch: { smooth: 0.5, sharpen: 0.45, relight: 0.4 } } : e.style === "exaggerate" ? { retouch: { smooth: 0.4, sharpen: 0.5, relight: 0.4, warp: 0.45, cx: 0.5, cy: 0.38 } } : {}) });
        else if (three < 4) (three++, els.push({ type: "card3d", slot: e.slot, ...box, tilt: e.spin >= 0 ? -14 : 14, spin: clamp(e.spin || 22, -40, 40) }));
        else els.push({ type: "photo", slot: e.slot, ...box, grade: "natural" });
        continue;
      }
      // craft inventory: a real 3D prop (licensed CC0 model, found and placed after design) — at most 4 in a film
      if (e.type === "prop3d") {
        const q = (e.prop ?? "").trim();
        if (q.length < 3 || threeProps >= 4) { dropped++; continue; }
        threeProps++;
        els.push({ type: "prop3d", ...box, ...(e.h > 0 ? { h: clamp(e.h, 0.1, 0.9) } : {}), query: q.slice(0, 80), spin: clamp(e.spin || 30, -180, 180), tilt: 22 });
        continue;
      }
      // craft inventory: 3D type — spoken words only, a phrase not a lone common word, at most 4 in a film
      if (e.type === "text3d") {
        const t = (e.text ?? "").trim();
        if (!t || !wordsOk(t) || !numsOk(t) || threeText >= 4) { dropped++; continue; }
        const why = loneText(t, lineOf(sh.startS - 1, sh.endS + 1));
        if (why) { dropped++; refusals.push(`${sh.id}: 3D "${t.slice(0, 30)}" — ${why}`); continue; }
        threeText++;
        els.push({ type: "text3d", ...box, ...(e.h > 0 ? { h: clamp(e.h, 0.08, 0.5) } : {}), text: t.slice(0, 40), spin: clamp(e.spin || 18, -40, 40), ...(e.material && e.material !== "paint" ? { material: e.material } : {}) });
        continue;
      }
      // a component of this film's kit: it must exist; every word and figure in its props is spoken in the shot
      if (!o.kit.components[e.component]) { dropped++; continue; }
      let props: Record<string, unknown> = {};
      try { props = e.propsJson.trim() ? (JSON.parse(e.propsJson) as Record<string, unknown>) : {}; } catch { dropped++; continue; }
      const bad = Object.entries(props).filter(([k, v]) => typeof v === "string" && !/^(slot|color|colour|align|variant|style|kind|mode|side|tone|edge|code|unit|prefix|suffix)$/i.test(k) && (!numsOk(v) || !wordsOk(v)));
      if (bad.length) { dropped++; continue; }
      // Build list 4, item 14: words on screen read as a phrase. A headline or phrase that is one common word
      // ("INVESTMENT", "MARKET" over money) or a broken fragment ("EARNED FROM") is refused; a name, a figure or a
      // label (a caption under a picture) may be one word.
      const role = Object.entries(o.kit.roles ?? {}).find(([, c]) => c === e.component)?.[0];
      if (role === "headline" || role === "phrase") {
        const why = Object.entries(props).filter(([k, v]) => typeof v === "string" && /^(text|title|headline|phrase|line|words)$/i.test(k)).map(([, v]) => loneText(String(v), lineOf(sh.startS - 1, sh.endS + 1))).find(Boolean);
        if (why) { dropped++; refusals.push(`${sh.id}: "${String(props.text ?? props.title ?? "").slice(0, 40)}" — ${why}`); continue; }
      }
      for (const [k, v] of Object.entries(props)) if (/slot/i.test(k) && typeof v === "number" && !slots.has(v)) delete props[k];
      if (phraseRole && e.component === phraseRole) props.sync = true;
      els.push({ type: "component", ...box, ...(e.h > 0 ? { h: clamp(e.h, 0.05, 1) } : {}), name: e.component, props });
    }
    return els;
    };
    const els = convert(d.elements);
    fitLayout(els, portrait);
    // Name guard: a real name on screen over footage that is not verified press of that person → the kit's stage.
    const onScreen = els.flatMap((e) => (e.type === "component" ? Object.values(e.props).filter((v): v is string => typeof v === "string") : [])).join(" ").toLowerCase();
    const named = people.filter((sn) => new RegExp(`\\b${sn}\\b`, "i").test(onScreen));
    const verified = (sn: string) => primaryM?.origin === "press" && (primaryM.depicts ?? "").toLowerCase().includes(sn);
    // the channel's practice (owner, 2026-11-26): a name over an actor performing the person is fine when no real
    // footage or photo of them exists in this film; when it does, the name goes on the real person.
    const realOf = (sn: string) => o.resolution.media.some((m) => m.origin === "press" && (m.depicts ?? "").toLowerCase().includes(sn));
    const unsafeFace = named.length > 0 && hasFootage && !named.every((sn) => verified(sn) || !realOf(sn));
    if (unsafeFace) nameGuarded++;
    // A journey: one camera through 2–6 panels, never a cut inside the shot (hand film v30b–v32)
    if (d.backdrop === "journey" && (d.journey?.stops.length ?? 0) >= 2) {
      const usable = (x: number) => slots.has(x) || (x === -1 && hasFootage && !unsafeFace);
      const drafts = d.journey!.stops.filter((st) => usable(st.slot)).slice(0, 6);
      if (drafts.length >= 2) {
        const stops = drafts.map((st, k) => {
          const pe = convert(st.elements), fe = convert(st.fore);
          fitLayout(pe, portrait);
          return { at: k === 0 ? 0 : clamp(st.at, 0.6, Math.max(0.6, dur - 0.8)), slot: st.slot === -1 ? FOOTAGE_SLOT : st.slot, move: st.move, look: st.look, frame: "none" as const, elements: pe.slice(0, 6), ...(fe.length ? { fore: fe.slice(0, 4) } : {}), ...(st.dof > 0 ? { dof: clamp(st.dof, 0, 1) } : {}), ...(st.blendSlot >= 0 && slots.has(st.blendSlot) ? { blendSlot: st.blendSlot } : {}) };
        });
        const journey = journeyStops(stops, dur);
        specs.push({ shotId: sh.id, idea: d.idea.slice(0, 200), ...((d as { techniques?: string[] }).techniques?.length ? { techniques: (d as { techniques: string[] }).techniques.slice(0, 6) } : {}), backdrop: "journey", journey, finish: finishOf(d.finish), ...(d.atmos && d.atmos !== "none" ? { atmos: { kind: d.atmos, opacity: 0.6 } } : {}), dim: 0, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: [] } as unknown as SceneSpec);
        continue;
      }
      refusals.push(`${sh.id}: journey needs two panels with real pictures — designed as a single scene instead`);
    }
    // Clean footage: moving video that plays with nothing on it (never a still, never a shot without footage).
    if (d.clean && primaryM?.kind === "video" && !unsafeFace) {
      specs.push({ shotId: sh.id, idea: d.idea.slice(0, 200), ...((d as { techniques?: string[] }).techniques?.length ? { techniques: (d as { techniques: string[] }).techniques.slice(0, 6) } : {}), backdrop: "footage", finish: finishOf(d.finish), ...(d.atmos && d.atmos !== "none" ? { atmos: { kind: d.atmos, opacity: 0.6 } } : {}), ...(d.drift && d.drift.slot >= 0 && slots.has(d.drift.slot) ? { drift: { slot: d.drift.slot, mode: d.drift.mode, count: d.drift.mode === "fall" ? 14 : 8 } } : {}), ...(d.fx && (d.fx.glitch || d.fx.dof > 0 || d.fx.rack || d.fx.scanlines || d.fx.grid || d.fx.cursorX >= 0 || d.fx.twotone) ? { fx: { ...(d.fx.glitch ? { glitch: true } : {}), ...(d.fx.dof > 0 ? { dof: clamp(d.fx.dof, 0, 1) } : {}), ...(d.fx.rack ? { rack: true } : {}), ...(d.fx.scanlines ? { scanlines: true } : {}), ...(d.fx.grid ? { grid: true } : {}), ...(d.fx.cursorX >= 0 ? { cursor: { x: clamp(d.fx.cursorX, 0.05, 0.95), y: clamp(d.fx.cursorY, 0.05, 0.95) } } : {}), ...(d.fx.twotone ? { twotone: true } : {}) } } : {}), dim: 0.1, camera: { fromScale: 1.02, toScale: 1.12, fromX: 0.5, toX: clamp(d.camera.toX, 0.42, 0.58), fromY: 0.5, toY: clamp(d.camera.toY, 0.42, 0.58) }, elements: [] });
      continue;
    }
    const stage = !hasFootage || unsafeFace || d.backdrop === "world";
    // build list 5, item 10: no plain stage — a shot without footage is built in a world made of real pictures
    const world = stage ? worldOf(d.world, [...slots].filter((x) => x >= 0).sort((a, b) => a - b), specs.length) : undefined;
    // proof film (Quibi): bursts, terminals and flat fields with nothing on them rendered as empty frames — a world
    // carries a picture or the line's words, never nothing
    if (!els.length && !(world && world.slot !== undefined)) { dropped++; continue; }
    specs.push({
      shotId: sh.id,
      idea: d.idea.slice(0, 200), ...((d as { techniques?: string[] }).techniques?.length ? { techniques: (d as { techniques: string[] }).techniques.slice(0, 6) } : {}),
      backdrop: stage ? "world" : "footage",
      ...(world ? { world } : {}),
      finish: finishOf(d.finish),
      ...(d.atmos && d.atmos !== "none" ? { atmos: { kind: d.atmos, opacity: 0.6 } } : {}), ...(d.drift && d.drift.slot >= 0 && slots.has(d.drift.slot) ? { drift: { slot: d.drift.slot, mode: d.drift.mode, count: d.drift.mode === "fall" ? 14 : 8 } } : {}), ...(d.fx && (d.fx.glitch || d.fx.dof > 0 || d.fx.rack || d.fx.scanlines || d.fx.grid || d.fx.cursorX >= 0 || d.fx.twotone) ? { fx: { ...(d.fx.glitch ? { glitch: true } : {}), ...(d.fx.dof > 0 ? { dof: clamp(d.fx.dof, 0, 1) } : {}), ...(d.fx.rack ? { rack: true } : {}), ...(d.fx.scanlines ? { scanlines: true } : {}), ...(d.fx.grid ? { grid: true } : {}), ...(d.fx.cursorX >= 0 ? { cursor: { x: clamp(d.fx.cursorX, 0.05, 0.95), y: clamp(d.fx.cursorY, 0.05, 0.95) } } : {}), ...(d.fx.twotone ? { twotone: true } : {}) } } : {}),
      dim: clamp(d.dim, 0.1, 0.6),
      ...(d.wash && !stage ? { wash: { color: "primary" as const, strength: 0.16, mode: "tint" as const } } : {}),
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
  // build list 5, items 10, 12 and 14: across the film — no world twice in a row, no phrase card repeated in the next
  // shot, each picture once (a second use only with a different crop AND treatment).
  const order = new Map(o.storyboard.shots.map((x, k) => [x.id, k] as [string, number]));
  const ordered = [...specs].sort((a, b) => (order.get(a.shotId) ?? 0) - (order.get(b.shotId) ?? 0));
  const refOf = (shotId: string, slot: number) => o.resolution.media.find((m) => m.shotId === shotId && m.role === "layer" && m.slot === slot)?.ref;
  refusals.push(...repetitionGuard(ordered, refOf, (id) => mediaOf(id).filter((m) => m.role === "layer").map((m) => m.slot ?? -1).filter((x) => x >= 0)));
  if (refusals.length) log(`  refused or changed by the guards: ${refusals.join("; ")}`);
  const kinds = new Map<string, number>();
  for (const s of specs) for (const e of s.elements) kinds.set(e.type === "component" ? `component:${e.name}` : e.type, (kinds.get(e.type === "component" ? `component:${e.name}` : e.type) ?? 0) + 1);
  log(`  scenes: ${specs.length}/${all.length} ready — ${[...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(", ")}${dropped ? `; ${dropped} element(s) or scene(s) refused (missing slot, unknown component, unspoken words or figures)` : ""}${nameGuarded ? `; ${nameGuarded} scene(s) moved to the kit's stage (a real name over a face that is not verified as that person)` : ""}`);
  return ScenePlan.parse({ schemaVersion: 2, storyboardId: o.storyboard.id, scenes: specs, generatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------------------------------------
// Worlds, finish and repetition (build list 5, items 10, 11, 12, 14)

type WorldOut = NonNullable<SceneSpec["world"]>;
const NEEDS_PICTURE = new Set(["mono_accent", "duotone", "collage", "filmstrip", "contact_grid", "split"]);
/** The world a draft asks for, made valid: its pictures must exist; with none it falls to a field that needs none. */
export function worldOf(d: z.infer<typeof WorldDraft> | undefined, slots: number[], k: number): WorldOut {
  const has = (x: number) => slots.includes(x);
  let kind = d && d.kind !== "none" ? d.kind : slots.length ? (["duotone", "mono_accent", "collage", "paper"] as const)[k % (slots.length >= 2 ? 4 : 2)]! : (["flat_field", "burst", "terminal"] as const)[k % 3]!;
  let slot = d && has(d.slot) ? d.slot : slots[0];
  const more = (d?.slots ?? []).filter((x) => has(x) && x !== slot).slice(0, 4);
  if (kind === "collage" && more.length === 0) more.push(...slots.filter((x) => x !== slot).slice(0, 3));
  if (kind === "collage" && more.length === 0) kind = "duotone";
  if (NEEDS_PICTURE.has(kind) && slot === undefined) kind = "flat_field";
  if (kind === "burst" || kind === "flat_field") slot = undefined;
  const color = (d?.color ?? "primary") as WorldOut["color"];
  const accent = (d?.accent && d.accent !== d.color ? d.accent : color === "accent" ? "primary" : "accent") as WorldOut["accent"];
  return { kind, ...(slot !== undefined ? { slot } : {}), ...(kind === "collage" ? { slots: more } : {}), color, accent };
}
/** The finish over a shot, with a floor: every frame of the channel carries some treatment. */
export function finishOf(f: { grain: number; vignette: number; leak: number; halftone?: number } | undefined): { grain: number; vignette: number; leak: number; halftone?: number } {
  return { grain: clamp(Math.max(f?.grain ?? 0, 0.18), 0, 1), vignette: clamp(Math.max(f?.vignette ?? 0, 0.22), 0, 1), leak: clamp(f?.leak ?? 0, 0, 0.8), ...(f?.halftone && f.halftone > 0 ? { halftone: clamp(f.halftone, 0, 1) } : {}) };
}
const cardText = (e: SceneElement) => (e.type === "component" ? norm(Object.entries(e.props).filter(([k, v]) => typeof v === "string" && !/^(slot|color|colour|align|variant|style|kind|mode|side|tone|edge|code|unit|prefix|suffix)$/i.test(k)).map(([, v]) => v as string).join(" ")) : "");
const treatmentOf = (sc: SceneSpec, e: SceneElement | null) => (e ? (e.type === "photo" ? e.grade ?? "natural" : e.type) : `world:${sc.world?.kind ?? "?"}`);
const cropOf = (e: SceneElement | null) => (e && "w" in e ? e.w : 1);

/**
 * Mutates `ordered` (scenes in film order). Returns what it refused, for the designer's log.
 *  - the same world kind never twice in a row (the later one turns to the next kind its pictures allow);
 *  - a phrase/headline card never repeats in the next shot;
 *  - a picture placed once; a second use only with a different crop (≥ 30 % size) AND a different treatment; never a third.
 */
export function repetitionGuard(ordered: SceneSpec[], refOf: (shotId: string, slot: number) => string | undefined, slotsOf: (shotId: string) => number[]): string[] {
  const refused: string[] = [];
  const uses = new Map<string, Array<{ shotId: string; crop: number; treat: string }>>();
  const base = (id: string) => id.replace(/(_\d+)+$/, "");
  const accept = (ref: string | undefined, shotId: string, crop: number, treat: string): boolean => {
    if (!ref) return true;
    const u = (uses.get(ref) ?? []).filter((x) => base(x.shotId) !== base(shotId));
    const ok = u.length === 0 || (u.length === 1 && Math.abs(crop - u[0]!.crop) / Math.max(crop, u[0]!.crop) >= 0.3 && treat !== u[0]!.treat);
    if (ok) uses.set(ref, [...(uses.get(ref) ?? []), { shotId, crop, treat }]);
    return ok;
  };
  let prev: SceneSpec | null = null;
  for (const sc of ordered) {
    if (sc.world && prev?.world && prev.world.kind === sc.world.kind) {
      const slots = slotsOf(sc.shotId);
      const options = (slots.length ? ["duotone", "mono_accent", "paper", "collage", "terminal", "flat_field", "burst"] : ["flat_field", "burst", "terminal"]).filter((k) => k !== prev!.world!.kind && (k !== "collage" || slots.length >= 2));
      const was = sc.world.kind;
      sc.world = { ...sc.world, kind: options[0] as WorldOut["kind"], ...(options[0] === "collage" ? { slots: slots.filter((x) => x !== sc.world!.slot).slice(0, 3) } : {}) };
      if ((sc.world.kind === "flat_field" || sc.world.kind === "burst") && sc.world.slot !== undefined) delete sc.world.slot;
      refused.push(`${sc.shotId}: world "${was}" again right after ${prev.shotId} — turned to "${sc.world.kind}"`);
    }
    if (prev) {
      const before = new Set(prev.elements.map(cardText).filter((t) => t.length > 3));
      for (let i = sc.elements.length - 1; i >= 0; i--) {
        const t = cardText(sc.elements[i]!);
        if (t.length > 3 && before.has(t) && sc.elements.length > 1) {
          refused.push(`${sc.shotId}: the card "${t.slice(0, 30)}" repeats the shot before — removed`);
          sc.elements.splice(i, 1);
        }
      }
    }
    if (sc.world?.slot !== undefined && !accept(refOf(sc.shotId, sc.world.slot), sc.shotId, 1, treatmentOf(sc, null))) {
      refused.push(`${sc.shotId}: its world picture is already used in this film — world turned to a field`);
      sc.world = { kind: "flat_field", color: sc.world.color, accent: sc.world.accent };
    }
    for (let i = sc.elements.length - 1; i >= 0; i--) {
      const e = sc.elements[i]!;
      if (e.type !== "photo" && e.type !== "cutout" && e.type !== "card3d") continue;
      if (!accept(refOf(sc.shotId, e.slot), sc.shotId, cropOf(e), treatmentOf(sc, e))) {
        refused.push(`${sc.shotId}: picture [${e.slot}] already used in this film (a second use needs another crop and treatment) — removed`);
        sc.elements.splice(i, 1);
      }
    }
    prev = sc;
  }
  return refused;
}

// ---------------------------------------------------------------------------------------------------------
// Layout guard

type Boxed = Extract<SceneElement, { x: number }>;
/** Estimated height of an element as a fraction of the frame height. */
function estHeight(e: Boxed, portrait: boolean): number {
  const k = portrait ? 16 / 9 : 9 / 16; // width of one height-unit in frame-width fractions
  if (e.type === "photo") return e.h ?? (e.w / k) * 0.72;
  if (e.type === "cutout") return (e.w / k) * 0.8;
  if (e.type === "card3d") return (e.w / k) * 0.75;
  if (e.type === "component") return e.h ?? (e.w / k) * 0.3;
  return 0;
}

/** Keep elements inside the safe area and apart from each other (mutates `els`). Full-frame components are left alone. */
export function fitLayout(els: SceneElement[], portrait: boolean): void {
  const SAFE = { l: 0.05, r: 0.95, t: 0.06, b: portrait ? 0.7 : 0.9 };
  const fullFrame = (e: Boxed) => e.w >= 0.95 && e.x <= 0.03;
  const focal = els.filter((e): e is Boxed => "x" in e && !fullFrame(e as Boxed));
  const rect = (e: Boxed) => ({ x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + estHeight(e, portrait) });
  const shrink = (e: Boxed) => { e.w = Math.max(0.12, e.w * 0.85); };
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
        else drop.add(b);
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
      ok: z.boolean().describe("true if the shot can ship: no defect a viewer would notice at normal speed"),
      severity: z.number().describe("0–10: 0–3 fine or a matter of taste; 4–5 a small flaw a viewer would not notice; 6–7 a visible defect; 8–10 broken or misleading"),
      problems: z.array(z.enum(["text_overlap", "off_frame", "unreadable", "covers_subject", "cluttered", "empty_or_dull", "picture_mismatch", "ugly_layout", "broken", "placeholder", "tinted_footage"])),
      fix: z.string().describe("one concrete instruction for the designer, or empty"),
    }),
  ),
});

/** Each preview is one image: the same shot at several moments, left to right. */
/** Defects a viewer sees. The rest (clutter, dullness, layout taste) only counts when the critic calls the shot broken. */
const HARD_DEFECT = new Set(["text_overlap", "off_frame", "unreadable", "covers_subject", "picture_mismatch", "broken", "placeholder", "tinted_footage"]);

/**
 * Calibrated on real reference frames (dev/critic-test.ts): the critic must pass nearly all of them. Only
 * visible defects send a scene back, worst first, and at most `maxShare` of the film — a critic that flags
 * everything doubles the design cost and tells the designer nothing.
 */
export async function critiqueScenes(o: { channel: string; previews: Array<{ shotId: string; sheet: string; line: string; idea: string }>; reference?: string[]; maxShare?: number }): Promise<Map<string, string[]>> {
  const found: Array<{ shotId: string; severity: number; notes: string[] }> = [];
  const parts: Array<typeof o.previews> = [];
  for (let i = 0; i < o.previews.length; i += 6) parts.push(o.previews.slice(i, i + 6));
  const img = async (p: string): Promise<Anthropic.Beta.BetaContentBlockParam> => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(p)).toString("base64") } });
  const refBlocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [i, r] of (o.reference ?? []).slice(0, 4).entries()) refBlocks.push({ type: "text", text: `REAL ${o.channel} frame ${i + 1} (the standard to meet):` }, await img(r));
  const review = async (part: typeof o.previews) => {
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [...refBlocks];
    for (const p of part) blocks.push({ type: "text", text: `SHOT ${p.shotId} — narration: "${p.line.slice(0, 160)}" — intended: ${p.idea.slice(0, 140)}. Preview (early, middle, end of the shot):` }, await img(p.sheet));
    const { data } = await structured({
      stage: "scenes.critique",
      model: ROLE_MODEL.sceneCritic,
      system: [plain(`You are a strict finishing editor for the YouTube documentary channel ${o.channel}, reviewing rendered previews of designed shots before the film is rendered. For each shot say whether it ships. Flag: text overlapping other text or pictures; anything cut off by the frame edge; text that is hard to read against what is behind it — including pale or mid-grey letters on a light label box, or dark letters on a dark box (a box does not make text readable; the letters must stand out from the box itself); a design covering a face or the main subject; clutter; a shot that is empty, dull or just a stock clip with a little text nobody would notice; a picture that does not show what the line is about; an amateur or unbalanced layout; anything visibly broken; PLACEHOLDERS — generic pictograms that stand in for pictures (grey person silhouettes, mountain-and-sun "image" icons, empty picture frames, blank cards), which read as an unfinished template, and a lone line icon (people, arrows, gears) dropped over real footage (problem "placeholder"); real footage drowned in one strong colour (a red or blue wash where the picture's own colours are gone — "tinted_footage"). Be specific in the fix (what to move, shrink, remove or replace). Do not flag a shot only because it is simple — a strong phrase over good footage ships. The real frames above are the standard: they are simple, sometimes rough, and they ship. A preview sheet shows three moments, so text caught mid-entrance in the first moment is animation, not a defect. Do not ask for elements that are merely absent from the brief, and do not judge taste: flag only what a viewer would see as wrong. Most finished shots should pass.`)],
      user: blocks,
      schema: Critique,
      effort: "low",
      maxTokens: 4000,
    }).catch(() => ({ data: { shots: [] as z.infer<typeof Critique>["shots"] } }));
    for (const s of data.shots) {
      if (s.ok || !part.some((p) => p.shotId === s.shotId)) continue;
      const hard = s.problems.some((x) => HARD_DEFECT.has(String(x)));
      if ((hard && s.severity >= 7) || s.severity >= 9) found.push({ shotId: s.shotId, severity: s.severity, notes: [...new Set(s.problems.map(String))].concat(s.fix ? [s.fix] : []) });
    }
  };
  // Batches run side by side (they are independent); four at a time.
  for (let i = 0; i < parts.length; i += 4) await Promise.all(parts.slice(i, i + 4).map(review));
  const cap = Math.max(1, Math.ceil(o.previews.length * (o.maxShare ?? 0.4)));
  return new Map(found.sort((a, b) => b.severity - a.severity || a.shotId.localeCompare(b.shotId)).slice(0, cap).map((f) => [f.shotId, f.notes]));
}


/** Merge technique recipes into a scene draft: a recipe fills what the designer left at its default. */
export function applyPresets(d: Record<string, any>, ps: Preset[]): void {
  for (const p of ps) {
    if (p.world !== "none" && (!d.world || d.world.kind === "none")) {
      d.world = { ...(d.world ?? {}), kind: p.world, slot: d.world?.slot ?? -1, slots: d.world?.slots ?? [] };
      d.backdrop = "world";
    }
    if (p.atmos !== "none" && (!d.atmos || d.atmos === "none")) d.atmos = p.atmos;
    d.fx = { glitch: false, dof: 0, rack: false, scanlines: false, grid: false, cursorX: -1, cursorY: -1, twotone: false, ...(d.fx ?? {}) };
    d.fx.glitch ||= p.glitch; d.fx.rack ||= p.rack; d.fx.scanlines ||= p.scanlines; d.fx.grid ||= p.grid; d.fx.twotone ||= p.twotone;
    d.fx.dof = Math.max(d.fx.dof ?? 0, p.dof ?? 0);
    d.finish = { grain: 0, vignette: 0, leak: 0, halftone: 0, ...(d.finish ?? {}) };
    d.finish.grain = Math.max(d.finish.grain, p.grain ?? 0); d.finish.leak = Math.max(d.finish.leak, p.leak ?? 0); d.finish.halftone = Math.max(d.finish.halftone ?? 0, p.halftone ?? 0);
    const els = (d.elements ?? []) as Array<Record<string, any>>;
    const photo = els.find((e) => e.type === "photo");
    if (photo && p.grade !== "none" && (!photo.grade || photo.grade === "natural")) photo.grade = p.grade;
    if (photo && p.frame !== "none" && (!photo.frame || photo.frame === "none")) photo.frame = p.frame;
    const cut = els.find((e) => e.type === "cutout");
    if (cut && p.cutout !== "none" && (!cut.style || cut.style === "none")) cut.style = p.cutout;
    const first = els[0];
    if (first && p.enter !== "none" && (!first.enter || first.enter === "fade")) first.enter = p.enter;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Journeys (hand film v30b–v32)

/** Seconds the camera stays after a panel's last word has arrived, before it leaves (owner: "never rushed, so viewers
 *  can actually see what the word says clearly"; the channel's words stay up a median 2.5 s). */
export const READ_HOLD = 1.1;
type DraftStop = { at: number; slot?: number; move: "slide" | "push" | "whip" | "rise"; elements: SceneElement[]; fore?: SceneElement[] } & Record<string, unknown>;
/**
 * Lays a journey's panels out and times it:
 *  - panels sit next to each other (just over a frame apart), so a flight always shows the picture it leaves and the
 *    one it reaches, never an empty table; a push sets the next panel straight behind (through the last picture), a
 *    rise above it;
 *  - the camera leaves a panel only after its last word has been up READ_HOLD s (later panels move later);
 *  - panels that no longer fit in the shot are dropped.
 */
export function journeyStops(stops: DraftStop[], durS: number, travel = 1.0) {
  const lastWord = (s: DraftStop) => Math.max(0, ...[...s.elements, ...(s.fore ?? [])].flatMap((e) => [Number((e as { at?: number }).at ?? 0), ...(((e as { props?: { words?: Array<{ from: number; text: string }> } }).props?.words ?? []).filter((w) => w.text !== "|").map((w) => w.from / 24))]));
  const out: Array<DraftStop & { x: number; y: number; depth: number; ry: number; rz: number; size: number }> = [];
  let px = 0, py = 0, pd = 0, dir = 1;
  for (const [k, s] of stops.entries()) {
    let at = s.at;
    if (k > 0) {
      const prev = out[k - 1]!;
      at = Math.max(at, +(prev.at + lastWord(prev) + READ_HOLD + travel).toFixed(2), prev.at + 1.2);
      if (at > durS - 0.6) break;
      if (s.move === "push") pd += 2.6;
      else if (s.move === "rise") { py -= 1.06; pd += 0.15; }
      else { px += dir * (s.move === "whip" ? 1.12 : 1.06); if (k % 3 === 2) dir = -dir; }
    }
    out.push({ ...s, at, x: px, y: py, depth: pd, ry: 0, rz: 0, size: 1 });
  }
  return { stops: out, travel, push: 0.035, ground: "black" as const };
}
