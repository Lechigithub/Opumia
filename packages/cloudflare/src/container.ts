import { Container } from "@cloudflare/containers";
import type { Env } from "./env.js";

/**
 * Renderer container: Node 22 + FFmpeg + Chromium running apps/container (the same `produce` code as
 * the local CLI). One instance per job (getContainer(binding, jobId)) so a job's working files stay warm
 * between stages; R2 remains the source of truth.
 */
export class RendererContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "20m";
  override enableInternet = true; // stock/archival APIs, ElevenLabs, Anthropic, Higgsfield

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      OPUMIA_REMOTE_URL: env.PUBLIC_URL,
      OPUMIA_INTERNAL_TOKEN: env.INTERNAL_TOKEN,
      OPUMIA_ROOT: "/work",
      OPUMIA_LIBRARY_DIR: "/work/Library",
      OPUMIA_REFERENCE_DIR: "/work/Reference",
      OPUMIA_DATA_DIR: "/work/data",
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY,
      PEXELS_API_KEY: env.PEXELS_API_KEY,
      PIXABAY_API_KEY: env.PIXABAY_API_KEY,
      COVERR_API_KEY: env.COVERR_API_KEY,
      VECTEEZY_API_KEY: env.VECTEEZY_API_KEY,
      VECTEEZY_ACCOUNT_ID: env.VECTEEZY_ACCOUNT_ID,
      VIMEO_ACCESS_TOKEN: env.VIMEO_ACCESS_TOKEN,
      EUROPEANA_API_KEY: env.EUROPEANA_API_KEY,
      NARA_API_KEY: env.NARA_API_KEY,
      WIKIMEDIA_ACCESS_TOKEN: env.WIKIMEDIA_ACCESS_TOKEN,
      HF_API_KEY_ID: env.HF_API_KEY_ID,
      HF_API_KEY_SECRET: env.HF_API_KEY_SECRET,
    };
  }

  override onError(error: unknown) {
    console.error("renderer container error", error);
    throw error;
  }
}
