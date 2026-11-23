// Build list 5, items 10–14: run the design checks (the same `designProblems` the scene designer and the gate use) on
// a job's scene previews — worlds, variety, treatment, raw stock, type scale, boxed labels, repeated cards, data kinds
// and holds, repeated pictures.
//   npx tsx apps/cli/src/dev/design-check.ts out/<job>
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { designProblems, embedPictures, ensureDesignBand, labelDesign, textAreas, usageLedger, withinFilmVariety } from "@opumia/agents";
import type { ResolutionReport, ScenePlan, Storyboard } from "@opumia/contracts";
import { loadKeys } from "../keys.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const data = path.join(root, "data");
loadKeys(root);
const job = path.resolve(process.argv[2] ?? "out/bl4c-nokia");
const j = async <T>(f: string) => JSON.parse(await readFile(path.join(job, f), "utf8")) as T;
const sb = await j<Storyboard>("storyboard.json");
const scenes = (await j<ScenePlan>("scenes.json")).scenes;
const res = await j<ResolutionReport>("resolution.json");
const band = (await ensureDesignBand({ root, data, channelId: (await j<{ channel: string }>("job.json")).channel }))!;
const frame = (id: string) => [`${id}_1.jpg`, `${id}_0.jpg`].map((f) => path.join(job, "previews", f)).find(existsSync);
const ids = scenes.map((s) => s.shotId).filter((id) => frame(id));
const files = ids.map((id) => frame(id)!);
const labels = await labelDesign(files, { data });
const areas = await textAreas(files, { root, data });
const designed = ids.filter((_, k) => labels[k] && labels[k]!.world !== "footage");
const vecs = (await embedPictures({ root, data, items: designed.map((id) => ({ file: frame(id)! })) })).filter((v): v is Float32Array => !!v);
const variety = withinFilmVariety(vecs);
const problems = designProblems({
  scenes, shots: sb.shots.map((s) => ({ id: s.id, startS: s.startS, endS: s.endS })), durationS: sb.durationS, band,
  labels: Object.fromEntries(ids.map((id, k) => [id, labels[k] ?? null])), textArea: Object.fromEntries(ids.map((id, k) => [id, areas[k] ?? null])), variety,
  refOf: (shotId, slot) => res.media.find((m) => m.shotId === shotId && m.role === "layer" && m.slot === slot)?.ref,
});
const worlds: Record<string, number> = {};
for (const l of labels) if (l) worlds[l.world] = (worlds[l.world] ?? 0) + 1;
console.log(`${path.basename(job)}: ${ids.length} previews; worlds ${JSON.stringify(worlds)}; variety ${variety} (channel ${band.variety?.p10}–${band.variety?.p90})`);
console.log(`text area (frames with words): ${ids.filter((_, k) => labels[k]?.text !== "none").map((id, k) => `${id} ${((areas[ids.indexOf(id)] ?? 0) * 100).toFixed(1)}%`).join(", ")}`);
for (const p of problems) console.log(`- [${p.check}] ${p.what}: ${p.measured} (band ${p.band}) — ${p.shots.join(", ")}`);
console.log(`$${usageLedger().reduce((a, r) => a + r.usd, 0).toFixed(3)}`);
