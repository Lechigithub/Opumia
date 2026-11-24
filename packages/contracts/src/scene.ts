import { z } from "zod";

/**
 * Composed scene: a layered, keyframed design spec the scene designer writes per shot and the generic
 * ComposedScene renderer draws. No fixed template: layout, motion and camera are data; every word and card is the film's kit.
 * Coordinates are fractions of the frame (0..1); times are seconds from the shot start.
 */
export const SceneEnter = z.enum(["fade", "slide_left", "slide_right", "slide_up", "slide_down", "pop", "stamp", "type", "draw", "wipe", "zoom", "settle", "glitch", "swoop"]);
const Box = { x: z.number(), y: z.number(), w: z.number(), rot: z.number().default(0), z: z.number().min(0).max(1).default(0.5), at: z.number().min(0).default(0), enter: SceneEnter.default("fade"), /** craft inventory: how it leaves before the cut — slides off, or erodes away (blur, crumble, fade) */ exit: z.enum(["none", "slide", "erode"]).optional(), /** craft inventory: the element follows the subject it is placed on (a motion-tracked caption): the footage point it is pinned to, and the tracked path filled in by the platform */ track: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), path: z.array(z.object({ t: z.number(), x: z.number(), y: z.number() })).optional() }).optional() };
export const ColorToken = z.enum(["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"]);
/** Treatment of a placed picture (build list 5, item 11): its own grade. */
export const PhotoGrade = z.enum(["natural", "mono", "duotone", "punch", "sepia", "contrast_bw", "split", "invert", "lowkey", "warm_glow", "thermal", "solarise"]);
/** Craft inventory: how a placed picture is framed — a white-bordered polaroid print, a glowing neon frame, ripped paper edges, tilted in 3D perspective. */
export const PhotoFrame = z.enum(["none", "polaroid", "neon", "torn", "perspective"]);



/**
 * Scene elements (build list 3, L3–L5): real pictures, and THIS film's own kit components. Every word, number,
 * label, card, frame, chart, map, document and infographic on screen is drawn by the film's kit (written for this film
 * by its art director); the engine only places pictures and passes verified data. The generic text, phrase, 3D type,
 * decorative shapes, textures and the engine-drawn infographics (counter, steps, icon grid, newspaper, screen) were
 * removed: they made every film look alike.
 */
export const SceneElement = z.discriminatedUnion("type", [
  /** A real picture placed as it is (framing, if any, comes from a kit component holding the slot). */
  z.object({ type: z.literal("photo"), slot: z.number().int().min(0), ...Box, grade: PhotoGrade.default("natural"), frame: PhotoFrame.optional(), h: z.number().optional(), /** craft inventory: a double exposure — the picture laid over the frame by light (screen), translucent */ blend: z.enum(["normal", "screen"]).optional() }),
  z.object({
    type: z.literal("cutout"), slot: z.number().int().min(0), ...Box, shadow: z.boolean().default(true),
    /** Craft inventory: the channel's black silhouette figures, and cut-outs with a white outline or a coloured glow. */
    silhouette: z.boolean().optional(),
    /** Owner 2026-11-23: deterministic retouching of a real face (never a generative model): smoothing, sharpening,
     *  relighting, a warp exaggerating a feature or expression centred on (cx, cy) of the cut-out. */
    retouch: z.object({ smooth: z.number().min(0).max(1).optional(), sharpen: z.number().min(0).max(1).optional(), relight: z.number().min(0).max(1).optional(), warp: z.number().min(0).max(1).optional(), cx: z.number().min(0).max(1).optional(), cy: z.number().min(0).max(1).optional() }).optional(),
    outline: z.boolean().optional(),
    glow: z.enum(["primary", "accent", "white"]).optional(),
    /** Compositing into the backdrop: its colour laid over the subject, light from the backdrop's own direction, a
     *  contact shadow, cleaned edges (resolver/composite.ts sets these from the footage or the stage). */
    matchColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    matchStrength: z.number().min(0).max(1).optional(),
    lightAngle: z.number().min(0).max(360).optional(),
    lightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    lightStrength: z.number().min(0).max(1).optional(),
    contactShadow: z.number().min(0).max(1).optional(),
    soften: z.number().min(0).max(3).optional(),
    brightness: z.number().min(0.6).max(1.5).optional(),
  }),
  /** Real 3D (Three.js): a picture slot as a lit card in perspective, turning through `spin` degrees. */
  z.object({ type: z.literal("card3d"), slot: z.number().int().min(0), ...Box, tilt: z.number().min(-40).max(40).default(-14), spin: z.number().min(-60).max(60).default(22) }),
  /** Real 3D type (Three.js): words the narrator says, extruded and lit, turning through `spin` degrees (craft inventory). */
  z.object({ type: z.literal("text3d"), ...Box, h: z.number().optional(), text: z.string().min(1).max(40), spin: z.number().min(-60).max(60).default(18), serif: z.boolean().optional(), color: z.enum(["primary", "accent", "white", "paper"]).optional(), /** craft inventory: a metallic chrome or gold title */ material: z.enum(["paint", "chrome", "gold"]).optional() }),
  /** Craft inventory: a real 3D prop — a licensed (CC0) glTF model found by `query`, lit and turning in the frame. */
  z.object({ type: z.literal("prop3d"), ...Box, h: z.number().optional(), query: z.string().min(2).max(80), model: z.string().optional(), spin: z.number().min(-180).max(180).default(30), tilt: z.number().min(-40).max(60).default(22) }),
  /** One of THIS film's kit components, with its props (words spoken in the shot; slots; verified data). */
  z.object({ type: z.literal("component"), ...Box, h: z.number().optional(), name: z.string(), props: z.record(z.string(), z.unknown()).default({}) }),
]);
export type SceneElement = z.infer<typeof SceneElement>;



