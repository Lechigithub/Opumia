// The ladder engine on a made-up film (no model, no render): a problem climbs one rung per round, a fixed shot stops
// climbing, an exhausted ladder is reported, every attempt and outcome is logged.
//   npx tsx apps/cli/src/dev/ladder-test.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ladders, type Problem, type Rung } from "@opumia/agents";

export async function ladderTest(): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "ladder-"));
  const fails: string[] = [];
  const ran: string[] = [];
  const rung = (name: string): Rung<{ fixed: Set<string> }> => ({ name, owner: "test", maxUsd: 0, run: async (ps, a) => { ran.push(`${name}:${ps[0]!.shots.join("+")}`); if (name === "r2") a.fixed.add("sh002"); return "did it"; } });
  const l = new Ladders<{ fixed: Set<string> }>({ jobDir: dir, stage: "test", table: { bad: [rung("r1"), rung("r2"), rung("r3")] } });
  const act = { fixed: new Set<string>() };
  const problems = (): Problem[] => [{ check: "bad", shots: ["sh001", "sh002"].filter((s) => !act.fixed.has(s)), what: "x", measured: "1", band: "0" }].filter((p) => p.shots.length);
  for (let k = 0; k < 5; k++) if (!(await l.step(problems(), act)).length) break;
  const exhausted = l.exhausted(problems());
  await l.close(problems());
  const want = ["r1:sh001+sh002", "r2:sh001+sh002", "r3:sh001"];
  if (JSON.stringify(ran) !== JSON.stringify(want)) fails.push(`rungs ran ${JSON.stringify(ran)}, expected ${JSON.stringify(want)}`);
  if (exhausted.length !== 1 || exhausted[0]!.shots.join() !== "sh001") fails.push(`exhausted ${JSON.stringify(exhausted)}`);
  const log = readFileSync(path.join(dir, "ladders.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x) as { kind: string; fixed?: string[] });
  if (log.filter((x) => x.kind === "attempt").length !== 3) fails.push("three attempts should be logged");
  if (!log.some((x) => x.kind === "outcome" && x.fixed?.includes("sh002"))) fails.push("the fix of sh002 should be logged as an outcome");
  if (!log.some((x) => x.kind === "unresolved")) fails.push("the unresolved problem should be logged");
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await ladderTest();
  console.log(f.length ? `FAIL\n${f.join("\n")}` : "PASS ladder engine");
  process.exit(f.length ? 1 : 0);
}
