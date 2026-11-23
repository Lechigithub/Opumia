import { withOutside } from "@opumia/senses";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z4 from "zod/v4";

/** Models named for this pipeline: Sonnet 5.5 for reasoning stages, Haiku 5.5 for high-volume checks. */
export const MODELS = { sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", opus: "claude-opus-5-5" } as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

// $ per 1M tokens (input, output, cache read). Cache writes bill at 1.25× input.
const PRICE: Record<ModelId, { in: number; out: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
};

let _client: Anthropic | null = null;
/** Drop the cached client (after credentials were reloaded during a pause). */
export function resetClient() {
  _client = null;
}
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
/** What the film may still spend (null = no limit set). */
export function budgetLeft(): number | null {
  if (!budget) return null;
  return budget.limitUsd - ledger.slice(budget.from).reduce((t, r) => t + r.usd, 0);
}
const guardBudget = () => {
  if (!budget) return;
  const spent = ledger.slice(budget.from).reduce((t, r) => t + r.usd, 0);
  if (spent >= budget.limitUsd) throw new BudgetError(`spend limit reached: $${spent.toFixed(2)} of $${budget.limitUsd.toFixed(2)} for this film (raise OPUMIA_MAX_USD to continue; finished stages are cached)`);
};

/**
 * H32: spend outside Claude goes in the same ledger (and counts toward the film's spend limit): ElevenLabs speech is
 * billed per character. The price per 1,000 characters is an estimate for the account's plan — set
 * OPUMIA_TTS_USD_PER_1K to the real figure (default 0.30).
 */
export function recordExternal(stage: string, provider: string, units: number, usd: number): UsageRecord {
  const r: UsageRecord = { stage, model: provider, input: units, output: 0, cacheRead: 0, cacheWrite: 0, usd: Math.round(usd * 1e5) / 1e5 };
  ledger.push(r);
  return r;
}
export const ttsUsdPer1k = () => Number(process.env.OPUMIA_TTS_USD_PER_1K ?? 0.3) || 0.3;

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
    const msg = await withOutside("anthropic", () => client().beta.messages.parse(params));
    const usage = record(o.stage, o.model, msg);
    if (msg.stop_reason === "refusal") throw new RefusalError(o.stage, msg.stop_details?.category ?? null);
    if (msg.stop_reason === "max_tokens") throw new Error(`${o.stage}: output truncated at max_tokens`);
    if (!msg.parsed_output) throw new Error(`${o.stage}: response did not match schema`);
    return { data: msg.parsed_output as z4.infer<S>, usage };
  }
  // Large outputs (long-form scripts, chunked shot lists) must stream; the format still constrains the
  // JSON server-side, and we validate the final text with the same Zod schema.
  const msg = await withOutside("anthropic", () => client().beta.messages.stream(params).finalMessage());
  const usage = record(o.stage, o.model, msg);
  if (msg.stop_reason === "refusal") throw new RefusalError(o.stage, msg.stop_details?.category ?? null);
  if (msg.stop_reason === "max_tokens") throw new Error(`${o.stage}: output truncated at max_tokens`);
  const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const parsed = o.schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${o.stage}: response did not match schema`);
  return { data: parsed.data as z4.infer<S>, usage };
}

/** A tool an agent can call: validated input in, text out (an error thrown becomes an error result the agent sees). */
export interface AgentTool {
  name: string;
  description: string;
  schema: z4.ZodType;
  run: (input: never) => Promise<string | Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam>>;
}

/**
 * A tool-using agent: the model works in a loop — it calls tools, sees their results and decides what to do
 * next — until `done()` is true, it stops by itself, or `maxTurns` is reached. The conversation is cached
 * turn to turn (the stable system blocks plus everything already said), thinking blocks are passed back
 * unchanged, and all results of one turn go back in a single message.
 */
export async function agentLoop(o: { stage: string; model: ModelId; system: Anthropic.Beta.BetaTextBlockParam[]; user: string; tools: AgentTool[]; /** Anthropic-hosted tools (e.g. web search), run by the API. */ serverTools?: Anthropic.Beta.BetaToolUnion[]; effort?: "low" | "medium" | "high" | "xhigh"; maxTurns?: number; maxTokens?: number; /** Build list 3, item 31: the agent stops (as at max_turns) once it has spent this much. */ maxUsd?: number; done?: () => boolean; nudge?: string; log?: (s: string) => void }): Promise<{ turns: number; calls: Record<string, number>; stopped: "done" | "end_turn" | "max_turns" | "max_usd"; usd: number }> {
  const fb = fallbackFor(o.model);
  const from = ledger.length;
  const tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: z4.toJSONSchema(t.schema) as Anthropic.Beta.BetaTool["input_schema"] }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: o.user }];
  const calls: Record<string, number> = {};
  let nudges = 0;
  const spent = () => ledger.slice(from).reduce((t, r) => t + r.usd, 0);
  for (let turn = 1; turn <= (o.maxTurns ?? 24); turn++) {
    if (o.maxUsd !== undefined && turn > 1 && spent() >= o.maxUsd) {
      o.log?.(`    ${o.stage}: spent $${spent().toFixed(2)} of its $${o.maxUsd.toFixed(2)} cap — stopping here`);
      return { turns: turn - 1, calls, stopped: "max_usd", usd: spent() };
    }
    // build list 3, part D: a usage limit, outage or rate limit waits here and the agent continues with its state intact
    const msg = await withOutside("anthropic", () => client()
      .beta.messages.stream({
        model: o.model,
        max_tokens: o.maxTokens ?? 32000,
        system: o.system,
        messages,
        tools: [...(o.serverTools ?? []), ...tools],
        cache_control: { type: "ephemeral" },
        output_config: { effort: o.effort ?? "medium" },
        ...(fb.betas.length ? { betas: fb.betas } : {}),
        ...("fallbacks" in fb ? { fallbacks: fb.fallbacks } : {}),
      })
      .finalMessage());
    record(o.stage, o.model, msg);
    if (msg.stop_reason === "refusal") throw new RefusalError(o.stage, msg.stop_details?.category ?? null);
    if (msg.stop_reason === "max_tokens") throw new Error(`${o.stage}: output truncated at max_tokens`);
    messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (uses.length) {
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          calls[u.name] = (calls[u.name] ?? 0) + 1;
          const tool = o.tools.find((t) => t.name === u.name);
          if (!tool) return { type: "tool_result", tool_use_id: u.id, content: `unknown tool ${u.name}`, is_error: true };
          const input = tool.schema.safeParse(u.input);
          if (!input.success) return { type: "tool_result", tool_use_id: u.id, content: `invalid input: ${input.error.message.slice(0, 600)}`, is_error: true };
          try {
            return { type: "tool_result", tool_use_id: u.id, content: await tool.run(input.data as never) };
          } catch (err) {
            if (err instanceof BudgetError) throw err;
            return { type: "tool_result", tool_use_id: u.id, content: `tool failed: ${(err as Error).message.slice(0, 600)}`, is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: results });
      o.log?.(`    turn ${turn}: ${uses.map((u) => u.name).join(", ")}`);
      if (o.done?.()) return { turns: turn, calls, stopped: "done", usd: spent() };
      continue;
    }
    if (msg.stop_reason === "pause_turn") continue;
    if (o.done?.() || !o.nudge || nudges >= 2) return { turns: turn, calls, stopped: o.done?.() ? "done" : "end_turn", usd: spent() };
    nudges++;
    messages.push({ role: "user", content: o.nudge });
  }
  return { turns: o.maxTurns ?? 24, calls, stopped: "max_turns", usd: spent() };
}

/** Research turn with the web search + fetch server tools; returns the final text and every URL the model saw. */
export async function webResearch(o: { stage: string; system: Anthropic.Beta.BetaTextBlockParam[]; user: string; maxSearches?: number; model?: (typeof MODELS)[keyof typeof MODELS]; maxFetches?: number }) {
  const model = o.model ?? MODELS.sonnet;
  const fb = fallbackFor(model);
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: o.user }];
  const urls = new Map<string, string | undefined>();
  let text = "";
  for (let turn = 0; turn < 6; turn++) {
    const stream = () => client().beta.messages.stream({
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
    const msg = await withOutside("anthropic", () => stream().finalMessage());
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
