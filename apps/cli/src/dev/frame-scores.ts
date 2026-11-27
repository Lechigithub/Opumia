// Which moments of a film read least and most like the channel (referee fold model that never saw the film).
//   npx tsx apps/cli/src/dev/frame-scores.ts <job> <fold 0|1> [film.mp4]
// Writes data/referee/work/frames/<job>/{low,high}.jpg (6 frames each, lowest/highest first) and scores.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd(), DATA = path.join(ROOT, "data");
const [job, fold = "0", file = "film_16x9.mp4"] = process.argv.slice(2);
const video = path.join(ROOT, "out", job!, file);
const d = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf8" }).stdout.trim());
const m = JSON.parse(readFileSync(path.join(DATA, "referee", "work", `taste-fold-${fold}.json`), "utf8"));
const agents = await import("@opumia/agents");
const ts = Array.from({ length: Math.floor(d) - 1 }, (_, i) => i + 0.5);
const vs = await agents.embedPictures({ root: ROOT, data: DATA, items: ts.map((t) => ({ file: video, t, degrade: "corners" })) });
const sc = ts.map((t, i) => ({ t, s: vs[i] ? Math.round(agents.tasteOf(m, vs[i]!) * 100) / 100 : NaN })).filter((x) => Number.isFinite(x.s));
const out = path.join(DATA, "referee", "work", "frames", job!);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "scores.json"), JSON.stringify(sc));
const sorted = [...sc].sort((a, b) => a.s - b.s);
for (const [name, pick] of [["low", sorted.slice(0, 6)], ["high", sorted.slice(-6).reverse()]] as const) {
  const files = pick.map((x, k) => { const f = path.join(out, `${name}_${k}.jpg`); spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", x.t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=640:360", f]); return f; });
  spawnSync("ffmpeg", ["-v", "error", "-y", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, k) => `[${k}:v]`).join("")}xstack=inputs=${files.length}:layout=0_0|640_0|1280_0|0_360|640_360|1280_360`, "-frames:v", "1", path.join(out, `${name}.jpg`)]);
  console.log(`${name}: ${pick.map((x) => `${x.t.toFixed(1)} s ${x.s}`).join(", ")} → ${path.join(out, `${name}.jpg`)}`);
}
console.log(`mean ${(sc.reduce((a, b) => a + b.s, 0) / sc.length).toFixed(2)} over ${sc.length} frames`);
