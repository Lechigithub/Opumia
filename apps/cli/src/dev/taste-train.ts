/**
 * Train the taste heads (build list D14) and print how well they generalise.
 *   npx tsx apps/cli/src/dev/taste-train.ts [channel] [thumb|shot|both]
 */
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import { trainTaste, type TasteKind } from "@opumia/agents";

const root = process.cwd();
const data = path.join(root, process.env.OPUMIA_DATA_DIR ?? "data");
const reference = path.join(root, process.env.OPUMIA_REFERENCE_DIR ?? "Reference");
const channel = (process.argv[2] ?? "magnates-media") as ChannelId;
const which = process.argv[3] ?? "both";
const kinds: TasteKind[] = which === "both" ? ["thumb", "shot"] : [which as TasteKind];
for (const kind of kinds) {
  const t0 = Date.now();
  const m = await trainTaste({ root, data, reference, channel, kind, log: (s) => console.log(s) });
  const c = m.calibration;
  console.log(`\n${kind}: pro AUC ${m.pro.auc.toFixed(3)} (${m.pro.n.pos}+/${m.pro.n.neg}-), channel AUC ${m.channelHead.auc.toFixed(3)} (${m.channelHead.n.pos}+/${m.channelHead.n.neg}-)`);
  console.log(`  held-out score /10: real median ${c.real.median.toFixed(1)} (p10 ${c.real.p10.toFixed(1)}, n ${c.real.n}) · ours median ${c.ours.median.toFixed(1)} (p90 ${c.ours.p90.toFixed(1)}, n ${c.ours.n}) · degraded median ${c.degraded.median.toFixed(1)} (n ${c.degraded.n}) · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
