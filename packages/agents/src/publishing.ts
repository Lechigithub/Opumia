import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type { FactSheet, FilmDesignSystem, SceneElement, SceneSpec, TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";
import { fitLayout } from "./scene-designer.js";

/**
 * Publishing studio: the package a film is published with — thumbnail, title, description, tags, hashtags and a
 * pinned comment — learned from how the reference channel packages its own films, and checked against the film
 * (nothing promised that the film does not deliver, no fact the research did not verify).
 *
 * Thumbnails are composed from REAL pictures by the packaging agent (packaging-agent.ts). No generated imagery.
 */
const img = async (p: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(p)).toString("base64") } });

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

/** Imposter test: our thumbnail among real ones. Can a designer who knows the channel pick it out? */
export async function thumbnailImposter(o: { channel: string; candidate: string; real: string[]; seed: number }): Promise<{ spotted: boolean; confidence: number; tells: string[]; usd: number }> {
  const all = [...o.real.slice(0, 4).map((p) => ({ p, ours: false }))];
  all.splice(o.seed % (all.length + 1), 0, { p: o.candidate, ours: true });
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [i, t] of all.entries()) blocks.push({ type: "text", text: `Thumbnail ${String.fromCharCode(65 + i)}:` }, await img(t.p));
  const { data, usage } = await structured({
    stage: "publish.imposter",
    model: MODELS.sonnet,
    system: [plain(`You are the thumbnail designer of the YouTube channel ${o.channel}. Of these thumbnails, all but one are real thumbnails from the channel; one was made by an imitator. Pick the imitation and say exactly what gives it away (composition, the subject and how it is cut out, colour, text, finish). Do not decide by topic or image resolution, and ignore the channel's own logo, badge or watermark (an imitation is not allowed to carry it, so its absence tells you nothing). If they all look like the channel, say so with low confidence.`)],
    user: blocks,
    schema: z.object({ observations: z.array(z.string()), pick: z.string().describe("the letter of the imitation"), confidence: z.number().describe("0.2 = guess, 1 = certain"), tells: z.array(z.string()) }),
    effort: "medium",
    maxTokens: 3000,
  });
  const idx = data.pick.trim().toUpperCase().charCodeAt(0) - 65;
  return { spotted: all[idx]?.ours === true, confidence: clamp(data.confidence, 0, 1), tells: data.tells.slice(0, 6), usd: usage.usd };
}

// ---------------------------------------------------------------------------------------------------------
// Title, description, tags, hashtags, pinned comment.

const TextSchema = z.object({
  titles: z.array(z.object({ title: z.string(), pattern: z.string().describe("which reference title pattern it follows") })).describe("6 candidates, each a different pattern"),
  hook: z.string().describe("the first two lines of the description (≤ 200 characters): what the viewer will find out, written to be read in the collapsed preview"),
  summary: z.string().describe("one paragraph, 60–110 words, in the channel's description style: restates the subject in the ways people search for it and tells what the film covers, without spoiling the ending"),
  tags: z.array(z.string()).describe("15–22 search phrases people would type, most specific first, modelled on the reference tags"),
  hashtags: z.array(z.string()).describe("3–5 hashtags without spaces, the first three are shown above the title"),
  pinnedComment: z.string().describe("one comment from the channel to pin: a specific, answerable question about the story that invites viewers to reply; no links, no 'subscribe'"),
});

export interface PublishingText { title: string; titleCandidates: Array<{ title: string; pattern: string }>; hook: string; summary: string; tags: string[]; hashtags: string[]; pinnedComment: string; checks: string[]; usd: number }

