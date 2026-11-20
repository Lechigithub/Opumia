import { readFile } from "node:fs/promises";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

const BenchmarkSchema = z.object({
  overall: z.number().describe("0–10: how close the film is to the reference channel's quality (10 = indistinguishable)"),
  summary: z.string(),
  scores: z.array(z.object({ area: z.enum(["story_hook", "pacing_editing", "compositing_depth", "graphics_typography", "footage_relevance", "color_grade_texture", "captions_lower_thirds", "sound_design"]), ours: z.number().describe("0–10"), note: z.string() })),
  gaps: z.array(
    z.object({
      severity: z.enum(["major", "minor"]),
      area: z.string(),
      ourFrame: z.number().describe("1-based OUR frame number, 0 if general"),
      refFrame: z.number().describe("1-based REFERENCE frame number that shows the target, 0 if none"),
      gap: z.string().describe("what still looks amateur vs the reference"),
      fix: z.string().describe("a concrete, implementable change (component, timing, asset choice, mix)"),
    }),
  ),
  amateurTells: z.array(z.string()).describe("the specific tells a viewer would notice first"),
});
export type BenchmarkResult = z.infer<typeof BenchmarkSchema>;

/**
 * Strict side-by-side critique: our rendered frames + measured metrics vs frames and metrics extracted from the
 * reference channel (Library/moments technique clips + reference film b-roll). Sonnet 5.5 vision.
 */
export async function benchmarkAgainstReference(o: { channel: string; ours: Array<{ path: string; label: string }>; reference: Array<{ path: string; label: string }>; metrics: string; script: string }): Promise<BenchmarkResult> {
  const img = async (p: string) => (await readFile(p)).toString("base64");
  const block = async (list: typeof o.ours, tag: string) =>
    (await Promise.all(list.map(async (f, i) => [{ type: "text" as const, text: `${tag} frame ${i + 1}: ${f.label}` }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: await img(f.path) } }]))).flat();
  const { data } = await structured({
    stage: "qa.benchmark",
    model: MODELS.sonnet,
    system: [
      plain(`You are a senior YouTube documentary editor who has cut for ${o.channel}. You are benchmarking an automated production against the real channel. Be strict and specific: the goal is to find every remaining place where it looks templated, flat, cheap or amateur next to the reference. Compare like with like (chart vs chart, map vs map, document vs document, lower third vs lower third, b-roll vs b-roll). Judge storytelling from the narration and the metric table, the picture from the frames, sound only from the metrics. Do not praise; list gaps with concrete fixes. Ignore that the reference frames are from different stories. Our film uses only licensed footage and designed graphics (no AI imagery) — that constraint is fixed.`),
    ],
    user: [
      { type: "text" as const, text: `REFERENCE (${o.channel}) FRAMES:` },
      ...(await block(o.reference, "REFERENCE")),
      { type: "text" as const, text: `OUR FILM FRAMES:` },
      ...(await block(o.ours, "OURS")),
      { type: "text" as const, text: `METRICS (ours vs reference channel):\n${o.metrics}\n\nOUR NARRATION:\n${o.script}` },
    ],
    schema: BenchmarkSchema,
    effort: "high",
    maxTokens: 12000,
  });
  return data;
}
