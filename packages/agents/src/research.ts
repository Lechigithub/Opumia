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
  quotes: z.array(z.object({ text: z.string(), speaker: z.string(), context: z.string(), claimId: z.string() })),
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
      system: [plain("You are a documentary story producer. Organise VERIFIED CLAIMS into a story dossier: characters (want, flaw, cost), dramatic scenes (kind, when, where, who, what happens, stakes), contrast anchors (one comparative sentence: us vs them) and verbatim quotes. Use ONLY information stated in the claims; cite the claim ids each item rests on. Do not invent motives, places or numbers: if a claim does not state a want or a flaw, describe it as what the claims show (e.g. 'bet the company on Symbian'), never as speculation. Quotes must be claims of kind quote, verbatim.")],
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
      quotes: data.quotes.filter((q) => ok.has(q.claimId) && usable.find((c) => c.id === q.claimId)?.kind === "quote"),
    });
    log(`  research: dossier — ${story.characters.length} characters, ${story.scenes.length} scenes, ${story.contrasts.length} contrasts, ${story.quotes.length} quotes`);
  } catch (e) {
    log(`  ! story dossier failed (${(e as Error).message.slice(0, 120)}); continuing with claims only`);
  }

  return story;
}

/**
 * Research and fact-check. By default the research agent does it (research-agent.ts): it searches, reads pages
 * itself, records each claim only once its evidence has been found on a readable page, and retries a fact on
 * another source when one cannot be read. OPUMIA_RESEARCH=legacy runs the older single pass below.
 */
