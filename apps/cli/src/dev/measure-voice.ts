// Measure a channel's narrator in passage mode (once; stored in data/voice-calibration.json under "<voice>|<model>|passage").
//   npx tsx apps/cli/src/dev/measure-voice.ts [channel]
import { ensureVoiceMeasured, resolveChannelVoice, ttsModel } from "@opumia/narration";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const channel = (process.argv[2] ?? "magnates-media") as never;
const voice = await resolveChannelVoice(channel, "data", console.log);
console.log(await ensureVoiceMeasured({ dataDir: "data", voice, modelId: ttsModel(), log: console.log }));
