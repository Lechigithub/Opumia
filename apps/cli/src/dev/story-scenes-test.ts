// Build list 5, items 5–9: the scene-and-character band at a length, the filler ban learned from the reference, and a
// script measured against them.
//   npx tsx apps/cli/src/dev/story-scenes-test.ts [out/<job>] [--length 90] [--fresh]
//   (no job: the offline cases only — time jumps and filler, no model calls)
import { readFile } from "node:fs/promises";
import path from "node:path";
import { endingKind, ensureFillerBan, ensureReferenceFilms, ensureSceneBand, labelSceneLines, openingLineCount, sceneIssues, timeJumps, type FillerBan } from "@opumia/agents";
import { loadKeys } from "../keys.js";

export function storyScenesOffline(): string[] {
  const fails: string[] = [];
  // the Nokia script's telescoped chronology: the iPhone (2007) and Elop's appointment (2010) in one sentence
  const j = timeJumps(["When Apple unveiled the iPhone in 2007 and Nokia hired Stephen Elop in 2010, the company was already sinking."]);
  if (j.length !== 1 || !j[0]!.inside) fails.push(`a 2007→2010 jump inside one sentence must be caught (got ${JSON.stringify(j)})`);
  if (timeJumps(["In 2007 Apple unveiled the iPhone.", "For the next three years Nokia's engineers kept polishing Symbian.", "In 2010 the board hired Elop."]).length) fails.push("a bridged jump must pass");
  if (timeJumps(["In 1998 Nokia became the world's biggest phone maker.", "To understand why, we need to go back to 1865."]).length) fails.push("a flashback is not a skip");
  if (timeJumps(["In 1998 Nokia led the market.", "In 2013 it sold its phone business."]).length !== 1) fails.push("an unbridged 15-year jump between sentences must be caught");
  const ban: FillerBan = { schemaVersion: 1, channel: "x", lines: 1, banned: ["it sounds absurd", "this is the story of", "in other words"], allowed: [] };
  const L5 = ["It sounds absurd, because Nokia owned the market.", "It had everything.", "Then things changed.", "The market moved.", "The company sold."];
  if (timeJumps(["Then the iPhone arrived and Nokia handed the job to Elop."], 2, [{ moment: false, agency: false, year: 2007, toYear: 2010 }]).length !== 1) fails.push("a labelled 2007→2010 line must be caught as telescoped");
  const fi = sceneIssues({ lines: L5, labels: L5.map(() => ({ moment: false, agency: false })), band: { schemaVersion: 1, channel: "x", lengthS: 90, windows: 9, wordsPerSecond: 3, moment: { p10: 0.3, p25: 0.3, p50: 0.4, p90: 0.6 }, agency: { p10: 0.05, p25: 0.05, p50: 0.1, p90: 0.3 }, jumpsPer10: { p10: 0, p25: 0, p50: 0, p90: 0.5 }, opensOnMoment: 0.7, endings: { consequence: 0.6, restatement: 0.1 } }, ban, openLines: 1, durationS: 90 });
  const kinds = fi.issues.map((i) => i.kind);
  for (const k of ["filler", "scene_low", "opening_no_moment"]) if (!kinds.includes(k as never)) fails.push(`expected ${k} on a summary opening with filler, got ${kinds.join(",")}`);
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fails = storyScenesOffline();
  const job = process.argv.slice(2).find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
  if (job) {
    loadKeys(process.cwd());
    const root = process.cwd();
    const data = path.join(root, "data");
    const ref = process.env.OPUMIA_REFERENCE_DIR ?? path.join(root, "Reference");
    const L = Number(process.argv[process.argv.indexOf("--length") + 1]) || 90;
    const films = await ensureReferenceFilms({ reference: ref, data, channelId: "magnates-media" });
    const ban = await ensureFillerBan({ data, root, channelId: "magnates-media", films, fresh: process.argv.includes("--fresh") });
    console.log(`filler ban (${ban.lines} real lines): ${ban.banned.length} banned — ${ban.banned.slice(0, 30).join(" | ")}`);
    console.log(`  used by the channel: ${ban.allowed.slice(0, 12).map((a) => `${a.phrase} ${a.per1000}`).join(" | ")}`);
    const band = await ensureSceneBand({ data, channelId: "magnates-media", films, lengthS: L, fresh: process.argv.includes("--fresh"), log: console.log });
    console.log("band", JSON.stringify(band));
    const d = JSON.parse(await readFile(path.join(job, "script.draft.json"), "utf8")) as { segments: Array<{ text: string }>; durationS?: number };
    const facts = JSON.parse(await readFile(path.join(job, "facts.json"), "utf8")) as { story?: { scenes: Array<{ what: string; when: string; where: string }> } };
    const lines = d.segments.flatMap((s) => s.text.split(/(?<=[.!?])\s+/)).filter(Boolean);
    const dated = ((JSON.parse(await readFile(path.join(job, "facts.json"), "utf8")) as { claims: Array<{ kind: string; text: string }> }).claims ?? []).filter((c) => c.kind === "date" || c.kind === "event").map((c) => c.text);
    const labels = await labelSceneLines(lines, dated);
    console.log(labels.map((l, i) => `${i}:${l.moment ? "M" : "-"}${l.agency ? "A" : "-"}${l.year ?? ""}${l.toYear && l.toYear !== l.year ? `→${l.toYear}` : ""}`).join(" "));
    const openW = Math.round(Math.min(20, L / 4) * (band?.wordsPerSecond ?? 3.3));
    const ol = openingLineCount(lines, openW);
    const ending = await endingKind(lines.slice(0, ol), lines.slice(-2));
    const r = sceneIssues({ lines, labels, band: band!, ban, openLines: ol, ending, dossierMoments: facts.story?.scenes ?? [], durationS: L });
    console.log(JSON.stringify(r.profile));
    for (const i of r.issues) console.log(`  [${i.kind}] ${i.detail}`);
  }
  console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "PASS story scenes (offline)");
  process.exit(fails.length ? 1 : 0);
}
