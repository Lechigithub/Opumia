import { createHash } from "node:crypto";
import { FactSheet, StoryLayer, type FactClaim } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured, webResearch } from "./llm.js";
import { readPage } from "./web.js";
import { researchAgent } from "./research-agent.js";

const ExtractSchema = z.object({
  summary: z.string(),
  angle: z.string(),
  claims: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(["number", "date", "event", "quote", "context"]),
      sourceUrl: z.string(),
      sourceTitle: z.string(),
    }),
  ),
});

const StorySchema = z.object({
  characters: z.array(z.object({ name: z.string(), role: z.string(), want: z.string(), flaw: z.string(), cost: z.string(), claimIds: z.array(z.string()) })),
  scenes: z.array(z.object({ kind: z.enum(["confrontation", "humiliation", "memo", "gamble", "decision", "launch", "collapse", "deal", "other"]), when: z.string(), where: z.string(), who: z.array(z.string()), what: z.string(), stakes: z.string(), claimIds: z.array(z.string()) })),
  contrasts: z.array(z.object({ text: z.string(), us: z.string(), them: z.string(), claimIds: z.array(z.string()) })),
  quotes: z.array(z.object({ text: z.string(), speaker: z.string(), context: z.string(), claimId: z.string(), image: z.string().describe("the concrete picture inside the quote's words, e.g. 'a man on a burning oil platform jumping into icy water'; empty if none") })),
  turns: z.array(z.object({ when: z.string(), what: z.string(), who: z.array(z.string()), claimIds: z.array(z.string()) })).describe("the turning points in order: what changed, when, for whom"),
});

const VerifySchema = z.object({
  checks: z.array(
    z.object({
      index: z.number(),
      verdict: z.enum(["supported", "partially_supported", "unsupported"]),
      evidence: z.string().describe("verbatim sentence from the page that supports the claim, or empty"),
    }),
  ),
});

const RESEARCH_SYSTEM = `You are the research desk for a business-documentary channel that tells stories through people, scenes and contrasts. You find specific, checkable facts — who wanted what and what it cost them, concrete scenes (meetings, memos, launches, humiliations, gambles, deals) with when/where/who, scale comparisons against famous rivals, verbatim quotes, numbers and dates — from reputable sources (company filings, major newspapers, encyclopedias, official sites, books' publisher pages). You never invent facts. Prefer primary sources. Every fact you report must carry the URL of the page that states it.`;

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/[^a-z0-9$%.,\s]/g, " ").replace(/\s+/g, " ").trim();

export interface ResearchOptions {
  topic: string;
  /** e.g. "60-second vertical short" — shapes how many facts we need. */
  format: string;
  minClaims?: number;
  /** Where the research agent keeps its memory (data/agents/research). */
  memoryDir?: string;
  /** Reads a page through a real browser when the plain request and the archive both fail (resolver/press.ts). */
  browserRead?: (url: string) => Promise<string | null>;
  /** The spoken words of a video, for interviews and talks (resolver/press.ts:youtubeTranscript). */
  videoTranscript?: (url: string) => Promise<{ title: string; channel: string; text: string } | null>;
  log?: (s: string) => void;
}

/** Story layer: the verified claims organised into characters, scenes, contrast anchors and quotes. */
async function storyLayer(topic: string, claims: FactClaim[], log: (s: string) => void): Promise<StoryLayer | undefined> {
  const usable = claims.filter((c) => c.verdict === "supported" || c.verdict === "partially_supported");
  let story: StoryLayer | undefined;
  try {
    log(`  research: structuring the story dossier (${MODELS.sonnet})…`);
    const { data } = await structured({
      stage: "research.story",
      model: MODELS.sonnet,
      system: [plain("You are a documentary story producer. Organise VERIFIED CLAIMS into a story dossier: characters (want, flaw, cost), dramatic scenes (kind, when, where, who, what happens, stakes — each one a MOMENT a viewer could be dropped into: a place, a date, people doing something), contrast anchors (one comparative sentence: us vs them), verbatim quotes with the concrete picture inside their words, and the turning points in order. Characters' wants are what the claims show each person wanted, feared or decided. Use ONLY information stated in the claims; cite the claim ids each item rests on. Do not invent motives, places or numbers: if a claim does not state a want or a flaw, describe it as what the claims show (e.g. 'bet the company on Symbian'), never as speculation. Quotes must be claims of kind quote, verbatim.")],
      user: `TOPIC: ${topic}\n\nVERIFIED CLAIMS:\n${usable.map((c) => `[${c.id}] (${c.kind}) ${c.text}`).join("\n")}`,
      schema: StorySchema,
      effort: "medium",
      maxTokens: 12000,
    });
    const ok = new Set(usable.map((c) => c.id));
    const bound = (ids: string[]) => ids.filter((x) => ok.has(x));
    story = StoryLayer.parse({
      characters: data.characters.map((c) => ({ ...c, claimIds: bound(c.claimIds) })).filter((c) => c.claimIds.length),
      scenes: data.scenes.map((c, i) => ({ ...c, id: `sc${String(i + 1).padStart(2, "0")}`, claimIds: bound(c.claimIds) })).filter((c) => c.claimIds.length),
      contrasts: data.contrasts.map((c) => ({ ...c, claimIds: bound(c.claimIds) })).filter((c) => c.claimIds.length),
      quotes: data.quotes.filter((q) => ok.has(q.claimId) && usable.find((c) => c.id === q.claimId)?.kind === "quote").map((q) => ({ text: q.text, speaker: q.speaker, context: q.context, claimId: q.claimId, ...(q.image.trim() ? { image: q.image.trim() } : {}) })),
      turns: data.turns.map((t) => ({ ...t, claimIds: bound(t.claimIds) })).filter((t) => t.claimIds.length),
    });
    log(`  research: dossier — ${story.characters.length} characters, ${story.scenes.length} scenes, ${story.contrasts.length} contrasts, ${story.quotes.length} quotes, ${story.turns?.length ?? 0} turns`);
  } catch (e) {
    log(`  ! story dossier failed (${(e as Error).message.slice(0, 120)}); continuing with claims only`);
  }

  return story;
}

/**
 * Research and fact-check. By default the research agent does it (research-agent.ts): it searches, reads pages
 * itself, records each claim only once its evidence has been found on a readable page, and retries a fact on
 * another source when one cannot be read. (The older single pass was removed once the agent was proven: 24 verified facts against 16 on Kodak.)
 */
export async function researchTopic(o: ResearchOptions): Promise<FactSheet> {
  const log = o.log ?? (() => {});
  const want = Math.max(o.minClaims ?? 8, 8);
  const res = await researchAgent({ topic: o.topic, format: o.format, want, ...(o.memoryDir ? { memoryDir: o.memoryDir } : {}), ...(o.browserRead ? { browserRead: o.browserRead } : {}), ...(o.videoTranscript ? { videoTranscript: o.videoTranscript } : {}), log });
  const story = await storyLayer(o.topic, res.claims, log);
  return FactSheet.parse({ ...(story ? { story } : {}), schemaVersion: 1, id: `fs_${createHash("sha1").update(o.topic).digest("hex").slice(0, 10)}`, topic: o.topic, summary: res.summary, angle: res.angle, claims: res.claims, sources: res.sources, ...(res.gaps.length ? { gaps: res.gaps } : {}), models: { research: MODELS.sonnet, verify: MODELS.haiku }, generatedAt: new Date().toISOString() });

}
