// The script referee must pass the channel's own held-back narrations and catch our scripts and cheap tricks
// (tools/referee/script_referee.py; data/referee/magnates-media-script.json). No API.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { scriptReferee } from "@opumia/agents";

const ROOT = process.cwd(), DATA = path.join(ROOT, "data");
const modelFile = path.join(DATA, "referee", "magnates-media-script.json");
let fails = 0;
const ok = (name: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); if (!pass) fails++; };
if (!existsSync(modelFile)) { console.log("SKIP: the script referee is not built (python tools/referee/script_referee.py build)"); process.exit(0); }
const M = JSON.parse(readFileSync(modelFile, "utf8")) as { held: string[]; bars: { film: number; short: number }; test: Record<string, unknown> };
const films = JSON.parse(readFileSync(path.join(DATA, "story-profile", "magnates-media-films.json"), "utf8")) as Array<{ id: string; lines: Array<string | { text: string }> }>;
const text = (f: (typeof films)[number]) => f.lines.map((l) => (typeof l === "string" ? l : l.text)).join(" ");

// the channel's own held-back narrations (never trained on): whole, and their 90 s openings
for (const f of films.filter((x) => M.held.includes(x.id))) {
  const whole = scriptReferee(ROOT, text(f))!, open = scriptReferee(ROOT, text(f).split(/\s+/).slice(0, 300).join(" "))!;
  ok(`held-back ${f.id} whole reads like the channel`, whole.pass, `${whole.score} (bar ${whole.bar})`);
  ok(`held-back ${f.id} 90 s opening reads like the channel`, open.pass, `${open.score} (bar ${open.bar})`);
}
// measured at build time on never-seen material
const t = M.test as { heldBackWindowsFlagged: number; ourWindowsCaught: number; gamedWindowsCaught: number };
ok("held-back channel windows rarely flagged (≤ 5 %)", t.heldBackWindowsFlagged <= 0.05, t.heldBackWindowsFlagged);
ok("our windows caught (≥ 75 %)", t.ourWindowsCaught >= 0.75, t.ourWindowsCaught);
ok("cheap tricks on never-seen scripts caught (≥ 75 %)", t.gamedWindowsCaught >= 0.75, t.gamedWindowsCaught);
// a known script of ours that does not read like the channel
const j = path.join(ROOT, "out", "agent-juicero-3", "script.draft.json");
if (existsSync(j)) {
  const v = scriptReferee(ROOT, (JSON.parse(readFileSync(j, "utf8")) as { segments: Array<{ text: string }> }).segments.map((s) => s.text).join(" "))!;
  ok("agent Juicero's script (accepted by the old checks) does not pass", !v.pass, `${v.score} (bar ${v.bar})`);
  ok("the writer is told craft gaps, never single words to sprinkle", v.gaps.every((g) => !g.what.startsWith('the word "')), v.gaps.map((g) => g.what));
}
console.log(fails ? `${fails} failed` : "script referee: all passed");
process.exitCode = fails ? 1 : 0;
