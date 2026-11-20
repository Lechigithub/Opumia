import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Higgsfield API adapter (docs.higgsfield.ai): POST {model path} with `Authorization: Key <id>:<secret>`,
 * then poll the returned status_url until `completed` and read images[].url.
 * Thumbnails are the only generated imagery in the platform; they never enter the film timeline.
 */
export interface HiggsfieldConfig {
  keyId: string;
  keySecret: string;
  modelPath: string;
  baseUrl: string;
}

export function higgsfieldConfig(): HiggsfieldConfig | null {
  const combined = process.env.HIGGSFIELD_API_KEY; // "id:secret"
  const keyId = process.env.HF_API_KEY_ID ?? process.env.HIGGSFIELD_API_KEY_ID ?? combined?.split(":")[0];
  const keySecret = process.env.HF_API_KEY_SECRET ?? process.env.HIGGSFIELD_API_SECRET ?? combined?.split(":").slice(1).join(":");
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret, modelPath: process.env.HIGGSFIELD_IMAGE_MODEL ?? "/higgsfield-ai/soul/v2/standard", baseUrl: process.env.HIGGSFIELD_BASE_URL ?? "https://api.higgsfield.ai" };
}

interface StatusResponse {
  status: "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";
  request_id: string;
  status_url?: string;
  images?: Array<{ url: string }>;
  error?: unknown;
}

export async function higgsfieldImage(cfg: HiggsfieldConfig, o: { prompt: string; aspect: "9:16" | "16:9"; out: string; timeoutMs?: number }): Promise<{ path: string; requestId: string }> {
  const headers = { Authorization: `Key ${cfg.keyId}:${cfg.keySecret}`, "Content-Type": "application/json", Accept: "application/json" };
  const submit = await fetch(`${cfg.baseUrl}${cfg.modelPath}`, { method: "POST", headers, body: JSON.stringify({ prompt: o.prompt, aspect_ratio: o.aspect }), signal: AbortSignal.timeout(60_000) });
  if (!submit.ok) throw new Error(`Higgsfield submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  let st = (await submit.json()) as StatusResponse;
  const statusUrl = st.status_url ?? `${cfg.baseUrl}/requests/${st.request_id}/status`;
  const deadline = Date.now() + (o.timeoutMs ?? 300_000);
  while (st.status === "queued" || st.status === "in_progress") {
    if (Date.now() > deadline) throw new Error(`Higgsfield request ${st.request_id} timed out`);
    await new Promise((r) => setTimeout(r, 3000));
    const r = await fetch(statusUrl, { headers, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Higgsfield status ${r.status}`);
    st = (await r.json()) as StatusResponse;
  }
  if (st.status !== "completed" || !st.images?.[0]?.url) throw new Error(`Higgsfield request ${st.request_id} ended ${st.status}`);
  await mkdir(path.dirname(o.out), { recursive: true });
  const img = await fetch(st.images[0].url, { signal: AbortSignal.timeout(120_000) });
  if (!img.ok || !img.body) throw new Error(`Higgsfield image download ${img.status}`);
  await pipeline(Readable.fromWeb(img.body as never), createWriteStream(o.out));
  return { path: o.out, requestId: st.request_id };
}
