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
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, cpSync, chmodSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { filmGate } from "./gate.js";
import { readPlan, validatePlan, scaffold, sceneBrief, pool, frameOf, filmPath, type FilmPlan } from "./plan.js";
import { sceneCheck, runAsync } from "./scene-check.js";
import { prefetch } from "./prefetch.js";
import { writeDraftMix } from "./sound-draft.js";
import { preFinishChecks } from "./checks.js";
import { freshEyes } from "./after.js";
import { plannerProcess, tellsAnswered, toolLog } from "./process.js";

export interface FilmAgentOptions {
  root: string; topic?: string; job: string; channel: string; durationS: number; maxUsd: number; model: string;
  /** 16:9 (default) or 9:16 — the platform makes both, at any length */
  aspect?: "16:9" | "9:16";
  builderModel?: string; parallel?: number; solo?: boolean; dryRun?: boolean; log?: (s: string) => void;
}

/** The guard on every action an agent takes (the platform's hard rules; the SDK asks it before each tool use).
 *  A scene builder (scene set) may write only its own scene's files. */
export function guard(job: string, root: string, scene?: string) {
  const home = process.env.HOME ?? "/Users";
  const expand = (p: string) => p.replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?/, home);
  const inside = (p: string, dir: string) => { const r = path.relative(dir, path.resolve(job, expand(p))); return !r.startsWith("..") && !path.isAbsolute(r); };
  /** code an agent writes may not read keys or the environment either (it would run it next) */
  const CODE_DENY = /process\.env|os\.environ|\bgetenv\(|Deno\.env|\bprintenv\b|loadKeys|\bkeys\.(js|ts)\b|opumia_keys|security\s+find|ENV\[/;
  const memory = path.join(root, "data", "agents", "film-agent");
  const SECRET = /(\.opumia_keys|(^|[\/\s"'])\.env(\.|\b)|keychain|\.ssh\/|\.aws\/|\.claude\/|credentials\.json|id_rsa)/i;
  const BASH_DENY: Array<[RegExp, string]> = [
    [/(^|[;&|(]\s*)(env|printenv|set|export -p|declare -x)\s*($|[;&|)>])/, "never dump the environment"],
    [/\bsecurity\s+(find|dump|add|delete|unlock|export)/, "never touch the Keychain"],
    [/\bprintenv\b|\bcompgen\s+-v\b|\/proc\/\S*environ|process\.env|os\.environ|ENV\[/i, "never read a key or the environment"],
    [/\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*/, "never read a key"],
    [SECRET, "never read or copy a secret"],
    [/\bgit\s+(push|commit|reset|checkout|rebase|merge|tag|stash|clean)\b/, "no git changes — the owner commits"],
    [/\bsudo\b|\bchmod\s+-R\s+\/|\bmkfs\b|\bdd\s+if=/, "not allowed"],
    [/(>|>>|\btee\b|\bmv\b|\bcp\b|\brm\b|\bsed\s+-i\b|\btouch\b|\bmkdir\b|\bln\b|\bunlink\b|\brsync\b)[^;&|\n]*\b(Library|Reference)\//, "Library/ and Reference/ are read-only"],
    [/\bcurl\b[^;&|\n]*\s-(X\s*(POST|PUT|DELETE|PATCH)|d\s|-data)/i, "no sending data to outside services"],
    // the reference channel's own clips and files never go into a film (looking is fine: film-tools ref watches them)
    [/\bLibrary\/(moments|bank|thumb_cache)\b/, "Library/moments, bank and thumb_cache are the reference's material or a remote catalogue — never in a film"],
    [/\b(ffmpeg|cp|rsync|ln|ditto|convert|magick|sips)\b[^;&|\n]*\bReference\//, "never cut or copy from Reference/ into a film — the channel's own material is never used (study it with film-tools ref)"],
  ];
  // a film is made from the reference and its own material, never from our other films (a test would be spoiled)
  const outDir = path.join(root, "out"), mine = path.basename(job);
  const otherFilm = (text: string) => [...text.matchAll(/(?:^|[\s"'=(])((?:[^\s"'=(]*\/)?out\/([\w.-]+))/g)].some((m) => m[2] !== mine && (m[1]!.startsWith("/") ? m[1]!.startsWith(outDir) : true)) || (text.startsWith(outDir + path.sep) && !text.startsWith(path.join(outDir, mine)));
  const WRITE_OP = /(>|>>|\btee\b|\bmv\b|\bcp\b|\brm\b|\bsed\s+-i\b|\btouch\b|\bln\b|\bunlink\b|\brsync\b|\bperl\s+-pi\b)/;
  /** a builder's own files: its scene (and folder), its media, downloads, stills, notes and ledgers */
  const ownBuilder = (abs: string) => {
    const r = path.relative(job, abs).split(path.sep).join("/");
    return r === `src/scenes/${scene}.tsx` || r.startsWith(`src/scenes/${scene}/`) || new RegExp(`^public/(v|img|a)/${scene}_`).test(r)
      || [`downloads/${scene}/`, `stills/${scene}/`, `watch/${scene}`].some((d) => r.startsWith(d)) || r.startsWith(`notes/${scene}.`) || [`credits/${scene}.json`, `fair-use/${scene}.json`].includes(r);
  };
  return async (tool: string, input: Record<string, unknown>) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const allow = { behavior: "allow" as const, updatedInput: input };
    if (tool === "Bash") {
      const c = String(input.command ?? "");
      if (otherFilm(c)) return deny("other films in out/ are not yours to look at — make this film from the reference and your own material (film agent guard)");
      for (const [re, why] of BASH_DENY) if (re.test(c)) return deny(`${why} (film agent guard)`);
      for (const m of c.matchAll(/\brm\s+(-[a-zA-Z]+\s+)*([^;&|\n]+)/g)) for (const p of (m[2] ?? "").trim().split(/\s+/)) if (p && !p.startsWith("-") && !inside(p, job)) return deny(`rm outside the workspace: ${p} (film agent guard)`);
      // deleting after moving elsewhere: cd only inside the workspace when the command removes anything
      if (/\brm\b|\bunlink\b|\bfind\b[^;&|\n]*-delete/.test(c)) for (const m of c.matchAll(/\bcd\s+([^;&|\n]+)/g)) { const p = (m[1] ?? "").trim(); if (p && !inside(p, job)) return deny(`delete only inside the workspace (cd ${p}) (film agent guard)`); }
      const w = c.replace(/\d?>>?\s*\/dev\/null|\d>&\d/g, "");
      if (scene && WRITE_OP.test(w)) {
        const other = [...w.matchAll(/src\/scenes\/(s\d{2})/g)].map((m) => m[1]).find((x) => x !== scene);
        if (other) return deny(`scene ${other} belongs to its own builder — change only ${scene} (film agent guard)`);
        if (/\b(plan\.json|src\/world\.tsx|src\/Film\.tsx|mix\.json)\b/.test(w)) return deny("the plan, the world and the film belong to the planner — write what you need in notes/" + scene + ".md (film agent guard)");
      }
      return allow;
    }
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const p = expand(String(input.file_path ?? input.notebook_path ?? ""));
      if (SECRET.test(p)) return deny("never write a secret (film agent guard)");
      const body = `${input.content ?? ""}\n${input.new_string ?? ""}\n${JSON.stringify(input.edits ?? "")}`;
      if (CODE_DENY.test(body)) return deny("code that reads keys or the environment is not allowed (film agent guard)");
      if (inside(p, memory)) return allow;
      if (!inside(p, job)) return deny(`write only inside the workspace (${job}) or your memory (${memory}) (film agent guard)`);
      if (scene && !ownBuilder(path.resolve(job, p))) return deny(`you build ${scene}: write only src/scenes/${scene}.tsx, src/scenes/${scene}/…, public/v|img/${scene}_…, downloads/${scene}/…, stills/${scene}/…, notes/${scene}.md (film agent guard)`);
      return allow;
    }
    if (["Read", "Glob", "Grep"].includes(tool)) {
      const p = expand(String(input.file_path ?? input.path ?? input.pattern ?? ""));
      if (otherFilm(p)) return deny("other films in out/ are not yours to look at — make this film from the reference and your own material (film agent guard)");
      return SECRET.test(p) || /\.(opumia_keys)|\/keys\.ts$/.test(p) ? deny("never read a secret (film agent guard)") : allow;
    }
    return allow;
  };
}

/** Prepare the workspace: narration (the platform's research, writer and voice), the Remotion project, the tools. */
export async function prepareWorkspace(o: FilmAgentOptions): Promise<{ before: number; durationS: number; lengthS: number }> {
  const log = o.log ?? console.log;
  const job = o.job;
  mkdirSync(job, { recursive: true });
  if (!existsSync(path.join(job, "timed-script.json"))) {
    if (o.dryRun || !o.topic) throw new Error("no narration in the workspace (run without --dry-run and with --topic to make it)");
    log("[A] research, script and narration (the platform's own agents)…");
    const { makeStory } = await import("./story.js");
    const dir = (k: string, d: string) => path.resolve(o.root, process.env[k] ?? d);
    await makeStory({ root: o.root, library: dir("OPUMIA_LIBRARY_DIR", "Library"), reference: dir("OPUMIA_REFERENCE_DIR", "Reference"), data: dir("OPUMIA_DATA_DIR", "data"), topic: o.topic, channel: o.channel, aspect: o.aspect ?? "16:9", durationS: o.durationS, job, maxUsd: o.maxUsd, log });
  }
  // on-device OCR (type checks, figures on screen, burned-in text) is built once if this machine lacks it
  if (!(await (await import("@opumia/senses")).ocrBinary(o.root))) log("  ! on-device OCR could not be built (swiftc) — the type and figure checks will not run");
  const timing = (() => { try { return JSON.parse(readFileSync(path.join(job, "timing.json"), "utf8")) as { runs: Array<{ filmUsd?: number; usd?: number }> }; } catch { return { runs: [] }; } })();
  const before = timing.runs.reduce((m, r) => Math.max(m, r.filmUsd ?? r.usd ?? 0), 0);
  const durationS = (JSON.parse(readFileSync(path.join(job, "timed-script.json"), "utf8")) as { durationS: number }).durationS;
  const lengthS = Math.round((durationS + 2.6) * 100) / 100;
  const src = path.join(job, "src");
  if (!existsSync(path.join(src, "index.ts"))) cpSync(path.join(o.root, "apps/cli/src/film-agent/template/src"), src, { recursive: true });
  if (!existsSync(path.join(job, "job.json"))) writeFileSync(path.join(job, "job.json"), JSON.stringify({ topic: o.topic ?? "", channel: o.channel, aspect: o.aspect ?? "16:9", durationS: o.durationS }, null, 2) + "\n");
  const fr = frameOf(job);
  writeFileSync(path.join(src, "length.json"), JSON.stringify({ seconds: lengthS, width: fr.w, height: fr.h }));
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
export interface Ctx { o: FilmAgentOptions; env: Record<string, string | undefined>; spent: { usd: number }; budget: number; before: number; log: (s: string) => void; totals?: Map<string, number> }
const skill = (root: string, name: string) => readFileSync(path.join(root, "packages/agents/skills", `${name}.md`), "utf8");

export async function session(ctx: Ctx, a: { label: string; prompt: string; append: string; model: string; maxUsd: number; maxTurns: number; scene?: string; resume?: string }): Promise<SessionResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const t0 = Date.now();
  const logF = path.join(ctx.o.job, "logs", `${a.label}.log`);
  mkdirSync(path.dirname(logF), { recursive: true });
  const maxUsd = Math.max(0.05, Math.min(a.maxUsd, ctx.budget - ctx.spent.usd));
  let r: SessionResult = { usd: 0, subtype: "none", seconds: 0, ...(a.resume ? { sessionId: a.resume } : {}) };
  const g = guard(ctx.o.job, ctx.o.root, a.scene);
  const q = query({ prompt: a.prompt, options: {
    model: a.model, cwd: ctx.o.job, additionalDirectories: [ctx.o.root], systemPrompt: { type: "preset", preset: "claude_code", append: a.append },
    settingSources: [], permissionMode: "default", canUseTool: g, maxBudgetUsd: maxUsd,
    hooks: { PreToolUse: [{ onFailure: "block", hooks: [async (input) => { const h = input as { tool_name?: string; tool_input?: unknown }; const d = await g(String(h.tool_name ?? ""), (h.tool_input ?? {}) as Record<string, unknown>); return d.behavior === "deny" ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: d.message } } : {}; }] }] }, maxTurns: a.maxTurns,
    // one config folder for every session: a resumed session (the finisher is the planner resumed) must find its transcript there
    env: { ...ctx.env, ...(a.scene ? { FILM_SCENE: a.scene } : {}), CLAUDE_CONFIG_DIR: path.join(ctx.o.job, ".agent-config") },
    ...(a.resume ? { resume: a.resume } : {}),
  } });
  // the SDK throws when a session ends in an error result (budget or turn limit, a refused key, an outage): one
  // builder's error must never take down the others or the film — record it and carry on
  let seenResult = false;
  try { for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    if (m.type === "assistant") {
      const content = ((m.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> })?.content) ?? [];
      for (const b of content) {
        if (b.type === "text" && b.text) appendFileSync(logF, `\n${b.text}\n`);
        if (b.type === "tool_use") {
          appendFileSync(logF, `→ ${b.name}: ${JSON.stringify(b.input ?? {}).slice(0, 400)}\n`);
          // every call in full: the process checks read what the agent actually did
          appendFileSync(toolLog(ctx.o.job, a.label), JSON.stringify({ t: new Date().toISOString(), name: b.name, input: b.input ?? {} }) + "\n");
        }
      }
    }
    if (m.type === "result") {
      // a resumed session's total carries its earlier turns: count only what this query added
      const sid = String(m.session_id ?? r.sessionId ?? "");
      const totals = (ctx.totals ??= new Map());
      const total = Number(m.total_cost_usd ?? 0), prev = totals.get(sid) ?? (a.resume ? totals.get(a.resume) ?? 0 : 0);
      const usd = Math.max(0, total - prev);
      totals.set(sid, Math.max(total, prev));
      r = { sessionId: sid, usd: r.usd + usd, subtype: String(m.subtype), seconds: 0 };
      ctx.spent.usd += usd;
      seenResult = true;
      writeFileSync(path.join(ctx.o.job, "spend.json"), JSON.stringify({ before: ctx.before, limit: ctx.o.maxUsd, agentSoFar: Math.round(ctx.spent.usd * 100) / 100 }));
    }
  } } catch (e) {
    const msg = (e as Error).message ?? String(e);
    appendFileSync(logF, `\n!! session ended in an error: ${msg.slice(0, 600)}\n`);
    // its spend is unknown when no result arrived: a budget stop spent its whole allowance, anything else is counted as half
    if (!seenResult) { const est = /budget/i.test(msg) ? maxUsd : maxUsd / 2; r.usd += est; ctx.spent.usd += est; }
    r.subtype = /budget/i.test(msg) ? "error_max_budget_usd" : /max.?turns/i.test(msg) ? "error_max_turns" : `error: ${msg.slice(0, 80)}`;
  }
  r.seconds = Math.round((Date.now() - t0) / 1000);
  ctx.log(`  ${a.label}: ${r.subtype}, $${r.usd.toFixed(2)}, ${r.seconds} s (film agent so far $${ctx.spent.usd.toFixed(2)} of $${ctx.budget.toFixed(2)})`);
  return r;
}

export { pool } from "./plan.js";

const renderFilm = (o: FilmAgentOptions, extra: string[] = []) => runAsync("npx", ["tsx", path.join(o.root, "packages/motion-engine/src/hand/render-film.ts"), o.job, ...extra], o.root);
const errorsOf = (r: { stdout?: string; stderr?: string }) => `${r.stderr ?? ""}\n${r.stdout ?? ""}`.split("\n").filter((l) => /error|Error|cannot|Cannot|failed/.test(l)).slice(0, 12).join("\n").slice(0, 2500);

export async function runFilmAgent(o: FilmAgentOptions): Promise<{ pass: boolean; usd: number; seconds: number }> {
  const log = o.log ?? console.log;
  const t0 = Date.now();
  const { before, durationS, lengthS } = await prepareWorkspace(o);
  const budget = Math.max(0, o.maxUsd - before);
  const job = o.job;
  const here = `## This film\n- Workspace: ${job} (your cwd). The repository is at ${o.root} (read-only for you except your memory).\n- Narration: ${durationS.toFixed(1)} s (timed-script.json); the film is ${lengthS.toFixed(2)} s with its closing title.\n- Facts: facts.json; script: script.draft.json; every word's time: timed-script.json.\n- The shared techniques: ${path.join(o.root, "packages/motion-engine/src/remotion/craft.tsx")} (the CRAFT_TOOLS list at the end).\n- Commands: film-tools (TOOLS.md). Memory: MEMORY.md. Owner notes: OWNER.md.`;
  const common = skill(o.root, "film-agent");
  log(`[film agent] ${o.solo ? "solo" : `parallel (${o.parallel ?? 4} builders at once)`}, ${o.model}, budget $${budget.toFixed(2)} (film limit $${o.maxUsd}, already spent $${before.toFixed(2)}), ${job}`);
  if (o.dryRun) { log(`[film agent] dry run: workspace ready (${readdirSync(job).length} entries) — no API call`); return { pass: false, usd: 0, seconds: 0 }; }
  if (budget < 1) throw new Error(`only $${budget.toFixed(2)} left of the film's $${o.maxUsd} — raise --max-usd`);
  const key = process.env.OPUMIA_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("the Claude key is not loaded (pnpm opumia keys)");
  // a short allowlist: the agents' shell gets no stock/voice keys (film-tools loads its own in its process); the Claude
  // key is the one its own process needs to run
  const ENV_PASS = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "OPUMIA_PY", "OPUMIA_LIBRARY_DIR", "OPUMIA_REFERENCE_DIR", "OPUMIA_ASR", "OPUMIA_TTS_MODEL"];
  const env: Record<string, string | undefined> = { ...Object.fromEntries(ENV_PASS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ANTHROPIC_API_KEY: key, PATH: `${path.join(job, ".bin")}:${process.env.PATH}`, FILM_JOB: job, OPUMIA_ROOT: o.root, FILM_CHANNEL: o.channel };
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
    // the plan is refused until it is usable AND the planner did the work (watched the reference, searched for real
    // material of everyone it names); a plan that is usable but skipped work goes ahead after two sends-back, logged
    for (let k = 0; k < 3; k++) {
      const errs = validatePlan(readPlan(job), lengthS, durationS, job);
      if (!errs.length) {
        scaffold(job, readPlan(job)!, lengthS);
        const w = await renderFilm(o, ["--entry", "src/entries/_world.tsx", "--stills", "0", "--stills-dir", "stills/_world"]);
        if (w.status !== 0) errs.push(`src/world.tsx does not compile:\n${errorsOf(w)}`);
      }
      const work = errs.length ? [] : plannerProcess(job, readPlan(job)!);
      if (!errs.length && !work.length) break;
      if (k === 2) {
        if (errs.length) throw new Error(`the plan is still not usable:\n${errs.join("\n")}`);
        log(`  ! the planner still skipped: ${work.join(" | ")}`);
        break;
      }
      planner = await session(ctx, { label: "planner", prompt: `${errs.length ? "The plan is not usable yet" : "The plan is refused: the work behind it was not done"}:\n${[...errs, ...work].map((e) => `- ${e}`).join("\n")}\nDo it, then revise WORLD.md, src/world.tsx and plan.json with what you found.`, append: planAppend, model: o.model, maxUsd: budget * 0.08, maxTurns: 80, ...(planner.sessionId ? { resume: planner.sessionId } : {}) });
    }
    const plan = readPlan(job) as FilmPlan;
    log(`  plan: ${plan.scenes.length} scenes, signature object: ${plan.signatureObject}`);
    // every scene's searches start at once in code; builders open with candidates on disk (they still choose)
    await phase("prefetch", () => prefetch({ root: o.root, job, channel: o.channel, plan, env, parallel: o.parallel ?? 4, log }));

    // 2. build every scene at once (each its own session, its own files, its own check)
    const buildAppend = `${common}\n\n${skill(o.root, "scene-builder")}\n\n${here}`;
    // what the builders share: the film's money left after the planner, less what the finisher (and its rebuild round)
    // and the fresh eyes need; a builder's first pass needs about $0.6 on Sonnet, $0.08 on Haiku (estimated from the
    // platform's prices: ~40 turns, ~50k tokens of context each, images, a few thousand words of code)
    const builderModel = o.builderModel ?? o.model;
    const need = /haiku/.test(builderModel) ? 0.08 : 0.6;
    const finishReserve = Math.max(1.5, budget * 0.25);
    const perScene = Math.max(0.05, (budget - ctx.spent.usd - finishReserve) / plan.scenes.length);
    log(`  builders: $${perScene.toFixed(2)} each (${plan.scenes.length} scenes on ${builderModel}; a first pass needs about $${need.toFixed(2)})${perScene < need ? " - STARVED: raise --max-usd, plan fewer scenes, or build on Haiku" : ""}`);
    const builders = new Map<string, string | undefined>();
    const build = async (id: string, why?: string) => {
      const i = plan.scenes.findIndex((s) => s.id === id);
      const brief = sceneBrief(plan, i, lengthS);
      const first = why ? `The finisher sent your scene back:\n${why}\n\nFix it, then run film-tools scene-check ${id} until it passes, and update notes/${id}.md.` : `Build scene ${id} of the film.\n\n${brief}\n\nRead WORLD.md, plan.json, src/world.tsx and downloads/${id}/PREFETCH.md (searches already run for you — look at them, then search again if none shows the line) first; build only src/scenes/${id}.tsx (and src/scenes/${id}/…). Finish when film-tools scene-check ${id} prints SCENE ${id} PASSED, with notes/${id}.md written and your hit points in notes/${id}.hits.json.`;
      let r = await session(ctx, { label: `build-${id}`, prompt: first, append: buildAppend, model: builderModel, maxUsd: why ? perScene * 0.6 : perScene, maxTurns: 120, scene: id, ...(builders.get(id) ? { resume: builders.get(id)! } : {}) });
      builders.set(id, r.sessionId);
      let chk = await sceneCheck(job, id);
      if (!chk.pass && ctx.spent.usd < budget * 0.85) {
        r = await session(ctx, { label: `build-${id}`, prompt: `film-tools scene-check ${id} fails:\n${chk.checks.filter((c) => !c.pass).map((c) => `- ${c.id}: ${c.detail}`).join("\n")}\nFix it.`, append: buildAppend, model: builderModel, maxUsd: perScene * 0.4, maxTurns: 60, scene: id, ...(r.sessionId ? { resume: r.sessionId } : {}) });
        chk = await sceneCheck(job, id);
      }
      return { id, pass: chk.pass, failed: chk.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`) };
    };
    const built = await phase("build", () => pool(plan.scenes.map((s) => s.id), o.parallel ?? 4, (id) => build(id)));
    const unbuilt = built.filter((b) => !b.pass);
    if (unbuilt.length) log(`  scenes not passing their check: ${unbuilt.map((b) => b.id).join(", ")}`);

    // 3–4. assemble, render, then the finisher watches it whole, sends scenes back, mixes, gates
    let note = unbuilt.length ? `\nScenes that did not pass their own check: ${unbuilt.map((b) => `${b.id} (${b.failed.join("; ")})`).join(" | ")}.` : "";
    // a rebuilt scene re-renders picture.mp4: the film is mixed again from mix.json before anyone judges it
    const remixIfStale = () => {
      const pic = path.join(job, "picture.mp4"), film = filmPath(job);
      if (existsSync(pic) && existsSync(path.join(job, "mix.json")) && (!existsSync(film) || statSync(pic).mtimeMs > statSync(film).mtimeMs + 1000)) {
        const r = spawnSync("npx", ["tsx", path.join(o.root, "apps/cli/src/film-agent/mix.ts"), job], { cwd: o.root, encoding: "utf8", env: { ...process.env, OPUMIA_ROOT: o.root } });
        log(`  re-mixed the current picture: ${(r.stdout ?? "").trim().split("\n").at(-1) ?? ""}`);
      }
    };
    const finisherMax = () => Math.max(0.3, budget * 0.85 - ctx.spent.usd); // a reserve for the fresh eyes and their round
    const platformUsd = { usd: 0 };
    const addPlatform = (u: number) => { platformUsd.usd += u; ctx.spent.usd += u; };
    for (let round = 0; round < 3; round++) {
      scaffold(job, plan, lengthS);
      const r = await phase(`render-${round + 1}`, () => renderFilm(o));
      const rendered = r.status === 0;
      if (round === 0) { const m = writeDraftMix({ root: o.root, job, lengthS }); if (m) log(`  sound draft: ${m.beds.length} bed(s), ${m.cues.length} cue(s), ${m.drops.length} drop-out(s)`); }
      if (rendered) {
        const ag = await import("@opumia/agents");
        ag.setBudget(Math.max(0.5, budget - ctx.spent.usd)); ag.setFinishing(true);
        const c = await phase(`checks-${round + 1}`, () => preFinishChecks({ root: o.root, job, channel: o.channel, plan, log }));
        addPlatform(c.usd);
        note += `\n\nChecks on the assembled film (FINDINGS.md) — FIX items are yours or a builder's, "look" items are for your eye:\n${c.text}`;
      }
      const prompt = round === 0
        ? `Every scene is built and the film is rendered: picture.mp4 (silent).${rendered ? "" : `\nThe render failed:\n${errorsOf(r)}`}${note}\nNow finish it, following the finisher's part of your playbook: watch it whole and beside the reference, send back scenes that need their builder (REBUILD.json) or fix seams yourself, adjust the draft mix.json (code wrote it from your marks, the cuts and the builders' hit points) and mix, run film-tools gate, write REVIEW.md and save lessons. If you write REBUILD.json, stop there: the builders will run and you will see the film again.`
        : `The builders reworked ${note}. The film is rendered again${rendered ? "" : ` — but the render failed:\n${errorsOf(r)}`}. Watch the changed scenes, then continue: mix, gate (until GATE PASSED), REVIEW.md, lessons. Write REBUILD.json again only if a scene is still wrong.`;
      const rebuildF = path.join(job, "REBUILD.json");
      if (existsSync(rebuildF)) writeFileSync(rebuildF, "[]");
      planner = await phase(`finish-${round + 1}`, () => session(ctx, { label: "finisher", prompt, append: `${common}\n\n${skill(o.root, "film-planner")}\n\n${skill(o.root, "film-finisher")}\n\n${here}`, model: o.model, maxUsd: finisherMax(), maxTurns: 200, ...(planner.sessionId ? { resume: planner.sessionId } : {}) }));
      const back = (() => { try { return (JSON.parse(readFileSync(rebuildF, "utf8")) as Array<{ id: string; why: string }>).filter((x) => plan.scenes.some((s) => s.id === x.id)); } catch { return []; } })();
      if (back.length && round < 2 && ctx.spent.usd < budget - 1) {
        log(`  sent back: ${back.map((b) => b.id).join(", ")}`);
        const again = await phase(`rebuild-${round + 1}`, () => pool(back, o.parallel ?? 4, (b) => build(b.id, b.why)));
        note = `${back.map((b) => b.id).join(", ")}${again.some((a) => !a.pass) ? ` (not passing their check: ${again.filter((a) => !a.pass).map((a) => a.id).join(", ")})` : ""}.`;
        continue;
      }
      remixIfStale();
      pass = (await filmGate({ root: o.root, job, channel: o.channel })).pass;
      if (pass || ctx.spent.usd > budget - 0.5) break;
      const g = await filmGate({ root: o.root, job, channel: o.channel, record: false });
      note = `nothing; the gate still fails: ${g.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`).join(" | ")}`;
    }
    // 5. fresh eyes on the finished film: the platform's viewer QA, final-cut judge and packaging, at the same time
    remixIfStale();
    if (existsSync(filmPath(job))) {
      const ag = await import("@opumia/agents");
      ag.setBudget(Math.max(0.5, budget - ctx.spent.usd)); ag.setFinishing(true);
      const fe = await phase("fresh-eyes", () => freshEyes({ root: o.root, job, channel: o.channel, topic: o.topic ?? plan.title ?? path.basename(job), lengthS, log }));
      addPlatform(fe.usd);
      // the finisher answers what outside eyes saw even when the film passed: every judge tell and every viewer issue
      // of severity 5+ is answered in TELLS.md (what changed, or why it stays)
      const tells = [...(fe.judge?.tells ?? []), ...(fe.referee?.low ?? []).map((x) => `the referee's weakest moment ${x}`)];
      const issues = (fe.viewer?.issues ?? []).filter((x) => x.severity >= 5).map((x) => x.what);
      const weak = (fe.viewer && fe.viewer.verdict !== "pass") || (fe.referee && !fe.referee.pass) || tells.length > 0 || issues.length > 0;
      const finAppend = `${common}\n\n${skill(o.root, "film-planner")}\n\n${skill(o.root, "film-finisher")}\n\n${here}`;
      if (weak && ctx.spent.usd < budget - 0.5 && planner.sessionId) {
        planner = await phase("finish-fresh", () => session(ctx, { label: "finisher", prompt: `Reviewers who made none of the film watched it:\n${fe.text}\nFix what is real (edit any scene yourself — no builder round is left), render, mix, and run film-tools gate until GATE PASSED. Write TELLS.md: every tell and issue above as a heading, under it what you changed or why it stays. Then update REVIEW.md and your lessons with what they saw that you did not.`, append: finAppend, model: o.model, maxUsd: budget - ctx.spent.usd, maxTurns: 120, resume: planner.sessionId! }));
        const open = tellsAnswered(job, [...tells, ...issues]);
        if (open.length && ctx.spent.usd < budget - 0.4 && planner.sessionId) {
          log(`  ${open.length} tell(s) not answered in TELLS.md — one more turn`);
          planner = await phase("finish-tells", () => session(ctx, { label: "finisher", prompt: `These are still not answered in TELLS.md:\n${open.map((t) => `- ${t}`).join("\n")}\nFix each (render, mix, gate) or write in TELLS.md why it stays.`, append: finAppend, model: o.model, maxUsd: Math.min(1, budget - ctx.spent.usd), maxTurns: 60, resume: planner.sessionId! }));
        }
      }
    }
    phases.platformUsd = { seconds: 0, usd: Math.round(platformUsd.usd * 100) / 100 };
  }
  const g = await filmGate({ root: o.root, job, channel: o.channel, record: false });
  for (const c of g.checks) log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.detail}`);
  pass = g.pass;
  const seconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(path.join(job, "agent-report.json"), JSON.stringify({ pass, mode: o.solo ? "solo" : "parallel", model: o.model, builderModel: o.builderModel ?? o.model, parallel: o.parallel ?? 4, usdBefore: before, usdAgent: Math.round(ctx.spent.usd * 100) / 100, usdTotal: Math.round((before + ctx.spent.usd) * 100) / 100, seconds, phases, at: new Date().toISOString() }, null, 1));
  log(`[film agent] ${pass ? "GATE PASSED" : "gate not passed"} — total $${(before + ctx.spent.usd).toFixed(2)} (agent $${ctx.spent.usd.toFixed(2)}), ${Math.round(seconds / 60)} min`);
  for (const [k, v] of Object.entries(phases)) log(`  ${k.padEnd(12)} ${String(v.seconds).padStart(5)} s  $${v.usd.toFixed(2)}`);
  return { pass, usd: before + ctx.spent.usd, seconds };
}
