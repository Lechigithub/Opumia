// Quality ratchet (owner, 2026-11-24): a reached level is frozen and never goes down.
// Measures a film with the local instruments (no model call) and compares it with the frozen baseline in
// eval/ratchet/<name>.json: every measure must be no worse (within its noise) than the frozen one. With --freeze, a
// candidate that regresses nothing and improves something becomes the new frozen level: the baseline is rewritten,
// the film and everything that built it is copied to out/<job>/frozen/<tag>/, and the git tag ratchet/<name>/<tag>
// is set by the caller (printed).
//   npx tsx apps/cli/src/dev/hand/ratchet.ts <name> <film.mp4> [--freeze <tag>] [--job out/<job>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste, scoreTaste } from "@opumia/agents";
import { measureLook } from "@opumia/senses";

const root = process.cwd(), data = path.join(root, "data");
const [name, film] = process.argv.slice(2) as [string, string];
const fi = process.argv.indexOf("--freeze"), tag = fi > 0 ? process.argv[fi + 1] : null;
// --owner "<their words>": the owner approved by eye a change no measure can see yet; freezes with no regression even
// if nothing measured improved, and records the approval
const oi = process.argv.indexOf("--owner"), owner = oi > 0 ? process.argv[oi + 1] : null;
const ji = process.argv.indexOf("--job"), job = ji > 0 ? path.resolve(process.argv[ji + 1]!) : path.dirname(path.resolve(film));
const baseFile = path.join(root, "eval", "ratchet", `${name}.json`);

/** The channel's band for each look measure (MagnatesMedia, measured on the reference); distance to it is what counts. */
// voiceOverBed: the channel's 37 films, voice over the bed while speaking (Reference sound.json): p10 14.4, p90 24.3 dB
// Look bands (2026-11-24): p10–p90 of all 37 MagnatesMedia films over their first 80 s (look-band.ts, SPAN=80). The
// first bands (luma 0.30–0.45, motion 0.04–0.10, …) came from two windows of one film and pushed the film too bright.
const LB = JSON.parse(readFileSync(path.join(root, "data", "quality-profile", "magnates-media-look-band-80s.json"), "utf8")).band as Record<string, { p10: number; p90: number }>;
// Grade over the whole film (grade-band.py, 37 films): contrast (p95−p5 luma), blown highlights, frames carried by one colour.
const GB = JSON.parse(readFileSync(path.join(root, "data", "quality-profile", "magnates-media-grade-band.json"), "utf8")).band as Record<string, { p10: number; p90: number }>;
const TB = JSON.parse(readFileSync(path.join(root, "data", "quality-profile", "magnates-media-text-band-80s.json"), "utf8")).band as Record<string, { p10: number; p90: number }>;
// Typeface properties (type-band.py over every reference channel's letter shapes): weight and width of the lettering
const TY = JSON.parse(readFileSync(path.join(root, "data", "quality-profile", "magnates-media-type-band.json"), "utf8")).band as Record<string, { p10: number; p90: number }>;
const TYPE_KEYS = ["strokeMed", "strokeLo", "aspectMed", "heavyShare", "lightShare"];
// The story (data/story-profile/magnates-media.json, 30 films): shares of quotes, bare facts, explanations, teases,
// motives, and lines that talk to the viewer
const SB = JSON.parse(readFileSync(path.join(root, "data", "story-profile", "magnates-media.json"), "utf8")) as { kinds: Record<string, { p10: number; p90: number }>; viewer: { p10: number; p90: number } };
const STORY_KINDS = ["quote", "fact", "explain", "tease", "motive"];
const BAND: Record<string, [number, number]> = { ...Object.fromEntries(STORY_KINDS.map((k) => [`${k}Share`, [SB.kinds[k]!.p10, SB.kinds[k]!.p90] as [number, number]])), viewerShare: [SB.viewer.p10, SB.viewer.p90], voiceOverBed: [14.4, 24.3], cleanShare: [0.19, 0.75], ...Object.fromEntries(Object.entries(LB).map(([k, b]) => [k, [b.p10, b.p90] as [number, number]])), contrast: [GB.contrast!.p10, GB.contrast!.p90], highlights: [GB.hi!.p10, GB.hi!.p90], oneColour: [GB.oneColour!.p10, GB.oneColour!.p90],
  // How words are set (text-band.py, on-device OCR, first 80 s of the 37 films): frames with words, tallest and widest
  // line, small boxed name tags, capitals, spread of sizes
  ...Object.fromEntries(Object.entries(TB).map(([k, b]) => [k, [b.p10, b.p90] as [number, number]])),
  ...Object.fromEntries(TYPE_KEYS.map((k) => [k, [TY[k]!.p10, TY[k]!.p90] as [number, number]])) };
