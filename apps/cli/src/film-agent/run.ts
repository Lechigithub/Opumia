// The film agent (owner, 2026-11-26: "the agents and the platform should work, think, execute … like you do"): one
// agent with a real workspace makes the whole film the way the hand films were made — research, script and narration
// come from the platform's own agents; then a Claude Agent SDK session (Sonnet, owner's choice) builds, renders,
// watches beside the reference, fixes and gates the film, and learns from it.
//   pnpm opumia film-agent --topic "…" [--job NAME] [--duration 70] [--max-usd 9] [--model claude-sonnet-5-5]
//   pnpm opumia film-agent --job NAME --dry-run      (set up and check the workspace; no API call)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, cpSync, chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { filmGate } from "./gate.js";

export interface FilmAgentOptions { root: string; topic?: string; job: string; channel: string; durationS: number; maxUsd: number; model: string; dryRun?: boolean; log?: (s: string) => void }

/** The guard on every action the agent takes (the platform's hard rules; the SDK asks this before each tool use). */
export function guard(job: string, root: string) {
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
  return async (tool: string, input: Record<string, unknown>) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const allow = { behavior: "allow" as const, updatedInput: input };
    if (tool === "Bash") {
      const c = String(input.command ?? "");
      for (const [re, why] of BASH_DENY) if (re.test(c)) return deny(`${why} (film agent guard)`);
      // rm only inside the workspace
      for (const m of c.matchAll(/\brm\s+(-[a-zA-Z]+\s+)*([^;&|\n]+)/g)) for (const p of (m[2] ?? "").trim().split(/\s+/)) if (p && !p.startsWith("-") && !inside(p, job)) return deny(`rm outside the workspace: ${p} (film agent guard)`);
      return allow;
    }
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const p = String(input.file_path ?? input.notebook_path ?? "");
      if (SECRET.test(p)) return deny("never write a secret (film agent guard)");
      return inside(p, job) || inside(p, memory) ? allow : deny(`write only inside the workspace (${job}) or your memory (${memory}) (film agent guard)`);
    }
    if (["Read", "Glob", "Grep"].includes(tool)) {
      const p = String(input.file_path ?? input.path ?? input.pattern ?? "");
      return SECRET.test(p) ? deny("never read a secret (film agent guard)") : allow;
    }
    return allow;
  };
}

/** Prepare the workspace: narration (the platform's research, writer and voice), the Remotion project, the tools. */
export function prepareWorkspace(o: FilmAgentOptions): { before: number; durationS: number } {
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
  const src = path.join(job, "src");
  if (!existsSync(path.join(src, "Film.tsx"))) cpSync(path.join(o.root, "apps/cli/src/film-agent/template/src"), src, { recursive: true });
  writeFileSync(path.join(src, "length.json"), JSON.stringify({ seconds: Math.round((durationS + 2.6) * 100) / 100 }));
  for (const d of ["public/v", "public/img", "downloads", "watch"]) mkdirSync(path.join(job, d), { recursive: true });
  // the narration as a public file too (the film may show its waveform or need its timing)
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
  writeFileSync(path.join(job, "spend.json"), JSON.stringify({ before, limit: o.maxUsd, agentSoFar: 0 }));
  return { before, durationS };
}

