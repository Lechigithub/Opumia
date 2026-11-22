import { z } from "zod";

/**
 * Composed scene: a layered, keyframed design spec the scene designer writes per shot and the generic
 * ComposedScene renderer draws. No fixed template: layout, typography, motion and camera are data.
 * Coordinates are fractions of the frame (0..1); times are seconds from the shot start.
 */
export const SceneEnter = z.enum(["fade", "slide_left", "slide_right", "slide_up", "slide_down", "pop", "stamp", "type", "draw", "wipe", "zoom"]);
const Box = { x: z.number(), y: z.number(), w: z.number(), rot: z.number().default(0), z: z.number().min(0).max(1).default(0.5), at: z.number().min(0).default(0), enter: SceneEnter.default("fade") };
export const ColorToken = z.enum(["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"]);

/** G24 vocabulary: the channel's infographic kinds. All words on them come from the narration. */
export const SceneElementG24 = [
  // A quantity made visible: `count` icons or pictures, `highlight` of them marked (13 staff → 13 figures).
  z.object({ type: z.literal("counter"), ...Box, count: z.number().int().min(1).max(60), highlight: z.number().int().min(0).max(60).optional(), slot: z.number().int().min(0).optional(), cols: z.number().int().min(1).max(15).optional(), color: ColorToken.optional(), label: z.string().max(40).optional() }),
  // A step flow: 2–5 steps (≤ 4 words each, optionally a picture slot each), connected and revealed in order.
  z.object({ type: z.literal("steps"), ...Box, direction: z.enum(["row", "column"]).default("row"), items: z.array(z.object({ label: z.string().max(32), slot: z.number().int().min(0).optional() })).min(2).max(5), color: ColorToken.optional() }),
  // An icon infographic: 2–6 icons or pictures with a short label each, in a grid.
  z.object({ type: z.literal("icongrid"), ...Box, items: z.array(z.object({ slot: z.number().int().min(0), label: z.string().max(28) })).min(2).max(6), cols: z.number().int().min(1).max(6).optional() }),
  // A newspaper-style layout (no real masthead): a headline the narration speaks, an optional date and photo.
  z.object({ type: z.literal("newspaper"), ...Box, headline: z.string().max(80), date: z.string().max(30).optional(), slot: z.number().int().min(0).optional() }),
  // A screen: a picture (a real page screenshot, an app) in a browser, phone or monitor frame, scrolling slowly.
  z.object({ type: z.literal("screen"), ...Box, slot: z.number().int().min(0), device: z.enum(["browser", "phone", "monitor"]).default("browser"), scroll: z.number().min(0).max(1).default(0.25) }),
] as const;

export const SceneElement = z.discriminatedUnion("type", [
  z.object({ type: z.literal("photo"), slot: z.number().int().min(0), ...Box, frame: z.enum(["none", "print", "torn", "circle", "tv", "polaroid"]).default("print"), grade: z.enum(["natural", "mono", "duotone"]).default("natural"), h: z.number().optional() }),
  z.object({
    type: z.literal("cutout"), slot: z.number().int().min(0), ...Box, shadow: z.boolean().default(true), outline: z.boolean().default(false),
    /** G23 compositing: the subject sits IN the backdrop — its colour laid over the subject, light falling from the
     *  backdrop's own light direction (CSS angle pointing away from the light), a contact shadow, cleaned edges, a rim. */
    matchColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    matchStrength: z.number().min(0).max(1).optional(),
    lightAngle: z.number().min(0).max(360).optional(),
    lightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    lightStrength: z.number().min(0).max(1).optional(),
    contactShadow: z.number().min(0).max(1).optional(),
    soften: z.number().min(0).max(3).optional(),
    glowColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    glowSize: z.number().min(0.3).max(3).optional(),
    brightness: z.number().min(0.6).max(1.5).optional(),
  }),
  /** Kinetic narration phrase: a run of words spoken in this shot, revealed word by word in sync with the voice. */
  z.object({ type: z.literal("phrase"), text: z.string().min(1).max(120), ...Box, size: z.number().min(0.02).max(0.2), align: z.enum(["left", "center", "right"]).default("center"), color: ColorToken.default("text"), emphasis: z.string().optional() }),
  /** Real 3D (Three.js): an extruded word with lights, slowly turning. */
  z.object({ type: z.literal("text3d"), text: z.string().min(1).max(18), ...Box, color: ColorToken.default("primary"), spin: z.number().min(-60).max(60).default(18) }),
  /** Real 3D (Three.js): a picture slot as a lit card in perspective, turning through `spin` degrees. */
  z.object({ type: z.literal("card3d"), slot: z.number().int().min(0), ...Box, tilt: z.number().min(-40).max(40).default(-14), spin: z.number().min(-60).max(60).default(22) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(90), role: z.enum(["display", "headline", "body", "label", "stamp", "kicker"]), ...Box, size: z.number().min(0.015).max(0.3), align: z.enum(["left", "center", "right"]).default("left"), color: ColorToken.default("text"), box: ColorToken.optional(), highlightWord: z.string().optional() }),
  z.object({ type: z.literal("shape"), shape: z.enum(["underline", "circle", "arrow", "bar", "line", "rect", "bracket", "cross"]), ...Box, h: z.number().default(0.01), color: ColorToken.default("accent"), x2: z.number().optional(), y2: z.number().optional() }),
  z.object({ type: z.literal("texture"), texture: z.enum(["paper", "halftone", "grid", "scanlines", "noise", "stripes"]), opacity: z.number().min(0).max(1).default(0.4), at: z.number().min(0).default(0) }),
  ...SceneElementG24,
]);
export type SceneElement = z.infer<typeof SceneElement>;



export const SceneSpec = z.object({
  shotId: z.string(),
  /** What sits behind the elements: the shot's own footage (sharp, dimmed), a design surface, or paper. */
  backdrop: z.enum(["footage", "surface", "paper", "split", "world"]).default("footage"),
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
  schemaVersion: z.literal(1),
  storyboardId: z.string(),
  scenes: z.array(SceneSpec),
  generatedAt: z.string(),
});
export type ScenePlan = z.infer<typeof ScenePlan>;
