// The paper-and-cards gate (build list 6, B3a) on known plans, no API: Wirecard v3 (all designed beats) must fail,
// a plan with the channel's mix must pass.
import path from "node:path";
import { paperChecks } from "../flow-checks.js";
const data = path.join(process.cwd(), "data");
const mk = (kinds: string[]) => ({ scenes: kinds.map((k, i) => ({ shotId: `s${i}`, backdrop: k === "card" ? "stage" : "footage", elements: k === "clean" ? [] : [{ type: "text" }] })) }) as never;
const bad = await paperChecks({ data, channel: "magnates-media", scenes: mk([...Array(9).fill("card"), "clean"]) });
const good = await paperChecks({ data, channel: "magnates-media", scenes: mk(["clean", "clean", "clean", "clean", "words", "words", "words", "card", "card", "clean"]) });
for (const [n, r] of [["paper-heavy", bad], ["channel mix", good]] as const) console.log(n, r.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.value}`).join(" | "));
if (bad.every((c) => c.pass) || good.some((c) => !c.pass)) { console.error("paper gate misjudged"); process.exit(1); }
