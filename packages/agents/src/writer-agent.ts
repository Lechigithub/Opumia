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
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ScriptDraft, usableClaims, type Aspect, type FactClaim, type FactSheet } from "@opumia/contracts";
import * as z from "zod/v4";
import { agentLoop, cached, MODELS, plain, type AgentTool } from "./llm.js";
import { critiqueNarrative, sentencesOf } from "./narrative.js";
import { earPunctuation, normalizeFigures } from "./numeric-facts.js";
import { labelLines, storyIssues, type ReferenceFilm, type StoryBand, type StoryProfile } from "./story-measure.js";
import type { StylePack } from "./style-pack.js";

const ROLES = ["cold_open", "hook", "thesis", "context", "rise", "twist", "climax", "fall", "resolution", "cta", "chapter", "rehook"] as const;
const Segment = z.object({ role: z.enum(ROLES), chapter: z.string().describe("chapter title (long-form); empty for shorts"), text: z.string(), claimIds: z.array(z.string()).describe("fact-sheet claim ids this segment relies on"), visualIdea: z.string().describe("one line: what should be on screen (real footage, a staged scene, a chart, a document) — never AI imagery") });
const Draft = z.object({ segments: z.array(Segment).min(1) });
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
  log?: (s: string) => void;
}

const countWords = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const norm = (t: string) => t.toLowerCase().replace(/[“”"'’‘]/g, "").replace(/\s+/g, " ").trim();
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

export async function writeScriptAgent(o: WriterOptions): Promise<ScriptDraft> {
  const log = o.log ?? (() => {});
  const short = o.durationS <= 90;
  const targetWords = Math.round((o.durationS * o.narrationWpm) / 60);
  const claims = usableClaims(o.facts);
  const known = new Set(claims.map((c) => c.id));
  const st = o.facts.story;
  let factText = norm([...claims.map((c) => c.text), ...(st ? [...st.characters.map((c) => `${c.name} ${c.role} ${c.want} ${c.flaw} ${c.cost}`), ...st.scenes.map((c) => `${c.when} ${c.where} ${c.what} ${c.stakes}`), ...st.contrasts.map((c) => c.text), ...st.quotes.map((q) => q.text)] : [])].join(" ")).replace(/,/g, "");
  const band = o.storyBand;
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const skill = await readFile(new URL("../skills/writer.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readFile(path.join(o.memoryDir, `${o.pack.channelId}.md`), "utf8").catch(() => "") : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";

  // ---- one evaluation, used by measure_draft and submit_script: the same checks, nothing rewritten.
  const rounds: StoryReport["rounds"] = [];
  let last: { segments: z.infer<typeof Segment>[]; ok: boolean; issues: Array<{ kind: string; detail: string }>; profile: StoryProfile } | null = null;
  const evaluate = async (segments: z.infer<typeof Segment>[]) => {
    const lines = segments.flatMap((sg) => sentencesOf(sg.text));
    const story = storyIssues(lines, await labelLines(lines), band);
    const issues: Array<{ kind: string; detail: string }> = story.issues.map((x) => ({ kind: x.kind, detail: `${x.detail}${x.lines.length ? ` Lines: ${x.lines.slice(0, 8).map((k) => `"${lines[k]}"`).join(" | ")}` : ""}` }));
    const words = segments.reduce((n, sg) => n + countWords(sg.text), 0);
    if (Math.abs(words - targetWords) / targetWords > 0.05) issues.push({ kind: "length", detail: `${words} words; this film needs ${targetWords} (±5%) — at ${o.narrationWpm} words a minute that is ${Math.round((words / o.narrationWpm) * 60)} s against ${o.durationS} s.` });
    for (const i of critiqueNarrative(segments, o.narrationWpm, { short, maxGapS: 50 })) issues.push({ kind: i.kind, detail: `${i.where}: ${i.detail}` });
    const withDigit = lines.filter((t) => /\d/.test(t));
    if (withDigit.length / Math.max(1, lines.length) > 0.2) issues.push({ kind: "too_many_figures", detail: `${withDigit.length} of ${lines.length} sentences carry a figure (the channel: about one in six). Keep the figures the story turns on; tell the rest without numbers or leave those facts out — never replace a number with a vague phrase.` });
    const text = segments.map((sg) => sg.text).join(" ");
    if (/[—–;()]|\s-\s/.test(text)) issues.push({ kind: "unspeakable_punctuation", detail: "the script contains a dash used as a pause, a bracket or a semicolon — rewrite those sentences with commas and full stops." });
    const figures = [...new Set((normalizeFigures(text).match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, "")))].filter((n) => !factText.includes(n));
    if (figures.length) issues.push({ kind: "unsupported_figure", detail: `these figures are not in the fact sheet: ${figures.slice(0, 8).join(", ")}. Use only figures from the fact sheet, exactly as given.` });
    const quotes = [...text.matchAll(/["“]([^"”]{18,})["”]/g)].map((m) => m[1]!).filter((q) => !factText.includes(norm(q).replace(/,/g, "").replace(/[.!?]$/, "")));
    if (quotes.length) issues.push({ kind: "unsupported_quote", detail: `these quotations are not in the fact sheet word for word: ${quotes.slice(0, 4).map((q) => `"${q}"`).join(" | ")}. Quote exactly or tell it in your own words without quotation marks.` });
    const badIds = [...new Set(segments.flatMap((sg) => sg.claimIds).filter((c) => !known.has(c)))];
    if (badIds.length) issues.push({ kind: "unknown_claim", detail: `claim ids not in the fact sheet: ${badIds.join(", ")}` });
    rounds.push({ issues: issues.map((x) => x.kind), profile: story.profile });
    last = { segments, ok: issues.length === 0, issues, profile: story.profile };
    const p = story.profile;
    const header = `MEASURED (${words} words, ${lines.length} sentences) against ${band.films} real films of the channel:\n- explains what things mean: ${pc(p.share.explain)} of lines (channel ${pc(band.kinds.explain.p10)}–${pc(band.kinds.explain.p90)})\n- talks to the viewer or as the narrator: ${pc(p.viewerShare)} (channel ${pc(band.viewer.p10)}–${pc(band.viewer.p90)})\n- quotations: ${pc(p.share.quote)} (channel up to ${pc(band.kinds.quote.p90)})\n- bare facts: ${pc(p.share.fact)} (channel up to ${pc(band.kinds.fact.p90)})\n- scenes: ${pc(p.share.scene)}, motives: ${pc(p.share.motive)}, questions: ${pc(p.share.question)}, teases: ${pc(p.share.tease)}, general sayings: ${pc(p.share.maxim)}\n- sentences with a figure: ${pc(withDigit.length / Math.max(1, lines.length))}`;
    return { ok: issues.length === 0, report: issues.length ? `${header}\n\nNOT YET — ${issues.length} thing(s) to fix:\n${issues.map((x, i) => `${i + 1}. [${x.kind}] ${x.detail}`).join("\n")}` : `${header}\n\nPASSES every check.` };
  };

  // ---- tools
  const filmsRead = new Set<string>();
  const film = (id: string) => o.films.find((f) => f.id === id);
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
      name: "list_reference_films",
      description: "List the channel's real films you can read: id, title, length, what kind of story each is, and its own section sequence. Call this first to choose what to study.",
      schema: z.object({}),
      run: async () => o.films.map((f) => `${f.id} | ${f.title} | ${f.minutes} min, ${f.lines.length} lines | ${f.note}\n   sections: ${f.sections.join(" → ")}`).join("\n"),
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
        for (const f of o.films) {
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
        const r = await evaluate(i.segments);
        if (r.ok) accepted = i;
        return r.ok ? `ACCEPTED.\n${r.report}\nIf this script taught you something worth knowing next time, call note_lesson once; then stop.` : r.report;
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
      `${skill}\n\n## This channel, measured on ${band.films} of its real films\n- explains what things mean in ${pc(band.kinds.explain.p10)}–${pc(band.kinds.explain.p90)} of its lines (typically ${pc(band.kinds.explain.p50)})\n- talks to the viewer or as the narrator in ${pc(band.viewer.p10)}–${pc(band.viewer.p90)} (typically ${pc(band.viewer.p50)})\n- quotes in at most ${pc(band.kinds.quote.p90)} of its lines; bare facts in at most ${pc(band.kinds.fact.p90)}\n- about one sentence in six carries a figure; the median sentence runs about 19 words; few sentences are six words or shorter\n\n## This film\n${short ? `A ${o.durationS}-second ${o.aspect === "9:16" ? "vertical short" : "16:9 mini-documentary"}: a hook and thesis early, one scene carried in detail, a turn, and an ending that lands. No chapter titles, no call to subscribe.` : `A ${Math.round(o.durationS / 60)}-minute 16:9 documentary in chapters of 90–150 seconds, each with a title; a re-hook that is a real revelation every half minute or so. No call to subscribe.`}\nLength: ${targetWords} words (±5%) — the narrator speaks at ${o.narrationWpm} words a minute.\nSegment roles: ${ROLES.join(", ")}. Each segment lists the claim ids it relies on and one line on what should be on screen.${notes.trim() ? `\n\n## Your own notes from earlier scripts\n${tail(notes, 30)}` : ""}${owner.trim() ? `\n\n## The owner's notes on your work (take these seriously)\n${tail(owner, 30)}` : ""}`,
    ),
  ];
  const user = `Write the narration for this film.\n\nTOPIC: ${o.facts.topic}\nANGLE: ${o.facts.angle}\nSUMMARY: ${o.facts.summary}\n\n${dossier}\n\nFACT SHEET (the only facts you may use):\n${claims.map((c) => `[${c.id}] (${c.verdict}) ${c.text}`).join("\n")}${earlier ? `\n\nEARLIER FILMS OF OURS WERE BUILT LIKE THIS — build this one differently:\n${earlier}` : ""}${o.recentOpenings?.length ? `\n\nEARLIER FILMS OF OURS OPENED ON — open differently:\n${o.recentOpenings.map((x) => `- "${x}…"`).join("\n")}` : ""}\n\nStart by studying the channel's real films with your tools.`;

  log(`  writer: one author with tools — ${o.films.length} real films to study, ${targetWords} words to write at ${o.narrationWpm} wpm (${MODELS.sonnet})…`);
  const run = await agentLoop({ stage: "script.writer", model: MODELS.sonnet, system, user, tools, effort: "high", maxTurns: 26, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "You have not had a script accepted yet. Measure your current draft and submit it when it passes.", log });
  const final = (accepted ?? lastSubmission) as z.infer<typeof Submission> | null;
  const lastEval = last as { segments: z.infer<typeof Segment>[]; ok: boolean; issues: Array<{ kind: string; detail: string }>; profile: StoryProfile } | null;
  if (!final && !lastEval) throw new Error("writer: no draft was produced");
  const segs = final?.segments ?? lastEval!.segments;
  const pass = accepted !== null;
  const report: StoryReport = { pass, rounds, remaining: pass ? [] : (lastEval?.issues ?? [{ kind: "not_submitted", detail: "the writer never submitted a script" }]), agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4, filmsRead: [...filmsRead] } };
  o.onStory?.(report);
  log(`  writer: ${pass ? "script accepted" : "NO ACCEPTED SCRIPT"} after ${run.turns} turn(s) — read ${filmsRead.size} real film(s), measured ${run.calls.measure_draft ?? 0}×, submitted ${run.calls.submit_script ?? 0}×, $${run.usd.toFixed(2)}${pass ? "" : ` — still: ${report.remaining.map((x) => x.kind).join(", ")}`}`);
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
