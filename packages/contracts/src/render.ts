import { z } from "zod";
import { Aspect, Frames, IsoDateTime, SourceKind } from "./common.js";

export const ASPECT_DIMENSIONS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
} as const;

export const Keyframe = z.object({ frame: Frames, scale: z.number().positive(), x: z.number(), y: z.number(), opacity: z.number().min(0).max(1).default(1) });

export const VideoLayer = z
  .object({
    id: z.string(),
    shotId: z.string(),
    sourceKind: SourceKind.exclude(["narration"]),
    /** AssetRecord id, stock externalId, or Remotion component name for designed layers. */
    ref: z.string(),
    src: z.string().optional(),
    startFrame: Frames,
    endFrame: Frames,
    trimStartFrame: Frames.default(0),
    zIndex: z.number().int().default(0),
    blend: z.enum(["normal", "screen", "multiply", "overlay"]).default("normal"),
    keyframes: z.array(Keyframe).default([]),
    props: z.record(z.unknown()).optional(),
  })
  .refine((l) => l.endFrame > l.startFrame, "layer must have positive length");

export const AudioLayer = z.object({
  id: z.string(),
  role: z.enum(["narration", "music", "sfx", "ambience"]),
  ref: z.string(),
  src: z.string(),
  startFrame: Frames,
  endFrame: Frames,
  trimStartFrame: Frames.default(0),
  gainDb: z.number().default(0),
  duckUnderNarrationDb: z.number().max(0).optional(),
  fadeInFrames: Frames.default(0),
  fadeOutFrames: Frames.default(0),
  /** Music drop-outs (absolute frames): the bed falls to `gainDb` ≈ silence, then slams back on the reveal. */
  dips: z.array(z.object({ fromFrame: Frames, toFrame: Frames, gainDb: z.number().default(-36) })).default([]),
});

export const Credit = z.object({ ref: z.string(), text: z.string(), license: z.string(), url: z.string().optional() });

export const RenderManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    scriptId: z.string(),
    aspect: Aspect,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
    durationFrames: Frames,
    video: z.array(VideoLayer),
    audio: z.array(AudioLayer),
    captions: z.array(z.object({ startFrame: Frames, endFrame: Frames, text: z.string() })).default([]),
    loudnessTargetLufs: z.number().default(-14),
    output: z.object({ path: z.string(), codec: z.enum(["h264", "h265", "prores"]).default("h264"), crf: z.number().int().min(0).max(51).default(18) }),
    credits: z.array(Credit),
    generatedAt: IsoDateTime,
  })
  .superRefine((m, ctx) => {
    const dims = ASPECT_DIMENSIONS[m.aspect];
    if (m.width !== dims.width || m.height !== dims.height)
      ctx.addIssue({ code: "custom", path: ["width"], message: `aspect ${m.aspect} requires ${dims.width}x${dims.height}` });
    m.video.forEach((l, i) => {
      if (l.endFrame > m.durationFrames) ctx.addIssue({ code: "custom", path: ["video", i], message: "layer exceeds duration" });
    });
  });
export type RenderManifest = z.infer<typeof RenderManifest>;

/** The platform's frame rate (owner decision 2026-11-22): 24 fps — the documentary standard and the most common rate of the
 *  reference channel (14 of 37 MagnatesMedia films; 25 fps 11, 30 fps 10, 60 fps 2). Every clip is conformed to it. */
export const PLATFORM_FPS = 24 as const;
