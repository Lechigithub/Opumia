import { lengthPlan } from "./film-length.js";
import { endingKind, ensureFillerBan, ensureSceneBand, labelSceneLines, openingLineCount, sceneIssues, type FillerBan, type SceneBand } from "./story-scenes.js";
/**
 * The writer agent: one author with tools, a skill file and a memory of its own.
 *
 *  skill    packages/agents/skills/writer.md — the craft, versioned on its own; improved without touching code.
 *  tools    list / read / search the channel's real films; measure its own draft the way those films were
 *           measured (story band, prose, length at the voice's pace, facts); submit; leave itself a lesson.
 *  memory   <memoryDir>/<channel>.md (its own lessons and a log of every script: what the measurement said,
 *           how many rounds it took) and <memoryDir>/owner-notes.md (the owner's feedback, read every time).
 *  loop     study → plan → draft → measure → revise → submit. Code only verifies; it never rewrites a sentence.
 */
import { readMemory } from "./lessons.js";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ScriptDraft, usableClaims, type Aspect, type FactClaim, type FactSheet } from "@opumia/contracts";
import * as z from "zod/v4";
import { agentLoop, cached, plain, structured, type AgentTool, ROLE_MODEL } from "./llm.js";
import { critiqueNarrative, sentencesOf } from "./narrative.js";
import { earPunctuation, normalizeFigures } from "./numeric-facts.js";
import { labelLines, storyIssues, type ReferenceFilm, type StoryBand, type StoryProfile } from "./story-measure.js";
import type { StylePack } from "./style-pack.js";
import { structureProfile, structureBrief, structureIssues } from "./story-structure.js";
import { voiceBand, voiceStats, voiceReport, voiceTargets, offendersReport } from "./voice-meter.js";
import { scriptReferee, scriptRefereeReport, heldBackScripts, SCRIPT_REFEREE_BLOCKS, openingFormula, openingShape, openingsLedger } from "./script-referee.js";

const ROLES = ["cold_open", "hook", "thesis", "context", "rise", "twist", "climax", "fall", "resolution", "cta", "chapter", "rehook"] as const;
const Segment = z.object({ role: z.enum(ROLES), chapter: z.string().describe("chapter title (long-form); empty for shorts"), text: z.string(), claimIds: z.array(z.string()).describe("fact-sheet claim ids this segment relies on"), visualIdea: z.string().describe("one line: what should be on screen (real footage, a staged scene, a chart, a document) — never AI imagery") });
const Draft = z.object({ segments: z.array(Segment).min(1) });
const Outline = z.object({ title: z.string(), parts: z.array(z.object({ title: z.string().describe("\"Intro\" for the first part, else the chapter's title"), purpose: z.string(), beats: z.array(z.string()), roles: z.array(z.enum(ROLES)), claimIds: z.array(z.string()) })).min(2) });
const Submission = z.object({
  title: z.string(),
  plan: z.object({
    opening: z.string().describe("the moment this film opens on and what it makes the viewer want to know"),
    beats: z.array(z.string()).describe("this story's own turns, in order"),
    closing: z.string().describe("what the film lands on"),
    hook: z.enum(["irony", "reversal", "mystery", "stakes", "flash_forward", "claim", "question"]).describe("label only: the kind of opening this turned out to be"),
    spine: z.string().describe("label only: a few words for the shape of this story"),
    ending: z.enum(["callback", "lesson", "open_question", "where_now", "warning"]).describe("label only: the kind of ending this turned out to be"),
  }),
  segments: z.array(Segment).min(1),
});

export interface StoryReport {
  pass: boolean;
  rounds: Array<{ issues: string[]; profile: StoryProfile }>;
  remaining: Array<{ kind: string; detail: string }>;
  agent?: { turns: number; calls: Record<string, number>; usd: number; filmsRead: string[] };
}

export interface WriterOptions {
  pack: StylePack;
  facts: FactSheet;
  aspect: Aspect;
  durationS: number;
  narrationWpm: number;
  storyBand: StoryBand;
  films: ReferenceFilm[];
  /**
   * The writer's line to the researcher: specific facts the story needs and the sheet lacks. Returns the claims
   * that could be verified (they are added to the fact sheet, which is changed in place).
   */
  askResearcher?: (questions: string[]) => Promise<FactClaim[]>;
  /** Where the writer keeps its memory (data/agents/writer). */
  memoryDir?: string;
  recent?: Array<{ hook: string; ending: string; spine: string; beats?: string[] }>;
  recentOpenings?: string[];
  onStory?: (r: StoryReport) => void;
  /** The showrunner sent the script back: what to change and why (with the lines concerned). */
  brief?: string;
  log?: (s: string) => void;
}

