import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { ChannelId } from "./style.js";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * The film's design tokens (schema v2, build list 3 L1): written from the film's OWN kit by its art director
 * (film-designer-agent.ts) — its palette grown from the film's pictures, its typefaces, its texture, its concept.
 * The renderer, colourist, compositor and packaging read them. There are no menus: no fixed font list, label style,
 * photo frame, background or particle kind exists any more (the menu art director was removed).
 */
export const FilmDesignSystem = z.object({
  schemaVersion: z.literal(2),
  id: z.string(),
  channelId: ChannelId,
  topic: z.string(),
  /** The film's visual idea, as its art director wrote it. */
  concept: z.string(),
  palette: z.object({
    primary: Hex,
    primarySoft: Hex,
    accent: Hex,
    accentDeep: Hex,
    surface: Hex.describe("dark surface"),
    surfaceAlt: Hex,
    paper: Hex.describe("light surface"),
    marker: Hex.describe("highlight"),
    text: Hex,
    textMuted: Hex,
  }),
  /** CSS font-family stacks of the kit's own typefaces (loaded by the kit). */
  fonts: z.object({ display: z.string(), body: z.string() }),
  texture: z.object({ grain: z.number().min(0).max(0.5), vignette: z.number().min(0).max(1) }),
  /** Colour grade per act (the colourist sets and moves it). */
  acts: z.array(z.object({ name: z.string(), tint: Hex, tintStrength: z.number().min(0).max(0.6), saturation: z.number().min(0.4).max(1.3), contrast: z.number().min(0.9).max(1.3), /** build list 5, item 28: exposure of the act (1 = as shot) */ brightness: z.number().min(0.7).max(1.4).optional() })).min(1),
  generatedAt: IsoDateTime,
});
export type FilmDesignSystem = z.infer<typeof FilmDesignSystem>;

/** Cross-film memory of what failed and what worked (data/production-memory.json; D1 table production_memory). */
export const ProductionMemory = z.object({
  schemaVersion: z.literal(1),
  /** Asset refs (library id or provider:externalId) that QA/gate/judge rejected, with why. */
  blocked: z.record(z.object({ reason: z.string(), query: z.string().optional(), job: z.string(), count: z.number().int() })).default({}),
  /** Query phrases that repeatedly produced mismatches (normalised) → penalty count. */
  badQueries: z.record(z.number().int()).default({}),
  /** Story blueprints used per channel (newest last) so films do not repeat openings/endings. */
  blueprints: z.record(z.array(z.object({ job: z.string(), hook: z.string(), ending: z.string(), spine: z.string(), beats: z.array(z.string()).optional() }))).default({}),
  /** Outcomes per channel: benchmark score with the visual mix and pacing that produced it. */
  outcomes: z.record(z.array(z.object({ job: z.string(), overall: z.number(), designedShare: z.number(), medianShotS: z.number(), kinds: z.record(z.number()) }))).default({}),
});
export type ProductionMemory = z.infer<typeof ProductionMemory>;
