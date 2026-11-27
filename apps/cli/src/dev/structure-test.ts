// The channel's whole-film structure (agents/story-structure.ts): measured from the reference, used by the length
// table and the writer's long-form checks. No API.
import path from "node:path";
import { existsSync } from "node:fs";
import { structureProfile, structureIssues, lengthPlan } from "@opumia/agents";

const ROOT = process.cwd();
let fails = 0;
const ok = (name: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); if (!pass) fails++; };
if (!existsSync(path.join(ROOT, "Reference", ".analysis", "story")) && !existsSync(path.join(ROOT, "data", "story-profile", "magnates-media-structure.json"))) { console.log("SKIP: no reference analysis"); process.exit(0); }
const p = structureProfile({ reference: path.join(ROOT, "Reference"), data: path.join(ROOT, "data") })!;
ok("measured on the channel's films (≥ 25)", p.films >= 25, p.films);
ok("chapters run about three minutes, not 90–150 s", p.chapterS.p50 > 150 && p.chapterS.p50 < 240, p.chapterS);
ok("the twist sits near the middle", p.twistAt.p50 > 0.35 && p.twistAt.p50 < 0.65, p.twistAt);
ok("short films have no chapters", lengthPlan(90).chapters === 0 && lengthPlan(240).chapters === 0);
ok("a 20-minute film has about six chapters", lengthPlan(1200).chapters >= 5 && lengthPlan(1200).chapters <= 7, lengthPlan(1200).chapters);
ok("short films keep their opening window", lengthPlan(45).openingS <= 20 && lengthPlan(90).openingS <= 20);
const w = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const ch = lengthPlan(1200).chapters, wpm = 170;
const old = [{ role: "hook", chapter: "Intro", text: w(60) }, ...Array.from({ length: 10 }, (_, i) => ({ role: i === 0 ? "context" : "rise", chapter: `Ch${i + 1}`, text: w(330) }))];
const good = [{ role: "hook", chapter: "Intro", text: w(70) }, { role: "thesis", chapter: "Intro", text: w(60) }, ...Array.from({ length: 6 }, (_, i) => ({ role: i === 3 ? "twist" : "rise", chapter: `Ch${i + 1}`, text: w(540) }))];
const oi = structureIssues(old, 1200, wpm, p, ch).map((x) => x.kind);
ok("a plan built the old way (ten 2-minute chapters, no thesis, no twist) is refused", oi.includes("chapter_count") && oi.includes("thesis_late") && oi.includes("twist_position"), oi);
ok("a plan built the channel's way passes", structureIssues(good, 1200, wpm, p, ch).length === 0, structureIssues(good, 1200, wpm, p, ch));
ok("a short film is not checked for chapters", structureIssues(old, 90, wpm, p, 0).length === 0);
console.log(fails ? `${fails} failed` : "structure: all passed");
process.exitCode = fails ? 1 : 0;
