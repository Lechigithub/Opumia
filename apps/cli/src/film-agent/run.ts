// The film agent (owner, 2026-11-26: "the agents and the platform should work, think, execute … like you do";
// "build the parallel version first"). Research, script and narration come from the platform's own agents; then:
//   1. the PLANNER (one Sonnet session) watches the reference and writes the whole film's plan: its world as code
//      (src/world.tsx), its signature object and a scene per idea (plan.json) — one mind keeps the film coherent;
//   2. SCENE BUILDERS (one session per scene, several at once) each find their scene's real pictures and build it in
//      src/scenes/<id>.tsx, rendered through its own entry, until its scene check passes;
//   3. code assembles src/Film.tsx and renders the film;
//   4. the FINISHER (the planner's session again) watches the film beside the reference, sends scenes back to their
//      builders (in parallel) or fixes seams itself, mixes the sound and runs the gate.
//   pnpm opumia film-agent --topic "…" [--job NAME] [--duration 70] [--max-usd 9] [--parallel 6] [--solo] [--dry-run]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, cpSync, chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { filmGate } from "./gate.js";
import { readPlan, validatePlan, scaffold, sceneBrief, type FilmPlan } from "./plan.js";
import { sceneCheck } from "./scene-check.js";

export interface FilmAgentOptions {
  root: string; topic?: string; job: string; channel: string; durationS: number; maxUsd: number; model: string;
  builderModel?: string; parallel?: number; solo?: boolean; dryRun?: boolean; log?: (s: string) => void;
}

/** The guard on every action an agent takes (the platform's hard rules; the SDK asks it before each tool use).
 *  A scene builder (scene set) may write only its own scene's files. */
