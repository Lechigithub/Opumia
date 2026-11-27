// The script referee (tools/referee/script_referee.py): does a narration read like the channel's? A topic-free style
// fingerprint proven on six held-back channel narrations (2026-11-27): held-back windows flagged 1 %, ours caught 86 %;
// whole held-back narrations 0.96–0.99, held-back 90 s openings 0.71–1.00, our 20 scripts 0.00–0.68.
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ScriptVerdict { score: number; bar: number; pass: boolean; windows: number[]; weakWindows: number[]; structure: number; gaps: Array<{ what: string; ours: number; channel: number; more: boolean; push: number }> }
/** Whether the referee blocks a script. Off until the writer is shown to reach the bar (a paid test); it reports meanwhile. */
export const SCRIPT_REFEREE_BLOCKS = false;

const modelFile = (data: string, channel: string) => path.join(data, "referee", `${channel}-script.json`);
/** The narrations held back from the referee's training: the writer may not read them either. */
export function heldBackScripts(data: string, channel = "magnates-media"): Set<string> {
  try { return new Set((JSON.parse(readFileSync(modelFile(data, channel), "utf8")) as { held: string[] }).held); } catch { return new Set(); }
}
export function scriptReferee(root: string, text: string, channel = "magnates-media"): ScriptVerdict | null {
  const data = path.join(root, "data");
  if (channel !== "magnates-media" || !existsSync(modelFile(data, channel))) return null;
  const py = process.env.OPUMIA_PY ?? path.join(process.env.HOME ?? "", "lechi_tts", "venv", "bin", "python");
  const d = mkdtempSync(path.join(tmpdir(), "sref-")), f = path.join(d, "script.txt");
  try {
    writeFileSync(f, text);
    const r = spawnSync(py, ["-I", path.join(root, "tools", "referee", "script_referee.py"), "score", f], { encoding: "utf8", timeout: 60_000 });
    const v = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1) ?? "null") as ScriptVerdict | { error: string } | null;
    return v && "score" in v ? v : null;
  } catch { return null; } finally { rmSync(d, { recursive: true, force: true }); }
}
/** The referee's verdict in the writer's words: the score, the bar and what pulls the script away from the channel. */
export function scriptRefereeReport(v: ScriptVerdict): string {
  const gap = (g: ScriptVerdict["gaps"][number]) => `${g.what}: ${g.more ? "more" : "less"} than the channel (yours ${g.ours}, the channel ${g.channel})`;
  return `- reads like the channel (the script referee, proven on held-back channel narrations): ${v.score} (bar ${v.bar}) — ${v.pass ? "yes" : "NOT YET"}${v.gaps.length ? `\n  what pulls it away from the channel, strongest first:\n${v.gaps.map((g) => `   · ${gap(g)}`).join("\n")}` : ""}${v.weakWindows.length ? `\n  weakest stretches: words ${v.weakWindows.map((i) => `${i * 50}–${i * 50 + 100}`).join(", ")}` : ""}`;
}
