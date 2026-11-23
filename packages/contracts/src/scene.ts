import { z } from "zod";

/**
 * Composed scene: a layered, keyframed design spec the scene designer writes per shot and the generic
 * ComposedScene renderer draws. No fixed template: layout, motion and camera are data; every word and card is the film's kit.
 * Coordinates are fractions of the frame (0..1); times are seconds from the shot start.
 */
export const SceneEnter = z.enum(["fade", "slide_left", "slide_right", "slide_up", "slide_down", "pop", "stamp", "type", "draw", "wipe", "zoom"]);
const Box = { x: z.number(), y: z.number(), w: z.number(), rot: z.number().default(0), z: z.number().min(0).max(1).default(0.5), at: z.number().min(0).default(0), enter: SceneEnter.default("fade") };
export const ColorToken = z.enum(["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"]);
/** Treatment of a placed picture (build list 5, item 11): its own grade. */
export const PhotoGrade = z.enum(["natural", "mono", "duotone", "punch", "sepia"]);



/**
 * Scene elements (build list 3, L3–L5): real pictures, and THIS film's own kit components. Every word, number,
 * label, card, frame, chart, map, document and infographic on screen is drawn by the film's kit (written for this film
 * by its art director); the engine only places pictures and passes verified data. The generic text, phrase, 3D type,
 * decorative shapes, textures and the engine-drawn infographics (counter, steps, icon grid, newspaper, screen) were
 * removed: they made every film look alike.
 */
export const SceneElement = z.discriminatedUnion("type", [
  /** A real picture placed as it is (framing, if any, comes from a kit component holding the slot). */
  z.object({ type: z.literal("photo"), slot: z.number().int().min(0), ...Box, grade: PhotoGrade.default("natural"), h: z.number().optional() }),
  z.object({
    type: z.literal("cutout"), slot: z.number().int().min(0), ...Box, shadow: z.boolean().default(true),
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
export const WORLD_KINDS = ["mono_accent", "duotone", "burst", "collage", "flat_field", "paper", "terminal"] as const;
export const SceneWorld = z.object({
  kind: z.enum(WORLD_KINDS),
  /** The real picture the world is made of (mono_accent, duotone; the first of a collage). */
  slot: z.number().int().min(0).optional(),
  /** Further real pictures of a collage. */
  slots: z.array(z.number().int().min(0)).max(5).optional(),
  color: ColorToken.default("primary"),
  accent: ColorToken.default("accent"),
});
export type SceneWorld = z.infer<typeof SceneWorld>;
/** Build list 5, item 11: the treatment laid over the whole shot (the channel's frames almost all carry one). */
export const SceneFinish = z.object({ grain: z.number().min(0).max(1).default(0), vignette: z.number().min(0).max(1).default(0), leak: z.number().min(0).max(1).default(0) });

export const SceneSpec = z.object({
  shotId: z.string(),
  /** What sits behind the elements: the shot's own footage (sharp, dimmed), or the kit's own stage. */
  backdrop: z.enum(["footage", "stage", "world"]).default("footage"),
  /** backdrop "world": which world, made of which real pictures. */
  world: SceneWorld.optional(),
  finish: SceneFinish.optional(),
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