export function guard(job: string, root: string, scene?: string) {
  const inside = (p: string, dir: string) => { const r = path.relative(dir, path.resolve(job, p)); return !r.startsWith("..") && !path.isAbsolute(r); };
  const memory = path.join(root, "data", "agents", "film-agent");
  const SECRET = /(\.opumia_keys|(^|[\/\s"'])\.env(\.|\b)|keychain|\.ssh\/|\.aws\/|\.claude\/|credentials\.json|id_rsa)/i;
  const BASH_DENY: Array<[RegExp, string]> = [
    [/(^|[;&|(]\s*)(env|printenv|set|export -p|declare -x)\s*($|[;&|)>])/, "never dump the environment"],
    [/\bsecurity\s+(find|dump|add|delete|unlock|export)/, "never touch the Keychain"],
    [/\bprintenv\b|\bcompgen\s+-v\b|\/proc\/\S*environ|\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)\w*|process\.env|os\.environ|ENV\[/i, "never read a key or the environment"],
    [SECRET, "never read or copy a secret"],
    [/\bgit\s+(push|commit|reset|checkout|rebase|merge|tag|stash|clean)\b/, "no git changes — the owner commits"],
    [/\bsudo\b|\bchmod\s+-R\s+\/|\bmkfs\b|\bdd\s+if=/, "not allowed"],
    [/(>|>>|\btee\b|\bmv\b|\bcp\b|\brm\b|\bsed\s+-i\b|\btouch\b|\bmkdir\b|\bln\b|\bunlink\b|\brsync\b)[^;&|\n]*\b(Library|Reference)\//, "Library/ and Reference/ are read-only"],
    [/\bcurl\b[^;&|\n]*\s-(X\s*(POST|PUT|DELETE|PATCH)|d\s|-data)/i, "no sending data to outside services"],
  ];
  const WRITE_OP = /(>|>>|\btee\b|\bmv\b|\bcp\b|\brm\b|\bsed\s+-i\b|\btouch\b|\bln\b|\bunlink\b|\brsync\b|\bperl\s+-pi\b)/;
  /** a builder's own files: its scene (and folder), its media, downloads, stills, notes and ledgers */
  const ownBuilder = (abs: string) => {
    const r = path.relative(job, abs).split(path.sep).join("/");
    return r === `src/scenes/${scene}.tsx` || r.startsWith(`src/scenes/${scene}/`) || new RegExp(`^public/(v|img|a)/${scene}_`).test(r)
      || [`downloads/${scene}/`, `stills/${scene}/`, `watch/${scene}`].some((d) => r.startsWith(d)) || [`notes/${scene}.md`, `credits/${scene}.json`, `fair-use/${scene}.json`].includes(r);
  };
  return async (tool: string, input: Record<string, unknown>) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const allow = { behavior: "allow" as const, updatedInput: input };
    if (tool === "Bash") {
      const c = String(input.command ?? "");
      for (const [re, why] of BASH_DENY) if (re.test(c)) return deny(`${why} (film agent guard)`);
      for (const m of c.matchAll(/\brm\s+(-[a-zA-Z]+\s+)*([^;&|\n]+)/g)) for (const p of (m[2] ?? "").trim().split(/\s+/)) if (p && !p.startsWith("-") && !inside(p, job)) return deny(`rm outside the workspace: ${p} (film agent guard)`);
      if (scene && WRITE_OP.test(c)) {
        const other = [...c.matchAll(/src\/scenes\/(s\d{2})/g)].map((m) => m[1]).find((x) => x !== scene);
        if (other) return deny(`scene ${other} belongs to its own builder — change only ${scene} (film agent guard)`);
        if (/\b(plan\.json|src\/world\.tsx|src\/Film\.tsx|mix\.json)\b/.test(c)) return deny("the plan, the world and the film belong to the planner — write what you need in notes/" + scene + ".md (film agent guard)");
      }
      return allow;
    }
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const p = String(input.file_path ?? input.notebook_path ?? "");
      if (SECRET.test(p)) return deny("never write a secret (film agent guard)");
      if (inside(p, memory)) return allow;
      if (!inside(p, job)) return deny(`write only inside the workspace (${job}) or your memory (${memory}) (film agent guard)`);
      if (scene && !ownBuilder(path.resolve(job, p))) return deny(`you build ${scene}: write only src/scenes/${scene}.tsx, src/scenes/${scene}/…, public/v|img/${scene}_…, downloads/${scene}/…, stills/${scene}/…, notes/${scene}.md (film agent guard)`);
      return allow;
    }
    if (["Read", "Glob", "Grep"].includes(tool)) {
      const p = String(input.file_path ?? input.path ?? input.pattern ?? "");
      return SECRET.test(p) ? deny("never read a secret (film agent guard)") : allow;
    }
    return allow;
  };
}

/** Prepare the workspace: narration (the platform's research, writer and voice), the Remotion project, the tools. */
export function prepareWorkspace(o: FilmAgentOptions): { before: number; durationS: number; lengthS: number } {
  const log = o.log ?? console.log;
  const job = o.job;
  mkdirSync(job, { recursive: true });
  if (!existsSync(path.join(job, "timed-script.json"))) {
    if (o.dryRun || !o.topic) throw new Error("no narration in the workspace (run without --dry-run and with --topic to make it)");
    log("[A] research, script and narration (the platform's own agents)…");
    const r = spawnSync("pnpm", ["-s", "opumia", "produce", "--topic", o.topic, "--channel", o.channel, "--aspect", "16:9", "--duration", String(o.durationS), "--job", path.basename(job), "--until", "narration"], { cwd: o.root, stdio: "inherit", env: { ...process.env, OPUMIA_MAX_USD: String(o.maxUsd) } });
    if (r.status !== 0 || !existsSync(path.join(job, "timed-script.json"))) throw new Error("narration did not finish — see the log above");
  }
  const timing = (() => { try { return JSON.parse(readFileSync(path.join(job, "timing.json"), "utf8")) as { runs: Array<{ filmUsd?: number; usd?: number }> }; } catch { return { runs: [] }; } })();
  const before = timing.runs.reduce((m, r) => Math.max(m, r.filmUsd ?? r.usd ?? 0), 0);
  const durationS = (JSON.parse(readFileSync(path.join(job, "timed-script.json"), "utf8")) as { durationS: number }).durationS;
  const lengthS = Math.round((durationS + 2.6) * 100) / 100;
  const src = path.join(job, "src");
  if (!existsSync(path.join(src, "index.ts"))) cpSync(path.join(o.root, "apps/cli/src/film-agent/template/src"), src, { recursive: true });
  writeFileSync(path.join(src, "length.json"), JSON.stringify({ seconds: lengthS }));
  for (const d of ["public/v", "public/img", "downloads", "watch", "notes", "credits", "fair-use"]) mkdirSync(path.join(job, d), { recursive: true });
  const bin = path.join(job, ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "film-tools"), `#!/bin/sh\nexec npx --prefix "${o.root}" tsx "${path.join(o.root, "apps/cli/src/film-agent/tools.ts")}" "$@"\n`);
  chmodSync(path.join(bin, "film-tools"), 0o755);
  const mem = path.join(o.root, "data", "agents", "film-agent");
  mkdirSync(mem, { recursive: true });
  const lessons = existsSync(path.join(mem, `${o.channel}.md`)) ? readFileSync(path.join(mem, `${o.channel}.md`), "utf8").trim().split("\n").slice(-40).join("\n") : "(no lessons yet — this is your first film)";
  writeFileSync(path.join(job, "MEMORY.md"), `# Lessons from your earlier films (newest last)\n\n${lessons}\n`);
  const owner = existsSync(path.join(mem, "owner-notes.md")) ? readFileSync(path.join(mem, "owner-notes.md"), "utf8") : "(no notes from the owner yet)";
  writeFileSync(path.join(job, "OWNER.md"), `# Notes from the owner\n\n${owner}\n`);
  writeFileSync(path.join(job, "TOOLS.md"), readFileSync(path.join(o.root, "apps/cli/src/film-agent/TOOLS.md"), "utf8"));
  if (!existsSync(path.join(job, "spend.json"))) writeFileSync(path.join(job, "spend.json"), JSON.stringify({ before, limit: o.maxUsd, agentSoFar: 0 }));
  return { before, durationS, lengthS };
}

// ---- sessions
interface SessionResult { sessionId?: string; usd: number; subtype: string; seconds: number }
interface Ctx { o: FilmAgentOptions; env: Record<string, string | undefined>; spent: { usd: number }; budget: number; before: number; log: (s: string) => void }
const skill = (root: string, name: string) => readFileSync(path.join(root, "packages/agents/skills", `${name}.md`), "utf8");

async function session(ctx: Ctx, a: { label: string; prompt: string; append: string; model: string; maxUsd: number; maxTurns: number; scene?: string; resume?: string }): Promise<SessionResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const t0 = Date.now();
  const logF = path.join(ctx.o.job, "logs", `${a.label}.log`);
  mkdirSync(path.dirname(logF), { recursive: true });
  const maxUsd = Math.max(0.05, Math.min(a.maxUsd, ctx.budget - ctx.spent.usd));
  let r: SessionResult = { usd: 0, subtype: "none", seconds: 0, ...(a.resume ? { sessionId: a.resume } : {}) };
  const q = query({ prompt: a.prompt, options: {
    model: a.model, cwd: ctx.o.job, additionalDirectories: [ctx.o.root], systemPrompt: { type: "preset", preset: "claude_code", append: a.append },
    settingSources: [], permissionMode: "default", canUseTool: guard(ctx.o.job, ctx.o.root, a.scene), maxBudgetUsd: maxUsd, maxTurns: a.maxTurns,
    env: { ...ctx.env, ...(a.scene ? { FILM_SCENE: a.scene } : {}), CLAUDE_CONFIG_DIR: path.join(ctx.o.job, ".agent-config", a.label) },
    ...(a.resume ? { resume: a.resume } : {}),
  } });
  for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    if (m.type === "assistant") {
      const content = ((m.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> })?.content) ?? [];
      for (const b of content) {
        if (b.type === "text" && b.text) appendFileSync(logF, `\n${b.text}\n`);
        if (b.type === "tool_use") appendFileSync(logF, `→ ${b.name}: ${JSON.stringify(b.input ?? {}).slice(0, 400)}\n`);
      }
    }
    if (m.type === "result") {
      const usd = Number(m.total_cost_usd ?? 0);
      r = { sessionId: String(m.session_id ?? r.sessionId ?? ""), usd: r.usd + usd, subtype: String(m.subtype), seconds: 0 };
      ctx.spent.usd += usd;
      writeFileSync(path.join(ctx.o.job, "spend.json"), JSON.stringify({ before: ctx.before, limit: ctx.o.maxUsd, agentSoFar: Math.round(ctx.spent.usd * 100) / 100 }));
    }
  }
  r.seconds = Math.round((Date.now() - t0) / 1000);
  ctx.log(`  ${a.label}: ${r.subtype}, $${r.usd.toFixed(2)}, ${r.seconds} s (film agent so far $${ctx.spent.usd.toFixed(2)} of $${ctx.budget.toFixed(2)})`);
  return r;
}

