// Which finish moves our frames toward the channel? (finishing layer, 2026-11-26) — offline, no API.
// Frames of the referee's test films (held-back channel films, our films, v7), each finished several ways with real
// textures from Library/overlays and plain filters, corners masked, scored by the referee's fold model that never saw
// that film. A finish is worth having only if it raises OUR frames without lowering the channel's own.
//   npx tsx apps/cli/src/dev/finish-experiment.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildSets, OURS, V7 } from "../referee/referee.js";

const ROOT = process.cwd(), DATA = path.join(ROOT, "data"), REF = path.join(ROOT, "Reference");
const WORK = path.join(DATA, "referee", "work", "finish");
mkdirSync(path.join(WORK, "base"), { recursive: true });
const LIB = path.join(ROOT, "Library", "overlays");
const dust = path.join(WORK, "dust.png"), grain = path.join(WORK, "grain.png");
// one frame of each real texture (read-only Library; the frames go to our own work folder)
if (!existsSync(dust)) spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", "2", "-i", path.join(LIB, "dust", "dust_scratches_on_black_03.mp4"), "-frames:v", "1", "-vf", "scale=1280:720", dust]);
if (!existsSync(grain)) spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", path.join(LIB, "dust", "grain_loop_on_white_02.mp4"), "-frames:v", "1", "-vf", "scale=1280:720", grain]);
const MASK = "drawbox=x=0:y=0:w=iw*0.16:h=ih*0.16:color=black:t=fill,drawbox=x=iw*0.84:y=0:w=iw*0.16:h=ih*0.16:color=black:t=fill,drawbox=x=0:y=ih*0.84:w=iw*0.16:h=ih*0.16:color=black:t=fill,drawbox=x=iw*0.84:y=ih*0.84:w=iw*0.16:h=ih*0.16:color=black:t=fill";
const VARIANTS: Record<string, { inputs: string[]; graph: string }> = {
  none: { inputs: [], graph: `[0:v]${MASK}[o]` },
  noise: { inputs: [], graph: `[0:v]noise=alls=14:allf=u,${MASK}[o]` },
  filmgrain: { inputs: [grain], graph: `[1:v]format=gray,negate,format=rgb24[g];[0:v][g]blend=all_mode=overlay:all_opacity=0.35,${MASK}[o]` },
  vignette: { inputs: [], graph: `[0:v]vignette=angle=PI/3.6,${MASK}[o]` },
  bloom: { inputs: [], graph: `[0:v]split[a][b];[b]gblur=sigma=22[g];[a][g]blend=all_mode=screen:all_opacity=0.3,${MASK}[o]` },
  dust: { inputs: [dust], graph: `[0:v][1:v]blend=all_mode=screen:all_opacity=0.55,${MASK}[o]` },
  grade: { inputs: [], graph: `[0:v]eq=contrast=1.12:saturation=0.82:gamma=0.94,${MASK}[o]` },
  all: { inputs: [grain, dust], graph: `[1:v]format=gray,negate,format=rgb24[g];[0:v]eq=contrast=1.12:saturation=0.82:gamma=0.94,vignette=angle=PI/3.6[e];[e][g]blend=all_mode=overlay:all_opacity=0.35[e2];[e2][2:v]blend=all_mode=screen:all_opacity=0.5,split[a][b];[b]gblur=sigma=22[bl];[a][bl]blend=all_mode=screen:all_opacity=0.25,${MASK}[o]` },
};

const { sets } = await buildSets({ root: ROOT, data: DATA, reference: REF, channel: "magnates-media" });
const test = sets.filter((s) => s.cls !== "train");
const testJobs = [...OURS.map((x) => x.job), V7.job];
const foldOf = (film: string) => (film.startsWith("MM-") ? 0 : testJobs.indexOf(film) % 2);
const models = [0, 1].map((f) => JSON.parse(readFileSync(path.join(DATA, "referee", "work", `taste-fold-${f}.json`), "utf8")));
const agents = await import("@opumia/agents");

const rows: Array<{ cls: string; film: string; variant: string; file: string }> = [];
for (const s of test) for (const d of [3, 5]) {
  const base = path.join(WORK, "base", `${s.id.replace(/[^\w@.-]/g, "_")}_${d}.png`);
  if (!existsSync(base)) spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", (s.from + d).toFixed(2), "-i", s.video, "-frames:v", "1", "-vf", "scale=1280:720", base]);
  if (!existsSync(base)) continue;
  for (const [name, v] of Object.entries(VARIANTS)) {
    const out = path.join(WORK, name, path.basename(base).replace(/\.png$/, ".jpg"));
    mkdirSync(path.dirname(out), { recursive: true });
    if (!existsSync(out)) {
      const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", base, ...v.inputs.flatMap((f) => ["-i", f]), "-filter_complex", v.graph, "-map", "[o]", "-q:v", "3", out], { encoding: "utf8" });
      if (r.status !== 0) { console.log(`${name} failed: ${r.stderr.slice(0, 300)}`); process.exit(1); }
    }
    rows.push({ cls: s.cls, film: s.film, variant: name, file: out });
  }
}
console.log(`${rows.length} finished frames; embedding…`);
const vs = await agents.embedPictures({ root: ROOT, data: DATA, items: rows.map((r) => ({ file: r.file })) });
const score = rows.map((r, i) => (vs[i] ? agents.tasteOf(models[foldOf(r.film)], vs[i]!) : NaN));
const res: Record<string, Record<string, number>> = {};
for (const cls of ["real", "ours", "v7"]) {
  res[cls] = {};
  for (const name of Object.keys(VARIANTS)) {
    const xs = rows.map((r, i) => ({ r, s: score[i]! })).filter((x) => x.r.cls === cls && x.r.variant === name && Number.isFinite(x.s)).map((x) => x.s);
    res[cls]![name] = Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 100) / 100;
  }
}
writeFileSync(path.join(WORK, "result.json"), JSON.stringify(res, null, 1));
console.log(`\nmean referee score by finish (corners masked; each film by a model that never saw it):`);
console.log(`${"finish".padEnd(10)} ${"channel".padStart(8)} ${"ours".padStart(8)} ${"v7".padStart(8)}   ours Δ   channel Δ`);
for (const name of Object.keys(VARIANTS)) console.log(`${name.padEnd(10)} ${res.real![name]!.toFixed(2).padStart(8)} ${res.ours![name]!.toFixed(2).padStart(8)} ${res.v7![name]!.toFixed(2).padStart(8)}   ${(res.ours![name]! - res.ours!.none!).toFixed(2).padStart(6)}   ${(res.real![name]! - res.real!.none!).toFixed(2).padStart(6)}`);
