// A scene builder's own check (code, no model): its scene is built, compiles, is not blank at its start, middle and
// end, uses only its own media and credits all of it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { readPlan, sceneWindow, STUB, FPS } from "./plan.js";
import { builderProcess } from "./process.js";
import type { GateCheck } from "./gate.js";

/** A command run without blocking the event loop. */
export function runAsync(bin: string, args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, env: process.env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
    p.on("error", (e) => resolve({ status: 1, stdout, stderr: String(e) }));
  });
}
const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
/** Brightness spread of a still (0–255): a frame with almost no spread is blank. */
export function lumaSpread(file: string): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YLOW:key=lavfi.signalstats.YHIGH", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const lo = Number(/YLOW=(\d+(\.\d+)?)/.exec(r)?.[1] ?? 0), hi = Number(/YHIGH=(\d+(\.\d+)?)/.exec(r)?.[1] ?? 0);
  return hi - lo;
}
export function sceneCredits(job: string): Set<string> {
  const all = [...jread<Array<{ file: string }>>(path.join(job, "credits.json"), [])];
  const dir = path.join(job, "credits");
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".json")) all.push(...jread<Array<{ file: string }>>(path.join(dir, f), []));
  return new Set(all.map((c) => path.basename(c.file).replace(/\.\w+$/, "")));
}

export async function sceneCheck(job: string, id: string, o: { render?: boolean } = {}): Promise<{ pass: boolean; checks: GateCheck[] }> {
  const checks: GateCheck[] = [];
  const add = (cid: string, pass: boolean, detail: string) => checks.push({ id: cid, pass, detail });
  const plan = readPlan(job), i = plan?.scenes.findIndex((s) => s.id === id) ?? -1;
  if (!plan || i < 0) { add("plan", false, `no scene ${id} in plan.json`); return { pass: false, checks }; }
  const file = path.join(job, "src", "scenes", `${id}.tsx`);
  const code = existsSync(file) ? readFileSync(file, "utf8") : "";
  add("built", Boolean(code) && !code.includes(STUB), code.includes(STUB) ? "still the stub — build the scene" : `${code.split("\n").length} lines`);
  const others = [...code.matchAll(/from\s+["']\.\/(s\d{2})["']|from\s+["']\.\.\/scenes\/(s\d{2})["']/g)].map((m) => m[1] ?? m[2]).filter((x) => x !== id);
  add("own_scene", others.length === 0, others.length ? `imports another scene (${others.join(", ")}) — share through src/world.tsx or your own folder src/scenes/${id}/` : "imports no other scene");
  const media = [...code.matchAll(/staticFile\(\s*[`"']([^`"'$]+)[`"']/g)].map((m) => m[1]!);
  const missing = media.filter((m) => !existsSync(path.join(job, "public", m)));
  add("media_exist", missing.length === 0, missing.length ? `missing in public/: ${missing.join(", ")}` : `${media.length} file(s) used`);
  const credited = sceneCredits(job);
  const raw = (m: string) => path.basename(m).replace(/\.\w+$/, "").replace(/_(cut|crop\w*|depth|mask)$/, "");
  const uncredited = media.filter((m) => !credited.has(raw(m)) && ![...credited].some((c) => raw(m).includes(c) || c.includes(raw(m))));
  add("credited", uncredited.length === 0, uncredited.length ? `no source recorded for: ${uncredited.join(", ")} — film-tools credit <file> <kind> "<source>" "<url>"` : "every file it uses has a source");
  if (o.render !== false && code && !code.includes(STUB)) {
    const len = jread<{ seconds: number }>(path.join(job, "src", "length.json"), { seconds: 0 }).seconds;
    const w = sceneWindow(plan, i, len), s = plan.scenes[i]!;
    const ts = [s.from + 0.15, (s.from + s.to) / 2, Math.min(s.to, w.startS + w.frames / FPS) - 0.15].map((t) => t.toFixed(2));
    const root = process.env.OPUMIA_ROOT ?? process.cwd();
    // async: the orchestrator runs several builders' sessions at once, and a blocking render would stall them all
    const r = await runAsync("npx", ["tsx", path.join(root, "packages/motion-engine/src/hand/render-film.ts"), job, "--entry", path.join("src", "entries", `${id}.tsx`), "--offset", String(w.startS), "--stills-dir", path.join("stills", id, "check"), "--stills", ts.join(",")], root);
    const outs = ts.map((t) => path.join(job, "stills", id, "check", `t${Number(t).toFixed(2)}.jpg`));
    const ok = r.status === 0 && outs.every((f) => existsSync(f));
    add("renders", ok, ok ? `stills at ${ts.join(", ")} s in stills/${id}/check/` : `render failed: ${(r.stderr || r.stdout).split("\n").filter((l) => /error|Error|cannot|Cannot/.test(l)).slice(0, 6).join(" | ").slice(0, 900)}`);
    if (ok) {
      const blank = outs.filter((f) => lumaSpread(f) < 24);
      add("not_blank", blank.length === 0, blank.length ? `blank or nearly flat frame(s): ${blank.map((f) => path.basename(f)).join(", ")}` : "picture at start, middle and end");
    }
  }
  // what the builder did (its own tool log): it looked at the scene it rendered, and searched for the real material of
  // the subjects its scene names before settling for stock
  const realKinds = /press|film clip|screenshot|photo/i;
  const allCredits = [...jread<Array<{ file: string; kind: string }>>(path.join(job, "credits.json"), []), ...(existsSync(path.join(job, "credits")) ? readdirSync(path.join(job, "credits")).filter((f) => f.endsWith(".json")).flatMap((f) => jread<Array<{ file: string; kind: string }>>(path.join(job, "credits", f), [])) : [])];
  const drawsReal = media.some((m) => allCredits.some((c) => realKinds.test(c.kind) && (c.file === m || raw(m).includes(path.basename(c.file).replace(/\.\w+$/, "")))));
  for (const c of builderProcess(job, plan, id, drawsReal, media.some((m) => /^(v|img)\//.test(m)))) add(c.id, c.pass, c.detail);
  // the referee on the scene's own stills (inside a production: the builder's log exists and the stills were rendered)
  const stills = path.join(job, "stills", id, "check");
  if (existsSync(path.join(job, "logs", `build-${id}.tools.jsonl`)) && existsSync(stills)) {
    try {
      const { refereeConfig, refereeScore } = await import("../referee/score.js");
      const root = process.env.OPUMIA_ROOT ?? process.cwd();
      const cfg = refereeConfig(path.join(root, "data"), "magnates-media");
      const files = readdirSync(stills).filter((f) => f.endsWith(".jpg")).map((f) => path.join(stills, f));
      if (cfg && files.length) {
        const v = await refereeScore({ root, data: path.join(root, "data"), reference: path.resolve(root, process.env.OPUMIA_REFERENCE_DIR ?? "Reference"), channel: "magnates-media", stills: files });
        add("referee", v.score >= cfg.stretchLow, `${v.score} against the channel (its weakest tenth of moments: ${cfg.stretchLow}; a whole channel film ≥ ${cfg.filmBar})${v.score >= cfg.stretchLow ? "" : ` — this reads below the channel's weakest moments: film-tools ref similar "<your words>" shows how it puts a line like yours on screen`}`);
      }
    } catch { /* the referee is not built yet: not checked */ }
  }
  return { pass: checks.every((c) => c.pass), checks };
}
