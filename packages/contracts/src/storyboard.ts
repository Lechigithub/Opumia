import { z } from "zod";
import { Seconds, StockProvider } from "./common.js";

export const CameraMove = z.discriminatedUnion("type", [
  z.object({ type: z.literal("static") }),
  z.object({
    type: z.literal("ken_burns"),
    fromScale: z.number().positive(),
    toScale: z.number().positive(),
    /** Normalized focus points (0..1). */
    from: z.tuple([z.number(), z.number()]),
    to: z.tuple([z.number(), z.number()]),
    easing: z.enum(["linear", "ease_in_out", "ease_out"]).default("ease_in_out"),
  }),
  z.object({ type: z.literal("pan"), direction: z.enum(["left", "right", "up", "down"]), amount: z.number().min(0).max(1) }),
  z.object({ type: z.literal("parallax"), layers: z.number().int().min(2).max(5), depth: z.number().min(0).max(1) }),
  z.object({ type: z.literal("shake"), intensity: z.number().min(0).max(1) }),
]);
export type CameraMove = z.infer<typeof CameraMove>;

export const DesignedKind = z.enum([
  "chart",
  "map",
  "big_word",
  "chapter_card",
  "name_label",
  "document",
  "screen",
  "versus",
  "money_figure",
  "cutout_collage",
  "timeline",
  "quote_card",
  "hero_face",
]);

/**
 * Shot source. There is no AI-generation variant; adding one is a contract change
 * that QA will still reject (see QAReport check "no_ai_video").
 */
export const ShotSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library"), assetId: z.string().regex(/^[0-9a-f]{16}$/), segmentId: z.string().optional() }),
  z.object({
    kind: z.enum(["stock", "archival"]),
    provider: StockProvider,
    externalId: z.string(),
    pageUrl: z.string().url(),
    license: z.string(),
    attributionText: z.string().optional(),
  }),
  z.object({ kind: z.literal("designed"), designed: DesignedKind, props: z.record(z.unknown()), assetIds: z.array(z.string()).default([]) }),
  /** Not yet resolved; the asset matcher fills this in. */
  z.object({ kind: z.literal("query"), query: z.string().min(3), mustBe: z.enum(["video", "image", "any"]).default("any"), era: z.string().optional() }),
]);
export type ShotSource = z.infer<typeof ShotSource>;

export const StoryboardShot = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    scriptSegmentId: z.string(),
    index: z.number().int().nonnegative(),
    startS: Seconds,
    endS: Seconds,
    intent: z.string().describe("what the viewer must understand from this shot"),
    lineLink: z.enum(["literal", "mood", "data", "metaphor", "transition"]),
    source: ShotSource,
    trimInS: Seconds.optional(),
    camera: CameraMove.default({ type: "static" }),
    overlays: z.array(z.object({ assetId: z.string(), blend: z.enum(["screen", "multiply", "overlay", "normal"]), opacity: z.number().min(0).max(1) })).default([]),
    onScreenText: z.string().optional(),
    sfx: z.array(z.object({ assetId: z.string(), atS: Seconds, gainDb: z.number().default(0) })).default([]),
    transitionIn: z.enum(["cut", "fade", "whip", "dip_black", "light_leak", "match"]).default("cut"),
    /** Named real-world entities on screen in this shot (archive-first sourcing). */
    entities: z.array(z.object({ name: z.string(), type: z.enum(["person", "company", "place", "landmark", "event", "product"]), year: z.number().int().optional() })).optional(),
    /** Numeric facts (FactSheet-derived ids) a designed graphic displays. */
    factIds: z.array(z.string()).optional(),
    /** Chapter title this shot belongs to (long-form). */
    chapter: z.string().optional(),
    /** Safe zone for 9:16 reframing, normalized center. */
    focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  })
  .refine((s) => s.endS > s.startS, "shot must have positive duration");
export type StoryboardShot = z.infer<typeof StoryboardShot>;
