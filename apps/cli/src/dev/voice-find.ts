// Resolve an ElevenLabs voice by name (prints id/name/labels only — never a key).
import { findVoiceByName } from "@opumia/narration";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const v = await findVoiceByName(process.argv[2] ?? "Christopher");
console.log(JSON.stringify(v, null, 2));
