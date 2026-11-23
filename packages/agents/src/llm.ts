import { withOutside } from "@opumia/senses";
import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z4 from "zod/v4";

/** Models named for this pipeline: Sonnet 5.5 for creative work, Haiku 5.5 for the jobs it does well (no Opus — owner, 2026-11-22). */
export const MODELS = { sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" } as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/**
 * Build list 4, item 17 (owner decision 2026-11-22): one table says which model does each job. Sonnet does the creative
 * work and the judgements where a mistake ships; Haiku does checks, labels, verification, retrieval and the
 * measure-driven agents. A role goes back to Sonnet only when its own score drops on Haiku.
 */
export const ROLE_MODEL = {
  // creative work — Sonnet
  writer: MODELS.sonnet,
  researchPlan: MODELS.sonnet,
  director: MODELS.sonnet,
  artDirector: MODELS.sonnet,
  sceneDesigner: MODELS.sonnet,
  showrunner: MODELS.sonnet,
  packaging: MODELS.sonnet,
  thumbnailCraft: MODELS.sonnet,
  voiceDirector: MODELS.sonnet,
  // judgements where a wrong call ships — Sonnet
  periodCheck: MODELS.sonnet,
  finalCutJudge: MODELS.sonnet,
  // high-volume or clear-cut — Haiku
  claimCheck: MODELS.haiku,
  queryPlan: MODELS.haiku,
  pictureFirstPass: MODELS.haiku,
  labels: MODELS.haiku,
  retrieval: MODELS.haiku,
  checks: MODELS.haiku,
  tagging: MODELS.haiku,
  // the scene critic was calibrated on Haiku against the channel's real shots (dev/critic-test.ts: 0 of 24 flagged)
  sceneCritic: MODELS.haiku,
  // measure-driven agents — Haiku while their own score holds
  pictureResearcher: MODELS.haiku,
  editor: MODELS.haiku,
  colourist: MODELS.haiku,
  soundDesigner: MODELS.haiku,
  viewerQa: MODELS.haiku,
} as const satisfies Record<string, ModelId>;
export type Role = keyof typeof ROLE_MODEL;

// $ per 1M tokens (input, output, cache read). Cache writes bill at 1.25× input.
const PRICE: Record<ModelId, { in: number; out: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
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
  /** Build list 5, item 32: the film stage the call ran in (safe when stages run in parallel). */
  filmStage?: string;
  /** Spent by a repair (a ladder rung). */
  repair?: boolean;
}
/**
 * Build list 5, item 32: which film stage a call belongs to. Work that runs BESIDE another stage (the publishing package
 * beside the render, chapters in parallel) runs inside `inFilmStage(code, fn)`; everything else takes the stage the log
 * header last opened (`setCurrentStage`).
 */
const stageScope = new AsyncLocalStorage<string>();
let currentStage: string | null = null;
export function setCurrentStage(code: string | null) {
  currentStage = code;
}
export function inFilmStage<T>(code: string, fn: () => Promise<T>): Promise<T> {
  return stageScope.run(code, fn);
}
const stageNow = () => stageScope.getStore() ?? currentStage ?? undefined;
/** What the calls tagged with this stage have cost so far. */
export function stageSpent(code: string): number {
  return ledger.filter((r) => r.filmStage === code).reduce((t, r) => t + r.usd, 0);
}
const ledger: UsageRecord[] = [];
export const usageLedger = () => [...ledger];

/**
 * The film's spend limit (build list 4, items 1, 2 and 6).
 *  - It counts the WHOLE film: what earlier runs of the job spent (`spentBefore`, from usage.json) plus this run.
 *  - A reserve is kept for the finish (render, QA, packaging): until `setFinishing(true)`, optional work (agent turns,
 *    ladder rungs, revisions) may only spend down to the reserve (`budgetLeft`).
 *  - Each stage has a cap of its own (`setStageCap`) that optional work inside the stage respects as well.
 *  - Only the hard limit itself refuses a model call (BudgetError); the stages that must run are sized well under it,
 *    and the production loop treats a refusal as "no more optional work" (never a stop).
 */
export class BudgetError extends Error {}
let budget: { limitUsd: number; reserveUsd: number; repairUsd: number; spentBefore: number; repairBefore: number; from: number; finishing: boolean } | null = null;
let stageCap: { usd: number; from: number } | null = null;
/**
 * Proof film fix (Blockbuster: every repair rung skipped at "$0.00 left", the package and judges starved): the film's
 * money is three buckets.
 *  - first passes (each stage's own work, up to its stage cap) may spend only what is left after the REPAIR POOL and the
 *    FINISH RESERVE are set aside;
 *  - repairs (ladder rungs, run inside `inRepair`) spend the repair pool, never a stage's cap;
 *  - the finish (package, QA, viewer, judge) opens the reserve with `setFinishing(true)`.
 */
export function setBudget(limitUsd: number | null, o: { spentBefore?: number; reserveUsd?: number; repairUsd?: number; repairBefore?: number } = {}) {
  budget = limitUsd === null ? null : { limitUsd, reserveUsd: o.reserveUsd ?? 0, repairUsd: o.repairUsd ?? 0, spentBefore: o.spentBefore ?? 0, repairBefore: o.repairBefore ?? 0, from: ledger.length, finishing: false };
  stageCap = null;
}
/** The finish (render, QA, packaging) may use the reserve. */
export function setFinishing(on: boolean) {
  if (budget) budget.finishing = on;
}
/** Optional work inside the current stage may spend at most this much (null = no stage cap). */
export function setStageCap(usd: number | null) {
  stageCap = usd === null ? null : { usd, from: ledger.length };
}
const sumFrom = (from: number) => ledger.slice(from).reduce((t, r) => t + r.usd, 0);
/** What the whole film has spent so far, earlier runs included. */
export function filmSpent(): number {
  return budget ? budget.spentBefore + sumFrom(budget.from) : 0;
}
const repairScope = new AsyncLocalStorage<boolean>();
/** Run repair work (a ladder rung): it is paid from the repair pool and tagged as repair in the ledger. */
export function inRepair<T>(fn: () => Promise<T>): Promise<T> {
  return repairScope.run(true, fn);
}
const repairing = () => repairScope.getStore() === true;
/** What repairs have spent so far, earlier runs included. */
export function repairSpent(): number {
  return budget ? budget.repairBefore + ledger.slice(budget.from).filter((r) => r.repair).reduce((t, r) => t + r.usd, 0) : 0;
}
const repairLeft = () => (budget ? Math.max(0, budget.repairUsd - repairSpent()) : Infinity);
/** What repair work (ladder rungs) may still spend: the repair pool, within the film's limit less the finish reserve. */
export function budgetLeft(): number | null {
  if (!budget && !stageCap) return null;
  if (!budget) return stageCap!.usd - sumFrom(stageCap!.from);
  const film = budget.limitUsd - filmSpent() - (budget.finishing ? 0 : budget.reserveUsd);
  return Math.min(film, repairLeft());
}
/**
 * What an agent doing its stage's own work may spend: its stage's cap and the film's HARD limit (not the reserve-backed
 * pool). The pool and the reserve gate only optional work — ladder rungs and revisions — so an overspend early in the
 * film can never starve a later stage's first pass (the Nokia proof film: a costly narration left the scene designer,
 * editor, colourist, sound designer and showrunner $0, and they did nothing).
 */
export function agentLeft(): number | null {
  if (!budget && !stageCap) return null;
  // a repair: the repair pool (its own cap applies; never the stage's)
  if (repairing()) return budget ? Math.min(budget.limitUsd - filmSpent() - (budget.finishing ? 0 : budget.reserveUsd), repairLeft()) : null;
  // a first pass: the stage's cap, within what the film has once the repair pool and the finish reserve are set aside
  const film = budget ? budget.limitUsd - filmSpent() - (budget.finishing ? 0 : budget.reserveUsd) - repairLeft() : Infinity;
  const stage = stageCap ? stageCap.usd - sumFrom(stageCap.from) : Infinity;
  return Math.min(film, stage);
}
/**
 * Build list 5, item 2: the film's length scales every agent's own caps (money per agent and seconds), by how much of
 * the agent's work grows with the film (`fixed` = the share that is the same for any length).
 */
let filmScale: ((fixed: number) => number) | null = null;
export function setFilmLength(scale: ((fixed: number) => number) | null) {
  filmScale = scale;
}

/**
 * Build list 5, item 1: every agent logs what it was given and what it used. An agent whose first pass was given less
 * than it needs (`firstPassUsd`, by default half of its own cap) is STARVED — a test failure, never silent.
 */
export interface Allotment { stage: string; model: string; askedUsd: number | null; givenUsd: number | null; needUsd: number; usedUsd: number; turns: number; seconds: number; stopped: string; starved: boolean }
const allot: Allotment[] = [];
export const allotments = () => [...allot];
export function resetAllotments() {
  allot.length = 0;
}

const guardBudget = () => {
  if (!budget) return;
  const spent = filmSpent();
  if (spent >= budget.limitUsd) throw new BudgetError(`spend limit reached: $${spent.toFixed(2)} of $${budget.limitUsd.toFixed(2)} for this film`);
};

/**
 * H32: spend outside Claude goes in the same ledger (and counts toward the film's spend limit): ElevenLabs speech is
 * billed per character. The price per 1,000 characters is an estimate for the account's plan — set
 * OPUMIA_TTS_USD_PER_1K to the real figure (default 0.30).
 */
export function recordExternal(stage: string, provider: string, units: number, usd: number): UsageRecord {
  const r: UsageRecord = { stage, model: provider, input: units, output: 0, cacheRead: 0, cacheWrite: 0, usd: Math.round(usd * 1e5) / 1e5 };
  const fs = stageNow();
  if (fs) r.filmStage = fs;
  if (repairing()) r.repair = true;
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
  const fs = stageNow();
  if (fs) r.filmStage = fs;
  if (repairing()) r.repair = true;
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
export async function agentLoop(o: { stage: string; model: ModelId; system: Anthropic.Beta.BetaTextBlockParam[]; user: string; tools: AgentTool[]; /** Anthropic-hosted tools (e.g. web search), run by the API. */ serverTools?: Anthropic.Beta.BetaToolUnion[]; effort?: "low" | "medium" | "high" | "xhigh"; maxTurns?: number; maxTokens?: number; /** Build list 3, item 31: the agent stops (as at max_turns) once it has spent this much. */ maxUsd?: number; /** Build list 4, item 18: and once it has worked this long (checked before each turn). */ maxSeconds?: number; /** Build list 4: work the film needs — at a cap, the agent gets these few turns to hand in what it has, told this message. */ finish?: { message: string; turns?: number }; /** Build list 5, item 2: share of this agent's work that does not grow with the film's length (default 0.3). */ fixed?: number; /** Build list 5, item 1: what its first pass needs; given less, the run is logged as starved. */ firstPassUsd?: number; done?: () => boolean; nudge?: string; log?: (s: string) => void }): Promise<{ turns: number; calls: Record<string, number>; stopped: "done" | "end_turn" | "max_turns" | "max_usd" | "max_time"; usd: number }> {
  // Build list 4, items 4 and 6: the agent's cap is the smallest of its own maxUsd, the stage's cap and what the film
  // has left. It is checked BEFORE each turn against what a turn has been costing, so one expensive turn never
  // overshoots it.
  const left0 = agentLeft();
  const grow = filmScale ? filmScale(o.fixed ?? 0.3) : 1;
  const asked = o.maxUsd === undefined ? null : o.maxUsd * grow;
  const maxSeconds = o.maxSeconds === undefined ? undefined : o.maxSeconds * grow;
  const cap0 = Math.min(asked ?? Infinity, left0 === null ? Infinity : left0);
  const need = Math.min(asked ?? Infinity, o.firstPassUsd ?? (asked ?? 0.2) * 0.5);
  const given = Number.isFinite(cap0) ? cap0 : null;
  const t00 = Date.now();
  let r: Awaited<ReturnType<typeof agentLoopInner>>;
  try {
    r = await agentLoopInner(o, { cap: cap0, maxSeconds });
  } catch (err) {
    // the run is logged even when it ends in an error (a budget refusal, a refusal by the model)
    allot.push({ stage: o.stage, model: o.model, askedUsd: asked, givenUsd: given, needUsd: Math.round(need * 1000) / 1000, usedUsd: 0, turns: 0, seconds: Math.round((Date.now() - t00) / 100) / 10, stopped: `error: ${(err as Error).message.slice(0, 80)}`, starved: given !== null && given < need });
    throw err;
  }
  const a: Allotment = { stage: o.stage, model: o.model, askedUsd: asked === null ? null : Math.round(asked * 1000) / 1000, givenUsd: given === null ? null : Math.round(given * 1000) / 1000, needUsd: Math.round(need * 1000) / 1000, usedUsd: Math.round(r.usd * 1000) / 1000, turns: r.turns, seconds: Math.round((Date.now() - t00) / 100) / 10, stopped: r.stopped, starved: given !== null && given < need };
  allot.push(a);
  if (a.starved) o.log?.(`    ! ${o.stage} STARVED: given $${a.givenUsd!.toFixed(2)}, its first pass needs $${a.needUsd.toFixed(2)}`);
  return r;
}

async function agentLoopInner(o: Parameters<typeof agentLoop>[0], lim: { cap: number; maxSeconds: number | undefined }): Promise<{ turns: number; calls: Record<string, number>; stopped: "done" | "end_turn" | "max_turns" | "max_usd" | "max_time"; usd: number }> {
  const fb = fallbackFor(o.model);
  const from = ledger.length;
  const tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: z4.toJSONSchema(t.schema) as Anthropic.Beta.BetaTool["input_schema"] }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: o.user }];
  const calls: Record<string, number> = {};
  let nudges = 0;
  const spent = () => ledger.slice(from).reduce((t, r) => t + r.usd, 0);
  const cap = lim.cap;
  const maxSecondsLim = lim.maxSeconds;
  let lastTurn = 0;
  let turnFrom = 0;
  const t0 = Date.now();
  let finishLeft: number | null = null;
  const maxT = o.maxTurns ?? 24;
  for (let turn = 1; turn <= maxT + (o.finish ? (o.finish.turns ?? 2) : 0); turn++) {
    // what the previous turn cost: its model call plus the tools it ran (some tools call models themselves)
    if (turn > 1) lastTurn = Math.max(lastTurn * 0.6, spent() - turnFrom);
    const overUsd = Number.isFinite(cap) && (cap <= 0 || (turn > 1 && spent() + lastTurn > cap));
    const overTime = (maxSecondsLim !== undefined && turn > 1 && (Date.now() - t0) / 1000 > maxSecondsLim) || turn > maxT;
    if ((overUsd || overTime) && finishLeft === null && o.finish && !o.done?.() && turn > 1) {
      // Build list 4: an agent whose work the film needs is never cut off unfinished — at its cap it gets a short
      // finishing go (at most `finish.turns` turns) told to hand in what it has now.
      finishLeft = o.finish.turns ?? 2;
      o.log?.(`    ${o.stage}: at its ${overUsd ? `$${Math.max(0, cap).toFixed(2)} cap` : `${turn > maxT ? `${maxT}-turn` : `${Math.round(maxSecondsLim ?? 0)} s`} limit`} — ${finishLeft} turn(s) to hand in what it has`);
      const last = messages.at(-1)!;
      const note: Anthropic.Beta.BetaTextBlockParam = { type: "text", text: o.finish.message };
      if (last.role === "user") last.content = typeof last.content === "string" ? [{ type: "text", text: last.content }, note] : [...last.content, note];
      else messages.push({ role: "user", content: [note] });
    } else if (finishLeft !== null) {
      if (finishLeft-- <= 0) {
        o.log?.(`    ${o.stage}: finishing turns used — stopping here`);
        return { turns: turn - 1, calls, stopped: overTime ? "max_time" : "max_usd", usd: spent() };
      }
    } else if (overUsd) {
      o.log?.(`    ${o.stage}: $${spent().toFixed(2)} spent, a turn costs about $${lastTurn.toFixed(2)}, cap $${Math.max(0, cap).toFixed(2)} — stopping here`);
      return { turns: turn - 1, calls, stopped: "max_usd", usd: spent() };
    } else if (overTime) {
      o.log?.(`    ${o.stage}: ${Math.round((Date.now() - t0) / 1000)} s of its ${Math.round(maxSecondsLim ?? 0)} s — stopping here`);
      return { turns: turn - 1, calls, stopped: "max_time", usd: spent() };
    }
    turnFrom = spent();
    // build list 3, part D: a usage limit, outage or rate limit waits here and the agent continues with its state intact
    const msg = await withOutside("anthropic", () => client()
      .beta.messages.stream({
        model: o.model,
        max_tokens: o.maxTokens ?? 32000,
        system: o.system,
        messages,
        tools: [...(o.serverTools ?? []), ...tools],
        cache_control: { type: "ephemeral" },
        // a repair (ladder rung) works at low effort: it fixes one named thing, it does not design from scratch
        output_config: { effort: repairing() ? "low" : (o.effort ?? "medium") },
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