/** Run tasks with at most n at once. */
export async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!); }));
  return out;
}

const renderFilm = (o: FilmAgentOptions, extra: string[] = []) => spawnSync("npx", ["tsx", path.join(o.root, "packages/motion-engine/src/hand/render-film.ts"), o.job, ...extra], { cwd: o.root, encoding: "utf8", maxBuffer: 1 << 26 });
const errorsOf = (r: { stdout?: string; stderr?: string }) => `${r.stderr ?? ""}\n${r.stdout ?? ""}`.split("\n").filter((l) => /error|Error|cannot|Cannot|failed/.test(l)).slice(0, 12).join("\n").slice(0, 2500);

export async function runFilmAgent(o: FilmAgentOptions): Promise<{ pass: boolean; usd: number; seconds: number }> {
  const log = o.log ?? console.log;
  const t0 = Date.now();
  const { before, durationS, lengthS } = prepareWorkspace(o);
  const budget = Math.max(0, o.maxUsd - before);
  const job = o.job;
  const here = `## This film\n- Workspace: ${job} (your cwd). The repository is at ${o.root} (read-only for you except your memory).\n- Narration: ${durationS.toFixed(1)} s (timed-script.json); the film is ${lengthS.toFixed(2)} s with its closing title.\n- Facts: facts.json; script: script.draft.json; every word's time: timed-script.json.\n- The shared techniques: ${path.join(o.root, "packages/motion-engine/src/remotion/craft.tsx")} (the CRAFT_TOOLS list at the end).\n- Commands: film-tools (TOOLS.md). Memory: MEMORY.md. Owner notes: OWNER.md.`;
  const common = skill(o.root, "film-agent");
  log(`[film agent] ${o.solo ? "solo" : `parallel (${o.parallel ?? 6} builders at once)`}, ${o.model}, budget $${budget.toFixed(2)} (film limit $${o.maxUsd}, already spent $${before.toFixed(2)}), ${job}`);
  if (o.dryRun) { log(`[film agent] dry run: workspace ready (${readdirSync(job).length} entries) — no API call`); return { pass: false, usd: 0, seconds: 0 }; }
  if (budget < 1) throw new Error(`only $${budget.toFixed(2)} left of the film's $${o.maxUsd} — raise --max-usd`);
  const key = process.env.OPUMIA_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("the Claude key is not loaded (pnpm opumia keys)");
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: key, PATH: `${path.join(job, ".bin")}:${process.env.PATH}`, FILM_JOB: job, OPUMIA_ROOT: o.root, FILM_CHANNEL: o.channel };
  const ctx: Ctx = { o, env, spent: { usd: 0 }, budget, before, log };
  const phases: Record<string, { seconds: number; usd: number }> = {};
  const phase = async <T>(name: string, f: () => Promise<T>): Promise<T> => { const s = Date.now(), u = ctx.spent.usd; log(`[${name}]`); const r = await f(); phases[name] = { seconds: Math.round((Date.now() - s) / 1000), usd: Math.round((ctx.spent.usd - u) * 100) / 100 }; return r; };
  let pass = false;

  if (o.solo) {
    // one agent does all of it (the first design; kept for comparison)
    const append = `${common}\n\n${skill(o.root, "film-solo")}\n\n${here}`;
    let sid: string | undefined;
    for (let round = 0; round < 3 && !pass && ctx.spent.usd < budget - 0.5; round++) {
      const g = round ? await filmGate({ root: o.root, job, channel: o.channel, record: false }) : null;
      const prompt = round === 0 ? `Make the film "${o.topic ?? path.basename(job)}" for the ${o.channel} channel, following your playbook, until film-tools gate prints GATE PASSED.` : `The gate still fails:\n${g!.checks.filter((c) => !c.pass).map((c) => `- ${c.id}: ${c.detail}`).join("\n")}\nFix the causes, render, mix and gate again.`;
      sid = (await phase(`solo-${round + 1}`, () => session(ctx, { label: `solo-${round + 1}`, prompt, append, model: o.model, maxUsd: budget, maxTurns: 400, ...(sid ? { resume: sid } : {}) }))).sessionId;
      pass = (await filmGate({ root: o.root, job, channel: o.channel })).pass;
    }
  } else {
    // 1. plan (one mind: the world, the signature object, a scene per idea)
    const planAppend = `${common}\n\n${skill(o.root, "film-planner")}\n\n${here}`;
    let planner = await phase("plan", () => session(ctx, { label: "planner", prompt: `Plan the film "${o.topic ?? path.basename(job)}" for the ${o.channel} channel, following your playbook: watch the reference, then write WORLD.md, src/world.tsx and plan.json. Stop when the plan is complete.`, append: planAppend, model: o.model, maxUsd: budget * 0.2, maxTurns: 150 }));
    for (let k = 0; k < 2; k++) {
      const errs = validatePlan(readPlan(job), lengthS, durationS, job);
      if (!errs.length) {
        scaffold(job, readPlan(job)!, lengthS);
        const w = renderFilm(o, ["--entry", "src/entries/_world.tsx", "--stills", "0", "--stills-dir", "stills/_world"]);
        if (w.status === 0) break;
        errs.push(`src/world.tsx does not compile:\n${errorsOf(w)}`);
      }
      if (k === 1) throw new Error(`the plan is still not usable:\n${errs.join("\n")}`);
      planner = await session(ctx, { label: "planner", prompt: `The plan is not usable yet:\n${errs.map((e) => `- ${e}`).join("\n")}\nFix it.`, append: planAppend, model: o.model, maxUsd: budget * 0.08, maxTurns: 60, ...(planner.sessionId ? { resume: planner.sessionId } : {}) });
    }
    const plan = readPlan(job) as FilmPlan;
    log(`  plan: ${plan.scenes.length} scenes, signature object: ${plan.signatureObject}`);

    // 2. build every scene at once (each its own session, its own files, its own check)
    const buildAppend = `${common}\n\n${skill(o.root, "scene-builder")}\n\n${here}`;
    const perScene = (budget * 0.5) / plan.scenes.length;
    const builders = new Map<string, string | undefined>();
    const build = async (id: string, why?: string) => {
      const i = plan.scenes.findIndex((s) => s.id === id);
      const brief = sceneBrief(plan, i, lengthS);
      const first = why ? `The finisher sent your scene back:\n${why}\n\nFix it, then run film-tools scene-check ${id} until it passes, and update notes/${id}.md.` : `Build scene ${id} of the film.\n\n${brief}\n\nRead WORLD.md, plan.json and src/world.tsx first; build only src/scenes/${id}.tsx (and src/scenes/${id}/…). Finish when film-tools scene-check ${id} prints SCENE ${id} PASSED, with notes/${id}.md written.`;
      let r = await session(ctx, { label: `build-${id}`, prompt: first, append: buildAppend, model: o.builderModel ?? o.model, maxUsd: why ? perScene * 0.6 : perScene, maxTurns: 120, scene: id, ...(builders.get(id) ? { resume: builders.get(id)! } : {}) });
      builders.set(id, r.sessionId);
      let chk = await sceneCheck(job, id);
      if (!chk.pass && ctx.spent.usd < budget * 0.85) {
        r = await session(ctx, { label: `build-${id}`, prompt: `film-tools scene-check ${id} fails:\n${chk.checks.filter((c) => !c.pass).map((c) => `- ${c.id}: ${c.detail}`).join("\n")}\nFix it.`, append: buildAppend, model: o.builderModel ?? o.model, maxUsd: perScene * 0.4, maxTurns: 60, scene: id, ...(r.sessionId ? { resume: r.sessionId } : {}) });
        chk = await sceneCheck(job, id);
      }
      return { id, pass: chk.pass, failed: chk.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`) };
    };
    const built = await phase("build", () => pool(plan.scenes.map((s) => s.id), o.parallel ?? 6, (id) => build(id)));
    const unbuilt = built.filter((b) => !b.pass);
    if (unbuilt.length) log(`  scenes not passing their check: ${unbuilt.map((b) => b.id).join(", ")}`);

    // 3–4. assemble, render, then the finisher watches it whole, sends scenes back, mixes, gates
    let note = unbuilt.length ? `\nScenes that did not pass their own check: ${unbuilt.map((b) => `${b.id} (${b.failed.join("; ")})`).join(" | ")}.` : "";
    for (let round = 0; round < 3; round++) {
      scaffold(job, plan, lengthS);
      const r = await phase(`render-${round + 1}`, async () => renderFilm(o));
      const rendered = r.status === 0;
      const prompt = round === 0
        ? `Every scene is built and the film is rendered: picture.mp4 (silent).${rendered ? "" : `\nThe render failed:\n${errorsOf(r)}`}${note}\nNow finish it, following the finisher's part of your playbook: watch it whole and beside the reference, send back scenes that need their builder (REBUILD.json) or fix seams yourself, write mix.json and mix, run film-tools gate, write REVIEW.md and save lessons. If you write REBUILD.json, stop there: the builders will run and you will see the film again.`
        : `The builders reworked ${note}. The film is rendered again${rendered ? "" : ` — but the render failed:\n${errorsOf(r)}`}. Watch the changed scenes, then continue: mix, gate (until GATE PASSED), REVIEW.md, lessons. Write REBUILD.json again only if a scene is still wrong.`;
      const rebuildF = path.join(job, "REBUILD.json");
      if (existsSync(rebuildF)) writeFileSync(rebuildF, "[]");
      planner = await phase(`finish-${round + 1}`, () => session(ctx, { label: "finisher", prompt, append: `${common}\n\n${skill(o.root, "film-planner")}\n\n${skill(o.root, "film-finisher")}\n\n${here}`, model: o.model, maxUsd: budget - ctx.spent.usd, maxTurns: 200, ...(planner.sessionId ? { resume: planner.sessionId } : {}) }));
      const back = (() => { try { return (JSON.parse(readFileSync(rebuildF, "utf8")) as Array<{ id: string; why: string }>).filter((x) => plan.scenes.some((s) => s.id === x.id)); } catch { return []; } })();
      if (back.length && round < 2 && ctx.spent.usd < budget - 1) {
        log(`  sent back: ${back.map((b) => b.id).join(", ")}`);
        const again = await phase(`rebuild-${round + 1}`, () => pool(back, o.parallel ?? 6, (b) => build(b.id, b.why)));
        note = `${back.map((b) => b.id).join(", ")}${again.some((a) => !a.pass) ? ` (not passing their check: ${again.filter((a) => !a.pass).map((a) => a.id).join(", ")})` : ""}`;
        continue;
      }
      pass = (await filmGate({ root: o.root, job, channel: o.channel })).pass;
      if (pass || ctx.spent.usd > budget - 0.5) break;
      const g = await filmGate({ root: o.root, job, channel: o.channel, record: false });
      note = `nothing; the gate still fails: ${g.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`).join(" | ")}`;
    }
  }
  const g = await filmGate({ root: o.root, job, channel: o.channel, record: false });
  for (const c of g.checks) log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.detail}`);
  pass = g.pass;
  const seconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(path.join(job, "agent-report.json"), JSON.stringify({ pass, mode: o.solo ? "solo" : "parallel", model: o.model, builderModel: o.builderModel ?? o.model, parallel: o.parallel ?? 6, usdBefore: before, usdAgent: Math.round(ctx.spent.usd * 100) / 100, usdTotal: Math.round((before + ctx.spent.usd) * 100) / 100, seconds, phases, at: new Date().toISOString() }, null, 1));
  log(`[film agent] ${pass ? "GATE PASSED" : "gate not passed"} — total $${(before + ctx.spent.usd).toFixed(2)} (agent $${ctx.spent.usd.toFixed(2)}), ${Math.round(seconds / 60)} min`);
  for (const [k, v] of Object.entries(phases)) log(`  ${k.padEnd(12)} ${String(v.seconds).padStart(5)} s  $${v.usd.toFixed(2)}`);
  return { pass, usd: before + ctx.spent.usd, seconds };
}
