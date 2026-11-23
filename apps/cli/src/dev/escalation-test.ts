// Learning from escalations (build list 3, item 30) on a made-up data folder: a check that needed a stronger rung in two
// produced films becomes an open platform fix and a lesson for the agent whose first rung did not prevent it; one film is
// not enough; a fixed problem that escalates again is open again.
//   npx tsx apps/cli/src/dev/escalation-test.ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyseEscalations, markEscalationFixed, markProduced, recordEscalations } from "@opumia/agents";

export async function escalationTest(): Promise<string[]> {
  const fails: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), "esc-"));
  const data = path.join(root, "data");
  const film = async (job: string, rows: Array<{ check: string; level: number; owner: string; at?: string }>) => {
    const jd = path.join(root, "out", job);
    mkdirSync(jd, { recursive: true });
    writeFileSync(path.join(jd, "ladders.jsonl"), rows.map((r) => JSON.stringify({ kind: "attempt", stage: "preflight", at: r.at ?? new Date().toISOString(), check: r.check, rung: `rung ${r.level + 1}`, level: r.level, owner: r.owner, shots: ["sh001"], usd: 0.1, seconds: 5, note: "did it" })).join("\n") + "\n");
    await markProduced(data, job, `${job}.mp4`);
    await recordEscalations({ data, jobDir: jd, job, channel: "magnates-media" });
  };
  await film("f1", [{ check: "unreadable_text", level: 0, owner: "scene designer" }, { check: "unreadable_text", level: 1, owner: "scene designer" }, { check: "weak_fit", level: 0, owner: "picture researcher" }]);
  let list = await analyseEscalations({ data, channel: "magnates-media" });
  if (list.length) fails.push(`one film is not recurring: ${list.map((x) => x.key).join()}`);
  await film("f2", [{ check: "unreadable_text", level: 0, owner: "scene designer" }, { check: "unreadable_text", level: 2, owner: "art director" }]);
  list = await analyseEscalations({ data, channel: "magnates-media" });
  const r = list.find((x) => x.key === "preflight|unreadable_text");
  if (!r || r.status !== "open" || r.films.length !== 2 || r.firstOwner !== "scene designer") fails.push(`recurring: ${JSON.stringify(r)}`);
  if (list.some((x) => x.check === "weak_fit")) fails.push("weak_fit never escalated: not recurring");
  let lesson = "";
  try { lesson = readFileSync(path.join(data, "agents", "scenes", "magnates-media.md"), "utf8"); } catch { /* missing */ }
  if (!/LESSON \(escalations\): "unreadable_text"/.test(lesson)) fails.push("no lesson written for the scene designer");
  await analyseEscalations({ data, channel: "magnates-media" });
  if ((readFileSync(path.join(data, "agents", "scenes", "magnates-media.md"), "utf8").match(/LESSON \(escalations\)/g) ?? []).length !== 1) fails.push("the lesson should be written once");
  await markEscalationFixed(data, "preflight|unreadable_text");
  list = await analyseEscalations({ data, channel: "magnates-media" });
  if (list.find((x) => x.key === "preflight|unreadable_text")?.status !== "fixed") fails.push("marked fixed should stay fixed");
  await film("f3", [{ check: "unreadable_text", level: 1, owner: "scene designer", at: new Date(Date.now() + 60_000).toISOString() }]);
  list = await analyseEscalations({ data, channel: "magnates-media" });
  if (list.find((x) => x.key === "preflight|unreadable_text")?.status !== "open") fails.push("escalating again after the fix should reopen it");
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await escalationTest();
  console.log(f.length ? `FAIL\n${f.join("\n")}` : "PASS escalation learning");
  process.exit(f.length ? 1 : 0);
}