export async function runFilmAgent(o: FilmAgentOptions): Promise<{ pass: boolean; usd: number; seconds: number }> {
  const log = o.log ?? console.log;
  const t0 = Date.now();
  const { before, durationS } = prepareWorkspace(o);
  const budget = Math.max(0, o.maxUsd - before);
  const playbook = readFileSync(path.join(o.root, "packages/agents/skills/film-agent.md"), "utf8");
  const facts = path.join(o.job, "facts.json"), draft = path.join(o.job, "script.draft.json");
  const append = `${playbook}\n\n## This film\n- Workspace: ${o.job} (your cwd). The repository is at ${o.root} (read-only for you except your memory).\n- Narration: ${durationS.toFixed(1)} s (timed-script.json); the film is ${(durationS + 2.6).toFixed(1)} s with its closing title.\n- Facts: ${facts}; script: ${draft}.\n- Your budget for this session: $${budget.toFixed(2)} (research, script and narration already cost $${before.toFixed(2)}).\n- The shared techniques: ${path.join(o.root, "packages/motion-engine/src/remotion/craft.tsx")} (read the CRAFT_TOOLS list at the end).\n- Commands: film-tools (TOOLS.md). Your memory: MEMORY.md. Owner notes: OWNER.md.`;
  const kickoff = `Make the film "${o.topic ?? path.basename(o.job)}" for the ${o.channel} channel, following your playbook: watch the reference, write SCENES.md, find the real pictures, build src/Film.tsx, look at every scene, render, mix, watch beside the reference, fix, then run film-tools gate until it prints GATE PASSED. Write REVIEW.md and save your lessons. Keep LOG.md as you go.`;
  log(`[film agent] ${o.model}, budget $${budget.toFixed(2)} (film limit $${o.maxUsd}, already spent $${before.toFixed(2)}), workspace ${o.job}`);
  if (o.dryRun) { log(`[film agent] dry run: workspace ready (${readdirSync(o.job).length} entries), system prompt ${append.length} characters — no API call`); return { pass: false, usd: 0, seconds: 0 }; }
  if (budget < 1) throw new Error(`only $${budget.toFixed(2)} left of the film's $${o.maxUsd} — raise --max-usd`);
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const key = process.env.OPUMIA_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("the Claude key is not loaded (pnpm opumia keys)");
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: path.join(o.job, ".agent-config"), PATH: `${path.join(o.job, ".bin")}:${process.env.PATH}`, FILM_JOB: o.job, OPUMIA_ROOT: o.root, FILM_CHANNEL: o.channel };
  const agentLog = path.join(o.job, "agent.log");
  let spent = 0, sessionId: string | undefined, pass = false;
  for (let round = 0; round < 3; round++) {
    const left = budget - spent;
    if (left < 0.5) { log(`[film agent] budget used ($${spent.toFixed(2)} of $${budget.toFixed(2)})`); break; }
    const gateBefore = round === 0 ? null : await filmGate({ root: o.root, job: o.job, channel: o.channel, record: false });
    const prompt = round === 0 ? kickoff : `The gate still fails:\n${gateBefore!.checks.filter((c) => !c.pass).map((c) => `- ${c.id}: ${c.detail}`).join("\n")}\nFind the cause of each, fix it, render and mix again, and run film-tools gate until it passes. Then update REVIEW.md and your lessons.`;
    const q = query({ prompt, options: { model: o.model, cwd: o.job, additionalDirectories: [o.root], systemPrompt: { type: "preset", preset: "claude_code", append }, settingSources: [], permissionMode: "default", canUseTool: guard(o.job, o.root), maxBudgetUsd: left, maxTurns: 400, env, ...(sessionId ? { resume: sessionId } : {}) } });
    for await (const m of q as AsyncIterable<Record<string, unknown>>) {
      const type = String(m.type);
      if (type === "assistant") {
        const content = ((m.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> })?.content) ?? [];
        for (const b of content) {
          if (b.type === "text" && b.text) appendFileSync(agentLog, `\n${b.text}\n`);
          if (b.type === "tool_use") { const line = `→ ${b.name}: ${JSON.stringify(b.input ?? {}).slice(0, 300)}`; appendFileSync(agentLog, `${line}\n`); log(`  ${line.slice(0, 160)}`); }
        }
      }
      if (type === "result") {
        sessionId = String(m.session_id ?? sessionId ?? "");
        spent += Number(m.total_cost_usd ?? 0);
        writeFileSync(path.join(o.job, "spend.json"), JSON.stringify({ before, limit: o.maxUsd, agentSoFar: spent }));
        log(`[film agent] round ${round + 1} ended (${String(m.subtype)}), agent spend $${spent.toFixed(2)}`);
      }
    }
    const g = await filmGate({ root: o.root, job: o.job, channel: o.channel });
    for (const c of g.checks) log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.detail}`);
    if (g.pass) { pass = true; break; }
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(path.join(o.job, "agent-report.json"), JSON.stringify({ pass, model: o.model, usdBefore: before, usdAgent: spent, usdTotal: before + spent, seconds, at: new Date().toISOString() }, null, 1));
  log(`[film agent] ${pass ? "GATE PASSED" : "gate not passed"} — total $${(before + spent).toFixed(2)} (agent $${spent.toFixed(2)}), ${Math.round(seconds / 60)} min`);
  return { pass, usd: before + spent, seconds };
}
