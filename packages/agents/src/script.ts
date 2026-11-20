import { createHash } from "node:crypto";
import { ScriptDraft, usableClaims, type Aspect, type FactSheet } from "@opumia/contracts";
import * as z from "zod/v4";
import { cached, MODELS, plain, structured } from "./llm.js";
import type { StylePack } from "./style-pack.js";
import { critiqueNarrative } from "./narrative.js";
import { normalizeFigures } from "./numeric-facts.js";

const ROLES = ["cold_open", "hook", "thesis", "context", "rise", "twist", "climax", "fall", "resolution", "cta", "chapter", "rehook"] as const;

const DraftSchema = z.object({
  title: z.string(),
  hookFormula: z.string(),
  segments: z.array(
    z.object({
      role: z.enum(ROLES),
      chapter: z.string().describe("chapter title this segment belongs to (long-form); empty for shorts"),
      text: z.string(),
      claimIds: z.array(z.string()),
      visualIdea: z.string(),
    }),
  ),
});

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;



/** Cold-open archetypes measured on the reference corpus (story labels), in the writer's own words. */
export const HOOK_ARCHETYPES = {
  irony: "the gap between appearance and reality — a humble origin against the empire, a hero brand with a hidden cost",
  reversal: "a fortune flips: the underdog humiliated, then the giant falls (or the reverse), with 'fast forward' to the outcome",
  mystery: "everyone knows the name but not the truth — what it really is, who really runs it, where the money comes from",
  stakes: "everything hinged on one moment, one person or one sum — what was on the table and how close it came",
  flash_forward: "open inside the climactic scene, then rewind to how it came to this",
  claim: "a bold, provocative thesis stated flatly up front, then the evidence",
  question: "a direct question to the viewer that the film promises to answer",
} as const;
export const ENDING_ARCHETYPES = {
  callback: "return to the opening image or line, now with new meaning",
  lesson: "close on the principle the story teaches, earned by the events",
  open_question: "leave the viewer with the unresolved question the story raises",
  where_now: "where the people and the company are today, and what remains",
  warning: "a cautionary note: it could happen again, and to whom",
} as const;
type HookKey = keyof typeof HOOK_ARCHETYPES;
type EndKey = keyof typeof ENDING_ARCHETYPES;
const BlueprintSchema = z.object({
  hook: z.enum(Object.keys(HOOK_ARCHETYPES) as [HookKey, ...HookKey[]]),
  spine: z.string().describe("story family name from the style pack section 3 (or a short act sequence)"),
  ending: z.enum(Object.keys(ENDING_ARCHETYPES) as [EndKey, ...EndKey[]]),
  why: z.string(),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

export interface ScriptOptions {
  pack: StylePack;
  facts: FactSheet;
  aspect: Aspect;
  durationS: number;
  /** Words per minute the TTS voice will actually speak at. */
  narrationWpm: number;
  /** Blueprints this channel used recently (from ProductionMemory) — the chooser must not repeat them. */
  recent?: Array<{ hook: string; ending: string; spine: string }>;
  /** Reuse a chosen blueprint (e.g. on a length re-fit). */
  blueprint?: { hook: string; spine: string; ending: string; why: string };
  log?: (s: string) => void;
}

/** Chapters for a runtime: 90–150 s each in long-form (3–15), none for shorts. */
export const chapterCount = (durationS: number) => (durationS <= 90 ? 0 : Math.max(3, Math.min(15, Math.round(durationS / 120))));

/** Filler re-hook phrases that read as templated; the critic rejects them. */
export const FILLER = /(untouchable\?|not for long|but (that|this) was (just|only) the beginning|little did (they|he|she) know|and that'?s when everything changed|what happened next (would|will)|buckle up|but there was (just )?one problem)/i;

const WRITER_TASK = (o: { short: boolean; words: number; durationS: number; bp: Blueprint }) => `BLUEPRINT FOR THIS FILM (chosen for this story — follow it exactly):
- Cold open: ${o.bp.hook} — ${HOOK_ARCHETYPES[o.bp.hook as HookKey]}
- Act spine: ${o.bp.spine}
- Ending: ${o.bp.ending} — ${ENDING_ARCHETYPES[o.bp.ending as EndKey]}

You are the head writer for the channel described in the style pack above. Write narration only — the words the narrator says. Section 6 of the pack holds the channel's MEASURED narrative devices and real excerpts: write with those devices, in your own words.

THE CHANNEL'S MEASURED PROSE (31 films): median sentence 19 words (p25 13, p75 27); 31% of sentences run 25+ words; only 6% are 6 words or shorter; 16% contain a digit; 13% open on a pivot ("But", "However", "And yet"); a tension turn about every 31 s (p75 56 s); the thesis lands around 36 s; 7 decision beats per film; 4 open loops per film, paid off minutes later.

STORY ENGINE:
1. COLD OPEN (0:00–0:36), IN MEDIA RES, written in the BLUEPRINT's cold-open archetype, built on famous reference points the viewer already knows (rivals, products in their pocket). Never open on a birth, a founding date or an old year. Turn it with one pivot, then a question or one-line reveal, then ONE thesis sentence around 30–36 s.
2. ACT 1 OPENS ON A PERSON. After the thesis, start the story on a character's desire or situation (what someone wanted, what they were up against) — from the CHARACTERS and SCENES in the dossier — not on a date.
3. CONSEQUENCE CHAINS, NOT LISTS. Write flowing, connected narrative prose where every sentence is caused by the one before: "on track → and then → crash → drastic action → tiny vs giant → metaphor". Use connectives ("So", "As a result", "Which meant", "Because", "And then"). Never stack date-led sentences ("In 2008… By 2010… In 2011…").
4. SCENES. Dramatise the dossier SCENES: who was in the room, what was decided, what it cost. Show decision beats (a person chooses and pays for it).
5. NUMBERS HELD BACK. Only about one sentence in five or six carries a figure. Bundle numbers into a single high-impact CONTRAST sentence (use the dossier CONTRAST ANCHORS: us vs a famous rival at the same moment), then cash it out with a short human metaphor ("This was David versus Goliath."). Write the figures you do use exactly as a graphic would show them, digits with units ("$7.2 billion", "49.4%", "€31 billion").
6. OPEN LOOPS. Open 2–4 loops (a question or an ominous line about what is coming) and pay them off later. A re-hook must be a real revelation, consequence or question rooted in the facts — never stock filler such as "Untouchable? Not for long.", "Little did they know", "But that was just the beginning" or "Buckle up".
7. QUOTES. Use the dossier's verbatim QUOTES as insider voice where they fit (attributed, never altered).

FORMAT:
- ${o.short ? `This is a ${o.durationS}-second vertical short with a tight 3-beat arc: (1) in-media-res hook + thesis by ~8 s, (2) one escalating scene with a decision and its cost, (3) the turn and a resolution that loops back to the hook. No chapter titles, no "subscribe" CTA, no sponsor.` : `This is a ${Math.round(o.durationS / 60)}-minute 16:9 long-form documentary in ${chapterCount(o.durationS)} chapters of roughly ${Math.round(o.durationS / chapterCount(o.durationS))} s each, following the channel's story families (setup → rise → obstacle/turn → fall/climax → aftermath), with a twist around the middle and the BLUEPRINT's ending archetype. Every segment's "chapter" field names its chapter (YouTube chapter titles, 2–5 words; the first chapter starts at the cold open). Segments are paragraphs of 2–5 connected sentences. Use role "rehook" only for a genuine loop-opening line. No sponsor read, no "subscribe" CTA.`}
- Length: ${o.words} words total (±5%). Hard limit: the narration must fit ${o.durationS} s.
- Facts: state ONLY facts from the FACT SHEET / dossier and list the claim ids each segment relies on. Hedge anything marked partially_supported ("around", "reportedly"). Never add a number, date, motive or quote that is not in the sheet.
- Write for the ear: varied sentence length around a 17–21 word median; short sentences only where they land a turn. No stage directions, no emojis, no markdown.
- visualIdea: one line describing what should be on screen (archival footage, a staged reenactment of the scene, a chart of X, a map of Y, a headline) — real footage, licensed reenactment stock and designed graphics only, never AI imagery.
- Never copy sentences from the reference excerpts.`;

/** The dossier as prompt text: characters, scenes, contrasts and quotes with their claim ids. */
function dossierText(f: FactSheet): string {
  const st = f.story;
  if (!st) return "";
  return [
    "\nSTORY DOSSIER (verified):",
    "CHARACTERS:",
    ...st.characters.map((c) => `- ${c.name} (${c.role}) — wants: ${c.want}; flaw: ${c.flaw}; cost: ${c.cost} [${c.claimIds.join(",")}]`),
    "SCENES:",
    ...st.scenes.map((c) => `- ${c.id} ${c.kind} — ${c.when}, ${c.where}; ${c.who.join(", ")}: ${c.what} (stakes: ${c.stakes}) [${c.claimIds.join(",")}]`),
    "CONTRAST ANCHORS:",
    ...st.contrasts.map((c) => `- ${c.text} [${c.claimIds.join(",")}]`),
    "QUOTES:",
    ...st.quotes.map((q) => `- "${q.text}" — ${q.speaker}, ${q.context} [${q.claimId}]`),
  ].join("\n");
}

export async function writeScript(o: ScriptOptions): Promise<ScriptDraft> {
  const log = o.log ?? (() => {});
  const short = o.durationS <= 90;
  const targetWords = Math.round((o.durationS * o.narrationWpm) / 60);
  const claims = usableClaims(o.facts);
  const factText = claims.map((c) => `[${c.id}] (${c.verdict}) ${c.text}`).join("\n");
  // Blueprint: pick the strongest cold-open archetype, act spine and ending for THIS story, avoiding the
  // channel's recent films so no two films share an opening or closing cadence.
  let bp = o.blueprint as Blueprint | undefined;
  if (!bp) {
    const avoid = (o.recent ?? []).map((r) => `${r.hook} + ${r.ending} (${r.spine})`).join("; ");
    const res = await structured({
      stage: "script.blueprint",
      model: MODELS.sonnet,
      system: [cached(o.pack.text), plain(`Choose this film's story blueprint from the style pack's BLUEPRINT CATALOG (section 7) and STORY FAMILIES (section 3): the cold-open archetype, the act spine (family) and the ending archetype that fit THIS dossier best — the one the facts can actually carry (a stakes hook needs a real decisive moment; a callback needs an opening image worth returning to). Cold-open options: ${Object.entries(HOOK_ARCHETYPES).map(([k, v]) => `${k} = ${v}`).join("; ")}. Endings: ${Object.entries(ENDING_ARCHETYPES).map(([k, v]) => `${k} = ${v}`).join("; ")}.${avoid ? ` This channel's recent films used: ${avoid}. Do not reuse a cold-open archetype or an act spine that any of them used if another fits, and never the same cold-open + ending pair.` : ""}`)],
      user: `TOPIC: ${o.facts.topic}\nANGLE: ${o.facts.angle}\n${dossierText(o.facts)}`,
      schema: BlueprintSchema,
      effort: "medium",
    });
    bp = res.data;
    const last = (o.recent ?? []).find((r) => r.hook === bp!.hook);
    if (last) {
      const alt = (Object.keys(HOOK_ARCHETYPES) as HookKey[]).find((k) => !(o.recent ?? []).some((r) => r.hook === k)) ?? (Object.keys(HOOK_ARCHETYPES) as HookKey[]).find((k) => k !== last.hook) ?? bp.hook;
      log(`  script: blueprint hook "${bp.hook}" was used by a recent film; switching to "${alt}"`);
      bp = { ...bp, hook: alt };
    }
  }
  log(`  script: blueprint — open ${bp.hook}, spine "${bp.spine}", end ${bp.ending}`);
  const system = [cached(o.pack.text), plain(WRITER_TASK({ short, words: targetWords, durationS: o.durationS, bp }))];
  const user = `TOPIC: ${o.facts.topic}\nANGLE: ${o.facts.angle}\nSUMMARY: ${o.facts.summary}\n${dossierText(o.facts)}\n\nFACT SHEET:\n${factText}`;

  log(`  script: drafting ${targetWords} words (${MODELS.sonnet}, style pack cached)…`);
  let { data, usage } = await structured({ stage: "script.draft", model: MODELS.sonnet, system, user, schema: DraftSchema, effort: "high", maxTokens: 32000 });
  log(`    cache write ${usage.cacheWrite} / read ${usage.cacheRead} tokens`);

  const words = () => data.segments.reduce((n, s) => n + countWords(s.text), 0);
  if (Math.abs(words() - targetWords) / targetWords > 0.08) {
    log(`  script: ${words()} words vs target ${targetWords}; revising…`);
    const rev = await structured({
      stage: "script.revise",
      model: MODELS.sonnet,
      system,
      user: `${user}\n\nYOUR DRAFT (${words()} words):\n${JSON.stringify(data)}\n\nRevise to exactly ${targetWords} words (±3%) keeping the hook formula, beats and facts. Return the full script.`,
      schema: DraftSchema,
      effort: "high",
    });
    data = rev.data;
    log(`    cache read ${rev.usage.cacheRead} tokens`);
  }

  // Structural critic: in-media-res open, a turn every ≤ 30 s, contrast framing. Up to two targeted revisions.
  for (let round = 1; round <= 2; round++) {
    const issues = critiqueNarrative(data.segments, o.narrationWpm, { short, maxGapS: 50 });
    if (!issues.length) {
      log(`  script: narrative checks pass (in-media-res open, ~19-word sentences, numbers held back, turn every ≤ 50 s, no filler)`);
      break;
    }
    log(`  script: ${issues.length} narrative issue(s) — ${issues.map((i) => `${i.kind} @ ${i.where}`).join("; ")}; revising (round ${round})…`);
    const rev = await structured({
      stage: "script.narrative",
      model: MODELS.sonnet,
      system,
      user: `${user}\n\nYOUR DRAFT:\n${JSON.stringify(data)}\n\nA story editor flagged these problems (narration pace ≈ ${o.narrationWpm} wpm):\n${issues.map((i) => `- [${i.kind}] ${i.where}: ${i.detail}`).join("\n")}\n\nFix every one using the STORY ENGINE rules. For flat stretches, add a consequence, a reversal or a scene from the dossier — never stock filler. For choppy prose, merge short sentences into connected consequence chains. For number dumps, keep the figures that matter, bundle them into one contrast sentence and cut the rest. Keep the total within ±3% of ${targetWords} words by tightening nearby lines; keep chapters, facts and claim ids. Return the full script.`,
      schema: DraftSchema,
      effort: "high",
      maxTokens: 32000,
    });
    data = rev.data;
  }
  {
    const left = critiqueNarrative(data.segments, o.narrationWpm, { short, maxGapS: 50 });
    if (left.length) log(`    still flagged: ${left.map((i) => `${i.kind} @ ${i.where}`).join("; ")}`);
  }

  const known = new Set(claims.map((c) => c.id));
  const segments = data.segments.map((s, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, role: s.role, ...(!short && s.chapter.trim() ? { chapter: s.chapter.trim() } : {}), text: normalizeFigures(s.text.trim()), claimIds: s.claimIds.filter((c) => known.has(c)), visualIdea: s.visualIdea }));
  // Long-form: every segment inherits the last named chapter so chapters are contiguous.
  let lastChapter = segments.find((s) => s.chapter)?.chapter;
  for (const s of segments) if (!short) s.chapter = (s.chapter ??= lastChapter), (lastChapter = s.chapter);
  const chapters = short ? undefined : [...new Set(segments.map((s) => s.chapter).filter((c): c is string => Boolean(c)))];
  return ScriptDraft.parse({
    schemaVersion: 1,
    id: `sc_${createHash("sha1").update(o.facts.id + o.pack.channelId + o.aspect + o.durationS).digest("hex").slice(0, 10)}`,
    factSheetId: o.facts.id,
    styleProfileId: o.pack.channelId,
    aspect: o.aspect,
    targetDurationS: o.durationS,
    targetWords,
    title: data.title,
    hookFormula: data.hookFormula,
    segments,
    wordCount: segments.reduce((n, s) => n + countWords(s.text), 0),
    ...(chapters ? { chapters } : {}),
    blueprint: bp,
    generatedAt: new Date().toISOString(),
  });
}
