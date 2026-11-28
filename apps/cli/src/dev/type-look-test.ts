// Type look (2026-11-28): MoviePass, made by copying the Juicero rebuild's code, must be caught as set like it; films
// that set their words their own way must pass. Uses the films on disk (skips what is missing). No API.
import { existsSync } from "node:fs";
import path from "node:path";
import { typeLook } from "../film-agent/checks.js";
const ROOT = process.env.OPUMIA_ROOT ?? process.cwd();
const film = (j: string) => path.join(ROOT, "out", j, "film_16x9.mp4");
let fail = 0, ran = 0;
const ok = (c: boolean, m: string) => { ran++; if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${m}`); };
if (!existsSync(path.join(ROOT, "data", "world-profile", "films", "hand-juicero-r.type.json")) || !existsSync(film("hand-moviepass"))) {
  console.log("type-look: films or their type looks not on disk — skipped (python -I tools/world/type_look.py save hand-juicero-r …)");
} else {
  const mp = typeLook(ROOT, "hand-moviepass", film("hand-moviepass"));
  ok(Boolean(mp && !mp.pass && mp.tooClose.some((x) => x.film === "hand-juicero-r")), `MoviePass is caught as set like the Juicero rebuild (${mp?.tooClose.map((x) => `${x.film} ${x.distance}`).join(", ")}; bar ${mp?.bar})`);
  if (existsSync(film("hand-wirecard-v7"))) { const w = typeLook(ROOT, "hand-wirecard-v7", film("hand-wirecard-v7")); ok(Boolean(w?.pass), `Wirecard v7 sets its words its own way (nearest ${w ? "farther than the bar" : "?"})`); }
}
console.log(fail ? `type-look: ${fail}/${ran} FAILED` : `type-look: ${ran} checks pass`);
process.exitCode = fail ? 1 : 0;
