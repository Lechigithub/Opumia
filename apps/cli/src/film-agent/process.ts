// What the agents actually did, checked in code (owner, 2026-11-26, after proof film 2: the planner watched 12 s of one
// reference film and admitted it; builders spent $0.15 of $0.73 each; the finisher passed over the judge's tells).
// Every session writes its full tool calls to logs/<label>.tools.jsonl; these checks read them. A playbook asks; these
// refuse.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FilmPlan } from "./plan.js";

export interface ToolCall { t: string; name: string; input: Record<string, unknown> }
export const toolLog = (job: string, label: string) => path.join(job, "logs", `${label}.tools.jsonl`);
export function toolCalls(job: string, label: string): ToolCall[] {
  const f = toolLog(job, label);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as ToolCall]; } catch { return []; } });
}
const commands = (calls: ToolCall[]) => calls.filter((c) => c.name === "Bash").map((c) => String(c.input.command ?? ""));
const reads = (calls: ToolCall[]) => calls.filter((c) => c.name === "Read").map((c) => String(c.input.file_path ?? ""));
const lastName = (n: string) => n.trim().split(/\s+/).at(-1)!.toLowerCase();

/** The reference stretches a session watched: film, from, to (from `film-tools ref watch "<film>" <from> <to>`). */
export function watched(calls: ToolCall[]): Array<{ film: string; from: number; to: number }> {
  const out: Array<{ film: string; from: number; to: number }> = [];
  for (const c of commands(calls)) for (const m of c.matchAll(/film-tools\s+ref\s+watch\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/g)) out.push({ film: (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase(), from: Number(m[4]), to: Number(m[5]) });
  // a side-by-side watch with --ref counts too
  for (const c of commands(calls)) for (const m of c.matchAll(/film-tools\s+watch\s+\S+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)[^;&|\n]*--ref\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g)) out.push({ film: (m[3] ?? m[4] ?? m[5] ?? "").toLowerCase(), from: Number(m[1]), to: Number(m[2]) });
  return out;
}

/** The planner must have studied the reference and searched for real material of everyone the plan names. */
export function plannerProcess(job: string, plan: FilmPlan, label = "planner"): string[] {
  const calls = toolCalls(job, label);
  if (!calls.length) return [];
  const errs: string[] = [];
  const w = watched(calls), films = new Set(w.map((x) => x.film)), secs = w.reduce((t, x) => t + Math.max(0, x.to - x.from), 0);
  const sheets = reads(calls).filter((f) => /\/watch\/ref-/.test(f)).length;
  if (w.length < 3 || films.size < 2 || secs < 45) errs.push(`watch the reference before planning: ${w.length} stretch(es) of ${films.size} film(s), ${Math.round(secs)} s so far — watch at least 3 stretches from 2 different films, 45 s or more (an opening and a middle), with film-tools ref watch`);
  if (sheets < 3) errs.push(`look at what you watched: ${sheets} reference sheet(s) read — Read at least 3 of the frame sheets film-tools ref watch writes`);
  const cmds = commands(calls).join("\n").toLowerCase();
  const subjects = [...new Map(plan.scenes.flatMap((s) => s.entities ?? []).filter((e) => e.type === "person" || e.type === "company").map((e) => [e.name.toLowerCase(), e])).values()];
  const unsearched = subjects.filter((e) => !new RegExp(`film-tools\\s+(press|screenshot|commons)[^\\n]*${lastName(e.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(cmds));
  if (unsearched.length) errs.push(`search for real material of ${unsearched.map((e) => e.name).join(", ")} (film-tools press, film-tools screenshot of the source articles, film-tools commons) before planning their scenes around stock`);
  return errs;
}

/** A builder must have looked at its own rendered scene, and searched for its named subjects' real material. */
export function builderProcess(job: string, plan: FilmPlan, id: string, drawsReal: boolean): Array<{ id: string; pass: boolean; detail: string }> {
  const calls = toolCalls(job, `build-${id}`);
  if (!calls.length) return [];
  const out: Array<{ id: string; pass: boolean; detail: string }> = [];
  const looked = reads(calls).filter((f) => new RegExp(`/stills/${id}/(?!check/)|/watch/[^/]*${id}|scene_${id}`).test(f)).length;
  out.push({ id: "looked", pass: looked > 0, detail: looked ? `looked at ${looked} rendered frame(s) of the scene` : `render your scene (film-tools render --stills …) and Read the stills before you finish — nothing of it was looked at` });
  // it saw how the channel shows a line like its own before building (retrieval over the channel's labelled shots)
  const studied = commands(calls).filter((c) => /film-tools\s+ref\s+(similar|technique)\b/.test(c)).length;
  out.push({ id: "studied", pass: studied > 0, detail: studied ? `looked at how the channel shows lines like this (${studied} search${studied > 1 ? "es" : ""})` : `before you build, see how the channel shows a line like yours: film-tools ref similar "<your scene's words>" (and Read the sheet), or film-tools ref technique "<technique>"` });
  const scene = plan.scenes.find((s) => s.id === id);
  const subjects = (scene?.entities ?? []).filter((e) => e.type === "person" || e.type === "company");
  if (subjects.length && !drawsReal) {
    const cmds = commands(calls).join("\n").toLowerCase();
    const prefetch = existsSync(path.join(job, "downloads", id, "PREFETCH.md")) ? readFileSync(path.join(job, "downloads", id, "PREFETCH.md"), "utf8").toLowerCase() : "";
    const tried = subjects.filter((e) => new RegExp(`film-tools\\s+(press|screenshot|commons)[^\\n]*${lastName(e.name)}`).test(cmds) || new RegExp(`## film-tools (press|commons)[^\\n]*${lastName(e.name)}`).test(prefetch));
    out.push({ id: "real_first", pass: tried.length === subjects.length, detail: tried.length === subjects.length ? "real material was searched for before stock" : `the scene names ${subjects.map((e) => e.name).join(", ")} but shows no real material and never searched for it — film-tools press "<name> <company>" --person/--world, film-tools screenshot <source article>, film-tools commons` });
  }
  return out;
}

/** The finisher's answer to the judge's tells: TELLS.md names each tell and what changed (or why not). */
export function tellsAnswered(job: string, tells: string[]): string[] {
  if (!tells.length) return [];
  const f = path.join(job, "TELLS.md");
  if (!existsSync(f)) return tells;
  const text = readFileSync(f, "utf8").toLowerCase();
  // a tell counts as answered when its distinctive words appear in TELLS.md
  return tells.filter((t) => { const words = t.toLowerCase().match(/[a-z]{6,}/g) ?? []; const hit = words.filter((w) => text.includes(w)).length; return words.length && hit / words.length < 0.3; });
}
