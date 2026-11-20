import { z } from "zod";
import { Aspect, IsoDateTime, Seconds } from "./common.js";
import { BeatRole } from "./script.js";
import { ChannelId } from "./style.js";

/** One checkable factual claim with its source. */
export const FactClaim = z.object({
  id: z.string(),
  text: z.string().min(5),
  kind: z.enum(["number", "date", "event", "quote", "context"]),
  sourceUrl: z.string().url(),
  sourceTitle: z.string().optional(),
  /** Verbatim support from the source, captured during verification (≤ 300 chars). */
  evidence: z.string().max(400).optional(),
  verdict: z.enum(["supported", "partially_supported", "unsupported", "unreachable", "unchecked"]),
  checkedBy: z.string().optional(),
});
export type FactClaim = z.infer<typeof FactClaim>;

export const FactSheet = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  topic: z.string(),
  summary: z.string(),
  angle: z.string().describe("the story angle: whose want, what obstacle, what turn"),
  claims: z.array(FactClaim).min(1),
  sources: z.array(z.object({ url: z.string().url(), title: z.string().optional(), reachable: z.boolean() })),
  models: z.object({ research: z.string(), verify: z.string() }),
  generatedAt: IsoDateTime,
});
export type FactSheet = z.infer<typeof FactSheet>;

/** Only claims a script may assert. */
export const usableClaims = (fs: FactSheet) => fs.claims.filter((c) => c.verdict === "supported" || c.verdict === "partially_supported");

/** Script before narration: text + beats, no timings yet. */
export const ScriptDraft = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  factSheetId: z.string(),
  styleProfileId: ChannelId,
  aspect: Aspect,
  targetDurationS: Seconds,
  targetWords: z.number().int().positive(),
  title: z.string(),
  hookFormula: z.string().describe("which channel hook pattern this script instantiates"),
  segments: z
    .array(
      z.object({
        id: z.string(),
        role: BeatRole,
        text: z.string().min(1),
        claimIds: z.array(z.string()),
        visualIdea: z.string(),
      }),
    )
    .min(2),
  wordCount: z.number().int(),
  generatedAt: IsoDateTime,
});
export type ScriptDraft = z.infer<typeof ScriptDraft>;

/** Thumbnail style rules extracted from a channel's reference thumbnails. */
export const ThumbnailStyle = z.object({
  schemaVersion: z.literal(1),
  channelId: ChannelId,
  rules: z.array(z.string()).min(3),
  palette: z.array(z.string()),
  textRules: z.object({ maxWords: z.number().int(), casing: z.string(), placement: z.string(), font: z.string() }),
  composition: z.string(),
  subject: z.string(),
  promptTemplate: z.string(),
  references: z.array(z.string()),
  generatedAt: IsoDateTime,
});
export type ThumbnailStyle = z.infer<typeof ThumbnailStyle>;
