// The channel's own band for the picture detectors (senses/jumps.ts): cuts, unbridged jumps, bridged changes,
// transition kinds and pops a minute, measured on 5-minute stretches of the real films with the same function as ours.
//   npx tsx apps/cli/src/dev/detector-band.ts [channel-folder=MagnatesMedia] [films=12]
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { measureJumps } from "@opumia/senses";

const folder = process.argv[2] ?? "MagnatesMedia";
const want = Number(process.argv[3] ?? 12);
const root = path.join("Reference", folder);
const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
const step = Math.max(1, Math.floor(dirs.length / want));
const rows: Array<{ film: string; cutsPerMin: number; unbridgedPerMin: number; bridgedPerMin: number; popsPerMin: number; flashPerMin: number; blurPerMin: number; dissolvePerMin: number }> = [];
for (const d of dirs.filter((_, i) => i % step === 0).slice(0, want)) {
  let mp4: string | undefined;
  try { mp4 = readdirSync(path.join(root, d)).find((f) => f.endsWith(".mp4")); } catch { continue; }
  if (!mp4) continue;
  const r = await measureJumps(path.join(root, d, mp4), { ss: 60, t: 300 }).catch(() => null);
  if (!r || r.seconds < 60) continue;
  const pm = (x: number) => Math.round((x / r.seconds) * 600) / 10;
  rows.push({ film: d, cutsPerMin: pm(r.cuts.length), unbridgedPerMin: r.jumpCutsPerMin, bridgedPerMin: r.bridgedPerMin, popsPerMin: r.popsPerMin, flashPerMin: pm(r.transitions.flash ?? 0), blurPerMin: pm(r.transitions.blur ?? 0), dissolvePerMin: pm(r.transitions.dissolve ?? 0) });
  console.log(JSON.stringify(rows.at(-1)));
}
const band = (k: keyof (typeof rows)[number]) => { const v = rows.map((r) => r[k] as number).sort((a, b) => a - b); const q = (p: number) => v[Math.min(v.length - 1, Math.round((v.length - 1) * p))] ?? 0; return { p10: q(0.1), median: q(0.5), p90: q(0.9) }; };
const out = { channelFolder: folder, films: rows.length, measuredAt: new Date().toISOString(), band: Object.fromEntries((["cutsPerMin", "unbridgedPerMin", "bridgedPerMin", "popsPerMin", "flashPerMin", "blurPerMin", "dissolvePerMin"] as const).map((k) => [k, band(k)])), rows };
mkdirSync("data/detector-band", { recursive: true });
writeFileSync(`data/detector-band/${folder.toLowerCase().replace(/\s+/g, "-")}.json`, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.band));
