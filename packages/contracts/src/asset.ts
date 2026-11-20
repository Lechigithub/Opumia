import { z } from "zod";
import { IsoDateTime, Orientation, RelPath, Seconds, StockProvider } from "./common.js";

export const LibraryCategory = z.enum([
  "music",
  "overlays",
  "sfx",
  "bank",
  "cinematic",
  "era",
  "footage",
  "icons",
  "maps",
  "objects",
  "thumb_cache",
  "moments",
]);
export type LibraryCategory = z.infer<typeof LibraryCategory>;

export const AssetKind = z.enum(["video", "audio", "image", "vector", "geo", "raster_data"]);
export type AssetKind = z.infer<typeof AssetKind>;

/** ffprobe-derived technical metadata. All optional: images have no duration, audio has no size. */
export const MediaProbe = z.object({
  durationS: Seconds.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  bitRate: z.number().int().positive().optional(),
  pixFmt: z.string().optional(),
  hasAudio: z.boolean().optional(),
  rotation: z.number().optional(),
});
export type MediaProbe = z.infer<typeof MediaProbe>;

export const Provenance = z.object({
  license: z.string().optional(),
  attributionRequired: z.boolean().optional(),
  attributionText: z.string().optional(),
  author: z.string().optional(),
  sourcePageUrl: z.string().optional(),
  directUrl: z.string().optional(),
  rightsTier: z.string().optional(),
  basis: z.string().optional(),
  sha256: z.string().optional(),
  /** Which metadata file(s) supplied this provenance (relative to Library). */
  from: z.array(z.string()).default([]),
  /** True when a sidecar shows the audio was produced by a generator (e.g. a music prompt). Never true for video. */
  generated: z.boolean().default(false),
  generationPrompt: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** A time range inside a longer asset (e.g. a SigLIP-indexed shot inside a PD film). */
export const AssetSegment = z.object({
  id: z.string(),
  inS: Seconds,
  outS: Seconds,
  caption: z.string().optional(),
  keyframe: z.string().optional(),
});
export type AssetSegment = z.infer<typeof AssetSegment>;

export const AssetRecord = z.object({
  schemaVersion: z.literal(1),
  /** sha1(category + ":" + relPath), truncated to 16 hex chars. Stable across runs. */
  id: z.string().regex(/^[0-9a-f]{16}$/),
  category: LibraryCategory,
  /** Path relative to the Library root. */
  relPath: RelPath,
  kind: AssetKind,
  ext: z.string(),
  bytes: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  probe: MediaProbe.optional(),
  probeError: z.string().optional(),
  orientation: Orientation.optional(),
  provenance: Provenance,
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Free-form, category-specific structured facts (era, decade, emotions, sfx class, technique…). */
  facets: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
  quality: z.number().min(0).max(5).optional(),
  /** Corners where a broadcaster bug/watermark was detected (from Library/bugspot_cache.json). */
  bugSpots: z.array(z.enum(["tl", "tr", "bl", "br"])).optional(),
  segments: z.array(AssetSegment).optional(),
});
export type AssetRecord = z.infer<typeof AssetRecord>;

/** Summary of a remote catalog we reference but do not expand (Library/bank). */
export const RemoteCatalogSummary = z.object({
  relPath: RelPath,
  items: z.number().int().nonnegative(),
  bySource: z.record(z.number().int()),
  byKind: z.record(z.number().int()),
  cachedThumbs: z.number().int().nonnegative(),
  cachedQueries: z.number().int().nonnegative(),
  readError: z.string().optional(),
  providers: z.array(z.union([StockProvider, z.string()])),
});

export const SidecarSummary = z.object({
  relPath: RelPath,
  role: z.enum(["embedding", "keyframes", "model", "source_code", "log", "script", "metadata", "cache", "lock"]),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});

export const LibraryIndex = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoDateTime,
  libraryRoot: z.string(),
  stats: z.object({
    assets: z.number().int(),
    byCategory: z.record(z.number().int()),
    byKind: z.record(z.number().int()),
    /** Assets carrying ffprobe data. */
    probed: z.number().int(),
    probeErrors: z.number().int(),
    withLicense: z.number().int(),
    generatedAudio: z.number().int(),
    totalBytes: z.number().int(),
  }),
  caches: z.object({
    bugspot: z.object({ relPath: z.string(), entries: z.number().int(), matched: z.number().int() }).optional(),
    wikiIpa: z.object({
      relPath: z.string(),
      entries: z.number().int(),
      withIpa: z.number().int(),
      lexicon: z.record(z.string()),
    }).optional(),
  }),
  remoteCatalogs: z.array(RemoteCatalogSummary),
  sidecars: z.array(SidecarSummary),
  assets: z.array(AssetRecord),
});
export type LibraryIndex = z.infer<typeof LibraryIndex>;
