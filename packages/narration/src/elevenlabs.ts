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
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`ElevenLabs ${status}: ${body.slice(0, 300)}`);
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
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    if (res.ok) {
      const j = (await res.json()) as { audio_base64: string; alignment?: CharAlignment | null; normalized_alignment?: CharAlignment | null };
      if (!j.alignment) throw new Error("ElevenLabs returned no alignment");
      return {
        audio: Buffer.from(j.audio_base64, "base64"),
        alignment: j.alignment,
        ...(j.normalized_alignment ? { normalized: j.normalized_alignment } : {}),
        requestId: res.headers.get("request-id") ?? undefined,
        characters: r.text.length,
      };
    }
    const txt = await res.text();
    lastErr = new ElevenLabsError(res.status, txt);
    if (res.status !== 429 && res.status < 500) break; // 4xx other than rate limit: not retryable
    await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
  }
  throw lastErr;
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
