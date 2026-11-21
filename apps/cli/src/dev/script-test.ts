// Write a script from a job's cached facts with the current writer (no narration, no film) and show the story test.
//   npx tsx apps/cli/src/dev/script-test.ts out/<job-with-facts> [outName]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FactSheet } from "@opumia/contracts";
import { buildStylePack, ensureReferenceFilms, ensureStoryBand, loadMemory, recentBlueprints, usageLedger, writeScript, type StoryReport } from "@opumia/agents";
import { resolveChannelVoice, storedVoiceMeasure, ttsModel } from "@opumia/narration";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const src = path.resolve(process.argv[2]!);
const out = path.resolve("out", process.argv[3] ?? `script-test-${path.basename(src)}`);
mkdirSync(out, { recursive: true });
const job = JSON.parse(readFileSync(path.join(src, "job.json"), "utf8")) as { channel: string; aspect: "16:9" | "9:16"; durationS: number };
const facts = FactSheet.parse(JSON.parse(readFileSync(path.join(src, "facts.json"), "utf8")));
const roots = { reference: process.env.OPUMIA_REFERENCE_DIR ?? "Reference", data: process.env.OPUMIA_DATA_DIR ?? "data" };
const pack = await buildStylePack(job.channel as never, roots);
const storyBand = await ensureStoryBand({ ...roots, channelId: job.channel, log: console.log });
const films = await ensureReferenceFilms({ ...roots, channelId: job.channel });
const voice = await resolveChannelVoice(job.channel as never, roots.data);
const wpm = (await storedVoiceMeasure(roots.data, voice.voiceId, ttsModel()))?.wpm ?? 150;
const memory = await loadMemory(roots.data);
const recent = recentBlueprints({ ...memory, blueprints: Object.fromEntries(Object.entries(memory.blueprints).map(([c, l]) => [c, l.filter((b) => b.job !== path.basename(src))])) }, job.channel);
let report: StoryReport | null = null;
const t0 = Date.now();
const draft = await writeScript({ pack, facts, aspect: job.aspect, durationS: job.durationS <= 90 ? job.durationS - 3 : job.durationS, narrationWpm: Math.round(wpm), recent, storyBand, films, memoryDir: path.join(roots.data, "agents", "writer"), onStory: (r) => (report = r), log: console.log });
writeFileSync(path.join(out, "script.draft.json"), JSON.stringify(draft, null, 2));
writeFileSync(path.join(out, "script.story.json"), JSON.stringify(report, null, 2));
console.log(`\n=== ${draft.title} (${draft.wordCount} words at ${Math.round(wpm)} wpm) ===`);
console.log(`PLAN opens: ${draft.blueprint?.opening}\nTURNS:\n${(draft.blueprint?.beats ?? []).map((b, i) => `  ${i + 1}. ${b}`).join("\n")}\nENDS: ${draft.blueprint?.closing}\n`);
for (const s of draft.segments) console.log(`[${s.role}] ${s.text}`);
const rp = report as StoryReport | null;
console.log(`\nwriter: ${rp?.pass ? "ACCEPTED" : "NOT ACCEPTED"} — ${rp?.rounds.length ?? 0} measurement(s), films read: ${rp?.agent?.filmsRead.join(", ") ?? "-"}, tool calls ${JSON.stringify(rp?.agent?.calls ?? {})} — ${Math.round((Date.now() - t0) / 1000)} s, $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
if (rp && !rp.pass) for (const x of rp.remaining) console.log(`  still: [${x.kind}] ${x.detail.slice(0, 200)}`);
