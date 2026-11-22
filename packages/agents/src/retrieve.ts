/**
 * Retrieval by meaning: the reference items nearest to a task, ranked by a cheap text-only model call (no embedding
 * service). Used so an agent studies the few real examples that match what it is doing now — the same story moment,
 * the same kind of idea — instead of averages or keyword hits. Falls back to word overlap if the call fails.
 */
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));

export async function nearestByMeaning(query: string, items: string[], k: number, what = "item"): Promise<number[]> {
  if (items.length <= k) return items.map((_, i) => i);
  const res = await structured({
    stage: "retrieve",
    model: MODELS.haiku,
    system: [plain(`You match a task to the most similar ${what}s. Judge by meaning and role (what is being shown or said, and why), not by shared words. Return the ${k} best indices, best first.`)],
    user: `TASK: ${query.slice(0, 1200)}\n\n${what.toUpperCase()}S:\n${items.map((t, i) => `[${i}] ${t.replace(/\s+/g, " ").slice(0, 220)}`).join("\n")}`,
    schema: z.object({ best: z.array(z.number()) }),
    effort: "low",
    maxTokens: 400,
  }).catch(() => null);
  const picked = [...new Set((res?.data.best ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < items.length))].slice(0, k);
  if (picked.length >= Math.min(k, 2)) return picked;
  const q = words(query);
  return items.map((t, i) => ({ i, s: [...words(t)].filter((w) => q.has(w)).length })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, k).map((x) => x.i);
}
