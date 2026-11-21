import { z } from "zod";
import { IsoDateTime } from "./common.js";

/**
 * Platform evaluation (blind reference test). A fixed EvalSet of topics is produced and every film is cut into
 * short windows that a blind judge compares against windows of real reference films of the same position.
 * The headline number is `realness`: the judge's probability that OUR window is the real channel film.
 * 0.5 = indistinguishable (target), 0 = obviously ours. The judge is trusted only after it passes calibration.
 */
export const EvalItem = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  topic: z.string(),
  channel: z.string(),
  aspect: z.enum(["16:9", "9:16"]),
  durationS: z.number().positive(),
});
export type EvalItem = z.infer<typeof EvalItem>;

export const EvalSet = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  description: z.string(),
  items: z.array(EvalItem).min(1),
});
export type EvalSet = z.infer<typeof EvalSet>;

export const EvalTrack = z.enum(["picture", "story"]);
export type EvalTrack = z.infer<typeof EvalTrack>;

export const EvalTell = z.object({
  side: z.enum(["real", "fake"]),
  area: z.string(),
  what: z.string(),
});

export const EvalPair = z.object({
  id: z.string(),
  track: EvalTrack,
  position: z.string(),
  /** Calibration control kind, or "film" for a real scored pair. */
  control: z.enum(["film", "wrong_picture", "bland_script", "foreign_picture", "real_vs_real"]),
  ours: z.string().describe("source of the candidate window (job + time, or the degraded reference)"),
  reference: z.string(),
  /** Which letter the candidate was shown as. */
  candidateAs: z.enum(["A", "B"]),
  pick: z.enum(["A", "B"]),
  confidence: z.number().min(0.5).max(1),
  /** Judge's probability that the candidate is the real film. */
  realness: z.number().min(0).max(1),
  tells: z.array(EvalTell),
  usd: z.number(),
});
export type EvalPair = z.infer<typeof EvalPair>;

export const Calibration = z.object({
  schemaVersion: z.literal(1),
  judgeVersion: z.string(),
  channel: z.string(),
  pairs: z.array(EvalPair),
  /** Share of degraded controls where the judge picked the real reference (target ≥ 0.85). */
  detection: z.record(z.string(), z.number()),
  /** Real-vs-real: share of "A" picks (target 0.35–0.65) and mean confidence (target ≤ 0.75). */
  positionBias: z.object({ aRate: z.number(), meanConfidence: z.number() }),
  /** Films a person already judged as clearly not reference quality: the judge must catch them nearly always. */
  knownBad: z.object({ caught: z.number(), total: z.number(), jobs: z.array(z.string()) }).optional(),
  trusted: z.boolean(),
  reasons: z.array(z.string()),
  usd: z.number(),
  generatedAt: IsoDateTime,
});
export type Calibration = z.infer<typeof Calibration>;

/** One objective measurement of a film against the reference channel's measured band. */
export const SlopMetric = z.object({ id: z.string(), label: z.string(), value: z.number(), target: z.string(), pass: z.boolean() });
export type SlopMetric = z.infer<typeof SlopMetric>;

export const FilmScore = z.object({
  job: z.string(),
  channel: z.string(),
  durationS: z.number(),
  realness: z.object({ picture: z.number(), story: z.number(), overall: z.number() }),
  pairs: z.array(EvalPair),
  /** Most frequent judge tells against the film, grouped by area. */
  topTells: z.array(z.object({ area: z.string(), count: z.number(), examples: z.array(z.string()) })),
  production: z.object({ claudeUsd: z.number().nullable(), wallS: z.number().nullable() }),
  /** Objective checks (look, motion, voice, reuse) with the same measurement run on the reference films. */
  metrics: z.array(SlopMetric).default([]),
  /** Release gate: blind test near chance AND every objective check met AND not a template of another film. */
  gate: z.object({ pass: z.boolean(), reasons: z.array(z.string()) }).optional(),
});
export type FilmScore = z.infer<typeof FilmScore>;

export const EvalReport = z.object({
  schemaVersion: z.literal(1),
  setId: z.string(),
  runId: z.string(),
  judgeVersion: z.string(),
  judgeTrusted: z.boolean(),
  films: z.array(FilmScore),
  /** Mean realness ×2, capped at 1: 1.0 = the judge can no longer tell our films from the reference. */
  indistinguishability: z.object({ picture: z.number(), story: z.number(), overall: z.number() }),
  topTells: z.array(z.object({ area: z.string(), count: z.number(), examples: z.array(z.string()) })),
  /** Cross-film sameness: how much two of OUR films look like one template (0–10), against the same test on pairs of reference films. */
  sameness: z.object({ ours: z.array(z.object({ a: z.string(), b: z.string(), score: z.number(), shared: z.array(z.string()) })), referenceBaseline: z.number(), pass: z.boolean() }).optional(),
  usd: z.number(),
  generatedAt: IsoDateTime,
});
export type EvalReport = z.infer<typeof EvalReport>;
