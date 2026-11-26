// The type gate (build list 6, Wirecard v6 → v7) on the two known films, no API: v6 (torn paper labels on line after
// line, one size) must fail boxed words, one type size and capitals — on the film and on its still previews; v7 (words
// set into footage) must pass those three. Skipped when the hand films are not on this machine.
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { runTypeCheck, typeItems } from "../flow-checks.js";
const root = process.cwd();
const film = (v: string) => path.join(root, "out", `hand-wirecard-${v}`, "film_16x9.mp4");
const stills = (v: string) => { const d = path.join(root, "out", `hand-wirecard-${v}`, "stills"); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".jpg")).map((f) => path.join(d, f)) : []; };
if (!existsSync(film("v6")) || !existsSync(film("v7"))) { console.log("skip: out/hand-wirecard-v6|v7 not on this machine"); process.exit(0); }
const tells = ["boxed_words", "one_type_size", "type_case"];
let bad = false;
for (const [v, mode] of [["v6", "film"], ["v7", "film"], ["v6", "frames"], ["v7", "frames"]] as const) {
  const r = await runTypeCheck({ root, channel: "magnates-media", ...(mode === "film" ? { film: film(v) } : { frames: stills(v) }) });
  if (!r) { console.error(`${v} ${mode}: no report`); bad = true; continue; }
  const items = typeItems(r).filter((c) => tells.includes(c.id));
  console.log(`${v} ${mode}:`, items.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.value}`).join(" | "));
  const want = v === "v7";
  if (items.length < 3 || items.some((c) => c.pass !== want)) { console.error(`  misjudged ${v} ${mode}`); bad = true; }
}
if (bad) process.exit(1);
