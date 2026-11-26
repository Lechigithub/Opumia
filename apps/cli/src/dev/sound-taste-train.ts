// Ears with taste: train the voice (humanness) and mix heads on the reference against our films (local models only).
//   npx tsx apps/cli/src/dev/sound-taste-train.ts [--channel magnates-media] [--kinds voice,mix,bed]
import path from "node:path";
import { trainSoundTaste } from "@opumia/agents";

const root = process.cwd();
const ci = process.argv.indexOf("--channel");
const channel = (ci > 0 ? process.argv[ci + 1] : "magnates-media") as never;
const ki = process.argv.indexOf("--kinds");
const kinds = (ki > 0 ? process.argv[ki + 1]!.split(",") : ["voice", "mix", "bed"]) as Array<"voice" | "mix" | "bed">;
for (const kind of kinds) {
  const m = await trainSoundTaste({ root, data: path.join(root, "data"), reference: process.env.OPUMIA_REFERENCE_DIR ?? path.join(root, "Reference"), channel, kind, log: console.log });
  console.log(`${kind}: AUC ${m.auc} on held-out films (${m.trained.real} real, ${m.trained.ours} ours) — real p10 ${m.calibration.real.p10}, real median ${m.calibration.real.median}, ours median ${m.calibration.ours.median}`);
}
