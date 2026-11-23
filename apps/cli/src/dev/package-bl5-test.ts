// Build list 5, items 29–30, on the Nokia proof film's package (no film is produced):
//  - a topic-sentence title ("How Nokia lost the smartphone war") fails the title test; a title promising a turn passes
//    the promise rule (labelled by the same function as the channel's real titles);
//  - the concept critic, told the story's turn, scores a topic concept (the burning phone) under a twist concept;
//  - a wordless thumbnail is allowed only while our recent share stays within the channel's (offline);
//  - packaging's craft measures are produced.
//   npx tsx apps/cli/src/dev/package-bl5-test.ts [out/<job>] [--offline]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { critiqueConcepts, ensureThumbCraft, ensureTitlePromiseBand, packagingCraftMeasures, storyTurn, testTitlesWithPromise, usageLedger, wordlessThumbAllowed, type ThumbBand } from "@opumia/agents";
import { TimedScript } from "@opumia/contracts";
import { loadKeys } from "../keys.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const data = path.join(ROOT, "data");
const job = path.join(ROOT, process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? "out/bl4c-nokia");
const offline = process.argv.includes("--offline");
const fails: string[] = [];

// offline: the wordless rule and the measures
if (wordlessThumbAllowed({ films: 0, wordless: 0 }, 0.38)) fails.push("a first film's thumbnail must carry words (channel: 62 % have words)");
if (!wordlessThumbAllowed({ films: 5, wordless: 1 }, 0.38)) fails.push("2 wordless of 6 (33 %) is within a 38 % share and must be allowed");
if (wordlessThumbAllowed({ films: 5, wordless: 2 }, 0.38)) fails.push("3 wordless of 6 (50 %) is over a 38 % share and must be refused");
const m = packagingCraftMeasures({ thumbWords: 0, titlePromise: "topic", titleRisk: 0.4 });
if (m.thumbHasWords !== 0 || m.titlePromises !== 0 || m.titleRealness !== 0.6) fails.push(`craft measures wrong: ${JSON.stringify(m)}`);

if (!offline) {
  loadKeys(ROOT);
  const channel = "magnates-media";
  const ex = JSON.parse(await readFile(path.join(data, "exemplars", channel, "index.json"), "utf8")) as { packaging?: Array<{ title: string; views: number | null }> };
  const refs = ex.packaging ?? [];
  const script = TimedScript.parse(JSON.parse(await readFile(path.join(job, "timed-script.json"), "utf8")));
  const narration = script.segments.map((s) => s.text).join(" ");
  const facts = JSON.parse(await readFile(path.join(job, "facts.json"), "utf8")) as { summary: string; claims: Array<{ text: string }> };
  const promises = await ensureTitlePromiseBand({ data, channel, references: refs });
  const tt = await testTitlesWithPromise({ channel, references: refs, titles: ["How Nokia lost the smartphone war", "The Memo That Burned Nokia to the Ground"], narration, verified: facts.claims.map((c) => c.text).join(" "), promises });
  for (const r of tt.results) console.log(`title ${r.ok ? "PASS" : "FAIL"} [${r.promise}] "${r.title}" — ${r.why}`);
  if (tt.results[0]?.ok) fails.push("the topic sentence must fail the title test");
  if (tt.results[1]?.promise === "topic") fails.push("a title promising a turn must not be labelled a topic");

  const turn = storyTurn(script);
  console.log(`turn: ${turn.slice(0, 200)}`);
  const band = JSON.parse(await readFile(path.join(data, "thumbnail-profile", `${channel}.json`), "utf8")) as ThumbBand;
  const craft = await ensureThumbCraft({ data, channel, band, log: () => {} });
  if (craft) {
    const c = await critiqueConcepts({ channel, craft, film: `${script.segments[0]?.text ?? ""} ${facts.summary}`, turn, pictures: "Nokia 3310 photo, Nokia HQ photo, Stephen Elop portrait, fire overlays, Microsoft logo, Samsung Galaxy photo", concepts: [
      { id: "topic", idea: "A Nokia phone burning in real fire in front of the dark Nokia building, no words", hero: "Nokia 3310", twist: "it is on fire", fusion: "the phone burns", background: "Nokia HQ at night", fill: "fire", lettering: "none", pictures: "3310, HQ, fire" },
      { id: "turn", idea: "Stephen Elop cut out, holding a burning Nokia 3310 like a torch, a Microsoft logo glowing on his suit lapel; one word: SABOTAGE?", hero: "Elop", twist: "the man hired to save Nokia handed it to Microsoft", fusion: "the torch he carries is Nokia itself", background: "a burning oil platform at sea", fill: "fire and smoke edge to edge", lettering: "SABOTAGE? in heavy white", pictures: "Elop portrait, 3310, Microsoft logo, burning platform" },
    ] });
    for (const s of c.scores) console.log(`concept ${s.id}: total ${s.total}, tells the turn ${s.story}`);
    const tp = c.scores.find((s) => s.id === "topic")?.story ?? 0;
    const tw = c.scores.find((s) => s.id === "turn")?.story ?? 0;
    if (!(tw > tp)) fails.push(`the twist concept should tell the turn better than the burning phone (${tw} vs ${tp})`);
  }
  console.log(`spent $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
}
console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "PASS packaging build list 5 (29–30)");
process.exit(fails.length ? 1 : 0);
