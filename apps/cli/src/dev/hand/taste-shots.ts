// Picture taste per shot (the ratchet's taste measure, one frame every 2 s), so a drop can be traced to its shots.
//   npx tsx apps/cli/src/dev/hand/taste-shots.ts <film.mp4> <storyboard.json>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const [film, sbf] = process.argv.slice(2) as [string, string];
const shots = (JSON.parse(await readFile(sbf, "utf8")) as { shots: Array<{ id: string; startS: number; endS: number }> }).shots;
const ts = Array.from({ length: Number(process.env.N ?? 44) }, (_, i) => 1 + i * 2);
const sc = (await scoreTaste({ root, data, channel: "magnates-media", kind: "shot", items: ts.map((t) => ({ file: path.resolve(film), t })) })).map((x) => x?.score ?? NaN);
const by = new Map<string, number[]>();
ts.forEach((t, i) => { const s = shots.find((x) => t >= x.startS && t < x.endS); if (s) (by.get(s.id) ?? by.set(s.id, []).get(s.id)!).push(sc[i]!); });
console.log([...by].map(([k, v]) => `${k} ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}(${v.length})`).join("  "));
const s = [...sc].sort((a, b) => a - b); console.log("median", s[Math.floor(s.length / 2)], "of", s.length);
