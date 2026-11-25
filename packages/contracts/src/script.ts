import { z } from "zod";
import { Aspect, IsoDateTime, Seconds } from "./common.js";
import { ChannelId } from "./style.js";

export const TimedWord = z
  .object({ word: z.string().min(1), startS: Seconds, endS: Seconds })
  .refine((w) => w.endS >= w.startS, "word ends before it starts");

export const BeatRole = z.enum(["cold_open", "hook", "thesis", "context", "rise", "twist", "climax", "fall", "resolution", "cta", "sponsor", "chapter", "rehook"]);

export const ScriptSegment = z
  .object({
    id: z.string(),
    role: BeatRole,
    chapter: z.string().optional(),
    text: z.string().min(1),
    startS: Seconds,
    endS: Seconds,
    words: z.array(TimedWord),
    /** Facts asserted in this segment, each with a source URL, for QA fact-checks. */
    claims: z.array(z.object({ text: z.string(), sourceUrl: z.string().url() })).default([]),
    /** Pronunciation overrides (IPA), e.g. from Library/wiki_ipa_cache.json. */
    pronunciations: z.record(z.string()).default({}),
  })
  .refine((s) => s.endS >= s.startS, "segment ends before it starts");
export type ScriptSegment = z.infer<typeof ScriptSegment>;

export const TimedScript = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    title: z.string(),
    styleProfileId: ChannelId,
    aspect: Aspect,
    language: z.string().default("en"),
    voice: z.object({
      provider: z.literal("elevenlabs"),
      voiceId: z.string(),
      modelId: z.string(),
      audioPath: z.string(),
    }),
    segments: z.array(ScriptSegment).min(1),
    /** A breath in the narration for the film's title card (hand film v34: the channel's cold open ends on its title,
     *  in a breath after the hook); the kit's chapter role draws the title there. */
    titleCard: z.object({ startS: Seconds, endS: Seconds }).optional(),
    durationS: Seconds,
    generatedAt: IsoDateTime,
  })
  .superRefine((s, ctx) => {
    for (let i = 1; i < s.segments.length; i++) {
      const prev = s.segments[i - 1]!;
      const cur = s.segments[i]!;
      if (cur.startS < prev.endS - 1e-3) ctx.addIssue({ code: "custom", path: ["segments", i], message: "segments overlap" });
    }
  });
export type TimedScript = z.infer<typeof TimedScript>;
