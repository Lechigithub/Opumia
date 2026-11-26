// Pixel craft of a finished film's frames against the reference's own frames (sharpest-part detail, typical detail,
// contrast, grain — the same function, scaled to 640×360). No API.
//   npx tsx apps/cli/src/dev/hand/frame-craft.ts <film.mp4> [storyboard.json]
import { readFile } from "node:fs/promises";
import { measureCraft } from "@opumia/senses";
const [film, sb] = process.argv.slice(2) as [string, string?];
const shots = sb ? (JSON.parse(await readFile(sb, "utf8")) as { shots: Array<{ id: string; startS: number; endS: number }> }).shots : [];
const ts = Array.from({ length: 33 }, (_, i) => 1 + i * 2);
const rows = await Promise.all(ts.map(async (t) => ({ t, c: await measureCraft(film, t), id: shots.find((s) => t >= s.startS && t < s.endS)?.id ?? "" })));
const med = (k: string) => { const v = rows.map((r) => (r.c as unknown as Record<string, number>)[k]!).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]!; };
console.log(`OURS (33 frames): sharpest-part detail median ${med("sharpTop").toFixed(0)} · typical detail ${med("sharpMedian").toFixed(0)} · contrast ${med("contrast").toFixed(0)} · grain ${med("grain").toFixed(1)}`);
console.log("REFERENCE frames: sharpest-part p10 39 / median 558 · typical p10 1 / median 18 · contrast p10 59 / median 152 · grain median 1.2");
for (const r of rows) console.log(`${r.t}s ${r.id.padEnd(5)} sharpTop ${r.c.sharpTop.toFixed(0).padStart(5)} typical ${r.c.sharpMedian.toFixed(0).padStart(4)} contrast ${r.c.contrast.toFixed(0).padStart(4)} grain ${r.c.grain.toFixed(1)}`);
