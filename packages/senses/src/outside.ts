/**
 * Failures outside the platform (build list 3, part D): an API usage limit, an expired or rejected key, a provider's
 * rate limit, an outage, a dropped connection. They are not the film's fault, so they never stop it: the call that hit
 * one WAITS and tries again — after the provider's own reset time when it gives one, else on a growing backoff — and
 * the film continues exactly where it was (an agent mid-conversation keeps its state). While waiting, the run is
 * marked paused (hooks: produce writes out/<job>/paused.json). Only a wait longer than OPUMIA_MAX_PAUSE_H (default 72 h)
 * ends the run, with PausedError; re-running the same command (or `opumia resume <job>`) continues from the cached stages.
 */
export type OutsideKind = "usage_limit" | "auth" | "rate_limit" | "outage" | "network";
export interface OutsideFailure { provider: string; kind: OutsideKind; status?: number; message: string; retryAfterS?: number; resetAt?: string }

export class PausedError extends Error {
  /** When access is expected back (the provider's reset time, or the next retry). */
  readonly resumeAt: string;
  constructor(readonly failure: OutsideFailure, readonly waitedS: number, nextS = 900) {
    super(`paused: ${failure.provider} ${failure.kind} (${failure.message.slice(0, 160)}) — waited ${Math.round(waitedS / 60)} min, longer than OPUMIA_MAX_PAUSE_H allows; run the same command again to resume`);
    this.resumeAt = failure.resetAt ?? new Date(Date.now() + nextS * 1000).toISOString();
  }
}

/** An error a provider adapter can throw so the status and reset hints reach the classifier. */
export class ProviderHttpError extends Error {
  constructor(readonly provider: string, readonly status: number, readonly body: string, readonly retryAfterS?: number) {
    super(`${provider} HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

const USAGE = /usage limit|reached your specified api usage|credit balance|quota|insufficient[_ ]credits|billing|payment required|exceeded your (monthly|character)|character limit|plan limit/i;
const AUTH = /invalid[_ ]api[_ ]key|unauthori[sz]ed|authentication|api key (is )?(expired|revoked|invalid)|permission denied/i;
const NET = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|aborted|timeout|TimeoutError|terminated/i;

/** A reset time stated in an error ("You will regain access on 2026-12-01 at 00:00 UTC"), as ISO. */
export function resetFromMessage(msg: string, now = Date.now()): string | undefined {
  const d = /(\d{4}-\d{2}-\d{2})(?:[ T]| at )(\d{2}:\d{2})(?::\d{2})?\s*(UTC|Z)?/i.exec(msg);
  if (d) {
    const t = Date.parse(`${d[1]}T${d[2]}:00Z`);
    if (Number.isFinite(t) && t > now) return new Date(t).toISOString();
  }
  const s = /(?:try again|retry) in (\d+(?:\.\d+)?)\s*(second|minute|hour)s?/i.exec(msg);
  if (s) return new Date(now + Number(s[1]) * (s[2]!.startsWith("h") ? 3600e3 : s[2]!.startsWith("m") ? 60e3 : 1e3)).toISOString();
  return undefined;
}

/** Is this error a failure outside the platform? (null: a real error, thrown on.) */
export function classifyOutside(provider: string, err: unknown): OutsideFailure | null {
  const e = err as { status?: number; message?: string; body?: string; retryAfterS?: number; headers?: Record<string, string> | Headers; error?: { error?: { message?: string } } };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = `${e?.message ?? ""} ${e?.body ?? ""} ${e?.error?.error?.message ?? ""}`.trim() || String(err);
  const header = (k: string) => (e?.headers instanceof Headers ? e.headers.get(k) : (e?.headers as Record<string, string> | undefined)?.[k]) ?? undefined;
  const ra = Number(header("retry-after") ?? NaN);
  const retryAfterS = e?.retryAfterS ?? (Number.isFinite(ra) ? ra : undefined);
  const resetAt = resetFromMessage(message) ?? header("anthropic-ratelimit-requests-reset") ?? undefined;
  const base = { provider, message: message.slice(0, 400), ...(status ? { status } : {}), ...(retryAfterS !== undefined ? { retryAfterS } : {}), ...(resetAt ? { resetAt } : {}) };
  if (status === 402 || ((status === 429 || status === 400 || status === 403) && USAGE.test(message))) return { ...base, kind: "usage_limit" };
  if (status === 401 || (status === 403 && AUTH.test(message)) || (!status && AUTH.test(message) && /key/i.test(message))) return { ...base, kind: "auth" };
  if (status === 429) return { ...base, kind: "rate_limit" };
  if (status !== undefined && (status >= 500 || status === 408)) return { ...base, kind: "outage" };
  if (status === undefined && NET.test(message)) return { ...base, kind: "network" };
  return null;
}

export interface PauseHooks {
  /** The run is waiting (shown and written down): until when, and why. */
  onPause?: (f: OutsideFailure, untilIso: string) => void | Promise<void>;
  /** Access is back after a pause. */
  onResume?: (f: OutsideFailure, waitedS: number) => void | Promise<void>;
  /** Before each retry after an auth failure: reload credentials (a rotated key reaches the running process). */
  reloadCredentials?: () => void;
}
let hooks: PauseHooks = {};
export function setPauseHooks(h: PauseHooks) {
  hooks = h;
}
/** For tests: no real waiting. */
let sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function setSleeper(fn: (ms: number) => Promise<void>) {
  sleeper = fn;
}

const BACKOFF_S = [5, 15, 45, 120, 300, 600, 900];
const maxPauseS = () => Number(process.env.OPUMIA_MAX_PAUSE_H ?? 72) * 3600;

/** How long to wait before the next try. */
export function waitFor(f: OutsideFailure, attempt: number, now = Date.now()): number {
  if (f.resetAt) return Math.max(5, (Date.parse(f.resetAt) - now) / 1000 + 30);
  if (f.retryAfterS !== undefined) return Math.max(1, f.retryAfterS);
  if (f.kind === "usage_limit") return 15 * 60;
  if (f.kind === "auth") return 30 * 60;
  return BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)]!;
}

/** Run a provider call; outside failures wait and retry (see the module note), anything else is thrown. */
export async function withOutside<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  let waited = 0;
  let attempt = 0;
  let paused: OutsideFailure | null = null;
  for (;;) {
    try {
      const out = await fn();
      if (paused) { if (hooks.onResume) await hooks.onResume(paused, waited); else console.error(`▶ RESUMED ${paused.provider} after ${Math.round(waited / 60)} min`); }
      return out;
    } catch (err) {
      const f = classifyOutside(provider, err);
      if (!f) throw err;
      const s = waitFor(f, attempt++);
      if (waited + s > maxPauseS()) throw new PausedError(f, waited, s);
      // short network blips and rate limits are retried quietly; anything longer is a visible pause
      if (s >= 60 || attempt >= 3 || f.kind === "usage_limit" || f.kind === "auth") {
        paused = f;
        const until = new Date(Date.now() + s * 1000).toISOString();
        // a pause is always visible: without a hook (dev scripts) it goes to stderr. A 10-minute writer test sat 46 min
        // in silent provider retries (2026-11-27) and looked hung.
        if (hooks.onPause) await hooks.onPause(f, until);
        else console.error(`⏸ PAUSED ${f.provider} ${f.kind}: ${f.message.slice(0, 140)} — waited ${Math.round(waited / 60)} min so far, trying again at ${until}`);
      }
      await sleeper(s * 1000);
      waited += s;
      if (f.kind === "auth") hooks.reloadCredentials?.();
    }
  }
}
