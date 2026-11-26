// Effects and transitions on cooldown (build list 6, B2/B4), no API: the FTX v35 and Wirecard v3 hand kits share most of
// their finished-look effects (the template the owner saw); Wirecard v4's kit shares none.
import { readFile } from "node:fs/promises";
import { DEVICE_SHARE_MAX, kitDevices } from "@opumia/agents";
const k = async (f: string) => kitDevices(await readFile(`apps/cli/src/dev/hand/${f}`, "utf8"));
const ftx = await k("kit-hand-ftx-v35.tsx.txt"), w3 = await k("kit-hand-wirecard-v3.tsx.txt"), w4 = await k("kit-hand-wirecard-v4.tsx.txt");
// how much of the NEW kit (first) is borrowed from the earlier one (second)
const jac = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length / Math.max(1, a.length);
console.log("FTX v35:", ftx.join(" "), "\nWirecard v3:", w3.join(" "), "\nWirecard v4:", w4.join(" ") || "(plain blocks only)");
console.log(`Wirecard v3 borrowed from FTX v35 ${jac(w3, ftx).toFixed(2)} | Wirecard v4 borrowed from FTX v35 ${jac(w4, ftx).toFixed(2)} (limit ${DEVICE_SHARE_MAX})`);
if (!(jac(w3, ftx) > DEVICE_SHARE_MAX) || jac(w4, ftx) > DEVICE_SHARE_MAX) { console.error("device cooldown misjudged"); process.exit(1); }
