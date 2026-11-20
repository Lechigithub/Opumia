import { z } from "zod";
import { Aspect, IsoDateTime, Stat } from "./common.js";

export const ChannelId = z.enum([
  "magnates-media",
  "logically-answered",
  "big-company",
  "modern-mba",
  "how-money-works",
  "moon",
]);
export type ChannelId = z.infer<typeof ChannelId>;

export const CorpusStatus = z.object({
  doneFile: z.string().nullable(),
  /** Video ids listed in the done file that belong to this channel. */
  doneIds: z.number().int(),
  /** Ids found on disk (info.json). */
  onDisk: z.number().int(),
  /** On disk AND listed done. */
  doneAndOnDisk: z.number().int(),
  /** Listed done but not found on disk for this channel. */
  missingOnDisk: z.array(z.string()),
  /** On disk but not listed in the done file. */
  notInDoneFile: z.array(z.string()),
  /** Ids in this channel's done file that live in another channel's folder. */
  foreignIds: z.array(z.object({ id: z.string(), channel: z.string() })),
  withVideoFile: z.number().int(),
  withTranscript: z.number().int(),
  withShotAnalysis: z.number().int(),
  withSoundAnalysis: z.number().int(),
  complete: z.boolean(),
});
export type CorpusStatus = z.infer<typeof CorpusStatus>;

export const StyleProfile = z.object({
  schemaVersion: z.literal(1),
  id: ChannelId,
  displayName: z.string(),
  draft: z.boolean(),
  generatedAt: IsoDateTime,
  corpus: CorpusStatus,
  format: z.object({
    primaryAspect: Aspect,
    durationMin: Stat.nullable(),
    fps: z.array(z.number()),
    resolution: z.array(z.string()),
  }),
  pacing: z.object({
    cutsPerMin: Stat.nullable(),
    shotMedianS: Stat.nullable(),
    shotCv: Stat.nullable(),
    cutsFirst60s: Stat.nullable(),
  }),
  look: z.object({
    saturation: Stat.nullable(),
    greyShare: Stat.nullable(),
    luma: Stat.nullable(),
    contrast: Stat.nullable(),
    faceShare: Stat.nullable(),
    motion: Stat.nullable(),
  }),
  /** Share of screen time by visual source class (from .analysis meta/screen measures). */
  visualMix: z.object({
    stock: Stat.nullable(),
    real: Stat.nullable(),
    designed: Stat.nullable(),
    still: Stat.nullable(),
  }),
  audio: z.object({
    integratedLufs: Stat.nullable(),
    voiceOverBedDb: Stat.nullable(),
    duckingDb: Stat.nullable(),
    speechShare: Stat.nullable(),
    strongHitsPerMin: Stat.nullable(),
    musicDropsPer10Min: Stat.nullable(),
    cueChangesPer10Min: Stat.nullable(),
  }),
  narration: z.object({
    wordsPerMin: Stat.nullable(),
    chaptersPerVideo: Stat.nullable(),
  }),
  /** Designed-moment techniques observed for this channel (Library/moments index), with counts. */
  techniques: z.record(z.number().int()),
  titles: z.object({
    examples: z.array(z.string()),
    chars: Stat.nullable(),
    questionShare: z.number().nullable(),
    numberShare: z.number().nullable(),
  }),
  audience: z.object({ views: Stat.nullable() }),
  /** Prompts/QA hints derived from the numbers; human-editable. */
  directives: z.array(z.string()),
  sources: z.array(z.string()),
});
export type StyleProfile = z.infer<typeof StyleProfile>;

export const ReferenceStatus = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoDateTime,
  referenceRoot: z.string(),
  doneFiles: z.array(z.object({ file: z.string(), lines: z.number().int(), ids: z.number().int(), channels: z.record(z.number().int()) })),
  channels: z.record(CorpusStatus),
});
export type ReferenceStatus = z.infer<typeof ReferenceStatus>;
