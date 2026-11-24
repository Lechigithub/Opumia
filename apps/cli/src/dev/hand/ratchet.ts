// Quality ratchet (owner, 2026-11-24): a reached level is frozen and never goes down.
// Measures a film with the local instruments (no model call) and compares it with the frozen baseline in
// eval/ratchet/<name>.json: every measure must be no worse (within its noise) than the frozen one. With --freeze, a
// candidate that regresses nothing and improves something becomes the new frozen level: the baseline is rewritten,
// the film and everything that built it is copied to out/<job>/frozen/<tag>/, and the git tag ratchet/<name>/<tag>
// is set by the caller (printed).
//   npx tsx apps/cli/src/dev/hand/ratchet.ts <name> <film.mp4> [--freeze <tag>] [--job out/<job>]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste, scoreTaste } from "@opumia/agents";
import { measureLook } from "@opumia/senses";

const root = process.cwd(), data = path.join(root, "data");
const [name, film] = process.argv.slice(2) as [string, string];
const fi = process.argv.indexOf("--freeze"), tag = fi > 0 ? process.argv[fi + 1] : null;
const ji = process.argv.indexOf("--job"), job = ji > 0 ? path.resolve(process.argv[ji + 1]!) : path.dirname(path.resolve(film));
const baseFile = path.join(root, "eval", "ratchet", `${name}.json`);

/** The channel's band for each look measure (MagnatesMedia, measured on the reference); distance to it is what counts. */
// voiceOverBed: the channel's 37 films, voice over the bed while speaking (Reference sound.json): p10 14.4, p90 24.3 dB
const BAND: Record<string, [number, number]> = { voiceOverBed: [14.4, 24.3], cleanShare: [0.19, 0.75], luma: [0.3, 0.45], darkShare: [0, 0.13], colourfulness: [31, 48], motion: [0.04, 0.1], stillShare: [0, 0.08], cutsPerMin: [13, 38] };
/** Higher is better for these; noise below which a drop is not a regression. */
const HIGHER: Record<string, number> = { taste: 0.15, tasteAboveFloor: 2, voice: 0.03 };
/** Recorded, never gated: the owner heard the music overpowering the voice in a mix this scored 0.84 (v9), so it
 *  rewards a defect. Retired 2026-11-24. */
const RETIRED = new Set(["mix"]);
const BAND_NOISE: Record<string, number> = { voiceOverBed: 1, cleanShare: 0.02, luma: 0.01, darkShare: 0.02, colourfulness: 1, motion: 0.003, stillShare: 0.02, cutsPerMin: 1 };

const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
export async function measure(file: string): Promise<Record<string, number>> {
  const span = Math.min(80, dur(file) - 0.5);
  const ts = Array.from({ length: Math.floor(span / 2) }, (_, i) => 1 + i * 2);
  const taste = (await scoreTaste({ root, data, channel: "magnates-media", kind: "shot", items: ts.map((t) => ({ file, t })) })).map((x) => x?.score ?? NaN);
  const wins = Array.from({ length: Math.floor(span / 4) }, (_, i) => ({ file, t: i * 4, dur: 4 }));
  const voice = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: wins });
  const mix = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items: wins });
  const l = (await measureLook(file, { t: span })) as unknown as Record<string, number>;
  // motion at full precision (measureLook rounds to 0.01): the median of the 4 s windows
  const mw: number[] = [];
  for (let t = 0; t + 4 <= span; t += 4) mw.push((await measureLook(file, { ss: t, t: 4 })).motion);
  return { taste: med(taste), tasteAboveFloor: taste.filter((x) => x >= 4.4).length, voice: voice?.median ?? NaN, mix: mix?.median ?? NaN, luma: l.luma!, darkShare: l.darkShare!, colourfulness: l.colourfulness!, motion: +med(mw).toFixed(4), stillShare: l.stillShare!, cutsPerMin: l.cutsPerMin! };
}
const off = (k: string, v: number) => { const [a, b] = BAND[k]!; return v < a ? a - v : v > b ? v - b : 0; };

