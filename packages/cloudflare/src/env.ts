import type { RendererContainer } from "./container.js";

export interface Env {
  MEDIA: R2Bucket; // library/…, reference/…, data/…, jobs/<id>/…
  DB: D1Database;
  PRODUCTION: Workflow<ProductionParams>;
  RENDERER: DurableObjectNamespace<RendererContainer>;
  /** Bearer token for the public job API. */
  API_TOKEN: string;
  /** Shared secret between this Worker and the renderer container (R2 proxy + stage calls). */
  INTERNAL_TOKEN: string;
  /** Public URL of this Worker, handed to the container for the R2 proxy. */
  PUBLIC_URL: string;
  // Provider secrets forwarded to the container (wrangler secret put …).
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  PEXELS_API_KEY: string;
  PIXABAY_API_KEY: string;
  COVERR_API_KEY: string;
  VECTEEZY_API_KEY: string;
  VECTEEZY_ACCOUNT_ID: string;
  VIMEO_ACCESS_TOKEN: string;
  EUROPEANA_API_KEY: string;
  NARA_API_KEY: string;
  WIKIMEDIA_ACCESS_TOKEN: string;
  HF_API_KEY_ID: string;
  HF_API_KEY_SECRET: string;
}

export interface ProductionParams {
  jobId: string;
  topic: string;
  channel: string;
  aspect: "9:16" | "16:9";
  durationS: number;
}

/** Same order as the local CLI's STAGES. */
export const STAGES = ["research", "script", "narration", "storyboard", "resolve", "manifest", "render", "thumbnail", "qa"] as const;
export type Stage = (typeof STAGES)[number];
