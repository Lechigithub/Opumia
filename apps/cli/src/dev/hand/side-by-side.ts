// Style with the subject held equal (owner, 2026-11-24): each of our shots beside the MagnatesMedia shots nearest to
// it in content (SigLIP image space over the channel's real shots), one row per shot, so what still differs is how it
// is shown, not what. No model call. Reference is read only (ffmpeg grabs frames).
//   npx tsx apps/cli/src/dev/hand/side-by-side.ts out/hand-ftx [film.mp4]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { embedPictures, loadReferenceIndex, nearest } from "@opumia/agents";

const root = process.cwd(), data = path.join(root, "data"), ref = path.join(root, "Reference");
const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const CONTROL = process.env.CONTROL ?? ""; // a real MagnatesMedia film id: run it as if it were ours (method check)
let film = path.resolve(process.argv[3] ?? path.join(job, "film_16x9.mp4"));
const out = path.join(job, CONTROL ? `side-by-side-control-${CONTROL}` : "side-by-side");
await mkdir(path.join(out, "frames"), { recursive: true });
const K = 3, W = 480, H = 270, ROWS = 8;

const idx = (await loadReferenceIndex(data))!;
let shots = (JSON.parse(await readFile(path.join(job, "storyboard.json"), "utf8")) as { shots: Array<{ id: string; startS: number; endS: number; intent?: string }> }).shots;
const files = new Map<string, string>();
const metaDir = path.join(ref, ".analysis", "meta");
for (const mf of await readdir(metaDir)) {
  const meta = JSON.parse(await readFile(path.join(metaDir, mf), "utf8")) as { id: string; folder: string };
  const dir = path.join(ref, meta.folder);
  if (!existsSync(dir)) continue;
  const mp4 = (await readdir(dir)).find((f) => f.endsWith(".mp4"));
  if (mp4) files.set(meta.id, path.join(dir, mp4));
}
if (CONTROL) {
  film = files.get(CONTROL)!;
  const own = idx.shots.filter((r) => r.film === CONTROL && r.t1 - r.t0 >= 0.8);
  const step = own.length / 32;
  shots = Array.from({ length: 32 }, (_, i) => own[Math.floor(i * step)]!).map((r, i) => ({ id: `C${String(i + 1).padStart(2, "0")}`, startS: r.t0, endS: r.t1 }));
}
const grab = (f: string, t: number, o: string) => { if (!existsSync(o)) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", f, "-frames:v", "1", "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, o]); };

const ts = shots.map((s) => s.startS + (s.endS - s.startS) * 0.6);
const vs = await embedPictures({ root, data, items: ts.map((t) => ({ file: film, t })) });
const report: unknown[] = [];
const rows: string[][] = [];
for (const [i, s] of shots.entries()) {
  const mine = path.join(out, "frames", `${s.id}.jpg`);
  grab(film, ts[i]!, mine);
  const near = vs[i] ? nearest(idx.shotVec, idx.shotOk, vs[i]!, K, (j) => idx.shots[j]!.channel === "magnates-media" && idx.shots[j]!.film !== CONTROL && files.has(idx.shots[j]!.film) && idx.shots[j]!.t1 - idx.shots[j]!.t0 >= 0.8) : [];
  const row = [mine];
  const picks = [];
  for (const n of near) {
    const r = idx.shots[n.i]!;
    const f = path.join(out, "frames", `${s.id}_${r.id.replace(/\W/g, "_")}.jpg`);
    grab(files.get(r.film)!, (r.t0 + r.t1) / 2, f);
    row.push(f);
    picks.push({ ref: r.id, sim: +n.sim.toFixed(3), picture: r.picture, overlay: r.overlay, text: r.textArea, line: r.line });
  }
  rows.push(row);
  report.push({ shot: s.id, t: +ts[i]!.toFixed(2), intent: s.intent, nearest: picks });
}
await writeFile(path.join(out, "pairs.json"), JSON.stringify(report, null, 2));
for (let p = 0; p * ROWS < rows.length; p++) {
  const page = rows.slice(p * ROWS, (p + 1) * ROWS);
  const tiles = page.flatMap((r) => [...r, ...Array(K + 1 - r.length).fill(null)]);
  const inputs: string[] = [], lay: string[] = [];
  tiles.forEach((t, j) => { if (!t) return; inputs.push("-i", t); lay.push(`${(j % (K + 1)) * (W + 8)}_${Math.floor(j / (K + 1)) * (H + 8)}`); });
  const n = inputs.length / 2;
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${Array.from({ length: n }, (_, j) => `[${j}]`).join("")}xstack=inputs=${n}:layout=${lay.join("|")}:fill=0x202020`, "-frames:v", "1", "-q:v", "3", path.join(out, `sheet_${p + 1}.jpg`)]);
}
console.log(`${rows.length} shots → ${Math.ceil(rows.length / ROWS)} sheets in ${path.relative(root, out)} (left: ours; right: the ${K} nearest MagnatesMedia shots)`);
