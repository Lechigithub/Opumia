import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

/**
 * Blind reference judge. It sees two windows, A and B — one from a real reference-channel film, one candidate —
 * and must say which is real. It is never told which is which, and it is checked against degraded reference
 * windows (calibration) before its verdicts on our films are trusted. Bump JUDGE_VERSION on any prompt change:
 * cached verdicts and calibration are keyed by it.
 */
export const JUDGE_VERSION = "blind-v2";

export interface EvalWindow {
  /** Frames in time order with their offset (s) inside the window. */
  frames: Array<{ path: string; t: number }>;
  /** Narration spoken over the window. */
  text: string;
  /** Same-method measurements on both sides (ffmpeg scene cuts, words per minute). */
  stats: { seconds: number; cuts: number; wpm: number };
}

const PICTURE_AREAS = ["picture_relevance", "footage_specificity", "editing_rhythm", "graphics_design", "typography", "compositing_depth", "color_grade", "captions", "story_writing", "other"] as const;
const STORY_AREAS = ["hook", "story_structure", "sentence_rhythm", "specificity", "voice_and_attitude", "cliche_or_filler", "numbers", "tension_and_payoff", "other"] as const;

const verdict = <A extends readonly [string, ...string[]]>(areas: A) =>
  z.object({
    differences: z.array(z.string()).describe("the concrete observable differences between window A and window B (short bullets)"),
    pick: z.enum(["A", "B"]).describe("the window you believe is the real channel film"),
    confidence: z.number().describe("0.5 = coin flip, 1.0 = certain"),
    fakeTells: z.array(z.object({ area: z.enum(areas), what: z.string().describe("the concrete thing in the OTHER window that gave it away as not the real channel") })),
    realTells: z.array(z.object({ area: z.enum(areas), what: z.string().describe("the concrete thing in your pick that only the real channel does") })),
  });
const PictureVerdict = verdict(PICTURE_AREAS);
const StoryVerdict = verdict(STORY_AREAS);

export interface BlindResult {
  pick: "A" | "B";
  confidence: number;
  tells: Array<{ side: "real" | "fake"; area: string; what: string }>;
  usd: number;
}

const RULES = `Rules of the test:
- The two windows are usually from DIFFERENT stories. Never decide by topic, era, which story you recognise, or whether you remember the channel covering it.
- Do not use as evidence: video resolution or compression, channel logos, watermarks, subscribe prompts or end screens, or transcription formatting (punctuation, number formatting).
- Decide only on what a viewer experiences: how the narration is written, whether each picture shows what is being said, how specific the visuals are to the story, editing rhythm, design, typography, compositing and grade.
- Be decisive when the evidence is strong and honest when it is not: if both look equally like the channel, say so with confidence near 0.5.`;

async function imageBlocks(w: EvalWindow, tag: string): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const out: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: `WINDOW ${tag} — ${w.stats.seconds.toFixed(0)} s, ${w.stats.cuts} cuts, ${Math.round(w.stats.wpm)} wpm.\nNarration over this window: "${w.text}"\nFrames (time inside the window):` }];
  for (const f of w.frames) {
    out.push({ type: "text", text: `${tag} @ ${f.t.toFixed(1)} s` });
    out.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(f.path)).toString("base64") } });
  }
  return out;
}

const toResult = (d: z.infer<typeof PictureVerdict> | z.infer<typeof StoryVerdict>, usd: number): BlindResult => ({
  pick: d.pick,
  confidence: Math.max(0.5, Math.min(1, d.confidence)),
  tells: [...d.fakeTells.map((t) => ({ side: "fake" as const, area: t.area, what: t.what })), ...d.realTells.map((t) => ({ side: "real" as const, area: t.area, what: t.what }))],
  usd,
});

/** Picture track: frames + narration + edit stats for each window. Sonnet 5.5 vision. */
export async function judgePictureBlind(o: { channel: string; a: EvalWindow; b: EvalWindow }): Promise<BlindResult> {
  const { data, usage } = await structured({
    stage: "eval.picture",
    model: MODELS.sonnet,
    system: [plain(`You are a senior editor who has cut many films for the YouTube documentary channel ${o.channel} and can spot an imitation instantly. You will see two windows of a documentary, A and B. Exactly one is from a real ${o.channel} film; the other is an imitation made by another studio. Find the real one.\n\n${RULES}`)],
    user: [...(await imageBlocks(o.a, "A")), ...(await imageBlocks(o.b, "B")), { type: "text", text: `Which window is the real ${o.channel} film?` }],
    schema: PictureVerdict,
    effort: "medium",
    maxTokens: 6000,
  });
  return toResult(data, usage.usd);
}

/** Story track: two narration passages of the same position in the film (cold open vs cold open, etc.). */
export async function judgeStoryBlind(o: { channel: string; position: string; a: string; b: string }): Promise<BlindResult> {
  const { data, usage } = await structured({
    stage: "eval.story",
    model: MODELS.sonnet,
    system: [plain(`You are the head writer of the YouTube documentary channel ${o.channel} and know its narration voice exactly. You will read two narration passages, A and B, both from the ${o.position} of a documentary. Exactly one was written by ${o.channel}; the other is an imitation. Find the real one: judge the writing as a viewer deciding whether to keep watching — hook, rhythm, specificity, attitude, tension and payoff.\n\n${RULES}`)],
    user: `PASSAGE A:\n"${o.a}"\n\nPASSAGE B:\n"${o.b}"\n\nWhich passage is the real ${o.channel} narration?`,
    schema: StoryVerdict,
    effort: "medium",
    maxTokens: 5000,
  });
  return toResult(data, usage.usd);
}

/** Calibration control: the same passage rewritten in generic AI-documentary prose (same facts, same length). */
export async function blandRewrite(text: string): Promise<{ text: string; usd: number }> {
  const { data, usage } = await structured({
    stage: "eval.control",
    model: MODELS.haiku,
    system: [plain("Rewrite documentary narration as a generic, safe, template documentary narrator would: same facts and roughly the same length, but with stock phrasing, even sentence lengths, no attitude, no irony, no withheld information and no cliffhangers. This text is used as a negative control in a writing test.")],
    user: text,
    schema: z.object({ text: z.string() }),
    effort: "low",
    maxTokens: 2000,
  });
  return { text: data.text, usd: usage.usd };
}
