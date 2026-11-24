// The channel's look band over WHOLE films (first 10 min of each MagnatesMedia film), measureLook as the ratchet uses
// it. Replaces the luma/dark-share band first taken from two 80 s windows of one film (2026-11-24).
//   npx tsx apps/cli/src/dev/hand/look-band.ts <film-list.txt>  → data/quality-profile/magnates-media-look-band.json
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { measureLook } from "@opumia/senses";
const files = readFileSync(process.argv[2]!, "utf8").split("\n").filter(Boolean);
const K = ["luma", "darkShare", "colourfulness", "motion", "stillShare", "cutsPerMin"] as const;
const rows: Array<Record<string, number>> = [];
for (const f of files) { const l = (await measureLook(f, { t: Number(process.env.SPAN ?? 600) })) as unknown as Record<string, number>; rows.push(l); console.log(path.basename(path.dirname(f)).slice(0, 40), K.map((k) => `${k} ${l[k]}`).join(" ")); }
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]!.toFixed(4); };
const band = Object.fromEntries(K.map((k) => [k, { p10: pct(rows.map((r) => r[k]!), 0.1), median: pct(rows.map((r) => r[k]!), 0.5), p90: pct(rows.map((r) => r[k]!), 0.9) }]));
const out = path.join(process.cwd(), "data", "quality-profile", `magnates-media-look-band${process.env.SPAN ? `-${process.env.SPAN}s` : ""}.json`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ what: `measureLook over the first ${process.env.SPAN ?? 600} s of every MagnatesMedia film`, films: rows.length, band, measuredAt: new Date().toISOString() }, null, 1));
console.log(JSON.stringify(band));
