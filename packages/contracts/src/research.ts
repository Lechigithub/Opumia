import { z } from "zod";
import { Aspect, IsoDateTime, Seconds } from "./common.js";
import { BeatRole } from "./script.js";
import { ChannelId } from "./style.js";

/** One checkable factual claim with its source. */
export const FactClaim = z.object({
  id: z.string(),
  text: z.string().min(5),
  kind: z.enum(["number", "date", "event", "quote", "context"]),
  sourceUrl: z.string().url(),
  sourceTitle: z.string().optional(),
  /** Verbatim support from the source, captured during verification (≤ 300 chars). */
  evidence: z.string().max(400).optional(),
  verdict: z.enum(["supported", "partially_supported", "unsupported", "unreachable", "unchecked"]),
  checkedBy: z.string().optional(),
});
export type FactClaim = z.infer<typeof FactClaim>;

/**
 * Story layer of the research dossier: who wanted what, the dramatic scenes, contrast anchors and quotes.
 * Every item cites claim ids; only items whose claims are supported/partially supported are kept.
 */
export const StoryCharacter = z.object({ name: z.string(), role: z.string(), want: z.string(), flaw: z.string(), cost: z.string(), claimIds: z.array(z.string()).min(1) });
export const StoryScene = z.object({
  id: z.string(),
  kind: z.enum(["confrontation", "humiliation", "memo", "gamble", "decision", "launch", "collapse", "deal", "other"]),
  when: z.string(),
  where: z.string(),
  who: z.array(z.string()),
  what: z.string().describe("what happens, concretely"),
  stakes: z.string(),
  claimIds: z.array(z.string()).min(1),
});
export const ContrastAnchor = z.object({ text: z.string().describe("one comparative sentence, e.g. '$5M revenue vs $800M in late fees alone'"), us: z.string(), them: z.string(), claimIds: z.array(z.string()).min(1) });
export const StoryQuote = z.object({ text: z.string(), speaker: z.string(), context: z.string(), claimId: z.string() });
export const StoryLayer = z.object({
  characters: z.array(StoryCharacter),
  scenes: z.array(StoryScene),
  contrasts: z.array(ContrastAnchor),
  quotes: z.array(StoryQuote),
});
export type StoryLayer = z.infer<typeof StoryLayer>;

export const FactSheet = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  topic: z.string(),
  summary: z.string(),
  angle: z.string().describe("the story angle: whose want, what obstacle, what turn"),
  claims: z.array(FactClaim).min(1),
  sources: z.array(z.object({ url: z.string().url(), title: z.string().optional(), reachable: z.boolean() })),
  /** Facts the story needed that could not be verified on any readable source (said plainly, never papered over). */
  gaps: z.array(z.string()).optional(),
  models: z.object({ research: z.string(), verify: z.string() }),
  /** Story dossier layer (characters, scenes, contrasts, quotes), every item bound to verified claims. */
  story: StoryLayer.optional(),
  generatedAt: IsoDateTime,
});
export type FactSheet = z.infer<typeof FactSheet>;
/** A FactSheet with its story layer: the research output the script writer dramatises. */
export const StoryDossier = FactSheet.extend({ story: StoryLayer });
export type StoryDossier = z.infer<typeof StoryDossier>;

/** Only claims a script may assert. */
export const usableClaims = (fs: FactSheet) => fs.claims.filter((c) => c.verdict === "supported" || c.verdict === "partially_supported");

/** Script before narration: text + beats, no timings yet. */
export const ScriptDraft = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  factSheetId: z.string(),
  styleProfileId: ChannelId,
  aspect: Aspect,
  targetDurationS: Seconds,
  targetWords: z.number().int().positive(),
  title: z.string(),
  hookFormula: z.string().describe("which channel hook pattern this script instantiates"),
  /** Story blueprint chosen for this film: cold-open archetype, act spine, ending archetype. */
  blueprint: z.object({ hook: z.string(), spine: z.string(), ending: z.string(), why: z.string(), opening: z.string().optional(), closing: z.string().optional(), beats: z.array(z.string()).optional() }).optional(),
  segments: z
    .array(
      z.object({
        id: z.string(),
        role: BeatRole,
        chapter: z.string().optional(),
        text: z.string().min(1),
        claimIds: z.array(z.string()),
        visualIdea: z.string(),
      }),
    )
    .min(2),
  wordCount: z.number().int(),
  /** Long-form: chapter titles in order (YouTube chapters). */
  chapters: z.array(z.string()).optional(),
  generatedAt: IsoDateTime,
});
export type ScriptDraft = z.infer<typeof ScriptDraft>;

