import { createHash } from "node:crypto";
import { ScriptDraft, usableClaims, type Aspect, type FactSheet } from "@opumia/contracts";
import * as z from "zod/v4";
import { cached, MODELS, plain, structured } from "./llm.js";
import type { StylePack } from "./style-pack.js";

const ROLES = ["cold_open", "hook", "thesis", "context", "rise", "twist", "climax", "fall", "resolution", "cta", "chapter"] as const;

const DraftSchema = z.object({
  title: z.string(),
  hookFormula: z.string(),
  segments: z.array(
    z.object({
      role: z.enum(ROLES),
      text: z.string(),
      claimIds: z.array(z.string()),
      visualIdea: z.string(),
    }),
  ),
});

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export interface ScriptOptions {
  pack: StylePack;
  facts: FactSheet;
  aspect: Aspect;
  durationS: number;
  /** Words per minute the TTS voice will actually speak at. */
  narrationWpm: number;
  log?: (s: string) => void;
}

const WRITER_TASK = (o: { short: boolean; words: number; durationS: number }) => `You are the head writer for the channel described in the style pack above. Write narration only — the words the narrator says.

Rules:
- Match the channel: its hook formula (pick ONE technique card of category "hook" and instantiate it on this topic), its act structure (beats in the order and proportions the story labels and families show), its rhetorical tone (how it addresses the viewer, its irony, its open loops and re-hooks), and its sentence rhythm from the real cold opens.
- ${o.short ? `This is a ${o.durationS}-second vertical short. Compress the long-form arc: hook in the first sentence (under 3 seconds), thesis by ~8 s, 2–3 escalating beats, one twist, a punchy resolution that loops back to the hook. No chapter titles, no "subscribe" CTA, no sponsor.` : "This is long-form: include chapter beats, re-hooks every ~90 s and a callback ending."}
- Length: ${o.words} words total (±5%). This is a hard limit: the narration must fit ${o.durationS} s.
- Facts: state ONLY facts from the FACT SHEET, and list the claim ids each segment relies on. Hedge anything marked partially_supported ("around", "reportedly"). Never add a number, date or quote that is not in the sheet.
- Write for the ear: spell numbers the way a narrator says them only when ambiguous; no stage directions, no emojis, no markdown.
- visualIdea: one line describing what should be on screen (archival footage, a chart of X, a map of Y, a headline, a big word) — real footage and designed graphics only, never AI imagery.
- Never copy sentences from the reference cold opens.`;

export async function writeScript(o: ScriptOptions): Promise<ScriptDraft> {
  const log = o.log ?? (() => {});
  const short = o.durationS <= 90;
  const targetWords = Math.round((o.durationS * o.narrationWpm) / 60);
  const claims = usableClaims(o.facts);
  const factText = claims.map((c) => `[${c.id}] (${c.verdict}) ${c.text}`).join("\n");
  const system = [cached(o.pack.text), plain(WRITER_TASK({ short, words: targetWords, durationS: o.durationS }))];
  const user = `TOPIC: ${o.facts.topic}\nANGLE: ${o.facts.angle}\nSUMMARY: ${o.facts.summary}\n\nFACT SHEET:\n${factText}`;

  log(`  script: drafting ${targetWords} words (${MODELS.sonnet}, style pack cached)…`);
  let { data, usage } = await structured({ stage: "script.draft", model: MODELS.sonnet, system, user, schema: DraftSchema, effort: "high" });
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

  const known = new Set(claims.map((c) => c.id));
  const segments = data.segments.map((s, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, role: s.role, text: s.text.trim(), claimIds: s.claimIds.filter((c) => known.has(c)), visualIdea: s.visualIdea }));
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
    generatedAt: new Date().toISOString(),
  });
}