export async function writePublishingText(o: { channel: string; references: Array<{ title: string; views: number | null; summary: string; tags: string[] }>; script: TimedScript; facts: FactSheet; /** Chosen and tested by the packaging agent: kept as it is. */ title?: string; /** Problems a first version had (from the package check): fix them. */ fix?: string[] }): Promise<PublishingText> {
  const refs = [...o.references].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const narration = o.script.segments.map((s) => s.text).join(" ");
  const verified = o.facts.claims.map((c) => c.text).join(" ");
  const res = await structured({
    stage: "publish.text",
    model: MODELS.sonnet,
    system: [
      plain(`You package films for the YouTube channel ${o.channel}: the title, the description text, the tags, the hashtags and the pinned comment. Learn from how the channel itself does it.

THE CHANNEL'S TITLES, most viewed first (views in brackets):
${refs.slice(0, 30).map((r) => `- ${r.title} [${r.views ?? "?"}]`).join("\n")}

STORY PARAGRAPHS FROM ITS DESCRIPTIONS:
${refs.filter((r) => r.summary.length > 150).slice(0, 5).map((r) => `- (${r.title}) ${r.summary.slice(0, 500)}`).join("\n")}

ITS TAGS (per film):
${refs.filter((r) => r.tags.length).slice(0, 6).map((r) => `- (${r.title}) ${r.tags.slice(0, 14).join(", ")}`).join("\n")}

RULES:
- Titles: follow the patterns that got the most views above — their length, their punctuation, their kind of promise. At most 60 characters. Each candidate uses a different pattern. Never clickbait the film cannot pay off.
- Only facts from the film. Every number, name and claim must be in the narration or the verified facts given. Hedge what the narration hedges.
- No links, no "subscribe", no channel promotion, no emojis.
- Tags: phrases a person would search, built around the subject's names and the story's angle; no single generic words like "business". Never use the name of ${o.channel} or any other channel as a tag, and never a person, product or term the narration does not mention.`),
    ],
    user: `${o.fix?.length ? `A FIRST VERSION OF THIS PACKAGE HAD THESE PROBLEMS — do not repeat them; mention nothing the narration does not:\n${o.fix.map((x) => `- ${x}`).join("\n")}\n\n` : ""}FILM NARRATION:\n${narration}\n\nVERIFIED FACTS:\n${o.facts.claims.map((c) => `- ${c.text}`).join("\n").slice(0, 6000)}`,
    schema: TextSchema,
    effort: "medium",
    maxTokens: 6000,
  });
  const d = res.data;
  let usd = res.usage.usd;
  const checks: string[] = [];
  // Code checks: figures must come from the film; lengths within YouTube's limits.
  const source = `${narration} ${verified}`.toLowerCase();
  const numsOk = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).every((n) => source.includes(n.replace(/[.,]$/, "").toLowerCase()));
  let candidates = d.titles.map((t) => ({ title: t.title.trim().replace(/\s+/g, " "), pattern: t.pattern })).filter((t) => t.title.length >= 12 && t.title.length <= 70);
  const badNum = candidates.filter((t) => !numsOk(t.title));
  if (badNum.length) checks.push(`${badNum.length} title candidate(s) dropped: a figure not in the film`);
  candidates = candidates.filter((t) => numsOk(t.title));
  if (!candidates.length) candidates = [{ title: o.script.title, pattern: "script title" }];
  if (o.title) candidates = [{ title: o.title, pattern: "chosen by the packaging agent" }];
  // Imposter test on titles: each candidate hidden among real titles; the one least often picked out wins.
  const judged = o.title ? null : await structured({
    stage: "publish.titles",
    model: MODELS.haiku,
    system: [plain(`You know the YouTube channel ${o.channel} well. For each numbered list, all titles but one are real titles from the channel; one is an imitation. Say which line is the imitation and how sure you are. Judge wording, length, punctuation and the kind of promise — not the topic.`)],
    user: candidates.map((c, k) => {
      const real = refs.filter((_, i) => i % candidates.length === k % candidates.length).slice(0, 5).map((r) => r.title);
      const lines = [...real];
      lines.splice((k * 2 + 1) % (lines.length + 1), 0, c.title);
      return `LIST ${k}:\n${lines.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
    }).join("\n\n"),
    schema: z.object({ lists: z.array(z.object({ list: z.number(), imitation: z.string().describe("the full text of the title you think is the imitation"), confidence: z.number() })) }),
    effort: "low",
    maxTokens: 2000,
  }).catch(() => null);
  if (judged) usd += judged.usage.usd;
  const risk = (k: number) => {
    const v = judged?.data.lists.find((x) => x.list === k);
    if (!v) return 0.5;
    return v.imitation.trim().toLowerCase() === candidates[k]!.title.toLowerCase() ? clamp(v.confidence, 0, 1) : 0;
  };
  const ranked = candidates.map((c, k) => ({ c, r: risk(k) })).sort((a, b) => a.r - b.r);
  const title = ranked[0]!.c.title;
  if (!o.title) checks.push(`title chosen by imposter test: "${title}" (spotted-risk ${ranked[0]!.r.toFixed(2)}; ${ranked.filter((x) => x.r === 0).length}/${ranked.length} candidates passed as real)`);
  // Description text: only figures the NARRATION speaks (stricter than the fact sheet — the description must
  // not promise a number the viewer never hears). A sentence with any other figure is removed.
  const spoken = narration.toLowerCase();
  // H28: the same for names — a capitalised word inside a sentence (a person, a company, a place) the narration
  // never says is a promise the film does not keep.
  const NAME_OK = /^(I|YouTube|The|A|An|In|On|At|By|But|And|Or|So|If|When|How|Why|What|Who|This|That|These|Those|It|Its|He|She|They|We|You|Our|Their|His|Her|After|Before|From|For|With|Today|Now|Then)$/;
  const namesOk = (t: string) => [...t.matchAll(/(?<=[\p{L}\p{N},;:] )\p{Lu}[\p{L}'’-]+/gu)].map((m) => m[0]).filter((w) => !NAME_OK.test(w)).every((w) => spoken.includes(w.toLowerCase().replace(/['’]s$/, "")));
  const spokenOk = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).every((n) => spoken.includes(n.replace(/[.,]$/, "").toLowerCase())) && namesOk(t);
  const keepSpoken = (t: string) => {
    const parts = t.split(/(?<=[.!?])\s+/);
    const kept = parts.filter(spokenOk);
    if (kept.length < parts.length) checks.push(`${parts.length - kept.length} description sentence(s) removed: a figure or name the narration never says`);
    return kept.join(" ");
  };
  d.hook = keepSpoken(d.hook);
  d.summary = keepSpoken(d.summary);
  // Tags: unique, ≤ 480 characters in total (YouTube's limit is 500).
  const tags: string[] = [];
  let len = 0;
  const brand = o.channel.toLowerCase().replace(/[^a-z]/g, "");
  const GENERIC = /^(the|a|an|of|and|to|in|on|for|by|with|what|how|why|who|did|does|is|was|happened|story|stories|history|documentary|explained|truth|real|inside|rise|fall|scandal|fraud|trial|verdict|prison|case|company|business|startup|founder|ceo|investors?|collapse|downfall|dark|secret|secrets|biggest|scam|lawsuit|investigation|timeline|full)$/;
  let droppedTags = 0;
  for (const t of d.tags.map((x) => x.trim().replace(/^#/, "").replace(/\s+/g, " ")).filter((x) => x.length >= 3 && x.length <= 60)) {
    const low = t.toLowerCase();
    // Not the reference channel's brand, and no name or term the film itself never uses.
    const foreign = low.replace(/[^a-z]/g, "").includes(brand) || low.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.test(w)).some((w) => !source.includes(w));
    if (foreign) {
      droppedTags++;
      continue;
    }
    if (tags.some((y) => y.toLowerCase() === low) || len + t.length + 1 > 480) continue;
    tags.push(t);
    len += t.length + 1;
  }
  if (droppedTags) checks.push(`${droppedTags} tag(s) dropped: the reference channel's name or a term the film never uses`);
  const hashtags = [...new Set(d.hashtags.map((h) => `#${h.replace(/[^\p{L}\p{N}]/gu, "")}`).filter((h) => h.length > 2 && h.length <= 30))].slice(0, 5);
  const noLinks = (t: string) => t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return { title, titleCandidates: ranked.map((x) => x.c), hook: noLinks(d.hook).slice(0, 220), summary: noLinks(d.summary), tags, hashtags, pinnedComment: noLinks(d.pinnedComment).slice(0, 400), checks, usd };
}

/**
 * Title test: each candidate is hidden among real titles of the channel (a different set per candidate) and a judge
 * picks the imitation; a figure the film does not contain or a title over 70 characters fails outright.
 * risk = the judge's confidence when it picked our title out, 0 when it did not.
 */
export async function testTitles(o: { channel: string; references: Array<{ title: string; views: number | null }>; titles: string[]; narration: string; verified: string }): Promise<{ results: Array<{ title: string; risk: number; ok: boolean; why: string }>; usd: number }> {
  const refs = [...o.references].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const source = `${o.narration} ${o.verified}`.toLowerCase();
  const numsOk = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).every((n) => source.includes(n.replace(/[.,]$/, "").toLowerCase()));
  const cands = o.titles.map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 8);
  const pre = cands.map((t) => (t.length > 70 ? "longer than 70 characters" : t.length < 12 ? "too short" : !numsOk(t) ? "a figure the film does not contain" : ""));
  const testable = cands.map((t, k) => ({ t, k })).filter((x) => !pre[x.k]);
  let usd = 0;
  const judged = testable.length
    ? await structured({
        stage: "publish.titles",
        model: MODELS.haiku,
        system: [plain(`You know the YouTube channel ${o.channel} well. For each numbered list, all titles but one are real titles from the channel; one is an imitation. Say which line is the imitation and how sure you are. Judge wording, length, punctuation and the kind of promise — not the topic.`)],
        user: testable.map(({ t }, j) => {
          const lines = refs.filter((_, i) => i % Math.max(1, testable.length) === j % Math.max(1, testable.length)).slice(0, 5).map((r) => r.title);
          lines.splice((j * 2 + 1) % (lines.length + 1), 0, t);
          return `LIST ${j}:\n${lines.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;
        }).join("\n\n"),
        schema: z.object({ lists: z.array(z.object({ list: z.number(), imitation: z.string(), confidence: z.number() })) }),
        effort: "low",
        maxTokens: 2000,
      }).catch(() => null)
    : null;
  if (judged) usd += judged.usage.usd;
  const results = cands.map((t, k) => {
    if (pre[k]) return { title: t, risk: 1, ok: false, why: pre[k]! };
    const j = testable.findIndex((x) => x.k === k);
    const v = judged?.data.lists.find((x) => x.list === j);
    const risk = !v ? 0.5 : v.imitation.trim().toLowerCase() === t.toLowerCase() ? clamp(v.confidence, 0, 1) : 0;
    return { title: t, risk, ok: true, why: risk === 0 ? "passed as a real title" : `picked out as the imitation (confidence ${risk.toFixed(2)})` };
  });
  return { results, usd };
}

/** Does the package promise what the film delivers? (title, thumbnail words, description vs the narration) */
export async function checkPackage(o: { title: string; thumbnailText: string[]; thumbnailConcept: string; hook: string; summary: string; pinnedComment: string; narration: string }): Promise<{ ok: boolean; issues: string[]; quotes: string[]; usd: number }> {
  const { data, usage } = await structured({
    stage: "publish.check",
    model: MODELS.haiku,
    system: [plain("You are a strict standards editor. Compare a film's publishing package with its narration. Flag only real problems: a promise or claim in the package that the narration does not deliver; a fact, figure or accusation not stated in the narration; the title, thumbnail and description contradicting each other; anything defamatory stated as fact when the narration hedges it. Do not flag style.")],
    user: `TITLE: ${o.title}\nTHUMBNAIL: ${o.thumbnailConcept} — words on it: ${o.thumbnailText.join(" / ") || "none"}\nDESCRIPTION HOOK: ${o.hook}\nDESCRIPTION SUMMARY: ${o.summary}\nPINNED COMMENT: ${o.pinnedComment}\n\nNARRATION:\n${o.narration}`,
    schema: z.object({ ok: z.boolean(), issues: z.array(z.object({ issue: z.string(), quote: z.string().describe("the exact words of the package that make the claim, copied verbatim") })) }),
    effort: "low",
    maxTokens: 1500,
  });
  return { ok: data.ok && !data.issues.length, issues: data.issues.slice(0, 6).map((x) => x.issue), quotes: data.issues.slice(0, 6).map((x) => x.quote).filter((q) => q.trim().length >= 4), usd: usage.usd };
}

/** H28: remove every sentence of a text that contains one of the quoted claims (the package check's quotes). */
export function withoutClaims(text: string, quotes: string[]): { text: string; removed: number } {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  const qs = quotes.map(norm).filter((q) => q.length >= 4);
  const parts = text.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => !qs.some((q) => norm(p).includes(q) || (q.length > 30 && q.includes(norm(p)))));
  return { text: kept.join(" "), removed: parts.length - kept.length };
}
