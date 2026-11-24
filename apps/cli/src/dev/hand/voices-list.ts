// The account's ElevenLabs voices: names and labels only.
import { loadKeys } from "../../keys.js";
loadKeys(process.cwd());
const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! } });
const j = (await r.json()) as { voices: Array<{ voice_id: string; name: string; category?: string; labels?: Record<string, string> }> };
for (const v of j.voices) console.log(`${v.voice_id} | ${v.name} | ${v.category} | ${Object.values(v.labels ?? {}).join(", ")}`);
