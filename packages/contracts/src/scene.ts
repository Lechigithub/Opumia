import { z } from "zod";

/**
 * Composed scene: a layered, keyframed design spec the scene designer writes per shot and the generic
 * ComposedScene renderer draws. No fixed template: layout, typography, motion and camera are data.
 * Coordinates are fractions of the frame (0..1); times are seconds from the shot start.
 */
export const SceneEnter = z.enum(["fade", "slide_left", "slide_right", "slide_up", "slide_down", "pop", "stamp", "type", "draw", "wipe", "zoom"]);
const Box = { x: z.number(), y: z.number(), w: z.number(), rot: z.number().default(0), z: z.number().min(0).max(1).default(0.5), at: z.number().min(0).default(0), enter: SceneEnter.default("fade") };
export const ColorToken = z.enum(["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"]);

export const SceneElement = z.discriminatedUnion("type", [
  z.object({ type: z.literal("photo"), slot: z.number().int().min(0), ...Box, frame: z.enum(["none", "print", "torn", "circle", "tv", "polaroid"]).default("print"), grade: z.enum(["natural", "mono", "duotone"]).default("natural"), h: z.number().optional() }),
  z.object({ type: z.literal("cutout"), slot: z.number().int().min(0), ...Box, shadow: z.boolean().default(true) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(90), role: z.enum(["display", "headline", "body", "label", "stamp", "kicker"]), ...Box, size: z.number().min(0.015).max(0.3), align: z.enum(["left", "center", "right"]).default("left"), color: ColorToken.default("text"), box: ColorToken.optional(), highlightWord: z.string().optional() }),
  z.object({ type: z.literal("shape"), shape: z.enum(["underline", "circle", "arrow", "bar", "line", "rect", "bracket", "cross"]), ...Box, h: z.number().default(0.01), color: ColorToken.default("accent"), x2: z.number().optional(), y2: z.number().optional() }),
  z.object({ type: z.literal("texture"), texture: z.enum(["paper", "halftone", "grid", "scanlines", "noise", "stripes"]), opacity: z.number().min(0).max(1).default(0.4), at: z.number().min(0).default(0) }),
]);
export type SceneElement = z.infer<typeof SceneElement>;

export const SceneSpec = z.object({
  shotId: z.string(),
  /** What sits behind the elements: the shot's own footage (sharp, dimmed), a design surface, or paper. */
  backdrop: z.enum(["footage", "surface", "paper", "split"]).default("footage"),
  dim: z.number().min(0).max(0.85).default(0.45),
  camera: z.object({ fromScale: z.number().min(0.9).max(1.6), toScale: z.number().min(0.9).max(1.6), fromX: z.number().default(0.5), toX: z.number().default(0.5), fromY: z.number().default(0.5), toY: z.number().default(0.5) }),
  elements: z.array(SceneElement).min(1).max(12),
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
