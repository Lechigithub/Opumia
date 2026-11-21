import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type * as z4 from "zod/v4";

/** Models named for this pipeline: Sonnet 5.5 for reasoning stages, Haiku 5.5 for high-volume checks. */
export const MODELS = { sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" } as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

// $ per 1M tokens (input, output, cache read). Cache writes bill at 1.25× input.
const PRICE: Record<ModelId, { in: number; out: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

let _client: Anthropic | null = null;
export function client(): Anthropic {
  guardBudget();
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPUMIA_ANTHROPIC_KEY;
  // Zero-arg resolution also works (auth token / `ant auth login` profile) when no key env var is set.
  _client = apiKey ? new Anthropic({ apiKey, maxRetries: 3 }) : new Anthropic({ maxRetries: 3 });
  return _client;
}

export interface UsageRecord {
  stage: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  servedBy?: string;
}
const ledger: UsageRecord[] = [];
export const usageLedger = () => [...ledger];

/** A spend limit for the current film: once reached, no further model call is started (stages are cached, so a stopped job resumes). */
export class BudgetError extends Error {}
let budget: { limitUsd: number; from: number } | null = null;
export function setBudget(limitUsd: number | null) {
  budget = limitUsd === null ? null : { limitUsd, from: ledger.length };
}
const guardBudget = () => {
  if (!budget) return;
  const spent = ledger.slice(budget.from).reduce((t, r) => t + r.usd, 0);
  if (spent >= budget.limitUsd) throw new BudgetError(`spend limit reached: $${spent.toFixed(2)} of $${budget.limitUsd.toFixed(2)} for this film (raise OPUMIA_MAX_USD to continue; finished stages are cached)`);
};

function record(stage: string, model: ModelId, msg: { model: string; usage: Anthropic.Beta.BetaUsage }) {
  const u = msg.usage;
  const p = PRICE[model];
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const usd = (u.input_tokens * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.cacheRead + u.output_tokens * p.out) / 1e6;
  const r: UsageRecord = { stage, model, input: u.input_tokens, output: u.output_tokens, cacheRead, cacheWrite, usd: Math.round(usd * 1e5) / 1e5 };
  if (msg.model !== model) r.servedBy = msg.model;
  ledger.push(r);
  return r;
}

export class RefusalError extends Error {
  constructor(
    readonly stage: string,
    readonly category: string | null,
  ) {
    super(`${stage}: model declined (${category ?? "unspecified"})`);
  }
}

/** Sonnet 5.5 gets server-side refusal fallbacks ("default" routing); Haiku 5.5 has none. */
const fallbackFor = (model: ModelId) =>
  model === MODELS.sonnet ? ({ betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[], fallbacks: "default" as const } as const) : ({ betas: [] as Anthropic.Beta.AnthropicBeta[] } as const);

export interface StructuredOpts<S extends z4.ZodType> {
  stage: string;
  model: ModelId;
  /** Stable, cacheable system blocks first (style pack etc.); volatile instructions last. */
  system: Anthropic.Beta.BetaTextBlockParam[];
  user: string | Anthropic.Beta.BetaContentBlockParam[];
  schema: S;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

/** One structured-output call, validated by the SDK's zod parser. */
export async function structured<S extends z4.ZodType>(o: StructuredOpts<S>): Promise<{ data: z4.infer<S>; usage: UsageRecord }> {
  const fb = fallbackFor(o.model);
  const maxTokens = o.maxTokens ?? 16000;
  const params = {
    model: o.model,
    max_tokens: maxTokens,
    system: o.system,
    messages: [{ role: "user" as const, content: o.user }],
    output_config: { effort: o.effort ?? "medium", format: betaZodOutputFormat(o.schema) },
    ...(fb.betas.length ? { betas: fb.betas } : {}),
    ...("fallbacks" in fb ? { fallbacks: fb.fallbacks } : {}),
  };
  if (maxTokens <= 16000) {
    const msg = await client().beta.messages.parse(params);
    const usage = record(o.stage, o.model, msg);
    if (msg.stop_reason === "refusal") throw new RefusalError(o.stage, msg.stop_details?.category ?? null);
    if (msg.stop_reason === "max_tokens") throw new Error(`${o.stage}: output truncated at max_tokens`);
    if (!msg.parsed_output) throw new Error(`${o.stage}: response did not match schema`);
    return { data: msg.parsed_output as z4.infer<S>, usage };
  }
  // Large outputs (long-form scripts, chunked shot lists) must stream; the format still constrains the
  // JSON server-side, and we validate the final text with the same Zod schema.
  const msg = await client().beta.messages.stream(params).finalMessage();
  const usage = record(o.stage, o.model, msg);
  if (msg.stop_reason === "refusal") throw new RefusalError(o.stage, msg.stop_details?.category ?? null);
  if (msg.stop_reason === "max_tokens") throw new Error(`${o.stage}: output truncated at max_tokens`);
  const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const parsed = o.schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${o.stage}: response did not match schema`);
  return { data: parsed.data as z4.infer<S>, usage };
}

/** Research turn with the web search + fetch server tools; returns the final text and every URL the model saw. */
export async function webResearch(o: { stage: string; system: Anthropic.Beta.BetaTextBlockParam[]; user: string; maxSearches?: number; model?: (typeof MODELS)[keyof typeof MODELS]; maxFetches?: number }) {
  const model = o.model ?? MODELS.sonnet;
  const fb = fallbackFor(model);
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: o.user }];
  const urls = new Map<string, string | undefined>();
  let text = "";
  for (let turn = 0; turn < 6; turn++) {
    const stream = client().beta.messages.stream({
      model,
      max_tokens: model === MODELS.sonnet ? 32000 : 6000,
      system: o.system,
      messages,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: o.maxSearches ?? 8 },
        ...((o.maxFetches ?? 6) > 0 ? [{ type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: o.maxFetches ?? 6 }] : []),
      ],
      output_config: { effort: "medium" },
      betas: fb.betas,
      ...("fallbacks" in fb ? { fallbacks: fb.fallbacks } : {}),
    });
    const msg = await stream.finalMessage();
    record(o.stage, model, msg);
    for (const b of msg.content) {
      if (b.type === "text") {
        text += b.text;
        for (const c of b.citations ?? []) if ("url" in c && c.url) urls.set(c.url, "title" in c ? (c.title ?? undefined) : undefined);
      } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r.type === "web_search_result") urls.set(r.url, r.title);
      }
    }
    if (msg.stop_reason === "refusal") throw new RefusalError(o.stage, msg.stop_details?.category ?? null);
    if (msg.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: msg.content });
  }
  return { text, urls };
}

/** Cacheable text block helper (5-minute TTL is enough within one production run). */
export const cached = (text: string): Anthropic.Beta.BetaTextBlockParam => ({ type: "text", text, cache_control: { type: "ephemeral" } });
export const plain = (text: string): Anthropic.Beta.BetaTextBlockParam => ({ type: "text", text });
