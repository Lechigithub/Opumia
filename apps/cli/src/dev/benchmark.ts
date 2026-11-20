/**
 * Benchmark a finished film against its reference channel.
 *
 *   npx tsx apps/cli/src/dev/benchmark.ts out/<job>
 *
 * Extracts 16 frames from our film (one per shot cluster) and 14 reference frames (the channel's top technique
 * clips in Library/moments/<channel>/ plus b-roll from reference films, read-only), computes the measurable
 * metrics on both sides, and asks Sonnet 5.5 (vision) for a strict gap list. Writes benchmark.json, benchmark.md
 * and the frame sheets into the job folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { benchmarkAgainstReference, recordOutcome, TENSION, updateMemory } from "@opumia/agents";
import { RenderManifest, Storyboard, StyleProfile, TimedScript } from "@opumia/contracts";
import { loadKeys } from "../keys.js";

const ROOT = process.cwd();
loadKeys(ROOT);
const jobDir = path.resolve(process.argv[2] ?? "out/nokia-magnates-v2");
const job = JSON.parse(readFileSync(path.join(jobDir, "job.json"), "utf8")) as { channel: string };
const CH: Record<string, { dir: string; display: string }> = { "magnates-media": { dir: "MagnatesMedia", display: "MagnatesMedia" }, "how-money-works": { dir: "How Money Works", display: "How Money Works" }, moon: { dir: "Moon", display: "Moon" }, "modern-mba": { dir: "Modern MBA", display: "Modern MBA" }, "logically-answered": { dir: "Logically Answered", display: "Logically Answered" } };
const ch = CH[job.channel] ?? { dir: job.channel, display: job.channel };
const outDir = path.join(jobDir, "benchmark");
mkdirSync(outDir, { recursive: true });
const ff = (a: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
const probeDur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

const manifest = RenderManifest.parse(JSON.parse(readFileSync(path.join(jobDir, "manifest.json"), "utf8")));
const timed = TimedScript.parse(JSON.parse(readFileSync(path.join(jobDir, "timed-script.json"), "utf8")));
const board = Storyboard.parse(JSON.parse(readFileSync(path.join(jobDir, "storyboard.json"), "utf8")));
const profile = StyleProfile.parse(JSON.parse(readFileSync(path.join(ROOT, "data", "style-profiles", `${job.channel}.json`), "utf8")));
const final = readdirSync(jobDir).find((f) => /_(16x9|9x16)\.mp4$/.test(f));
if (!final) throw new Error("no final mp4 in job dir");
const finalPath = path.join(jobDir, final);

// --- Our frames: 16, sampled at 70 % into evenly spaced shots (so each frame is a settled composition).
const shots = board.shots;
const pickShots = Array.from({ length: 16 }, (_, k) => shots[Math.min(shots.length - 1, Math.round((k * (shots.length - 1)) / 15))]!);
const ours = pickShots.map((s, k) => {
  const t = s.startS + (s.endS - s.startS) * 0.7;
  const p = path.join(outDir, `ours_${String(k + 1).padStart(2, "0")}.jpg`);
  ff(["-ss", t.toFixed(2), "-i", finalPath, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", p]);
  return { path: p, label: `${t.toFixed(1)} s, ${s.source.kind === "designed" ? `designed ${s.source.designed}` : "footage"} — "${s.intent.slice(0, 60)}"` };
});

// --- Reference frames: top technique clip per kind (mid frame) + b-roll from two reference films.
const mIndex = JSON.parse(readFileSync(path.join(ROOT, "Library", "moments", ch.dir, "index.json"), "utf8")) as Record<string, { moments: Array<{ clip: string; film: string }> }>;
const reference: Array<{ path: string; label: string }> = [];
for (const kind of ["chart", "map", "document", "versus", "big_word", "name_label", "money_figure", "cutout_collage", "chapter_card", "screen"]) {
  const mo = mIndex[kind]?.moments.find((m) => existsSync(path.join(ROOT, m.clip)));
  if (!mo) continue;
  const src = path.join(ROOT, mo.clip);
  const p = path.join(outDir, `ref_${kind}.jpg`);
  ff(["-ss", (probeDur(src) * 0.6).toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", p]);
  reference.push({ path: p, label: `${kind} technique (${mo.film.slice(0, 50)})` });
}
const films = readdirSync(path.join(ROOT, "Reference", ch.dir)).filter((d) => /^\d{8} - /.test(d)).sort();
for (const [k, film] of [films[Math.floor(films.length * 0.3)], films[Math.floor(films.length * 0.8)]].entries()) {
  if (!film) continue;
  const mp4 = readdirSync(path.join(ROOT, "Reference", ch.dir, film)).find((f) => f.endsWith(".mp4"));
  if (!mp4) continue;
  const src = path.join(ROOT, "Reference", ch.dir, film, mp4);
  const d = probeDur(src);
  for (const frac of [0.22, 0.47]) {
    const p = path.join(outDir, `ref_broll_${k}_${Math.round(frac * 100)}.jpg`);
    ff(["-ss", (d * frac).toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", p]);
    reference.push({ path: p, label: `b-roll / story frame (${film.slice(11, 60)})` });
  }
}
ff(["-i", path.join(outDir, "ours_%02d.jpg"), "-vf", "scale=480:-2,tile=4x4", "-frames:v", "1", path.join(outDir, "ours_sheet.jpg")]);

// --- Metrics.
const fps = manifest.fps;
const durS = manifest.durationFrames / fps;
const base = manifest.video.filter((l) => l.zIndex === 0);
const cuts = new Set(base.map((l) => l.startFrame)).size;
const lens = shots.map((s) => s.endS - s.startS).sort((a, b) => a - b);
const words = timed.segments.flatMap((s) => s.words);
const wpm = (words.length / ((words.at(-1)?.endS ?? durS) - (words[0]?.startS ?? 0))) * 60;
const thesis = timed.segments.find((s) => s.role === "thesis");
const sentences: Array<{ t: number; text: string }> = [];
for (const sg of timed.segments) {
  let cur: string[] = [];
  let t0 = sg.words[0]?.startS ?? sg.startS;
  for (const w of sg.words) {
    if (!cur.length) t0 = w.startS;
    cur.push(w.word);
    if (/[.?!]["”']?$/.test(w.word)) {
      sentences.push({ t: t0, text: cur.join(" ") });
      cur = [];
    }
  }
  if (cur.length) sentences.push({ t: t0, text: cur.join(" ") });
}
const marks = sentences.filter((s) => TENSION.test(s.text) || /\?["”']?$/.test(s.text)).map((s) => s.t);
const gaps = marks.slice(1).map((t, i) => t - marks[i]!).sort((a, b) => a - b);
const qa = JSON.parse(readFileSync(path.join(jobDir, "qa.json"), "utf8")) as { measurements?: Record<string, unknown>; checks: Array<{ id: string; measured?: unknown; message: string }> };
const lufs = qa.checks.find((c) => c.id === "loudness")?.measured;
const sfx = manifest.audio.filter((a) => a.role === "sfx").length;
const musicCues = manifest.audio.filter((a) => a.role === "music");
const dips = musicCues.reduce((n, a) => n + (a.dips?.length ?? 0), 0);
const designedShots = shots.filter((s) => s.source.kind === "designed").length;
const p = profile.pacing;
const au = profile.audio as Record<string, { p50?: number } | null>;
const row = (k: string, ours: string, ref: string) => `| ${k} | ${ours} | ${ref} |`;
const metrics = [
  "| metric | ours | reference p50 |",
  "|---|---|---|",
  row("duration", `${durS.toFixed(0)} s`, "8–30 min long-form"),
  row("cuts / min", (cuts / (durS / 60)).toFixed(1), String(p.cutsPerMin?.p50 ?? "?")),
  row("median shot", `${lens[Math.floor(lens.length / 2)]?.toFixed(2)} s`, `${p.shotMedianS?.p50 ?? "?"} s`),
  row("designed share of shots", `${Math.round((designedShots / shots.length) * 100)} %`, `${Math.round((profile.visualMix.designed?.p50 ?? 0) * 100)} %`),
  row("narration wpm", wpm.toFixed(0), String(profile.narration.wordsPerMin?.p50?.toFixed(0) ?? "?")),
  row("cold open → thesis", `${thesis?.startS.toFixed(1) ?? "?"} s`, "36 s (median hook end)"),
  row("tension turn gap (median)", `${gaps[Math.floor(gaps.length / 2)]?.toFixed(0) ?? "?"} s`, "31 s"),
  row("integrated loudness", `${lufs} LUFS`, `${au.integratedLufs?.p50 ?? "?"} LUFS`),
  row("sfx hits / min", (sfx / (durS / 60)).toFixed(1), String(au.strongHitsPerMin?.p50?.toFixed(1) ?? "?")),
  row("music drops / 10 min", ((dips / durS) * 600).toFixed(1), String(au.musicDropsPer10Min?.p50?.toFixed(1) ?? "?")),
  row("music cue changes / 10 min", (((musicCues.length - 1) / durS) * 600).toFixed(1), String(au.cueChangesPer10Min?.p50?.toFixed(1) ?? "?")),
].join("\n");

console.log(metrics);
console.log(`benchmark: ${ours.length} of our frames vs ${reference.length} reference frames (Sonnet 5.5 vision)…`);
const res = await benchmarkAgainstReference({ channel: ch.display, ours, reference, metrics, script: timed.segments.map((s) => `[${s.role}] ${s.text}`).join("\n") });
writeFileSync(path.join(jobDir, "benchmark.json"), JSON.stringify({ metrics, ...res }, null, 2) + "\n");
const designPath = path.join(jobDir, "design.json");
const design = existsSync(designPath) ? (JSON.parse(readFileSync(designPath, "utf8")) as { concept: string; palette: Record<string, string>; typography: { display: string; body: string } }) : null;
const draft = JSON.parse(readFileSync(path.join(jobDir, "script.draft.json"), "utf8")) as { blueprint?: { hook: string; spine: string; ending: string } };
const kinds: Record<string, number> = {};
for (const sh of shots) if (sh.source.kind === "designed") kinds[sh.source.designed] = (kinds[sh.source.designed] ?? 0) + 1;
await updateMemory(path.join(ROOT, "data"), (m) => recordOutcome(m, job.channel, { job: path.basename(jobDir), overall: res.overall, designedShare: Math.round((designedShots / shots.length) * 100) / 100, medianShotS: lens[Math.floor(lens.length / 2)] ?? 0, kinds }));
const md = [
  `# Benchmark vs ${ch.display}`,
  "",
  ...(design ? [`**Design system:** ${design.concept} — primary \`${design.palette.primary}\`, accent \`${design.palette.accent}\`, surface \`${design.palette.surface}\`; type ${design.typography.display} / ${design.typography.body}`, ""] : []),
  ...(draft.blueprint ? [`**Blueprint:** cold open \`${draft.blueprint.hook}\` · spine "${draft.blueprint.spine}" · ending \`${draft.blueprint.ending}\``, ""] : []),
  `**Overall ${res.overall}/10** — ${res.summary}`,
  "",
  "## Scores",
  ...res.scores.map((s) => `- **${s.area}** ${s.ours}/10 — ${s.note}`),
  "",
  "## Metrics",
  metrics,
  "",
  "## Remaining gaps (strict)",
  ...res.gaps.map((g) => `- [${g.severity}] **${g.area}**${g.ourFrame ? ` (our frame ${g.ourFrame}${g.refFrame ? ` vs ref ${g.refFrame}` : ""})` : ""}: ${g.gap} → _${g.fix}_`),
  "",
  "## Amateur tells",
  ...res.amateurTells.map((t) => `- ${t}`),
  "",
].join("\n");
writeFileSync(path.join(jobDir, "benchmark.md"), md);
console.log(`overall ${res.overall}/10; ${res.gaps.length} gaps (${res.gaps.filter((g) => g.severity === "major").length} major) → ${path.relative(ROOT, path.join(jobDir, "benchmark.md"))}`);