/**
 * Build list 5, item 10: the worlds a designed shot is built in, learned from the reference (it almost never uses a
 * plain stage): a treated real picture (black and white with a colour accent, duotone), a cut-out over a burst, a
 * collage of real pictures, a bold flat field that changes with the idea, paper and print, a terminal or UI.
 * Drawn deterministically by the engine (remotion/scenes/Worlds.tsx) from real pictures and designed shapes only.
 */
export const WORLD_KINDS = ["mono_accent", "duotone", "burst", "collage", "flat_field", "paper", "terminal", "filmstrip", "contact_grid", "split", "gradient", "room3d"] as const;
export const SceneWorld = z.object({
  kind: z.enum(WORLD_KINDS),
  /** The real picture the world is made of (mono_accent, duotone; the first of a collage). */
  slot: z.number().int().min(0).optional(),
  /** Further real pictures of a collage. */
  slots: z.array(z.number().int().min(0)).max(5).optional(),
  color: ColorToken.default("primary"),
  accent: ColorToken.default("accent"),
  /** craft inventory: a real paper scan from the library (crumpled, folded, aged) under a paper world, tinted */
  texture: z.number().int().min(0).optional(),
});
export type SceneWorld = z.infer<typeof SceneWorld>;
/** Build list 5, item 11: the treatment laid over the whole shot (the channel's frames almost all carry one). */
export const SceneFinish = z.object({ grain: z.number().min(0).max(1).default(0), vignette: z.number().min(0).max(1).default(0), leak: z.number().min(0).max(1).default(0), /** craft inventory: a halftone / grunge dot print texture */ halftone: z.number().min(0).max(1).optional() });
/** Craft inventory: a real filmed atmosphere over the shot (Library/overlays, screen-blended): the channel's smoke and
 *  fog layers, embers and dust, film scratches, film burns and the sprocket gate. */
export const ATMOS_KINDS = ["smoke", "embers", "dust", "scratches", "burn", "sprocket", "leak", "money", "snow", "confetti", "bokeh"] as const;
export const SceneAtmos = z.object({ kind: z.enum(ATMOS_KINDS), opacity: z.number().min(0.1).max(1).default(0.6) });

export const SceneSpec = z.object({
  shotId: z.string(),
  /** What sits behind the elements: the shot's own footage (sharp, dimmed), or the kit's own stage. */
  backdrop: z.enum(["footage", "stage", "world"]).default("footage"),
  /** backdrop "world": which world, made of which real pictures. */
  world: SceneWorld.optional(),
  finish: SceneFinish.optional(),
  atmos: SceneAtmos.optional(),
  /** Craft inventory: the channel techniques this scene uses (ids), as the designer named them. */
  techniques: z.array(z.string()).optional(),
  /** Craft inventory: a glitch burst with RGB split at the shot's start; shallow depth of field (the backdrop defocused
   *  behind the pictures on it, 0–1). */
  /** Craft inventory: a picture slot (a cut-out object: banknotes, coins, documents, leaves) repeated as a falling or
   *  drifting layer over the shot. */
  drift: z.object({ slot: z.number().int().min(0), mode: z.enum(["fall", "float"]), count: z.number().int().min(3).max(24).default(10) }).optional(),
  fx: z.object({
    glitch: z.boolean().optional(), dof: z.number().min(0).max(1).optional(), /** a rack focus: the shot opens out of focus and pulls sharp */ rack: z.boolean().optional(),
    /** scanlines and a flicker over glowing type (the channel's neon / CRT text) */ scanlines: z.boolean().optional(),
    /** a ruler / numeral grid laid over the picture (measuring something) */ grid: z.boolean().optional(),
    /** an interface cursor that moves to (x, y) and clicks — a UI close-up */ cursor: z.object({ x: z.number(), y: z.number() }).optional(),
    /** two-tone complementary grade: a cool backdrop against warm pictures in front */ twotone: z.boolean().optional(),
  }).optional(),
  /** Colour the footage backdrop into the film's world. */
  wash: z.object({ color: ColorToken, strength: z.number().min(0).max(0.85), mode: z.enum(["tint", "duotone"]) }).optional(),
  dim: z.number().min(0).max(0.85).default(0.45),
  camera: z.object({ fromScale: z.number().min(0.9).max(1.6), toScale: z.number().min(0.9).max(1.6), fromX: z.number().default(0.5), toX: z.number().default(0.5), fromY: z.number().default(0.5), toY: z.number().default(0.5) }),
  /** Empty = the footage plays clean, with nothing on it (the reference leaves about four shots in ten this way). */
  elements: z.array(SceneElement).max(12),
  /** Why this layout (for logs / memory). */
  idea: z.string(),
});
export type SceneSpec = z.infer<typeof SceneSpec>;

export const ScenePlan = z.object({
  schemaVersion: z.literal(2),
  storyboardId: z.string(),
  scenes: z.array(SceneSpec),
  generatedAt: z.string(),
});
export type ScenePlan = z.infer<typeof ScenePlan>;
