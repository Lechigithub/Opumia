// Proof film 1 (2026-11-26, Wirecard by the agents) stopped at the art director: given $0.27 (stage share) when its
// first pass needs $0.60, it submitted a complete kit, ran out before its final look, and the film ended. No API:
//  - the kit's transition is read from FILM, not from a component's CSS `transition: "none"`;
//  - the art director's stage share covers its measured first pass on the 90 s floor target ($3);
//  - the kit that film wrote (complete: roles, transition) is recognised.
import { readFileSync, existsSync } from "node:fs";
import { kitTransition, STAGE_SHARE } from "@opumia/agents";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`${c ? "ok  " : "FAIL"} ${w}`); if (!c) bad++; };
const code = 'const W = () => <span style={{ transition: "none" }}>x</span>;\nexport const FILM = {\n  components: {},\n  transitions: { ledger: Ledger },\n  transition: "ledger",\n  transitionFrames: 11,\n};';
ok(kitTransition(code) === "ledger", `transition read from FILM: ${kitTransition(code)}`);
ok(STAGE_SHARE.B2d!.usd * 3 >= 0.6, `art director share on the $3 floor: $${(STAGE_SHARE.B2d!.usd * 3).toFixed(2)} >= $0.60`);
const kit = "out/proof-wirecard-a/design/film/index.tsx";
if (existsSync(kit)) { const t = kitTransition(readFileSync(kit, "utf8")); ok(t !== null && t !== "none" && /transitions\s*:\s*\{[^}]*\b/.test(readFileSync(kit, "utf8")) && new RegExp(`\\b${t}\\s*:`).test(readFileSync(kit, "utf8")), `proof film 1's own kit: transition "${t}" is one of its own transitions`); }
if (bad) process.exit(1);
