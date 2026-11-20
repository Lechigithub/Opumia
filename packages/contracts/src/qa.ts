import { z } from "zod";
import { IsoDateTime } from "./common.js";

export const QACheckId = z.enum([
  "no_ai_video", // every video layer traces to library/stock/archival/designed
  "license_coverage", // every non-designed layer has a licence + credit when required
  "loudness", // integrated LUFS within target ±1
  "true_peak",
  "black_frames",
  "frozen_frames",
  "caption_sync", // captions vs TimedScript words
  "pacing", // cuts/min vs StyleProfile band
  "watermark", // no asset with bugSpots shown un-cropped
  "safe_zone_9x16",
  "fact_claims", // every claim has a source
  "judge", // Claude (Sonnet) holistic review
]);

export const QACheck = z.object({
  id: QACheckId,
  severity: z.enum(["blocker", "major", "minor", "info"]),
  passed: z.boolean(),
  message: z.string(),
  measured: z.union([z.number(), z.string(), z.boolean()]).optional(),
  expected: z.string().optional(),
  atFrames: z.array(z.number().int()).default([]),
});
export type QACheck = z.infer<typeof QACheck>;

export const QAReport = z
  .object({
    schemaVersion: z.literal(1),
    manifestId: z.string(),
    renderPath: z.string(),
    checks: z.array(QACheck).min(1),
    verdict: z.enum(["pass", "review", "fail"]),
    summary: z.string(),
    generatedAt: IsoDateTime,
  })
  .superRefine((r, ctx) => {
    const blockerFailed = r.checks.some((c) => !c.passed && c.severity === "blocker");
    if (blockerFailed && r.verdict !== "fail") ctx.addIssue({ code: "custom", path: ["verdict"], message: "a failed blocker requires verdict=fail" });
    const aiCheck = r.checks.find((c) => c.id === "no_ai_video");
    if (!aiCheck) ctx.addIssue({ code: "custom", path: ["checks"], message: "no_ai_video check is mandatory" });
    else if (aiCheck.severity !== "blocker") ctx.addIssue({ code: "custom", path: ["checks"], message: "no_ai_video must be a blocker" });
  });
export type QAReport = z.infer<typeof QAReport>;
