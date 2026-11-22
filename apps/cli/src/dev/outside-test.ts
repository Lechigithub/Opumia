// Build list 3, part D, simulated (no network, no real waiting): failures outside the platform are recognised, the call
// waits and continues, a usage limit waits until its reset time, a pause too long ends with a resumable PausedError, a
// stock source whose key is rejected is skipped for the rest of the run.
//   npx tsx apps/cli/src/dev/outside-test.ts
import { classifyOutside, PausedError, ProviderHttpError, setPauseHooks, setSleeper, withOutside } from "@opumia/senses";
import { providerHealth, searchStock } from "@opumia/resolver";

export async function outsideTest(): Promise<string[]> {
  const fails: string[] = [];
  const slept: number[] = [];
  setSleeper(async (ms) => void slept.push(ms));
  const events: string[] = [];
  setPauseHooks({ onPause: (f) => void events.push(`pause:${f.kind}`), onResume: (f) => void events.push(`resume:${f.kind}`), reloadCredentials: () => void events.push("reload") });
  try {
    // classification
    const c = (status: number | undefined, message: string) => classifyOutside("p", status === undefined ? new Error(message) : new ProviderHttpError("p", status, message))?.kind ?? null;
    const want: Array<[number | undefined, string, string | null]> = [[429, "rate limited", "rate_limit"], [429, "You have reached your specified API usage limits. You will regain access on 2099-12-01 at 00:00 UTC.", "usage_limit"], [401, "invalid_api_key", "auth"], [529, "overloaded", "outage"], [undefined, "fetch failed", "network"], [400, "messages: field required", null], [402, "quota_exceeded", "usage_limit"]];
    for (const [s, m, k] of want) if (c(s, m) !== k) fails.push(`classify ${s} "${m.slice(0, 30)}" → ${c(s, m)}, expected ${k}`);
    const reset = classifyOutside("p", new ProviderHttpError("p", 429, "usage limits … regain access on 2099-12-01 at 00:00 UTC"));
    if (reset?.resetAt !== "2099-12-01T00:00:00.000Z") fails.push(`reset time ${reset?.resetAt}`);

    // an outage twice, then the call succeeds: it continues, no error
    let n = 0;
    const r1 = await withOutside("p", async () => { if (n++ < 2) throw new ProviderHttpError("p", 503, "unavailable"); return "ok"; });
    if (r1 !== "ok" || slept.length !== 2) fails.push(`outage: got ${r1}, slept ${slept.length}×`);

    // a usage limit with a stated reset: waits until then (a visible pause), then resumes
    slept.length = 0;
    events.length = 0;
    const soon = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " at ");
    let m = 0;
    const r2 = await withOutside("p", async () => { if (m++ < 1) throw new ProviderHttpError("p", 429, `You have reached your specified API usage limits. You will regain access on ${soon} UTC.`); return "ok"; });
    if (r2 !== "ok" || !(slept[0]! > 1.9 * 3600e3 && slept[0]! < 2.2 * 3600e3) || events.join() !== "pause:usage_limit,resume:usage_limit") fails.push(`usage limit: slept ${slept[0]} ms, events ${events.join()}`);

    // an expired key: credentials are reloaded before the retry
    events.length = 0;
    let a = 0;
    await withOutside("p", async () => { if (a++ < 1) throw new ProviderHttpError("p", 401, "invalid_api_key"); return 1; });
    if (!events.includes("reload")) fails.push("auth: credentials were not reloaded");

    // a pause longer than allowed ends the run with a resumable PausedError
    const prev = process.env.OPUMIA_MAX_PAUSE_H;
    process.env.OPUMIA_MAX_PAUSE_H = "1";
    const e = await withOutside("p", async () => { throw new ProviderHttpError("p", 429, "usage limits — regain access on 2099-12-01 at 00:00 UTC"); }).catch((x: unknown) => x);
    if (prev === undefined) delete process.env.OPUMIA_MAX_PAUSE_H;
    else process.env.OPUMIA_MAX_PAUSE_H = prev;
    if (!(e instanceof PausedError) || e.resumeAt !== "2099-12-01T00:00:00.000Z") fails.push(`long pause: ${String(e).slice(0, 80)}`);

    // a stock source whose key is rejected is down for the run; the others keep answering
    const realFetch = globalThis.fetch;
    const hadKey = "EUROPEANA_API_KEY" in process.env;
    const asked: string[] = [];
    if (!hadKey) process.env.EUROPEANA_API_KEY = "test-placeholder";
    globalThis.fetch = (async (u: string | URL) => { const h = new URL(String(u)).hostname; asked.push(h); return new Response(h === "api.europeana.eu" ? "{}" : "{}", { status: h === "api.europeana.eu" ? 401 : 200 }); }) as typeof fetch;
    try {
      await searchStock("factory", { kind: "image", orientation: "landscape", perPage: 3, providers: ["europeana"] });
      asked.length = 0;
      await searchStock("factory", { kind: "image", orientation: "landscape", perPage: 3, providers: ["europeana"] });
      if (!providerHealth().europeana) fails.push("europeana with a rejected key should be down");
      if (asked.includes("api.europeana.eu")) fails.push("a down source should not be asked again");
    } finally {
      globalThis.fetch = realFetch;
      if (!hadKey) delete process.env.EUROPEANA_API_KEY;
    }
  } finally {
    setPauseHooks({});
    setSleeper((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await outsideTest();
  console.log(f.length ? `FAIL\n${f.join("\n")}` : "PASS outside failures");
  process.exit(f.length ? 1 : 0);
}
