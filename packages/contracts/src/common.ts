import { z } from "zod";

/** Aspect ratios the platform renders. */
export const Aspect = z.enum(["16:9", "9:16"]);
export type Aspect = z.infer<typeof Aspect>;

export const Orientation = z.enum(["landscape", "portrait", "square"]);
export type Orientation = z.infer<typeof Orientation>;

/** Seconds (float, >= 0). */
export const Seconds = z.number().finite().nonnegative();
/** Integer frame index/count. */
export const Frames = z.number().int().nonnegative();

export const IsoDateTime = z.string().datetime({ offset: true });

/** Relative POSIX path, never absolute, never escaping its root. */
export const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "must be a relative path inside its root");

/** 0..1 normalized number. */
export const Unit = z.number().min(0).max(1);

/** Distribution summary used by StyleProfile metrics. */
export const Stat = z.object({
  n: z.number().int().nonnegative(),
  mean: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  min: z.number(),
  max: z.number(),
});
export type Stat = z.infer<typeof Stat>;

/**
 * Where a visual/audio element comes from. There is deliberately NO variant for
 * AI-generated video or imagery: the type system makes "zero AI scenes" unrepresentable.
 */
export const SourceKind = z.enum([
  "library", // Opumia/Library asset (AssetRecord)
  "stock", // licensed stock API (pexels, pixabay, coverr, vecteezy, vimeo)
  "archival", // archival API (europeana, nara, wikimedia commons, loc, archive.org)
  "press", // fair-use press material: news/interview clips (YouTube), Wikipedia lead photos and logos — short, muted, transformed, logged
  "designed", // deterministic Remotion motion graphic (chart, map, text card…)
  "narration", // ElevenLabs voice track
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const StockProvider = z.enum([
  "pexels",
  "pixabay",
  "coverr",
  "vecteezy",
  "vimeo",
  "europeana",
  "nara",
  "commons",
  "archive",
  "loc",
  "nasa",
  "smithsonian",
  "openverse",
  "cleveland",
  "wikidata",
  "wikipedia",
  "youtube",
  "web",
]);
export type StockProvider = z.infer<typeof StockProvider>;