const m = await measure(path.resolve(film));
// voice over the bed while speaking, from the film's own stems (same 100 ms method as the reference analysis)
if (existsSync(path.join(job, "manifest.json"))) {
  const { premixStems } = await import("@opumia/motion-engine");
  const { RenderManifest } = await import("@opumia/contracts");
  const st = await premixStems(RenderManifest.parse(JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"))), path.join(job, "ears"));
  const out = execFileSync(path.join(process.env.HOME!, "lechi_tts/venv/bin/python"), ["-I", path.join(root, "apps/cli/src/dev/hand/mix-measure.py"), st.voice, st.bed]).toString();
  const v = /speaking (-?[\d.]+) dB/.exec(out);
  if (v) m.voiceOverBed = Number(v[1]);
}
// share of shots left as clean footage (nothing on them): the channel leaves 19–75 % per film (42 % typical)
if (existsSync(path.join(job, "scenes.json"))) {
  const sc = (JSON.parse(await readFile(path.join(job, "scenes.json"), "utf8")) as { scenes: Array<{ backdrop?: string; elements: unknown[] }> }).scenes;
  m.cleanShare = +(sc.filter((x) => (x.backdrop ?? "footage") === "footage" && !x.elements.length).length / sc.length).toFixed(3);
}
const base = existsSync(baseFile) ? (JSON.parse(await readFile(baseFile, "utf8")) as { tag: string; measures: Record<string, number> }) : null;
const worse: string[] = [], better: string[] = [];
for (const [k, v] of Object.entries(m)) {
  const b = base?.measures[k];
  if (b === undefined || !Number.isFinite(b) || RETIRED.has(k)) continue;
  if (k in HIGHER) { if (v < b - HIGHER[k]!) worse.push(`${k} ${b} → ${v}`); else if (v > b + HIGHER[k]!) better.push(`${k} ${b} → ${v}`); }
  else { const d0 = off(k, b), d1 = off(k, v); if (d1 > d0 + BAND_NOISE[k]!) worse.push(`${k} ${b} → ${v} (band ${BAND[k]})`); else if (d1 < d0 - BAND_NOISE[k]!) better.push(`${k} ${b} → ${v} (band ${BAND[k]})`); }
}
console.log(JSON.stringify(m));
console.log(base ? `vs frozen ${base.tag}: ${worse.length ? `REGRESSES ${worse.join("; ")}` : "no regression"}${better.length ? ` | improves ${better.join("; ")}` : ""}` : "no frozen baseline yet");
if (tag) {
  if (base && worse.length) { console.log("NOT FROZEN: a frozen level may never go down"); process.exit(2); }
  if (base && !better.length) { console.log("NOT FROZEN: nothing improved"); process.exit(3); }
  const dir = path.join(job, "frozen", tag);
  await mkdir(dir, { recursive: true });
  await cp(path.resolve(film), path.join(dir, path.basename(film)));
  for (const f of ["timed-script.json", "storyboard.json", "scenes.json", "resolution.json", "design.json", "manifest.json", "narration.mp3", "design/film/index.tsx"]) if (existsSync(path.join(job, f))) await cp(path.join(job, f), path.join(dir, f), { recursive: true });
  await cp(path.join(root, "apps/cli/src/dev/hand"), path.join(dir, "hand-scripts"), { recursive: true });
  await mkdir(path.dirname(baseFile), { recursive: true });
  await writeFile(baseFile, JSON.stringify({ name, tag, film: path.relative(root, path.join(dir, path.basename(film))), frozenAt: new Date().toISOString(), measures: m, previous: base ? { tag: base.tag, measures: base.measures } : null }, null, 2));
  console.log(`FROZEN ${name} at ${tag} → ${path.relative(root, dir)}; commit eval/ratchet and tag: git tag ratchet/${name}/${tag}`);
}
