// Film 3's faults as tests (build list 4), no network and no model calls:
//  - the film's limit counts earlier runs (a resume does not start again from $0) and keeps a reserve for the finish;
//  - an agent stops before a turn that would overshoot its cap;
//  - a resumed ladder continues at its level, and a rung that fixed nothing is not bought again;
//  - an exhausted ladder leaves the problem logged (the film goes on);
//  - one chart, one unit ("$1,100" patents); lone words and broken fragments are refused; same-subject films are
//    recognised.
//   npx tsx apps/cli/src/dev/film3-test.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentLeft, inRepair, bindFactProps, budgetLeft, filmSpent, filmSubject, Ladders, loneText, recordExternal, setBudget, setFinishing, setStageCap, type NumericFact } from "@opumia/agents";

export async function film3Test(): Promise<string[]> {
  const fails: string[] = [];
  // 1–2 (and the Blockbuster proof film): the film's money in three buckets — first passes, the repair pool, the finish
  setBudget(5, { spentBefore: 2, reserveUsd: 1.2, repairUsd: 0.8 });
  if (Math.abs(filmSpent() - 2) > 1e-9) fails.push(`film spent should start at the earlier runs' $2, got ${filmSpent()}`);
  if (Math.abs((budgetLeft() ?? 0) - 0.8) > 1e-9) fails.push(`repairs should have the $0.80 pool, got ${budgetLeft()}`);
  recordExternal("test", "test", 1, 0.5);
  setStageCap(0.2);
  if (Math.abs((agentLeft() ?? 0) - 0.2) > 1e-9) fails.push(`a first pass is bounded by its stage cap ($0.20), got ${agentLeft()}`);
  setStageCap(1);
  if (Math.abs((agentLeft() ?? 0) - 0.5) > 1e-9) fails.push(`a first pass may not touch the repair pool or the finish reserve ($0.50 left of 5 − 2.5 − 1.2 − 0.8), got ${agentLeft()}`);
  if (Math.abs((budgetLeft() ?? 0) - 0.8) > 1e-9) fails.push(`first-pass spending must not shrink the repair pool, got ${budgetLeft()}`);
  await inRepair(async () => { recordExternal("test", "test", 1, 0.3); });
  if (Math.abs((budgetLeft() ?? 0) - 0.5) > 1e-9) fails.push(`a repair spends the pool ($0.50 left), got ${budgetLeft()}`);
  setStageCap(null);
  setFinishing(true);
  if (Math.abs((agentLeft() ?? 0) - 1.7) > 1e-9) fails.push(`the finish opens the reserve (5 − 2.8 − 0.5 pool = $1.70), got ${agentLeft()}`);
  setBudget(null);

  // 5 and 3: ladders resume at their level, skip futile rungs, and end exhausted (logged), never throwing
  const jobDir = mkdtempSync(path.join(tmpdir(), "f3-"));
  let ran: string[] = [];
  const table = { look: [
    { name: "kit change", owner: "art director", maxUsd: 0, run: async () => (ran.push("kit"), "the art director did not get the change accepted") },
    { name: "new concept", owner: "art director", maxUsd: 0, run: async () => (ran.push("concept"), "kit redesigned") },
  ], words: [
    { name: "fix the words", owner: "scene designer", maxUsd: 0, run: async () => (ran.push("words"), "1 scene sent back") },
  ] };
  const p = (check: string) => ({ check, shots: [], what: check, measured: "1", band: "0" });
  const a = new Ladders<null>({ jobDir, stage: "preflight", table });
  await a.step([p("look"), p("words")], null);
  if (ran.join() !== "kit,words") fails.push(`round 1 ran ${ran.join()}`);
  // a resumed run (new Ladders on the same job): the art director already failed a whole-film change → its rungs skip
  ran = [];
  const b = new Ladders<null>({ jobDir, stage: "preflight", table });
  await b.step([p("look"), p("words")], null);
  if (ran.includes("kit") || ran.includes("concept")) fails.push(`a resumed ladder bought the failed art director again: ${ran.join()}`);
  if (b.exhausted([p("look")]).length !== 1) fails.push("the look problem should be exhausted (logged), not retried");
  await b.close([p("look")]);
  const log = readFileSync(path.join(jobDir, "ladders.jsonl"), "utf8");
  if (!/"kind":"unresolved","check":"look"/.test(log)) fails.push("the exhausted problem must be logged as unresolved");
  if (!/already failed to get a whole-film change accepted/.test(log)) fails.push("the skip must be logged with its reason");

  // 12: one chart, one unit
  const nf: NumericFact[] = [
    { id: "n1", value: 3e9, unit: "$", display: "$3B", context: "licensing", claimId: "c1" } as NumericFact,
    { id: "n2", value: 1100, unit: "", display: "1,100", context: "patents unsold", claimId: "c2" } as NumericFact,
  ];
  if (bindFactProps("chart", { facts: ["n1", "n2"], labels: ["Licensing", "Unsold"], unit: "$" }, nf) !== null) fails.push("a chart mixing $3B and 1,100 patents must be refused");
  const nfTwo = [...nf, { id: "n3", value: 2e9, unit: "$", display: "$2B", context: "royalties", claimId: "c5" } as NumericFact];
  if (bindFactProps("chart", { facts: ["n1", "n3"], labels: ["Licensing", "Royalties"] }, nfTwo) === null) fails.push("a one-unit chart of two figures must bind");
  if (bindFactProps("chart", { facts: ["n1"], labels: ["Licensing"] }, nf) !== null) fails.push("a chart of one figure (a lonely bar, the Blockbuster proof film) must be refused");
  // proof film: "promised $100M vs real $100K" drew one bar and an invisible one
  const nf2 = [{ id: "m1", value: 1e8, unit: "$", display: "$100M", context: "promised", claimId: "c3" }, { id: "m2", value: 1e5, unit: "$", display: "$100K", context: "real", claimId: "c4" }] as NumericFact[];
  if (bindFactProps("chart", { type: "bar", facts: ["m1", "m2"], labels: ["Promised", "Real"] }, nf2) !== null) fails.push("a bar chart whose bars cannot be read (1000:1) must be refused");
  // proof film: a rung needing $0.60 was skipped with $0.59 left — a cent is inside the tolerance
  {
    const jd = mkdtempSync(path.join(tmpdir(), "f3b-"));
    let did = false;
    setBudget(1.59, { reserveUsd: 1, repairUsd: 0.59 });
    const l = new Ladders<null>({ jobDir: jd, stage: "narration", table: { len: [{ name: "trim", owner: "writer", maxUsd: 0.6, run: async () => ((did = true), "trimmed") }] } });
    await l.step([{ check: "len", shots: [], what: "", measured: "", band: "" }], null);
    setBudget(null);
    if (!did) fails.push("a rung one cent over what is left must still run");
  }

  // 14: lone words and fragments
  const line = "Kodak engineer Steven Sasson built the camera, and the investment market kept competing. Kodak earned from it.";
  for (const [t, bad] of [["INVESTMENT", true], ["EARNED FROM", true], ["Sasson", false], ["KODAK", false], ["the camera Sasson built", false]] as const) if (Boolean(loneText(t, line)) !== bad) fails.push(`lone text "${t}" should be ${bad ? "refused" : "allowed"}`);

  // 7: same subject
  if (filmSubject("How Kodak invented the digital camera and still went bankrupt") !== filmSubject("How Kodak invented the digital camera and still died")) fails.push("two Kodak topics must share a subject");
  if (filmSubject("How Nokia lost the smartphone war") === filmSubject("How Kodak invented the digital camera")) fails.push("Nokia and Kodak are different subjects");
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await film3Test();
  console.log(f.length ? `FAIL\n${f.join("\n")}` : "PASS film 3 faults");
  process.exit(f.length ? 1 : 0);
}