export async function researchTopic(o: ResearchOptions): Promise<FactSheet> {
  const log = o.log ?? (() => {});
  const want = Math.max(o.minClaims ?? 8, 8);
  if (process.env.OPUMIA_RESEARCH !== "legacy") {
    const res = await researchAgent({ topic: o.topic, format: o.format, want, ...(o.memoryDir ? { memoryDir: o.memoryDir } : {}), log });
    const story = await storyLayer(o.topic, res.claims, log);
    return FactSheet.parse({ ...(story ? { story } : {}), schemaVersion: 1, id: `fs_${createHash("sha1").update(o.topic).digest("hex").slice(0, 10)}`, topic: o.topic, summary: res.summary, angle: res.angle, claims: res.claims, sources: res.sources, ...(res.gaps.length ? { gaps: res.gaps } : {}), models: { research: MODELS.sonnet, verify: MODELS.haiku }, generatedAt: new Date().toISOString() });
  }

  log(`  research: web search (${MODELS.sonnet})…`);
  const research = await webResearch({
    stage: "research.search",
    system: [plain(RESEARCH_SYSTEM)],
    user: `Topic: ${o.topic}\nFormat: ${o.format}\n\nResearch this topic as a STORY, not a stats list, and report ${want + 4}-${want + 8} distinct facts:
- CHARACTERS: the 2–5 people who drove it — what each wanted, their flaw or blind spot, and what it cost them (each as its own fact).
- SCENES: 4–8 specific dramatic moments with date, place and people — confrontations, humiliations, secret memos, gambles, launches, deals, collapses — and what was at stake.
- CONTRASTS: 3–6 scale comparisons against famous rivals or peers at the same moment (e.g. revenue vs a rival's, market share vs a rival's, value then vs value later).
- QUOTES: 2–5 short verbatim quotes by named people (exact words, with who said them and when).
- NUMBERS & DATES: the origin, the peak, the turning point, the downfall and the present day.
For each fact write one line: FACT: <fact> | SOURCE: <exact URL> . Use several different sources. Finish with a 2-sentence story angle (whose want, what obstacle, what turn).`,
  });
  const urlList = [...research.urls.entries()].map(([u, t]) => `- ${u}${t ? ` (${t})` : ""}`).join("\n");

  log(`  research: extracting claims (${MODELS.haiku})…`);
  const { data: ex } = await structured({
    stage: "research.extract",
    model: MODELS.haiku,
    system: [plain("You turn research notes into a list of atomic, checkable claims. Each claim states exactly one fact. Keep the URL the notes gave for it; only use URLs that appear in the notes or the URL list. Drop facts without a URL.")],
    user: `RESEARCH NOTES:\n${research.text}\n\nURLS SEEN:\n${urlList}`,
    schema: ExtractSchema,
    effort: "low",
  });

  // Verify: fetch each source once, judge its claims against the page text.
  const bySource = new Map<string, number[]>();
  ex.claims.forEach((c, i) => {
    if (!/^https?:\/\//.test(c.sourceUrl)) return;
    (bySource.get(c.sourceUrl) ?? bySource.set(c.sourceUrl, []).get(c.sourceUrl)!).push(i);
  });
  const verdicts = new Map<number, { verdict: FactClaim["verdict"]; evidence?: string }>();
  const sources: FactSheet["sources"] = [];
  log(`  verify: ${ex.claims.length} claims across ${bySource.size} sources (${MODELS.haiku})…`);
  for (const [url, idxs] of bySource) {
    const page = (await readPage(url))?.text ?? null;
    sources.push({ url, title: ex.claims[idxs[0]!]?.sourceTitle, reachable: Boolean(page) });
    if (!page) {
      for (const i of idxs) verdicts.set(i, { verdict: "unreachable" });
      continue;
    }
    const { data } = await structured({
      stage: "research.verify",
      model: MODELS.haiku,
      system: [plain("You are a strict fact-checker. For each numbered claim decide whether the PAGE TEXT supports it: supported (the page states it, numbers and dates match), partially_supported (the page states part of it or a rounded/close figure), unsupported (absent or contradicted). Quote the supporting sentence verbatim from the page; never paraphrase the evidence.")],
      user: `PAGE: ${url}\n\nPAGE TEXT:\n${page}\n\nCLAIMS:\n${idxs.map((i, k) => `${k}. ${ex.claims[i]!.text}`).join("\n")}`,
      schema: VerifySchema,
      effort: "low",
    });
    const normPage = norm(page);
    for (const chk of data.checks) {
      const i = idxs[chk.index];
      if (i === undefined) continue;
      let verdict: FactClaim["verdict"] = chk.verdict;
      const ev = chk.evidence.trim();
      // Evidence must actually appear on the page; otherwise downgrade.
      const found = ev.length > 10 && normPage.includes(norm(ev).slice(0, 120));
      if (verdict === "supported" && !found) verdict = "partially_supported";
      verdicts.set(i, { verdict, ...(found ? { evidence: ev.slice(0, 300) } : {}) });
    }
  }

  const claims: FactClaim[] = ex.claims.map((c, i) => {
    const v = verdicts.get(i) ?? { verdict: "unchecked" as const };
    return {
      id: `c${String(i + 1).padStart(2, "0")}`,
      text: c.text,
      kind: c.kind,
      sourceUrl: c.sourceUrl,
      ...(c.sourceTitle ? { sourceTitle: c.sourceTitle } : {}),
      ...(v.evidence ? { evidence: v.evidence } : {}),
      verdict: v.verdict,
      checkedBy: MODELS.haiku,
    };
  }).filter((c) => /^https?:\/\//.test(c.sourceUrl));

  const supported = claims.filter((c) => c.verdict === "supported").length;
  log(`  verify: ${supported} supported, ${claims.filter((c) => c.verdict === "partially_supported").length} partial, ${claims.filter((c) => ["unsupported", "unreachable"].includes(c.verdict)).length} rejected`);
  if (supported < Math.min(5, want)) throw new Error(`research: only ${supported} supported claims — not enough to write a factual script`);

  const story = await storyLayer(o.topic, claims, log);

  return FactSheet.parse({
    ...(story ? { story } : {}),
    schemaVersion: 1,
    id: `fs_${createHash("sha1").update(o.topic).digest("hex").slice(0, 10)}`,
    topic: o.topic,
    summary: ex.summary,
    angle: ex.angle,
    claims,
    sources,
    models: { research: MODELS.sonnet, verify: MODELS.haiku },
    generatedAt: new Date().toISOString(),
  });
}
