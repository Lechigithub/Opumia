// Build list 5, item 13: the figure on screen equals what the voice says at that moment, totals included.
//   npx tsx apps/cli/src/dev/design-parity-test.ts
import { figureParity } from "@opumia/agents";
import { figureInputs } from "@opumia/motion-engine";

const words = (t: string, at = 0) => t.split(" ").map((word, k) => ({ word, startS: at + k * 0.3 }));
const fails: string[] = [];
// the Nokia ending: the voice says €5.44 billion, the chart shows €3.8B and €1.6B (3.8 + 1.6 = 5.4 ≠ 5.44)
const nokia = figureParity(figureInputs([{ id: "sh30", startS: 0, endS: 4, shown: ["€3.8B", "€1.6B"] }], words("Microsoft paid €5.44 billion for it")));
if (!nokia.length) fails.push("parts that do not add up to the spoken total must fail");
const ok = figureParity(figureInputs([{ id: "a", startS: 0, endS: 4, shown: ["€3.79B", "€1.65B"] }], words("Microsoft paid €5.44 billion for it")));
if (ok.length) fails.push(`parts that add up to the spoken total must pass: ${JSON.stringify(ok)}`);
const same = figureParity(figureInputs([{ id: "b", startS: 0, endS: 4, shown: ["$7.2B"] }], words("worth $7.2 billion by then")));
if (same.length) fails.push("a figure said as shown must pass");
const unsaid = figureParity(figureInputs([{ id: "c", startS: 0, endS: 4, shown: ["$9B"] }], words("worth $7.2 billion by then")));
if (!unsaid.length) fails.push("a figure never said must fail");
const year = figureParity(figureInputs([{ id: "d", startS: 0, endS: 4, shown: ["2007"] }], words("then the iPhone arrived")));
if (year.length) fails.push("a year on screen is not a figure to check");
console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "PASS figure parity (totals included)");
process.exit(fails.length ? 1 : 0);
