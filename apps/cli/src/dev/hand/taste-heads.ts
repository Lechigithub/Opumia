// Taste per shot, split into its two heads (pro: "made professionally?", channel: "this channel's look?"), so a low
// score is traced to its cause. Local (SigLIP heads), no API.
//   npx tsx apps/cli/src/dev/hand/taste-heads.ts <film.mp4> <storyboard.json> [step s]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const [film, sbf, stepArg] = process.argv.slice(2) as [string, string, string?];
const step = Number(stepArg ?? 1);
const shots = (JSON.parse(await readFile(sbf, "utf8")) as { shots: Array<{ id: string; startS: number; endS: number }> }).shots;
const end = shots.at(-1)!.endS;
const ts = Array.from({ length: Math.floor((end - 0.5) / step) }, (_, i) => 0.5 + i * step);
const sc = await scoreTaste({ root, data, channel: "magnates-media", kind: "shot", items: ts.map((t) => ({ file: path.resolve(film), t })) });
const by = new Map<string, Array<Record<string, number>>>();
ts.forEach((t, i) => { const s = shots.find((x) => t >= x.startS && t < x.endS); const v = sc[i] as unknown as Record<string, number> | null; if (s && v) (by.get(s.id) ?? by.set(s.id, []).get(s.id)!).push(v); });
const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
for (const [k, v] of by) console.log(`${k.padEnd(6)} score ${m(v.map((x) => x.score!)).toFixed(1)}  pro ${m(v.map((x) => x.pro!)).toFixed(2)}  channel ${m(v.map((x) => x.channel!)).toFixed(2)}  (${v.length})`);
