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