/** Higher is better for these; noise below which a drop is not a regression. */
const HIGHER: Record<string, number> = { taste: 0.1, tasteAboveFloor: 2, voice: 0.02 };
/** Recorded, never gated: the owner heard the music overpowering the voice in a mix this scored 0.84 (v9), so it
 *  rewards a defect. Retired 2026-11-24. */
const RETIRED = new Set(["mix"]);
const BAND_NOISE: Record<string, number> = { quoteShare: 0.02, factShare: 0.02, explainShare: 0.02, teaseShare: 0.02, motiveShare: 0.02, viewerShare: 0.02, strokeMed: 0.006, strokeLo: 0.006, aspectMed: 0.015, heavyShare: 0.04, lightShare: 0.03, textFrames: 0.03, bigText: 0.01, wideText: 0.02, smallBoxed: 0.03, caps: 0.05, sizeSpread: 0.03, contrast: 0.01, highlights: 0.003, oneColour: 0.02, voiceOverBed: 1, cleanShare: 0.02, luma: 0.01, darkShare: 0.02, colourfulness: 1, motion: 0.003, stillShare: 0.02, cutsPerMin: 1 };

const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
export async function measure(file: string): Promise<Record<string, number>> {
  // the whole film (up to 2 min): an 80 s cap cut a longer film's ending out of the comparison (v16, 87 s)
  const span = Math.min(120, dur(file) - 0.5);
  const ts = Array.from({ length: Math.floor(span / 2) }, (_, i) => 1 + i * 2);
  const taste = (await scoreTaste({ root, data, channel: "magnates-media", kind: "shot", items: ts.map((t) => ({ file, t })) })).map((x) => x?.score ?? NaN);
  // one sample grid moves the median by up to 0.3 on the same film (taste-noise.ts), so taste is the mean of the medians
  // of four grids offset by 0 / 0.5 / 1 / 1.5 s
  const grids: number[] = [med(taste)];
  for (const o of [0.5, 1, 1.5]) grids.push(med((await scoreTaste({ root, data, channel: "magnates-media", kind: "shot", items: ts.map((t) => ({ file, t: t + o })).filter((x) => x.t < span) })).map((x) => x?.score ?? NaN)));
  const tasteMean = +(grids.reduce((x, y) => x + y, 0) / grids.length).toFixed(2);
  const wins = Array.from({ length: Math.floor(span / 4) }, (_, i) => ({ file, t: i * 4, dur: 4 }));
  const voice = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: wins });
  // the voice median moves by up to 0.05 with the window grid (voice-noise.ts): mean of four grids offset 0/1/2/3 s
  const vg: number[] = [voice?.median ?? NaN];
  for (const o of [1, 2, 3]) vg.push((await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: wins.map((w) => ({ ...w, t: w.t + o })).filter((w) => w.t + 4 <= span + 0.5) }))?.median ?? NaN);
  const voiceMean = +(vg.reduce((x, y) => x + y, 0) / vg.length).toFixed(3);
  const mix = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items: wins });
  const l = (await measureLook(file, { t: span })) as unknown as Record<string, number>;
  // motion at full precision (measureLook rounds to 0.01): the median of the 4 s windows
  const mw: number[] = [];
  for (let t = 0; t + 4 <= span; t += 4) mw.push((await measureLook(file, { ss: t, t: 4 })).motion);
  return { taste: tasteMean, tasteAboveFloor: taste.filter((x) => x >= 4.4).length, voice: voiceMean, mix: mix?.median ?? NaN, luma: l.luma!, darkShare: l.darkShare!, colourfulness: l.colourfulness!, motion: +med(mw).toFixed(4), stillShare: l.stillShare!, cutsPerMin: l.cutsPerMin! };
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
// grade over the whole film, same function as the channel's band
{
  const g = JSON.parse(execFileSync(path.join(process.env.HOME!, "lechi_tts/venv/bin/python"), ["-I", path.join(root, "apps/cli/src/dev/hand/grade-band.py"), path.resolve(film)]).toString()) as Record<string, number>;
  m.contrast = +g.contrast!.toFixed(3); m.highlights = +g.hi!.toFixed(4); m.oneColour = +g.oneColour!.toFixed(3);
}
// how words are set (OCR), same function as the channel's text band
{
  const t = JSON.parse(execFileSync(path.join(process.env.HOME!, "lechi_tts/venv/bin/python"), ["-I", path.join(root, "apps/cli/src/dev/hand/text-band.py"), path.resolve(film)]).toString()) as Record<string, number>;
  for (const [k, v] of Object.entries(t)) m[k] = +v.toFixed(3);
}
// the lettering's weight and width (letter-shape crops, same function as the reference channels')
{
  const dir = path.join(job, "type-ratchet");
  await import("node:fs/promises").then((f) => f.rm(dir, { recursive: true, force: true }));
  const py = path.join(process.env.HOME!, "lechi_tts/venv/bin/python");
  execFileSync(py, ["-I", path.join(root, "apps/cli/src/dev/hand/type-crops.py"), dir, "120", `film=${path.resolve(film)}`]);
  const r = JSON.parse(execFileSync(py, ["-I", path.join(root, "apps/cli/src/dev/hand/type-band.py"), path.join(root, "data", "type-crops"), "magnates-media", dir]).toString()) as { ours: Record<string, Record<string, number>> };
  const o = Object.values(r.ours)[0] ?? {};
  for (const k of TYPE_KEYS) if (o[k] !== undefined) m[k] = +o[k]!.toFixed(3);
}
// the story: what each sentence does (the script's recorded line kinds), against the channel's 30 films
if (existsSync(path.join(job, "story-kinds.json"))) {
  const { storyProfile } = await import("@opumia/agents");
  const sk = JSON.parse(await readFile(path.join(job, "story-kinds.json"), "utf8")) as { sentences: string[]; kinds: string[] };
  const pr = storyProfile(sk.sentences, sk.kinds as never);
  for (const k of STORY_KINDS) m[`${k}Share`] = pr.share[k as keyof typeof pr.share];
  m.viewerShare = pr.viewerShare;
}
// share of shots left as clean footage (nothing on them): the channel leaves 19–75 % per film (42 % typical)
if (existsSync(path.join(job, "scenes.json"))) {
  const sc = (JSON.parse(await readFile(path.join(job, "scenes.json"), "utf8")) as { scenes: Array<{ backdrop?: string; elements: unknown[] }> }).scenes;
  m.cleanShare = +(sc.filter((x) => (x.backdrop ?? "footage") === "footage" && !x.elements.length).length / sc.length).toFixed(3);
}
// Each measure keeps the best level it has reached in any version (owner, 2026-11-24: "only freeze the better part"):
// a candidate is compared with those bests, not with one frozen film. --lock-best <label> records a candidate's better
// measures as bests without freezing the film; a freeze also raises the bests.
type Best = Record<string, { value: number; from: string }>;
const base = existsSync(baseFile) ? (JSON.parse(await readFile(baseFile, "utf8")) as { tag: string; measures: Record<string, number>; best?: Best }) : null;
const best: Best = base ? { ...Object.fromEntries(Object.entries(base.measures).map(([k, v]) => [k, { value: v, from: base.tag }])), ...(base.best ?? {}) } : {};
const li = process.argv.indexOf("--lock-best"), lockLabel = li > 0 ? process.argv[li + 1] : null;
const worse: string[] = [], better: string[] = [];
// a regression is judged against the best of each measure; an improvement against the frozen film
const cmp = (k: string, v: number, b: number) => k in HIGHER ? (v < b - HIGHER[k]! ? -1 : v > b + HIGHER[k]! ? 1 : 0) : (off(k, v) > off(k, b) + BAND_NOISE[k]! ? -1 : off(k, v) < off(k, b) - BAND_NOISE[k]! ? 1 : 0);
for (const [k, v] of Object.entries(m)) {
  if (RETIRED.has(k) || !Number.isFinite(v)) continue;
  const b = best[k]?.value, f = base?.measures[k];
  if (b !== undefined && Number.isFinite(b) && cmp(k, v, b) < 0) worse.push(`${k} best ${b} (${best[k]!.from}) → ${v}${k in BAND ? ` (band ${BAND[k]})` : ""}`);
  if (f !== undefined && Number.isFinite(f) && cmp(k, v, f) > 0) better.push(`${k} ${f} → ${v}${k in BAND ? ` (band ${BAND[k]})` : ""}`);
}
console.log(JSON.stringify(m));
const raise = () => { for (const [k, v] of Object.entries(m)) { if (RETIRED.has(k) || !Number.isFinite(v)) continue; const b = best[k]; const up = !b || (k in HIGHER ? v > b.value : off(k, v) < off(k, b.value) || (off(k, v) === off(k, b.value) && false)); if (up) best[k] = { value: v, from: tag ?? lockLabel ?? "?" }; } };
console.log(base ? `vs the best of every measure (frozen film ${base.tag}): ${worse.length ? `REGRESSES ${worse.join("; ")}` : "no regression"}${better.length ? ` | improves ${better.join("; ")}` : ""}` : "no frozen baseline yet");
if (lockLabel && !tag) {
  raise();
  await writeFile(baseFile, JSON.stringify({ ...base, best }, null, 2));
  console.log(`LOCKED the better measures of ${lockLabel} as bests (the frozen film stays ${base?.tag})`);
}
if (tag) {
  if (base && worse.length) { console.log("NOT FROZEN: a frozen level may never go down"); process.exit(2); }
  if (base && !better.length && !owner) { console.log("NOT FROZEN: nothing improved"); process.exit(3); }
  const dir = path.join(job, "frozen", tag);
  await mkdir(dir, { recursive: true });
  await cp(path.resolve(film), path.join(dir, path.basename(film)));
  for (const f of ["timed-script.json", "storyboard.json", "scenes.json", "resolution.json", "design.json", "manifest.json", "narration.mp3", "design/film/index.tsx"]) if (existsSync(path.join(job, f))) await cp(path.join(job, f), path.join(dir, f), { recursive: true });
  await cp(path.join(root, "apps/cli/src/dev/hand"), path.join(dir, "hand-scripts"), { recursive: true });
  await mkdir(path.dirname(baseFile), { recursive: true });
  raise();
  await writeFile(baseFile, JSON.stringify({ name, tag, best, film: path.relative(root, path.join(dir, path.basename(film))), frozenAt: new Date().toISOString(), measures: m, ...(owner ? { ownerApproval: owner } : {}), previous: base ? { tag: base.tag, measures: base.measures } : null }, null, 2));
  console.log(`FROZEN ${name} at ${tag} → ${path.relative(root, dir)}; commit eval/ratchet and tag: git tag ratchet/${name}/${tag}`);
}
