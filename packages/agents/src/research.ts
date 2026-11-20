import { createHash } from "node:crypto";
import { FactSheet, type FactClaim } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured, webResearch } from "./llm.js";
import { fetchPageText } from "./web.js";

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

const VerifySchema = z.object({
  checks: z.array(
    z.object({
      index: z.number(),
      verdict: z.enum(["supported", "partially_supported", "unsupported"]),
      evidence: z.string().describe("verbatim sentence from the page that supports the claim, or empty"),
    }),
  ),
});

const RESEARCH_SYSTEM = `You are the research desk for a business-documentary channel. You find specific, checkable facts — numbers, dates, named events, short quotes — from reputable sources (company filings, major newspapers, encyclopedias, official sites, books' publisher pages). You never invent facts. Prefer primary sources. Every fact you report must carry the URL of the page that states it.`;

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/[^a-z0-9$%.,\s]/g, " ").replace(/\s+/g, " ").trim();

export interface ResearchOptions {
  topic: string;
  /** e.g. "60-second vertical short" — shapes how many facts we need. */
  format: string;
  minClaims?: number;
  log?: (s: string) => void;
}

export async function researchTopic(o: ResearchOptions): Promise<FactSheet> {
  const log = o.log ?? (() => {});
  const want = Math.max(o.minClaims ?? 8, 8);

  log(`  research: web search (${MODELS.sonnet})…`);
  const research = await webResearch({
    stage: "research.search",
    system: [plain(RESEARCH_SYSTEM)],
    user: `Topic: ${o.topic}\nFormat: ${o.format}\n\nResearch this topic and report ${want + 4}-${want + 8} distinct facts that a documentary narrator could state on screen: the founding/origin, the turning point, the most dramatic numbers, the downfall or twist, and the present-day outcome. For each fact write one line: FACT: <fact> | SOURCE: <exact URL> . Use several different sources. Finish with a 2-sentence story angle (whose want, what obstacle, what turn).`,
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
    const page = await fetchPageText(url);
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

  return FactSheet.parse({
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
