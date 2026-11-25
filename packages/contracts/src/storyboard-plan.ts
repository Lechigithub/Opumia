import { z } from "zod";
import { Aspect, IsoDateTime, Seconds, StockProvider } from "./common.js";
import { StoryboardShot } from "./storyboard.js";
import { ChannelId } from "./style.js";

/** A music bed for a span (one per chapter in long-form). `drops` are short drop-outs before a reveal (seconds, absolute). */
export const MusicCue = z.object({
  assetId: z.string(),
  startS: Seconds,
  endS: Seconds,
  gainDb: z.number().default(-18),
  mood: z.enum(["intrigue", "rise", "tension", "collapse", "resolve"]).optional(),
  drops: z.array(z.object({ startS: Seconds, endS: Seconds })).default([]),
  /** Where in the bed to start (s): after its quiet intro, beat-aligned to the first strong hit. */
  inS: Seconds.optional(),
  /** How far the bed ducks under the voice (dB, ≤ 0). Default −14 (the channel's whole-film duck); its cold opens
   *  duck less: the bed sits ≈ 9.5 dB under the voice (Ponzi, measured on its stems). */
  duckDb: z.number().min(-30).max(0).optional(),
});

export const Storyboard = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    scriptId: z.string(),
    styleProfileId: ChannelId,
    aspect: Aspect,
    durationS: Seconds,
    shots: z.array(StoryboardShot).min(1),
    music: z.array(MusicCue),
    generatedAt: IsoDateTime,
  })
  .superRefine((s, ctx) => {
    const sorted = [...s.shots].sort((a, b) => a.startS - b.startS);
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i]!.startS < sorted[i - 1]!.endS - 0.05) ctx.addIssue({ code: "custom", path: ["shots", i], message: "shots overlap" });
    const last = sorted[sorted.length - 1];
    if (last && Math.abs(last.endS - s.durationS) > 0.25) ctx.addIssue({ code: "custom", path: ["shots"], message: "shots must cover the full duration" });
  });
export type Storyboard = z.infer<typeof Storyboard>;

/** A media file the resolver made available locally for one shot (library asset or downloaded stock). */
export const ResolvedMedia = z.object({
  shotId: z.string(),
  role: z.enum(["primary", "overlay", "sfx", "music", "layer"]),
  origin: z.enum(["library", "stock", "archival", "press"]),
  /** For role "layer": which picture slot of a composed scene this fills (0-based). */
  slot: z.number().int().min(0).optional(),
  /** What the layer depicts (entity name + kind), so the scene designer can place it. */
  depicts: z.string().optional(),
  /** Vision review of the picked picture: fit to the line 0–10, an identifiable face fills the frame, broadcaster banners present. */
  seen: z.object({ fit: z.number(), face: z.boolean(), banner: z.boolean(), note: z.string() }).optional(),
  /** Fair-use record for press material: where it came from and how much was used. */
  fairUse: z.object({ sourceTitle: z.string(), channel: z.string().optional(), atS: z.number().optional(), usedS: z.number(), reason: z.string() }).optional(),
  ref: z.string(),
  provider: z.union([StockProvider, z.literal("library")]),
  kind: z.enum(["video", "image", "audio"]),
  localPath: z.string(),
  /** Path inside the render job's public dir (what Remotion's staticFile() sees). */
  publicPath: z.string(),
  durationS: Seconds.optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  license: z.string().min(1),
  attributionRequired: z.boolean(),
  attributionText: z.string().optional(),
  sourceUrl: z.string().optional(),
  aiGenerated: z.literal(false),
  score: z.number(),
  query: z.string(),
});
export type ResolvedMedia = z.infer<typeof ResolvedMedia>;

export const ResolutionReport = z.object({
  schemaVersion: z.literal(1),
  storyboardId: z.string(),
  media: z.array(ResolvedMedia),
  unresolved: z.array(z.object({ shotId: z.string(), query: z.string(), reason: z.string() })),
  stats: z.object({ library: z.number().int(), stock: z.number().int(), archival: z.number().int(), designed: z.number().int() }),
  generatedAt: IsoDateTime,
});
export type ResolutionReport = z.infer<typeof ResolutionReport>;
