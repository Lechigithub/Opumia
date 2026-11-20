import { readFile } from "node:fs/promises";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

const JudgeSchema = z.object({
  verdict: z.enum(["pass", "review", "fail"]),
  summary: z.string(),
  issues: z.array(
    z.object({
      severity: z.enum(["major", "minor"]),
      frame: z.number().describe("1-based frame number the issue is on, or 0 if it applies to the whole video"),
      fix: z.enum(["replace_broll", "edit_graphic", "audio", "other"]).describe("replace_broll when the footage/photo itself should be swapped"),
      note: z.string(),
    }),
  ),
});
export type JudgeResult = z.infer<typeof JudgeSchema>;

/** Holistic review of rendered frames + script by Sonnet 5.5 (vision). */
export async function judgeRender(o: { frames: string[]; script: string; channel: string; aspect: string; checks: string }): Promise<JudgeResult> {
  const imgs = await Promise.all(o.frames.map(async (f) => (await readFile(f)).toString("base64")));
  const { data } = await structured({
    stage: "qa.judge",
    model: MODELS.sonnet,
    system: [plain(`You are the final QA editor for a ${o.channel}-style ${o.aspect} documentary. Judge the frames (evenly sampled) and the narration: is picture relevant to the words, are captions legible and inside the safe area, are graphics readable, is anything broken (black frames, stretched media, unreadable text, watermarks), does any frame look AI-generated or depict a real person misleadingly? House rules (do not flag these): burned-in word captions are mandatory for accessibility and may repeat on-screen kinetic typography; designed text cards and money/number cards are part of the channel's style. Verdict pass only if it is publishable as-is.`)],
    user: [
      ...imgs.flatMap((d, i) => [
        { type: "text" as const, text: `Frame ${i + 1}/${imgs.length}` },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: d } },
      ]),
      { type: "text" as const, text: `NARRATION:\n${o.script}\n\nAUTOMATED CHECKS:\n${o.checks}` },
    ],
    schema: JudgeSchema,
    effort: "medium",
  });
  return data;
}

const GateSchema = z.object({
  frames: z.array(
    z.object({
      index: z.number().describe("1-based frame number"),
      ok: z.boolean(),
      issue: z.enum(["none", "text_overlap", "unreadable_contrast", "placeholder", "off_era", "mismatch", "misleading_person", "broken"]),
      fix: z.enum(["none", "replace_footage", "drop_graphic"]),
      note: z.string(),
    }),
  ),
});
export type GateResult = z.infer<typeof GateSchema>;

/**
 * Pre-render frame gate: a fast vision check of ~10 key stills BEFORE the full render. Each frame comes with the
 * words spoken at that moment and the layout used, so footage relevance and layout defects are caught in seconds.
 */
export async function gateReview(o: { frames: Array<{ path: string; line: string; layout: string; era: string }>; channel: string }): Promise<GateResult> {
  const imgs = await Promise.all(o.frames.map(async (f) => (await readFile(f.path)).toString("base64")));
  const { data } = await structured({
    stage: "gate.review",
    model: MODELS.haiku,
    system: [plain(`You are a fast pre-render checker for a ${o.channel}-style documentary. For each still decide ok or not, with ONE issue and ONE fix:
- text_overlap: any text collides with other text (captions over a title, labels over each other) → drop_graphic
- unreadable_contrast: designed text that is hard to read on its background → drop_graphic
- placeholder: an empty panel, ghost initials, a missing image box or template filler → drop_graphic
- off_era: devices, cars, clothing or screens that do not exist in the spoken line's era → replace_footage
- mismatch: footage unrelated to the spoken line, or a third-party title card / slate / ad → replace_footage
- misleading_person: a close-up of an identifiable stranger presented as a named real person → replace_footage
- broken: black, blank, stretched or corrupted → replace_footage
Staged reenactment with anonymous actors, hands, silhouettes and offices is fine when it matches the line. Burned-in word captions at the bottom are house style. Be decisive but do not flag stylistic taste.`)],
    user: [
      ...imgs.flatMap((d, i) => [
        { type: "text" as const, text: `Frame ${i + 1}: layout ${o.frames[i]!.layout}; era ${o.frames[i]!.era}; narration: "${o.frames[i]!.line}"` },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: d } },
      ]),
    ],
    schema: GateSchema,
    effort: "low",
  });
  return data;
}