const countWords = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const norm = (t: string) => t.toLowerCase().replace(/[“”"'’‘]/g, "").replace(/\s+/g, " ").trim();
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

const CAUSE = /\b(caused|causes|cause of|led to|leads to|lead to|resulted in|result of|as a result|because of|due to|thanks to|that'?s why|which is why|this is why|is why|which meant|meant that|that meant|so (it|they|he|she|the company) (had to|filed|went|lost|collapsed|failed|missed)|drove|forced|doomed|killed|destroyed|sank|ruined|cost (them|it|him|her|the company)|brought down|triggered)\b/i;
const CAUSE_HEDGE = /\b(reportedly|allegedly|apparently|seems?|seemed|appears?|may|might|could have|probably|perhaps|likely|helped|partly|in part|part of the reason|one reason|arguably|according to|(he|she|they) (later )?(said|says|argued|claimed|admitted)|critics|many (say|believe|argue)|didn'?t help)\b/i;
const CAUSE_STOP = new Set(["the", "and", "that", "this", "with", "from", "they", "them", "their", "have", "had", "was", "were", "would", "could", "about", "into", "than", "what", "when", "which", "meant", "years", "later", "because", "caused", "led"]);
/** Lines that state a cause as fact with no fact-sheet claim stating it (a causal word and half the line's content words in one claim). */
export function causesAsFact(lines: string[], claims: string[]): string[] {
  const content = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3 && !CAUSE_STOP.has(w));
  const causal = claims.filter((c) => CAUSE.test(c)).map((c) => new Set(content(c)));
  return lines.filter((t) => CAUSE.test(t) && !CAUSE_HEDGE.test(t)).filter((t) => {
    const cw = content(t);
    return !cw.length || !causal.some((set) => cw.filter((w) => set.has(w)).length / cw.length >= 0.5);
  });
}

export async function writeScriptAgent(o: WriterOptions): Promise<ScriptDraft> {
  const log = o.log ?? (() => {});
  const lp = lengthPlan(o.durationS);
  const short = lp.chapters === 0;
  const targetWords = Math.round((o.durationS * o.narrationWpm) / 60);
  // the writer's turns and time grow with the script (a 10-minute Enron script, 1,659 words, ran out of the fixed 6 min
  // and 22 turns that a 60-second script gets after 6 measurements; 2026-11-27): ×1 up to ~250 words, up to ×6
  const lengthFactor = Math.max(1, Math.min(6, targetWords / 250));
  const claims = usableClaims(o.facts);
  const known = new Set(claims.map((c) => c.id));
  const st = o.facts.story;
  let factText = norm([...claims.map((c) => c.text), ...(st ? [...st.characters.map((c) => `${c.name} ${c.role} ${c.want} ${c.flaw} ${c.cost}`), ...st.scenes.map((c) => `${c.when} ${c.where} ${c.what} ${c.stakes}`), ...st.contrasts.map((c) => c.text), ...st.quotes.map((q) => q.text)] : [])].join(" ")).replace(/,/g, "");
  const band = o.storyBand;
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const skill = await readFile(new URL("../skills/writer.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.pack.channelId, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";

  // ---- build list 5, items 5–9: the scene-and-character band at THIS film's length and the filler the channel never
  // uses, both learned from the real narrations (built once, cached in data/story-profile/).
  const dataDir = o.memoryDir ? path.dirname(path.dirname(o.memoryDir)) : null;
  let sceneBand: SceneBand | null = null;
  let fillerBan: FillerBan | null = null;
  if (dataDir) {
    sceneBand = await ensureSceneBand({ data: dataDir, channelId: o.pack.channelId, films: o.films, lengthS: o.durationS, log }).catch(() => null);
    fillerBan = await ensureFillerBan({ data: dataDir, root: path.dirname(dataDir), channelId: o.pack.channelId, films: o.films }).catch(() => null);
  }
  const datedFacts = claims.filter((c) => c.kind === "date" || c.kind === "event").map((c) => c.text);
  const dossierMoments = (st?.scenes ?? []).map((c) => ({ what: c.what, when: c.when, where: c.where }));
  const openWords = Math.round((lp.openingS * o.narrationWpm) / 60);
  // the channel's whole-film structure (long films): measured from the reference's story analysis, built once
  const structure = !short && dataDir ? (() => { try { return structureProfile({ reference: path.resolve(path.dirname(dataDir), process.env.OPUMIA_REFERENCE_DIR ?? "Reference"), data: dataDir, channel: o.pack.channelId }); } catch { return null; } })() : null;

  // ---- speed (owner, 2026-11-27: "the script is not the hard part — it should be super fast and still reach the score"):
  // a sentence is labelled once per run; a re-measured draft costs only the sentences that changed.
  const lineCache = new Map<string, Awaited<ReturnType<typeof labelLines>>[number]>();
  const sceneCache = new Map<string, Awaited<ReturnType<typeof labelSceneLines>>[number]>();
  const endCache = new Map<string, Awaited<ReturnType<typeof endingKind>>>();
  const labelOnce = async <T>(lines: string[], cache: Map<string, T>, fn: (xs: string[]) => Promise<T[]>): Promise<T[]> => {
    const miss = [...new Set(lines.filter((l) => !cache.has(l)))];
    if (miss.length) { const got = await fn(miss); miss.forEach((l, i) => { if (got[i] !== undefined) cache.set(l, got[i]!); }); }
    return lines.map((l) => cache.get(l)!);
  };
  const endingOnce = async (open: string[], end: string[]) => { const k = `${open.join(" ")}|${end.join(" ")}`; if (!endCache.has(k)) endCache.set(k, await endingKind(open, end)); return endCache.get(k)!; };

  // ---- one evaluation, used by measure_draft and submit_script: the same checks, nothing rewritten.
  const rounds: StoryReport["rounds"] = [];
  let last: { segments: z.infer<typeof Segment>[]; ok: boolean; issues: Array<{ kind: string; detail: string }>; profile: StoryProfile } | null = null;
  const evaluate = async (segments: z.infer<typeof Segment>[]) => {
    const lines = segments.flatMap((sg) => sentencesOf(sg.text));
    const openLines = openingLineCount(lines, openWords);
    const [labels, sceneLabels, ending] = await Promise.all([labelOnce(lines, lineCache, labelLines), sceneBand ? labelOnce(lines, sceneCache, (xs) => labelSceneLines(xs, datedFacts)) : Promise.resolve(null), sceneBand ? endingOnce(lines.slice(0, openLines), lines.slice(-Math.max(1, Math.min(3, Math.ceil(lines.length / 6))))) : Promise.resolve(null)]);
    const story = storyIssues(lines, labels, band);
    const issues: Array<{ kind: string; detail: string }> = story.issues.map((x) => ({ kind: x.kind, detail: `${x.detail}${x.lines.length ? ` Lines: ${x.lines.slice(0, 8).map((k) => `"${lines[k]}"`).join(" | ")}` : ""}` }));
    // the scene measure decides together with the line-kind band (item 5): both must pass
    const scenes = sceneBand && sceneLabels ? sceneIssues({ lines, labels: sceneLabels, band: sceneBand, ban: fillerBan, openLines, ending, dossierMoments, durationS: o.durationS }) : null;
    for (const x of scenes?.issues ?? []) issues.push({ kind: x.kind, detail: `${x.detail}${x.lines.length ? ` Lines: ${[...new Set(x.lines)].slice(0, 6).map((k) => `"${lines[k]}"`).join(" | ")}` : ""}` });
    const words = segments.reduce((n, sg) => n + countWords(sg.text), 0);
    if (Math.abs(words - targetWords) / targetWords > 0.05) issues.push({ kind: "length", detail: `${words} words; this film needs ${targetWords} (±5%) — at ${o.narrationWpm} words a minute that is ${Math.round((words / o.narrationWpm) * 60)} s against ${o.durationS} s.` });
    for (const i of critiqueNarrative(segments, o.narrationWpm, { short, maxGapS: lp.maxGapS })) issues.push({ kind: i.kind, detail: `${i.where}: ${i.detail}` });
    if (structure) for (const i of structureIssues(segments, o.durationS, o.narrationWpm, structure, lp.chapters)) issues.push(i);
    const withDigit = lines.filter((t) => /\d/.test(t));
    if (withDigit.length / Math.max(1, lines.length) > 0.2) issues.push({ kind: "too_many_figures", detail: `${withDigit.length} of ${lines.length} sentences carry a figure (the channel: about one in six). Keep the figures the story turns on; tell the rest without numbers or leave those facts out — never replace a number with a vague phrase.` });
    const text = segments.map((sg) => sg.text).join(" ");
    if (/[—–;()]|\s-\s/.test(text)) issues.push({ kind: "unspeakable_punctuation", detail: "the script contains a dash used as a pause, a bracket or a semicolon — rewrite those sentences with commas and full stops." });
    const figures = [...new Set((normalizeFigures(text).match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, "")))].filter((n) => !factText.includes(n));
    if (figures.length) issues.push({ kind: "unsupported_figure", detail: `these figures are not in the fact sheet: ${figures.slice(0, 8).join(", ")}. Use only figures from the fact sheet, exactly as given.` });
    const quotes = [...text.matchAll(/["“]([^"”]{18,})["”]/g)].map((m) => m[1]!).filter((q) => !factText.includes(norm(q).replace(/,/g, "").replace(/[.!?]$/, "")));
    if (quotes.length) issues.push({ kind: "unsupported_quote", detail: `these quotations are not in the fact sheet word for word: ${quotes.slice(0, 4).map((q) => `"${q}"`).join(" | ")}. Quote exactly or tell it in your own words without quotation marks.` });
    // H29: a motive (what someone wanted, feared, believed) is a claim. A motive line must be hedged ("reportedly",
    // "he later said", "it seems") or carried by a fact-sheet claim that says it (most of its content words in one claim).
    const HEDGE = /\b(reportedly|allegedly|apparently|seemingly|seems?|seemed|appears?|appeared|may have|might have|probably|perhaps|likely|according to|(he|she|they|it) (later )?(said|says|told|wrote|claimed|admitted|insisted|recalled|explained)|in (his|her|their) words|as (he|she|they) put it|by (his|her|their) own account|believed by|critics|insiders|employees said|people close)\b/i;
    const STOPW = new Set(["the", "and", "that", "this", "with", "from", "they", "them", "their", "have", "had", "was", "were", "would", "could", "about", "into", "than", "what", "when", "which", "wanted", "want", "feared", "thought", "believed", "knew", "felt", "hated", "loved"]);
    const content = (t: string) => norm(t).split(" ").filter((w) => w.length > 3 && !STOPW.has(w));
    const claimWords = claims.map((c) => new Set(content(c.text)));
    const motives = lines.map((t, k) => ({ t, k })).filter(({ k }) => (labels[k] as unknown as string) === "motive").filter(({ t }) => {
      if (HEDGE.test(t)) return false;
      const cw = content(t);
      return !cw.length || !claimWords.some((set) => cw.filter((w) => set.has(w)).length / cw.length >= 0.6);
    });
    if (motives.length) issues.push({ kind: "motive_as_fact", detail: `these lines state what someone wanted, feared or believed as fact, and no claim in the fact sheet says it: ${motives.slice(0, 5).map((x) => `"${x.t}"`).join(" | ")}. A motive is a claim: tell it as what they did, hedge it in plain words ("it seems", "he later said"), or ask the researcher for evidence.` });
    // Build list 3, item 22 (film 1: "kept the camera quiet, which meant … so it filed for Chapter 11"): a cause stated
    // as fact is a claim too, checked like a motive.
    const causes = causesAsFact(lines, claims.map((c) => c.text));
    if (causes.length) issues.push({ kind: "cause_as_fact", detail: `these lines state that one thing caused another as fact, and no claim in the fact sheet states that cause: ${causes.slice(0, 5).map((x) => `"${x}"`).join(" | ")}. A cause is a claim: tell the events in order and let the viewer connect them, hedge it in plain words ("it didn't help", "part of the reason"), or ask the researcher for evidence of the cause.` });
    const badIds = [...new Set(segments.flatMap((sg) => sg.claimIds).filter((c) => !known.has(c)))];
    if (badIds.length) issues.push({ kind: "unknown_claim", detail: `claim ids not in the fact sheet: ${badIds.join(", ")}` });
    rounds.push({ issues: issues.map((x) => x.kind), profile: story.profile });
    last = { segments, ok: issues.length === 0, issues, profile: story.profile };
    const p = story.profile;
    const header = `MEASURED (${words} words, ${lines.length} sentences) against ${band.films} real films of the channel:\n- explains what things mean: ${pc(p.share.explain)} of lines (channel ${pc(band.kinds.explain.p10)}–${pc(band.kinds.explain.p90)})\n- talks to the viewer or as the narrator: ${pc(p.viewerShare)} (channel ${pc(band.viewer.p10)}–${pc(band.viewer.p90)})\n- quotations: ${pc(p.share.quote)} (channel up to ${pc(band.kinds.quote.p90)})\n- bare facts: ${pc(p.share.fact)} (channel up to ${pc(band.kinds.fact.p90)})\n- scenes: ${pc(p.share.scene)}, motives: ${pc(p.share.motive)}, questions: ${pc(p.share.question)}, teases: ${pc(p.share.tease)}, general sayings: ${pc(p.share.maxim)}\n- sentences with a figure: ${pc(withDigit.length / Math.max(1, lines.length))}${scenes && sceneBand ? `\n- lines that put the viewer in a moment: ${pc(scenes.profile.moment)} (channel ${pc(sceneBand.moment.p25)}–${pc(sceneBand.moment.p90)} at ${sceneBand.lengthS} s); a named person wanting, fearing or deciding: ${pc(scenes.profile.agency)} (channel ${pc(sceneBand.agency.p25)}–${pc(sceneBand.agency.p90)})\n- time skipped without a bridge: ${scenes.profile.jumps.length} (${scenes.profile.jumps.map((j) => `${j.from}→${j.to}`).join(", ") || "none"}); opens on a moment: ${scenes.profile.opensOnMoment ? "yes" : "no"}; ending: ${ending?.kind ?? "?"}` : ""}`;
    // the script referee (proven on held-back channel narrations): reported to the writer, blocking once proven
    const verdict = dataDir ? scriptReferee(path.dirname(dataDir), text, o.pack.channelId) : null;
    if (verdict && !verdict.pass && SCRIPT_REFEREE_BLOCKS) issues.push({ kind: "reads_unlike_channel", detail: `the script referee scores it ${verdict.score} (bar ${verdict.bar}); fix what it names, sentence by sentence, without changing the facts.` });
    if (verdict) refereeSeen.push(verdict.score);
    const formula = o.memoryDir ? openingFormula(text, o.facts.topic, openingsLedger(o.memoryDir, o.pack.channelId)) : null;
    if (formula) issues.push({ kind: "opening_formula", detail: `${formula}. The channel's own openings, for range: ${studyFilms.slice(0, 6).map((f) => `"${String(f.lines[0] ?? "").slice(0, 90)}"`).join(" | ")}` });
    // the best draft that passes everything but the script referee: kept for when no script is accepted (proof run
    // 2026-11-27, Quibi: 21 drafts, best 0.36, the last one handed in 0.29)
    if (verdict && issues.every((x) => x.kind === "reads_unlike_channel") && verdict.score > (bestDraft?.score ?? -1)) bestDraft = { segments, score: verdict.score, issues };
    const offenders = offendersReport(text);
    const header2 = `${verdict ? `${header}\n${scriptRefereeReport(verdict)}` : header}${vband ? `\n${voiceReport(voiceStats(text), vband)}` : ""}${offenders ? `\n${offenders}` : ""}`;
    return { ok: issues.length === 0, report: issues.length ? `${header2}\n\nNOT YET — ${issues.length} thing(s) to fix:\n${issues.map((x, i) => `${i + 1}. [${x.kind}] ${x.detail}`).join("\n")}` : `${header2}\n\nPASSES every check.` };
  };

  // ---- tools
  const filmsRead = new Set<string>();
  const refereeSeen: number[] = [];
  // the voice meter: how a passage is built against the channel's own narration (guidance, instant, no model)
  const vband = dataDir ? (() => { try { return voiceBand({ data: dataDir, channel: o.pack.channelId, films: o.films, held: heldBackScripts(dataDir, o.pack.channelId) }); } catch { return null; } })() : null;
  let bestDraft: { segments: z.infer<typeof Segment>[]; score: number; issues: Array<{ kind: string; detail: string }> } | null = null;
  // the narrations the script referee holds back are hidden from the writer's reference tools (a fair test)
  const heldBack = dataDir ? heldBackScripts(dataDir, o.pack.channelId) : new Set<string>();
  const studyFilms = o.films.filter((f) => !heldBack.has(f.id));
  const film = (id: string) => studyFilms.find((f) => f.id === id);
  let accepted: z.infer<typeof Submission> | null = null;
  let noteSaved = false;
  let grace = 1; // one more turn after acceptance, for the writer's own note
  let lastSubmission: z.infer<typeof Submission> | null = null;
  let asked = 0;
  const tools: AgentTool[] = [
    ...(o.askResearcher
      ? [
          {
            name: "ask_researcher",
            description: "Ask the researcher to find and verify specific facts the story needs and the fact sheet lacks: the other side of a contrast, a date, a figure, what happened next. Up to 3 facts per call, 2 calls per script. Each comes back verified with a claim id you can then use, or not found. Ask only for what the script will actually use.",
            schema: z.object({ questions: z.array(z.string()).min(1).max(3) }),
            run: (async (i: { questions: string[] }) => {
              if (asked >= 2) return "You have used both calls. Write with the facts you have.";
              asked++;
              const got = (await o.askResearcher!(i.questions)).filter((c) => c.verdict === "supported" || c.verdict === "partially_supported");
              for (const c of got) {
                o.facts.claims.push(c);
                claims.push(c);
                known.add(c.id);
              }
              factText = `${factText} ${norm(got.map((c) => c.text).join(" ")).replace(/,/g, "")}`;
              return got.length ? `VERIFIED and added to the fact sheet:\n${got.map((c) => `[${c.id}] (${c.verdict}) ${c.text}`).join("\n")}\nAnything you asked for that is not listed could not be verified: do not use it.` : "Nothing could be verified. Do not use those facts.";
            }) as AgentTool["run"],
          } satisfies AgentTool,
        ]
      : []),
    {
      name: "read_openings_endings",
      description: "Read how real films of the channel OPEN and CLOSE: the first and last ~20 seconds of narration of several real films (any length of film works from these). Study them before you write your opening and your ending: the channel opens on a moment (a person, a place, a time, doing something) and closes on a consequence, not a restatement.",
      schema: z.object({ n: z.number().min(2).max(10).optional() }),
      run: (async (i: { n?: number }) => {
        const w = Math.round(lp.openingS * 3.3);
        const take = (ls: string[], fromEnd: boolean) => {
          const out: string[] = [];
          let k = 0;
          for (const l of fromEnd ? [...ls].reverse() : ls) {
            if (k >= w) break;
            fromEnd ? out.unshift(l) : out.push(l);
            k += l.split(/\s+/).length;
          }
          return out.join(" ");
        };
        return studyFilms.slice(0, i.n ?? 6).map((f) => `"${f.title}"\n  OPENS: ${take(f.lines, false)}\n  CLOSES: ${take(f.lines, true)}`).join("\n\n");
      }) as AgentTool["run"],
    } satisfies AgentTool,
    {
      name: "list_reference_films",
      description: "List the channel's real films you can read: id, title, length, what kind of story each is, and its own section sequence. Call this first to choose what to study.",
      schema: z.object({}),
      run: async () => studyFilms.map((f) => `${f.id} | ${f.title} | ${f.minutes} min, ${f.lines.length} lines | ${f.note}\n   sections: ${f.sections.join(" → ")}`).join("\n"),
    },
    {
      name: "read_reference_film",
      description: "Read the real narration of one film: its opening, its ending, or any stretch by line numbers. Read whole stretches to hear how the narrator moves from event to meaning to the viewer. Up to 120 lines per call.",
      schema: z.object({ id: z.string(), part: z.enum(["opening", "ending", "lines"]), from: z.number().describe("first line (for part=lines), else 0"), to: z.number().describe("last line (for part=lines), else 0") }),
      run: (async (i: { id: string; part: "opening" | "ending" | "lines"; from: number; to: number }) => {
        const f = film(i.id);
        if (!f) throw new Error(`no film ${i.id}; call list_reference_films`);
        filmsRead.add(f.id);
        const [a, b] = i.part === "opening" ? [0, 45] : i.part === "ending" ? [Math.max(0, f.lines.length - 30), f.lines.length] : [Math.max(0, Math.floor(i.from)), Math.min(f.lines.length, Math.max(Math.floor(i.from) + 1, Math.floor(i.to) + 1), Math.floor(i.from) + 120)];
        return `${f.title} — lines ${a}–${b - 1} of ${f.lines.length}\n${f.lines.slice(a, b).map((l, k) => `[${a + k}] ${l}`).join("\n")}`;
      }) as AgentTool["run"],
    },
    {
      name: "search_reference",
      description: "Find lines in the channel's real films that contain a word or phrase (e.g. \"which meant\", \"you've probably\", \"bankrupt\"), each with the line before and after. Use it to see how the narrator handles a kind of moment.",
      schema: z.object({ phrase: z.string() }),
      run: (async (i: { phrase: string }) => {
        const q = i.phrase.toLowerCase().trim();
        if (q.length < 3) throw new Error("phrase too short");
        const hits: string[] = [];
        for (const f of studyFilms) {
          for (let k = 0; k < f.lines.length && hits.length < 14; k++) if (f.lines[k]!.toLowerCase().includes(q)) hits.push(`${f.id} [${k}] … ${f.lines[k - 1] ?? ""} ▸ ${f.lines[k]} ▸ ${f.lines[k + 1] ?? ""}`);
          if (hits.length >= 14) break;
        }
        return hits.length ? hits.join("\n") : `no line contains "${i.phrase}"`;
      }) as AgentTool["run"],
    },
    {
      name: "measure_draft",
      description: "Measure your draft the way the channel's real films were measured: what each sentence does against the channel's range, length at the narrator's pace, prose rhythm, figures, and that every figure and quotation is in the fact sheet. Returns the numbers and what is not yet right, with the lines concerned.",
      schema: Draft,
      run: (async (i: z.infer<typeof Draft>) => (await evaluate(i.segments)).report) as AgentTool["run"],
    },
    {
      name: "submit_script",
      description: "Submit the finished script with the plan you built it on. It is measured once more; if it passes it is accepted and your work is done, otherwise you get back what is still wrong.",
      schema: Submission,
      run: (async (i: z.infer<typeof Submission>) => {
        lastSubmission = i;
        // the writer studies how the channel writes before its script is accepted (it read none in three test runs)
        if (!firstDraft && filmsRead.size < Math.min(2, studyFilms.length)) return `NOT YET — read at least two of the channel's narrations first (read_reference_film; you have read ${filmsRead.size}). See how it opens, carries one thread from sentence to sentence and repeats the way speech does, then rewrite in that voice.`;
        const r = await evaluate(i.segments);
        if (r.ok) accepted = i;
        if (r.ok && o.memoryDir) {
          const text = i.segments.map((sg) => sg.text).join(" ");
          await mkdir(o.memoryDir, { recursive: true });
          await appendFile(path.join(o.memoryDir, `${o.pack.channelId}.openings.jsonl`), JSON.stringify({ topic: o.facts.topic, first: (text.split(/(?<=[.?!])\s+/)[0] ?? "").slice(0, 200), shape: openingShape(text), at: new Date().toISOString() }) + "\n");
        }
        return r.ok ? `ACCEPTED.\n${r.report}\nIf this script taught you something worth knowing next time, call note_lesson once; then stop.` : r.report;
      }) as AgentTool["run"],
    },
    {
      name: "check_passage",
      description: "Instant and free (no model call): the script referee alone on a passage you are writing — a paragraph, a chapter or the whole script — with what pulls it away from the channel and which words to cut. Use it on every paragraph as you go; use measure_draft only on a full draft.",
      schema: z.object({ text: z.string().min(20) }),
      run: (async (i: { text: string }) => {
        const v = dataDir ? scriptReferee(path.dirname(dataDir), i.text, o.pack.channelId) : null;
        const off = offendersReport(i.text);
        const meter = `${vband ? `\n${voiceReport(voiceStats(i.text), vband)}` : ""}${off ? `\n${off}` : ""}`;
        return v ? `${scriptRefereeReport(v)}${meter}` : `the script referee is not available here${meter}`;
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one short lesson for your future self (what worked, what the measurement kept catching, a mistake to avoid). It is shown to you before your next script.",
      schema: z.object({ lesson: z.string().max(400) }),
      run: (async (i: { lesson: string }) => {
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.pack.channelId}.md`), `- LESSON (${o.facts.topic.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        noteSaved = true;
        return "saved";
      }) as AgentTool["run"],
    },
  ];

  const dossier = st
    ? ["CHARACTERS:", ...st.characters.map((c) => `- ${c.name} (${c.role}) — wants: ${c.want}; flaw: ${c.flaw}; cost: ${c.cost} [${c.claimIds.join(",")}]`), "SCENES:", ...st.scenes.map((c) => `- ${c.kind} — ${c.when}, ${c.where}; ${c.who.join(", ")}: ${c.what} (stakes: ${c.stakes}) [${c.claimIds.join(",")}]`), "CONTRASTS:", ...st.contrasts.map((c) => `- ${c.text} [${c.claimIds.join(",")}]`), "QUOTES (verbatim):", ...st.quotes.map((q) => `- "${q.text}" — ${q.speaker}, ${q.context} [${q.claimId}]`)].join("\n")
    : "";
  const earlier = (o.recent ?? []).map((r) => `- ${r.beats?.length ? r.beats.map((b) => b.slice(0, 80)).join(" → ") : `${r.hook} opening, "${r.spine}", ${r.ending} ending`}`).join("\n");
  const system = [
    cached(o.pack.text),
    plain(
      `${skill}\n\n## This channel, measured on ${band.films} of its real films\n- explains what things mean in ${pc(band.kinds.explain.p10)}–${pc(band.kinds.explain.p90)} of its lines (typically ${pc(band.kinds.explain.p50)})\n- talks to the viewer or as the narrator in ${pc(band.viewer.p10)}–${pc(band.viewer.p90)} (typically ${pc(band.viewer.p50)})\n- quotes in at most ${pc(band.kinds.quote.p90)} of its lines; bare facts in at most ${pc(band.kinds.fact.p90)}\n- about one sentence in six carries a figure; the median sentence runs about 19 words; few sentences are six words or shorter\n\n## This film\n${short ? `A ${o.durationS}-second ${o.aspect === "9:16" ? "vertical short" : "16:9 mini-documentary"}: a hook and thesis early, one scene carried in detail, a turn, and an ending that lands. No chapter titles, no call to subscribe.` : `${structure ? structureBrief(structure, o.durationS, lp.chapters) : `A ${Math.round(o.durationS / 60)}-minute 16:9 documentary in ${lp.chapters} titled chapters of about three minutes.`}\nNo call to subscribe.`}\nLength: ${targetWords} words (±5%) — the narrator speaks at ${o.narrationWpm} words a minute.\nSegment roles: ${ROLES.join(", ")}. Each segment lists the claim ids it relies on and one line on what should be on screen.${notes.trim() ? `\n\n## Your own notes from earlier scripts\n${notes}` : ""}${owner.trim() ? `\n\n## The owner's notes on your work (take these seriously)\n${tail(owner, 30)}` : ""}`,
    ),
  ];
  const user = `Write the narration for this film.\n\nTOPIC: ${o.facts.topic}\nANGLE: ${o.facts.angle}\nSUMMARY: ${o.facts.summary}\n\n${dossier}\n\nFACT SHEET (the only facts you may use):\n${claims.map((c) => `[${c.id}] (${c.verdict}) ${c.text}`).join("\n")}${earlier ? `\n\nEARLIER FILMS OF OURS WERE BUILT LIKE THIS — build this one differently:\n${earlier}` : ""}${o.recentOpenings?.length ? `\n\nEARLIER FILMS OF OURS OPENED ON — open differently:\n${o.recentOpenings.map((x) => `- "${x}…"`).join("\n")}` : ""}${o.brief ? `\n\nTHE SHOWRUNNER SENT THE LAST VERSION OF THIS SCRIPT BACK. Keep what worked; change what it asks, for the reasons it gives:\n${o.brief}` : ""}\n\nStart by studying the channel's real films with your tools.`;

  // ---- long films: a first draft written in parallel (an outline to the measured structure, then every part at once,
  // each checked by the script referee on this machine and the weak ones rewritten once, at once). The writer then
  // starts from this draft and only fixes what fails.
  const factsBlock = user.replace(/\n\nStart by studying the channel's real films with your tools\.$/, "");
  let draftAtBar = false;
  const parallelDraft = async (): Promise<z.infer<typeof Segment>[] | null> => {
    if (short || !structure || !dataDir) return null;
    const t0 = Date.now(), root = path.dirname(dataDir);
    const introWords = Math.round((structure.introS.p50 * o.narrationWpm) / 60);
    const chapterWords = Math.round((targetWords - introWords) / Math.max(1, lp.chapters));
    const want = lp.chapters + 1;
    // the voice (2026-11-27): a long stretch of real narration to continue in — models take texture from long examples, not
    // from rules (two 260-word excerpts and the voice meter's targets left parts at 0.2–0.6). Each variant gets a
    // different ~1,500-word stretch from three films the writer may study (never the held-back ones).
    const stretch = (f: (typeof studyFilms)[number], at: number, n: number) => { const lines = f.lines.map(String); let txt = ""; for (let k = Math.floor(lines.length * at); k < lines.length && txt.split(/\s+/).length < n; k++) txt += `${lines[k]} `; return `"${f.title}":\n${txt.trim()}`; };
    const seed = createHash("sha1").update(o.facts.topic).digest();
    const voiceFor = (v: number) => {
      if (!studyFilms.length) return "";
      const films3 = [0, 1, 2].map((i) => studyFilms[(seed[i]! + v * 5 + i * 11) % studyFilms.length]!);
      return `\n\nHOW THE CHANNEL SOUNDS — about 1,500 words of its real narration from three films. Write your part in exactly this voice: its sentence lengths, its asides, how one sentence picks up the last, how rarely it asks a question. Never reuse a sentence.\n\n${films3.map((f, i) => stretch(f, 0.2 + 0.25 * i + 0.05 * v, 500)).join("\n\n")}`;
    };
    const askOutline = (fix?: string) => structured({ stage: "script.outline", model: ROLE_MODEL.writer, system, user: `${factsBlock}\n\nPLAN THE FILM FIRST, to the structure above: exactly ${want} parts — an intro (title "Intro": the hook and the thesis) and ${lp.chapters} titled chapters. For each part: its title, its purpose, its beats in order, the roles of its segments (the twist in a middle chapter; the last chapter ends the film the channel's way) and the claim ids it will use. Open on this story's strongest first moment, not the way earlier films of ours opened.${fix ? `\n\n${fix}` : ""}`, schema: Outline, effort: "medium", maxTokens: 6000 }).catch(() => null);
    let ol = await askOutline();
    if (ol && ol.data.parts.length !== want) ol = (await askOutline(`Your last plan had ${ol.data.parts.length} parts. It must have exactly ${want}: "Intro" and ${lp.chapters} chapters.`)) ?? ol;
    if (!ol || ol.data.parts.length < 2) return null;
    const parts = ol.data.parts.slice(0, want);
    const plan = parts.map((c, i) => `${i}. ${c.title} — ${c.purpose}: ${c.beats.join(" → ")}`).join("\n");
    const wordsFor = (k: number) => (k === 0 ? introWords : chapterWords);
    const writePart = (k: number, v: number) => structured({ stage: "script.part", model: ROLE_MODEL.writer, system, user: `${factsBlock}${voiceFor(v)}\n\nTHE FILM'S PLAN (title: ${ol!.data.title}):\n${plan}\n\nWrite part ${k} only — "${parts[k]!.title}": ${wordsFor(k)} words (no fewer than ${Math.round(wordsFor(k) * 0.9)}); beats ${parts[k]!.beats.join(" → ")}; segment roles ${parts[k]!.roles.join(", ")}; claim ids ${parts[k]!.claimIds.join(", ") || "as needed"}. It follows "${parts[k - 1]?.title ?? "nothing — it opens the film"}" and leads into "${parts[k + 1]?.title ?? "nothing — it ends the film"}". Every segment's chapter field is "${parts[k]!.title}". Tell it forwards, in the moment; a figure then the narrator's verdict; one thread carried from sentence to sentence.`, schema: Draft, effort: "medium", maxTokens: 8000 }).then((x) => x.data.segments).catch(() => null);
    const judge = (segs: z.infer<typeof Segment>[] | null) => (segs ? scriptReferee(root, segs.map((x) => x.text).join(" "), o.pack.channelId) : null);
    const wc = (segs: z.infer<typeof Segment>[] | null) => (segs ? segs.reduce((n, x) => n + countWords(x.text), 0) : 0);
    // selection, not instruction: the same request gives parts from 0.0 to 0.9, so every part is written five times at
    // once and the best is kept, judged on both measures at the WHOLE film's bars (human 0.90, channel 0.75)
    const VARIANTS = Math.max(1, Number(process.env.OPUMIA_WRITER_VARIANTS) || 5), H = 0.9, C = 0.75;
    const merit = (v: ReturnType<typeof judge>, segs: z.infer<typeof Segment>[] | null, k: number) => (!v || !segs ? -1 : Math.min((v.human ?? v.score) / H, (v.channel ?? 1) / C) - (wc(segs) < wordsFor(k) * 0.85 ? 0.3 : 0));
    const all = await Promise.all(parts.map((_, k) => Promise.all(Array.from({ length: VARIANTS }, (_, v) => writePart(k, v)))));
    const drafts: Array<z.infer<typeof Segment>[] | null> = [], verdicts: Array<ReturnType<typeof judge>> = [], spread: string[] = [];
    all.forEach((vs, k) => {
      const scored = vs.map((segs) => { const v = judge(segs); return { segs, v, m: merit(v, segs, k) }; }).sort((a, b) => b.m - a.m);
      drafts.push(scored[0]?.segs ?? null); verdicts.push(scored[0]?.v ?? null);
      spread.push(`${scored.map((x) => (x.v?.human ?? 0).toFixed(2)).join(",")}`);
    });
    const segs = drafts.flatMap((d) => d ?? []);
    draftAtBar = verdicts.every((v, k) => merit(v, drafts[k] ?? null, k) >= 1);
    log(`  writer: first draft, ${VARIANTS} versions of every part at once — ${parts.length} parts, ${wc(segs)} of ${targetWords} words; human-ness by part (best first) ${spread.map((x) => `[${x}]`).join(" ")}; kept ${verdicts.map((v) => `${v?.human ?? "?"}/${v?.channel ?? "?"}`).join(" · ")}, ${Math.round((Date.now() - t0) / 1000)} s${draftAtBar ? " — every part at the bar" : ""}`);
    return segs.length ? segs : null;
  };
  const firstDraft = await parallelDraft();
  const userStart = firstDraft ? `${factsBlock}\n\nA FIRST DRAFT HAS ALREADY BEEN WRITTEN, chapter by chapter in parallel, each part checked by the script referee (below, as segments). Do not start over and do not rewrite what passes. Measure this draft once, fix only what the measurement names — stretch by stretch, using check_passage as you go — and submit. You have only a few turns.\n\nFIRST DRAFT:\n${JSON.stringify(firstDraft)}` : user;

  log(`  writer: one author with tools — ${studyFilms.length} real films to study${heldBack.size ? ` (${heldBack.size} held back for the script referee)` : ""}, ${targetWords} words to write at ${o.narrationWpm} wpm (${ROLE_MODEL.writer})…`);
  const run = await agentLoop({ stage: "script.writer", finish: { message: "Your budget for this stage is used up. Call submit_script NOW with the work you have — change nothing else first. If it is refused, fix only what the refusal names and call submit_script again." }, model: ROLE_MODEL.writer, system, user: userStart, tools, effort: "high", maxTurns: firstDraft ? 10 : Math.round(22 * Math.sqrt(lengthFactor)), maxSeconds: firstDraft ? 300 : Math.round(360 * lengthFactor), ...(firstDraft ? { maxUsd: ROLE_MODEL.writer === "claude-opus-5-5" ? 1.2 : 0.6 } : {}), done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "You have not had a script accepted yet. Measure your current draft and submit it when it passes.", log });
  const final = (accepted ?? lastSubmission) as z.infer<typeof Submission> | null;
  const lastEval = last as { segments: z.infer<typeof Segment>[]; ok: boolean; issues: Array<{ kind: string; detail: string }>; profile: StoryProfile } | null;
  if (!final && !lastEval) throw new Error("writer: no draft was produced");
  const pass = accepted !== null;
  const best = bestDraft as { segments: z.infer<typeof Segment>[]; score: number; issues: Array<{ kind: string; detail: string }> } | null;
  const segs = !pass && best ? best.segments : (final?.segments ?? lastEval!.segments);
  if (!pass && best) log(`  writer: no script reached the referee's bar — the best clean draft (${best.score}) is kept`);
  const report: StoryReport = { pass, rounds, remaining: pass ? [] : ((best ? best.issues : lastEval?.issues) ?? [{ kind: "not_submitted", detail: "the writer never submitted a script" }]), agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4, filmsRead: [...filmsRead] } };
  o.onStory?.(report);
  log(`  writer: ${pass ? "script accepted" : "NO ACCEPTED SCRIPT"} after ${run.turns} turn(s) — read ${filmsRead.size} real film(s), measured ${run.calls.measure_draft ?? 0}×, submitted ${run.calls.submit_script ?? 0}×, $${run.usd.toFixed(2)}${refereeSeen.length ? `, script referee ${refereeSeen.at(-1)} (best ${Math.max(...refereeSeen)})` : ""}${pass ? "" : ` — still: ${report.remaining.map((x) => x.kind).join(", ")}`}`);
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    const p = rounds.at(-1)?.profile;
    await appendFile(path.join(o.memoryDir, `${o.pack.channelId}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.facts.topic.slice(0, 60)}": ${pass ? "accepted" : "not accepted"} after ${rounds.length} measurement(s); caught along the way: ${[...new Set(rounds.flatMap((r) => r.issues))].join(", ") || "nothing"}${p ? `; final explains ${pc(p.share.explain)}, viewer ${pc(p.viewerShare)}, quotes ${pc(p.share.quote)}, facts ${pc(p.share.fact)}` : ""}\n`);
  }

  const segments = segs.map((s, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, role: s.role, ...(!short && s.chapter.trim() ? { chapter: s.chapter.trim() } : {}), text: earPunctuation(normalizeFigures(s.text.trim())), claimIds: s.claimIds.filter((c) => known.has(c)), visualIdea: s.visualIdea }));
  let lastChapter = segments.find((s) => s.chapter)?.chapter;
  for (const s of segments) if (!short) s.chapter = (s.chapter ??= lastChapter), (lastChapter = s.chapter);
  const chapters = short ? undefined : [...new Set(segments.map((s) => s.chapter).filter((c): c is string => Boolean(c)))];
  const plan = final?.plan;
  return ScriptDraft.parse({
    schemaVersion: 1,
    id: `sc_${createHash("sha1").update(o.facts.id + o.pack.channelId + o.aspect + o.durationS).digest("hex").slice(0, 10)}`,
    factSheetId: o.facts.id,
    styleProfileId: o.pack.channelId,
    aspect: o.aspect,
    targetDurationS: o.durationS,
    targetWords,
    title: final?.title ?? o.facts.topic,
    hookFormula: plan ? `${plan.hook}: ${plan.opening.slice(0, 160)}` : "",
    segments,
    wordCount: segments.reduce((n, s) => n + countWords(s.text), 0),
    ...(chapters ? { chapters } : {}),
    ...(plan ? { blueprint: { hook: plan.hook, spine: plan.spine, ending: plan.ending, why: "built by the writer from this story's own facts", opening: plan.opening, closing: plan.closing, beats: plan.beats } } : {}),
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Build list 5, item 23: the writer rewords ONE sentence so a narrator can say it naturally (the voice director's
 * retakes could not fix its delivery): same facts, about the same length, no new figures or names. Returns null when
 * it cannot do better than the sentence as it is.
 */
export async function rewordForSpeech(o: { text: string; why: string; context: string; facts: string[] }): Promise<string | null> {
  const Out = z.object({ sentence: z.string(), changed: z.boolean() });
  const r = await structured({ stage: "script.reword", model: ROLE_MODEL.writer, system: [plain("You are the writer of a documentary narration. Reword ONE sentence so a narrator says it naturally, as a person telling a story: keep every fact, figure and name exactly, keep about the same length, use commas and full stops only (no dashes, brackets or semicolons). Never add a fact. If you cannot improve it, return it unchanged with changed=false.")], user: `WHY IT FAILS WHEN SPOKEN: ${o.why}\n\nAROUND IT: ${o.context}\n\nSENTENCE: ${o.text}\n\nFACTS (the only ones you may use):\n${o.facts.slice(0, 40).join("\n")}`, schema: Out, effort: "low", maxTokens: 800 });
  const s = r.data.sentence.trim();
  if (!r.data.changed || !s || s === o.text.trim()) return null;
  // figures must survive unchanged
  const nums = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "")).sort().join("|");
  return nums(s) === nums(o.text) ? earPunctuation(s) : null;
}
