import { recordExternal, ttsUsdPer1k } from "@opumia/agents";
import { withOutside } from "@opumia/senses";
export interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface TtsRequest {
  voiceId: string;
  modelId: string;
  text: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  previousText?: string;
  nextText?: string;
  outputFormat?: string;
  seed?: number;
}

export interface TtsResult {
  audio: Buffer;
  alignment: CharAlignment;
  normalized?: CharAlignment;
  requestId?: string;
  characters: number;
}

export class ElevenLabsError extends Error {
  readonly body: string;
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`ElevenLabs ${status}: ${body.slice(0, 300)}`);
    this.body = body;
  }
}

/** POST /v1/text-to-speech/{voice_id}/with-timestamps — audio plus per-character timings. */
export async function ttsWithTimestamps(r: TtsRequest, apiKey = process.env.ELEVENLABS_API_KEY): Promise<TtsResult> {
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(r.voiceId)}/with-timestamps?output_format=${encodeURIComponent(r.outputFormat ?? "mp3_44100_192")}`;
  const body = {
    text: r.text,
    model_id: r.modelId,
    voice_settings: {
      stability: r.stability ?? 0.45,
      similarity_boost: r.similarityBoost ?? 0.8,
      style: r.style ?? 0.25,
      speed: r.speed ?? 1,
      use_speaker_boost: true,
    },
    ...(r.previousText ? { previous_text: r.previousText } : {}),
    ...(r.nextText ? { next_text: r.nextText } : {}),
    ...(r.seed !== undefined ? { seed: r.seed } : {}),
    apply_text_normalization: "auto",
  };
  // build list 3, part D: a quota, an expired key, a rate limit or an outage waits and retries (see senses/outside.ts)
  return withOutside("elevenlabs", async () => {
    const res = await fetch(url, { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY || apiKey, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after") ?? NaN);
      throw Object.assign(new ElevenLabsError(res.status, await res.text()), Number.isFinite(ra) ? { retryAfterS: ra } : {});
    }
    const j = (await res.json()) as { audio_base64: string; alignment?: CharAlignment | null; normalized_alignment?: CharAlignment | null };
    if (!j.alignment) throw new Error("ElevenLabs returned no alignment");
    recordExternal("narration.tts", `elevenlabs:${r.modelId}`, r.text.length, (r.text.length / 1000) * ttsUsdPer1k());
    return {
      audio: Buffer.from(j.audio_base64, "base64"),
      alignment: j.alignment,
      ...(j.normalized_alignment ? { normalized: j.normalized_alignment } : {}),
      requestId: res.headers.get("request-id") ?? undefined,
      characters: r.text.length,
    };
  });
}

export async function remainingCharacters(apiKey = process.env.ELEVENLABS_API_KEY): Promise<number | null> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": apiKey ?? "" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { character_count?: number; character_limit?: number };
    return j.character_limit !== undefined && j.character_count !== undefined ? j.character_limit - j.character_count : null;
  } catch {
    return null;
  }
}

export interface VoiceInfo {
  voiceId: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  /** "account" = already in the user's voice list; "library" = shared library voice (must be added before use). */
  source: "account" | "library";
  publicOwnerId?: string;
}

/**
 * Find a voice by display name: the account's voices first (GET /v1/voices), then the shared voice library.
 * Exact (case-insensitive) name match wins; otherwise the first name that starts with the query.
 */
export async function findVoiceByName(query: string, apiKey = process.env.ELEVENLABS_API_KEY): Promise<VoiceInfo | null> {
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const q = query.trim().toLowerCase();
  const rank = (n: string) => (n.toLowerCase() === q ? 0 : n.toLowerCase().split(/[\s-]/)[0] === q ? 1 : n.toLowerCase().startsWith(q) ? 2 : n.toLowerCase().includes(q) ? 3 : 9);
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ElevenLabsError(res.status, await res.text());
  const j = (await res.json()) as { voices: Array<{ voice_id: string; name: string; category?: string; labels?: Record<string, string> }> };
  const own = j.voices.map((v) => ({ v, r: rank(v.name) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.v.name.localeCompare(b.v.name))[0];
  if (own) return { voiceId: own.v.voice_id, name: own.v.name, ...(own.v.category ? { category: own.v.category } : {}), ...(own.v.labels ? { labels: own.v.labels } : {}), source: "account" };
  const lib = await fetch(`https://api.elevenlabs.io/v1/shared-voices?page_size=30&search=${encodeURIComponent(query)}`, { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(20_000) });
  if (!lib.ok) return null;
  const lj = (await lib.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string; public_owner_id?: string; accent?: string; gender?: string; age?: string; use_case?: string; descriptive?: string }> };
  const best = (lj.voices ?? []).map((v) => ({ v, r: rank(v.name) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.v.name.localeCompare(b.v.name))[0];
  if (!best) return null;
  const labels = Object.fromEntries(Object.entries({ accent: best.v.accent, gender: best.v.gender, age: best.v.age, use_case: best.v.use_case, descriptive: best.v.descriptive }).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  return { voiceId: best.v.voice_id, name: best.v.name, ...(best.v.category ? { category: best.v.category } : {}), labels, source: "library", ...(best.v.public_owner_id ? { publicOwnerId: best.v.public_owner_id } : {}) };
}
