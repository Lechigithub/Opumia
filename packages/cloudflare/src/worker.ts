import { JobsTable } from "./d1.js";
import type { Env, ProductionParams } from "./env.js";

export { RendererContainer } from "./container.js";
export { ProductionWorkflow } from "./workflow.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
const CHANNELS = ["magnates-media", "logically-answered", "big-company", "modern-mba", "how-money-works", "moon"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Timing-safe token comparison. */
function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const safeKey = (k: string) => k && !k.split("/").includes("..") && !k.startsWith("/");

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const jobs = new JobsTable(env.DB);

    // ---- Internal R2 proxy for the renderer container (it has no bindings of its own).
    if (url.pathname.startsWith("/internal/")) {
      if (!same(bearer(req), env.INTERNAL_TOKEN)) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/internal/r2-list") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const out: Array<{ key: string; size: number; etag: string }> = [];
        let cursor: string | undefined;
        do {
          const page = await env.MEDIA.list({ prefix, ...(cursor ? { cursor } : {}) });
          for (const o of page.objects) out.push({ key: o.key, size: o.size, etag: o.etag });
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return json(out);
      }
      const key = decodeURIComponent(url.pathname.slice("/internal/r2/".length));
      if (!url.pathname.startsWith("/internal/r2/") || !safeKey(key)) return json({ error: "bad key" }, 400);
      if (req.method === "GET") {
        const o = await env.MEDIA.get(key);
        return o ? new Response(o.body, { headers: { etag: o.etag, "content-length": String(o.size) } }) : json({ error: "not found" }, 404);
      }
      if (req.method === "PUT") {
        // The container may only write job outputs and data/ caches — never library/ or reference/.
        if (!/^(jobs\/[\w.-]+\/|data\/)/.test(key)) return json({ error: "read-only prefix" }, 403);
        await env.MEDIA.put(key, req.body);
        return json({ ok: true, key });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ---- Public job API.
    if (!same(bearer(req), env.API_TOKEN)) return json({ error: "unauthorized" }, 401);

    if (req.method === "POST" && url.pathname === "/jobs") {
      const b = (await req.json().catch(() => null)) as Partial<ProductionParams> | null;
      if (!b?.topic || typeof b.topic !== "string" || b.topic.length > 300) return json({ error: "topic required (≤ 300 chars)" }, 400);
      const channel = b.channel ?? "magnates-media";
      if (!CHANNELS.includes(channel)) return json({ error: `channel must be one of ${CHANNELS.join(", ")}` }, 400);
      const aspect = b.aspect === "16:9" ? "16:9" : "9:16";
      const durationS = Math.min(1200, Math.max(20, Number(b.durationS ?? (aspect === "9:16" ? 60 : 600))));
      const jobId = `${slug(b.topic)}-${channel}-${aspect.replace(":", "x")}-${crypto.randomUUID().slice(0, 8)}`;
      await jobs.create({ id: jobId, topic: b.topic, channel, aspect, duration_s: durationS });
      const instance = await env.PRODUCTION.create({ id: jobId, params: { jobId, topic: b.topic, channel, aspect, durationS } });
      return json({ jobId, workflow: instance.id, status: "queued" }, 202);
    }

    const m = /^\/jobs\/([\w.-]+)(?:\/files\/(.+))?$/.exec(url.pathname);
    if (m && req.method === "GET") {
      const job = await jobs.get(m[1]!);
      if (!job) return json({ error: "not found" }, 404);
      if (m[2]) {
        const key = `jobs/${job.id}/${decodeURIComponent(m[2])}`;
        if (!safeKey(key)) return json({ error: "bad key" }, 400);
        const o = await env.MEDIA.get(key);
        return o ? new Response(o.body, { headers: { "content-type": o.httpMetadata?.contentType ?? "application/octet-stream" } }) : json({ error: "file not found" }, 404);
      }
      const status = job.workflow_id ? await (await env.PRODUCTION.get(job.workflow_id)).status().catch(() => null) : null;
      return json({ job, workflow: status });
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
