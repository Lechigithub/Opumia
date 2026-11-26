// Every music bed in the library scored by the voice-blind bed head (build list 6, G3): which of our beds sound like the
// channel's music. Local, no API. Writes data/audio-profile-bed-taste.json.
//   npx tsx apps/cli/src/dev/bed-rank.ts
import { readdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { embedAudio, loadSoundTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const m = await loadSoundTaste(data, "magnates-media", "bed");
if (!m) throw new Error("no bed head: run dev/sound-taste-train.ts --kinds bed");
const dir = path.join(root, "Library", "music");
const files = readdirSync(dir).filter((f) => f.endsWith(".mp3")).map((f) => path.join(dir, f));
const items = files.flatMap((f) => { const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString()) || 60; return [0.25, 0.5, 0.75].map((p) => ({ file: f, t: Math.max(0, d * p - 4), dur: 8 })); });
const vecs = await embedAudio({ root, data, items });
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const sc = vecs.map((v) => (v ? sig(m.w.reduce((a, w, i) => a + w * v[i]!, m.b)) : NaN));
const out = files.map((f, k) => ({ file: path.relative(root, f), score: Math.round(((sc[3 * k]! + sc[3 * k + 1]! + sc[3 * k + 2]!) / 3) * 1000) / 1000 })).filter((x) => Number.isFinite(x.score)).sort((a, b) => b.score - a.score);
await writeFile(path.join(data, "audio-profile-bed-taste.json"), JSON.stringify({ head: { realP10: m.calibration.real.p10, realMedian: m.calibration.real.median }, beds: out }, null, 1));
console.log(`${out.length} beds; channel's real beds p10 ${m.calibration.real.p10}, median ${m.calibration.real.median}`);
console.log(`at or above the channel's median: ${out.filter((x) => x.score >= m.calibration.real.median).length}; above its p10: ${out.filter((x) => x.score >= m.calibration.real.p10).length}`);
for (const x of out.slice(0, 12)) console.log(x.score.toFixed(3), path.basename(x.file));
console.log("…", out.slice(-3).map((x) => `${x.score.toFixed(3)} ${path.basename(x.file)}`).join(" | "));
for (const n of ["floating_cities", "lightless_dawn", "discovery", "emergent"]) { const h = out.find((x) => x.file.toLowerCase().includes(n)); if (h) console.log("ours:", h.score.toFixed(3), path.basename(h.file)); }
