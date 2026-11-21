import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { ChannelId } from "./style.js";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Per-film art direction, produced by the Art Director agent right after research. Every colour, font pairing,
 * texture level and per-act tint the motion engine uses comes from here — nothing topic-specific is hardcoded.
 */
export const TextStyle = z.enum(["neon_glow", "solid_stroke", "boxed", "gradient", "paper_cut", "outline_only"]);
export const FilmTreatment = z.object({
  /** How headline and slam type is drawn. */
  headline: TextStyle,
  /** How the kinetic narration phrases are drawn (must differ from the headline style). */
  phrase: TextStyle,
  label: z.enum(["tag", "underline", "pill", "bracket", "plain"]),
  photo: z.enum(["print", "torn", "polaroid", "none", "tv", "circle"]),
  /** Procedural backdrop for scenes without footage, drawn in the film's colours. */
  world: z.enum(["nebula", "blueprint", "paper", "halftone", "smoke", "stripes", "spotlight"]),
  particles: z.enum(["none", "dust", "embers", "snow", "bokeh"]),
  /** How footage is coloured into the film's world. */
  wash: z.enum(["none", "tint", "duotone"]),
  washStrength: z.number().min(0).max(0.8).default(0.35),
  glow: z.number().min(0).max(1).default(0.6),
  /** A recurring visual device unique to this film (e.g. "film sprocket strips", "blood-drop bullet points"). */
  motif: z.string(),
});
export type FilmTreatment = z.infer<typeof FilmTreatment>;

export const FilmDesignSystem = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  channelId: ChannelId,
  topic: z.string(),
  concept: z.string().describe("one-line art-direction concept, e.g. 'Nordic cold blue boardroom, crimson crisis'"),
  palette: z.object({
    primary: Hex.describe("subject / brand colour"),
    primarySoft: Hex,
    accent: Hex.describe("tension / crisis accent"),
    accentDeep: Hex,
    surface: Hex.describe("dark background surface"),
    surfaceAlt: Hex,
    paper: Hex.describe("document / light card tone"),
    marker: Hex.describe("highlighter colour"),
    text: Hex,
    textMuted: Hex,
  }),
  typography: z.object({
    display: z.enum(["condensed_sans", "editorial_serif", "geometric_sans", "slab"]),
    body: z.enum(["grotesk", "humanist", "serif"]),
    casing: z.enum(["upper", "title"]),
    tracking: z.number().min(-2).max(6),
  }),
  texture: z.object({ grain: z.number().min(0).max(0.5), vignette: z.number().min(0).max(1), halftone: z.boolean(), lightLeaks: z.boolean() }),
  /** Colour grade per act (chapter index → tint and strengths). */
  acts: z.array(z.object({ name: z.string(), tint: Hex, tintStrength: z.number().min(0).max(0.6), saturation: z.number().min(0.4).max(1.3), contrast: z.number().min(0.9).max(1.3) })).min(1),
  /**
   * Visual treatment: the film's own motion-design language, chosen for its topic. One system per film (so the
   * film is coherent) and different from recent films (so no two films share a look).
   */
  treatment: FilmTreatment.optional(),
  /** Scene grammar: designed kinds this film should favour and the minimum gap before a layout may repeat. */
  sceneGrammar: z.object({ favour: z.array(z.string()), avoid: z.array(z.string()), minRepeatGapS: z.number().default(45) }),
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
  blueprints: z.record(z.array(z.object({ job: z.string(), hook: z.string(), ending: z.string(), spine: z.string() }))).default({}),
  /** Outcomes per channel: benchmark score with the visual mix and pacing that produced it. */
  outcomes: z.record(z.array(z.object({ job: z.string(), overall: z.number(), designedShare: z.number(), medianShotS: z.number(), kinds: z.record(z.number()) }))).default({}),
});
export type ProductionMemory = z.infer<typeof ProductionMemory>;
