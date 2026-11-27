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
const t = (M.test as { human: { heldWindowsFlagged: number; ourWindowsCaught: number; gamedWindowsCaught: number }; channel: { heldMagnates: Record<string, number>; heldOthers: Record<string, number> } });
ok("held-back human narration windows rarely flagged (≤ 5 %)", t.human.heldWindowsFlagged <= 0.05, t.human.heldWindowsFlagged);
ok("our windows caught as not human (≥ 75 %)", t.human.ourWindowsCaught >= 0.75, t.human.ourWindowsCaught);
ok("cheap tricks on never-seen scripts caught (≥ 75 %)", t.human.gamedWindowsCaught >= 0.75, t.human.gamedWindowsCaught);
// the first referee passed the other channels' human narrations (it measured human vs ours, not this channel): the
// channel measure must separate MagnatesMedia from them
const cm = Object.values(t.channel.heldMagnates), co = Object.values(t.channel.heldOthers);
ok("every held-back MagnatesMedia narration scores above every held-back narration of the other channels", Math.min(...cm) > Math.max(...co), { magnates: [Math.min(...cm), Math.max(...cm)], others: [Math.min(...co), Math.max(...co)] });
// other channels' human narrations pass as human but fail as MagnatesMedia
{
  const { scriptReferee: sr } = await import("@opumia/agents");
  const other = JSON.parse(readFileSync(path.join(DATA, "story-profile", "how-money-works-films.json"), "utf8")) as Array<{ lines: Array<string | { text: string }> }>;
  const v = sr(ROOT, other[0]!.lines.map((l) => (typeof l === "string" ? l : l.text)).join(" "))!;
  ok("another channel's narration reads as human but not as MagnatesMedia", (v.human ?? 0) >= (v.humanBar ?? 1) && (v.channel ?? 1) < (v.channelBar ?? 0), { human: v.human, channel: v.channel });
}
// a known script of ours that does not read like the channel
const j = path.join(ROOT, "out", "agent-juicero-3", "script.draft.json");
if (existsSync(j)) {
  const v = scriptReferee(ROOT, (JSON.parse(readFileSync(j, "utf8")) as { segments: Array<{ text: string }> }).segments.map((s) => s.text).join(" "))!;
  ok("agent Juicero's script (accepted by the old checks) does not pass", !v.pass, `${v.score} (bar ${v.bar})`);
  ok("the writer is told craft gaps, never single words to sprinkle", v.gaps.every((g) => !g.what.startsWith('the word "')), v.gaps.map((g) => g.what));
}
// the proof run's Quibi script: the words that drag its weak stretches are shown as words to CUT ("had", "than")
// the proof run's first Quibi script (0.29), kept apart from later re-runs that overwrite out/writer-score
const qf = path.join(ROOT, "out", "writer-score-proof1", "bl5c-quibi", "script.draft.json");
if (existsSync(qf)) {
  const q = scriptReferee(ROOT, (JSON.parse(readFileSync(qf, "utf8")) as { segments: Array<{ text: string }> }).segments.map((s) => s.text).join(" "))!;
  const cut = (q.cut ?? []).map((c) => c.word);
  ok("weak stretches name the over-used words to cut (Quibi: had, than)", cut.includes("had") && cut.includes("than"), cut);
  ok("every word to cut is over-used, never one to add", (q.cut ?? []).every((c) => c.ours > c.channel), q.cut);
}
// openings: our formula is refused, the channel's own openings (in date order) never are
{
  const { openingFormula, openingShape } = await import("@opumia/agents");
  type E = { topic: string; first: string; shape: string; at: string };
  const L: E[] = [];
  let flagged = 0;
  for (const f of films) { const t = text(f); if (openingFormula(t, f.id, L)) flagged++; L.push({ topic: f.id, first: t.slice(0, 200), shape: openingShape(t), at: "" }); }
  ok("the channel's 30 openings, in order, are never called a formula", flagged === 0, flagged);
  const ours: E[] = [];
  const run = ["One August morning, WeWork filed papers for its stock market debut.", "One January, Nikola posted a video of its electric truck.", "On a Monday in November, Sam Bankman-Fried told the world.", "It's a Thursday in June, and Wirecard has promised to publish its accounts."];
  const verdicts = run.map((t, i) => { const v = openingFormula(t, `t${i}`, ours); ours.push({ topic: `t${i}`, first: t, shape: openingShape(t), at: "" }); return Boolean(v); });
  ok("our time-stamped opening formula is refused once it repeats", verdicts[3] === true, verdicts);
  ok("an opening built another way passes", openingFormula("Wirecard said it had €1.9 billion sitting in two Philippine banks.", "t9", ours) === null);
}
// the voice meter: the channel's own held-back stretches sit inside its band; an early script of ours asked too much
{
  const { voiceBand, voiceStats, voiceOff } = await import("@opumia/agents");
  const b = voiceBand({ data: DATA, films: films as never, held: new Set(M.held) });
  const chunks = films.filter((f) => M.held.includes(f.id)).flatMap((f) => { const w = text(f).split(/\s+/); const out: string[] = []; for (let i = 0; i + 300 <= w.length; i += 300) out.push(w.slice(i, i + 300).join(" ")); return out; });
  const off = chunks.reduce((n, c) => n + voiceOff(voiceStats(c), b).length, 0) / chunks.length;
  ok("held-back channel stretches sit inside the voice band (≤ 1.2 of 7 measures off)", off <= 1.2, off.toFixed(2));
  const early = path.join(ROOT, "out", "writer-score-advisory", "bl5c-quibi", "script.draft.json");
  if (existsSync(early)) {
    const t = (JSON.parse(readFileSync(early, "utf8")) as { segments: Array<{ text: string }> }).segments.map((s) => s.text).join(" ");
    ok("an early script of ours is flagged for its questions", voiceOff(voiceStats(t), b).includes("questions"), voiceOff(voiceStats(t), b));
  }
}
console.log(fails ? `${fails} failed` : "script referee: all passed");
process.exitCode = fails ? 1 : 0;
