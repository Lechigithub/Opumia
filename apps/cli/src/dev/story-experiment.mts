// Experiment: do line-kind profiles separate the real channel from bland rewrites and from our scripts?
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { blandRewrite, labelLines, sentencesOf, storyProfile, usageLedger, LINE_KINDS, type StoryProfile } from "@opumia/agents";
import { loadKeys } from "../keys.js";
loadKeys(process.cwd());
const dir = "Reference/.analysis/story_in";
const films = readdirSync(dir).filter((f) => f.startsWith("MM-"));
const linesOf = (f: string) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => /^\[\d+\]/.test(l)).map((l) => l.replace(/^\[\d+\]\s*[\d.]+s\s*/, "").trim()).filter(Boolean);
const fmt = (p: StoryProfile) => `${LINE_KINDS.map((k) => `${k} ${(p.share[k] * 100).toFixed(0)}`).join(" | ")} || you ${(p.youShare * 100).toFixed(0)} I/we ${(p.firstPersonShare * 100).toFixed(0)} || open ${p.open.kinds.join(",")} || end ${p.end.kinds.join(",")}${p.end.callback ? " (callback)" : ""}`;
const prof = async (lines: string[]) => storyProfile(lines, await labelLines(lines));
// Real: the first 17 lines of each film (the length of one of our 90 s scripts) and the last 3 lines before the outro.
const real: StoryProfile[] = [];
const whole: StoryProfile[] = [];
const bland: StoryProfile[] = [];
for (const [i, f] of films.entries()) {
  const all = linesOf(f);
  const head = all.slice(0, 17);
  real.push(await prof(head));
  if (i % 4 === 0) {
    const b = await blandRewrite(head.join(" "));
    bland.push(await prof(sentencesOf(b.text)));
    // a whole film, sampled evenly (first 25, 50 from the middle, last 15)
    const mid = all.slice(25, -15);
    const sample = [...all.slice(0, 25), ...mid.filter((_, k) => k % Math.max(1, Math.floor(mid.length / 50)) === 0).slice(0, 50), ...all.slice(-15)];
    whole.push(await prof(sample));
  }
}
const ours: Array<[string, StoryProfile]> = [];
for (const job of ["preview-kodak", "preview-theranos", "eval-quick-kodak", "eval-quick-theranos", "enron-mm", "nokia-magnates-v3"]) {
  try {
    const d = JSON.parse(readFileSync(`out/${job}/script.draft.json`, "utf8")) as { segments: Array<{ text: string }> };
    ours.push([job, await prof(d.segments.flatMap((s) => sentencesOf(s.text)))]);
  } catch { /* no script */ }
}
const band = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!; return `${(q(0.1) * 100).toFixed(0)}–${(q(0.9) * 100).toFixed(0)} (median ${(q(0.5) * 100).toFixed(0)})`; };
const table = (name: string, ps: StoryProfile[]) => console.log(`\n${name} (n=${ps.length})\n` + [...LINE_KINDS.map((k) => `  ${k.padEnd(9)} ${band(ps.map((p) => p.share[k]))}`), `  you       ${band(ps.map((p) => p.youShare))}`, `  I/we      ${band(ps.map((p) => p.firstPersonShare))}`, `  opens with: question ${ps.filter((p) => p.open.question).length}, address ${ps.filter((p) => p.open.address).length}, scene ${ps.filter((p) => p.open.scene).length} of ${ps.length}`].join("\n"));
table("REAL openings (first 17 lines of each film)", real);
table("REAL whole films (sampled)", whole);
table("BLAND rewrites of real openings", bland);
console.log("\nOURS");
for (const [j, p] of ours) console.log(`  ${j.padEnd(22)} ${p.lines} lines: ${fmt(p)}`);
console.log("\nreal endings (last 3 lines):", whole.map((p) => p.end.kinds.join(",") + (p.end.callback ? "*" : "")).join("  "));
writeFileSync("/private/tmp/claude-501/-Users-lechi-Opumia/6c4690a8-30dd-4dba-b0be-43cbbc224332/scratchpad/story-exp.json", JSON.stringify({ real, whole, bland, ours }, null, 1));
console.log(`\nspend $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
