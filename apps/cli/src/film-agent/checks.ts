// The checks before the finisher (owner, 2026-11-26: agents grading their own work is the weakest part): code and
// cheap model checks on the assembled film, handed to the finisher as findings. They also write what the release
// needs: captions.srt and LICENSES.md.
//   captions        captions.srt from the narration's word times
//   licences        LICENSES.md from every scene's ledgers
//   numbers         every figure on screen (on-device OCR, 2 frames a second) against the narration and the fact sheet
//   period          footage under a line set before 2009 dated on its own frame (resolver periodCheck)
//   faces           a stranger's face under a named person when real material of that person exists in the film
//   repeats         one source, one moment or one scene's file used in two scenes
//   closing         the closing title over footage clearly weaker than the film's strongest (the channel's move: the
//                   title over the film's best picture — the Juicero rebuild's closing went 3.4 → 5.6 that way)
//   dark            stretches of ≥ 2 s where almost nothing can be seen (below the channel's darkest 5 % of frames)
//   sameness        line fit and sameness to our earlier films (tools/world/world_check.py)
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readPlan, filmMedia, mediaRefs, type FilmPlan } from "./plan.js";
import { ledgers } from "./gate.js";
import { darkBar } from "./scene-check.js";

/** Stretches where almost nothing can be seen: 4 frames a second, the share of each frame brighter than luma 48. */
export function darkStretches(video: string, bar: number, minS = 2): Array<{ from: number; to: number; lit: number }> {
  const W = 160, H = 90, FPS = 4;
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `fps=${FPS},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const b = r.stdout as Buffer | null;
  if (!b?.length) return [];
  const lit: number[] = [];
  for (let o = 0; o + W * H <= b.length; o += W * H) { let n = 0; for (let k = o; k < o + W * H; k++) if (b[k]! > 48) n++; lit.push(n / (W * H)); }
  const out: Array<{ from: number; to: number; lit: number }> = [];
  for (let i = 0; i < lit.length;) {
    if (lit[i]! >= bar) { i++; continue; }
    let j = i; while (j < lit.length && lit[j]! < bar) j++;
    if ((j - i) / FPS >= minS) out.push({ from: i / FPS, to: j / FPS, lit: Math.max(...lit.slice(i, j)) });
    i = j;
  }
  return out;
}

export interface Finding { check: string; scene?: string; atS?: number; what: string; severity: "fix" | "look" }
type Credit = { file: string; kind: string; source: string; url?: string; license: string; note?: string; scene?: string };
type FairUse = { file: string; kind: string; video: string; title: string; channel: string; inS: number; seconds: number };
const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };

/** Every staticFile a scene draws (its file and its folder). */
export function sceneMedia(job: string, id: string): string[] {
  const files = [path.join(job, "src", "scenes", `${id}.tsx`)];
  const dir = path.join(job, "src", "scenes", id);
  if (existsSync(dir)) for (const f of readdirSync(dir, { recursive: true }) as string[]) if (/\.tsx?$/.test(f)) files.push(path.join(dir, f));
  const out = new Set<string>();
  for (const f of files) if (existsSync(f)) for (const m of mediaRefs(readFileSync(f, "utf8"))) out.add(m);
  return [...out];
}

/** Numbers in a text, as values (scale letters and words applied): "$7.2B" → 7.2e9, "3,500" → 3500, "49%" → 49. */
export function numbersIn(text: string): Array<{ raw: string; value: number; unit: string }> {
  const out: Array<{ raw: string; value: number; unit: string }> = [];
  const re = /([$€£])?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(%|percent|bn|billion|million|thousand|trillion|[kmbt]\b)?/gi;
  const SC: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
  for (const m of text.matchAll(re)) {
    const n = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const s = (m[3] ?? "").toLowerCase();
    out.push({ raw: m[0].trim(), value: n * (SC[s] ?? 1), unit: m[1] ?? (s === "%" || s === "percent" ? "%" : "") });
  }
  return out;
}

/** The closing title over footage clearly weaker than the film's strongest (scored by the picture referee, cached). */
export async function closingFinding(root: string, job: string, plan: FilmPlan): Promise<Finding | null> {
  const last = plan.scenes.at(-1);
  if (!last || plan.scenes.length < 3) return null;
  try {
    const { rankFiles } = await import("./footage.js");
    const placed = plan.scenes.map((s) => ({ id: s.id, files: sceneMedia(job, s.id).filter((m) => /^(v|img)\//.test(m) && !/_(cut|mask|depth)\./.test(m)).map((m) => path.join(job, "public", m)).filter(existsSync) }));
    const scores = await rankFiles(root, job, placed.flatMap((x) => x.files));
    const best = (files: string[]) => Math.max(-1, ...files.map((f) => scores.get(f) ?? -1));
    const lastScore = best(placed.at(-1)!.files);
    const top = placed.slice(0, -1).map((x) => ({ id: x.id, s: best(x.files), f: [...x.files].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))[0] })).sort((a, b) => b.s - a.s)[0];
    if (top && top.s > 0 && lastScore < top.s - 0.5 && lastScore < 4.9) return { check: "closing", scene: last.id, what: `the closing title sits on footage scoring ${lastScore < 0 ? "nothing (no footage)" : lastScore.toFixed(2)} while the film's strongest is ${top.s.toFixed(2)} (${top.id}: ${top.f ? path.relative(job, top.f) : "?"}) — the channel closes with the title over its best picture: use that footage, or another moment of it, under the title`, severity: "fix" };
  } catch { /* the referee is not built here: not checked */ }
  return null;
}

export async function preFinishChecks(o: { root: string; job: string; channel: string; plan?: FilmPlan; video?: string; models?: boolean; log?: (s: string) => void }): Promise<{ findings: Finding[]; text: string; usd: number }> {
  const log = o.log ?? (() => {});
  const plan = o.plan ?? readPlan(o.job);
  if (!plan) throw new Error("no plan.json");
  const video = path.join(o.job, o.video ?? "picture.mp4");
  const findings: Finding[] = [];
  const timed = jread<{ durationS: number; segments: Array<{ words: Array<{ word: string; startS: number; endS: number }> }> }>(path.join(o.job, "timed-script.json"), { durationS: 0, segments: [] });
  const words = timed.segments.flatMap((s) => s.words ?? []);
  const credits = ledgers<Credit>(o.job, "credits"), fair = ledgers<FairUse>(o.job, "fair-use");
  const sceneAt = (t: number) => plan.scenes.find((s) => t >= s.from && t < s.to)?.id;
  const { usageLedger } = await import("@opumia/agents");
  const usd0 = usageLedger().reduce((t, r) => t + r.usd, 0);

  // captions and licences
  try {
    const { captionGroups, toSrt } = await import("@opumia/motion-engine");
    writeFileSync(path.join(o.job, "captions.srt"), toSrt(captionGroups(JSON.parse(readFileSync(path.join(o.job, "timed-script.json"), "utf8")), 7, 42)));
  } catch (e) { findings.push({ check: "captions", what: `captions.srt not written: ${(e as Error).message.slice(0, 120)}`, severity: "look" }); }
  const onScreen = [...filmMedia(o.job)];
  const key = (f: string) => path.basename(f).replace(/\.\w+$/, "");
  const usedCredits = credits.filter((c) => onScreen.some((m) => m === c.file || key(m).includes(key(c.file))));
  const usedFair = fair.filter((f) => onScreen.some((m) => m === f.file || key(m).includes(key(f.file))));
  const lic = ["# Licences and sources", "", "Every picture in the film, its source and its licence. Press and film excerpts are short, muted, transformed and under commentary (fair use); each is listed with its in-point and length.", "",
    "| File | Kind | Source | Licence | Link |", "|---|---|---|---|---|",
    ...usedCredits.map((c) => `| ${c.file} | ${c.kind} | ${(c.source ?? "").replace(/\|/g, "/")}${c.note ? ` — ${c.note.replace(/\|/g, "/").slice(0, 80)}` : ""} | ${c.license} | ${c.url ?? ""} |`),
    "", "## Fair-use excerpts", "", "| File | Video | Channel | In (s) | Seconds |", "|---|---|---|---|---|",
    ...usedFair.map((f) => `| ${f.file} | ${f.title.replace(/\|/g, "/")} (${f.video}) | ${f.channel} | ${f.inS} | ${f.seconds} |`)];
  writeFileSync(path.join(o.job, "LICENSES.md"), lic.join("\n") + "\n");

  // repeats: one source in two scenes, one moment twice, one scene drawing another scene's files
  const byUrl = new Map<string, Set<string>>();
  for (const c of credits) if (c.url && c.scene && !/fair use/i.test(c.license)) byUrl.set(c.url, new Set([...(byUrl.get(c.url) ?? []), c.scene]));
  for (const [u, sc] of byUrl) if (sc.size > 1) findings.push({ check: "repeat", what: `${[...sc].join(" and ")} use the same source ${u}`, severity: "fix" });
  const fairScene = (f: FairUse) => /^v\/(s\d{2})_/.exec(f.file)?.[1];
  for (const [i, a] of fair.entries()) for (const b of fair.slice(i + 1)) if (a.video === b.video && fairScene(a) !== fairScene(b) && a.inS < b.inS + b.seconds && b.inS < a.inS + a.seconds) findings.push({ check: "repeat", what: `${fairScene(a)} and ${fairScene(b)} show the same moment of ${a.video}`, severity: "fix" });
  for (const s of plan.scenes) for (const m of sceneMedia(o.job, s.id)) { const owner = /^(?:v|img|a)\/(s\d{2})_/.exec(m)?.[1]; if (owner && owner !== s.id) findings.push({ check: "repeat", scene: s.id, what: `${s.id} draws ${m}, which ${owner} brought in — the same picture twice`, severity: "fix" }); }

  // numbers on screen against the narration and the fact sheet
  const ocrBin = path.join(o.root, "data", ".cache", "ocr", "ocr");
  if (existsSync(video) && existsSync(ocrBin)) {
    const dir = path.join(o.job, "checks", "ocr");
    mkdirSync(dir, { recursive: true });
    spawnSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", "fps=2,scale=1280:-2", path.join(dir, "f%04d.jpg")]);
    const frames = readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort().map((f) => path.join(dir, f));
    const allowed = [...numbersIn(words.map((w) => w.word).join(" ")).map((x) => x.value), ...numbersIn(readFileSync(path.join(o.job, "facts.json"), "utf8")).map((x) => x.value)];
    const near = (v: number) => allowed.some((a) => Math.abs(a - v) <= Math.max(0.011 * Math.abs(a), 1e-9));
    const seen = new Set<string>();
    for (let i = 0; i < frames.length; i += 40) {
      const r = spawnSync(ocrBin, frames.slice(i, i + 40), { encoding: "utf8", maxBuffer: 1 << 26 }).stdout ?? "";
      for (const line of r.split("\n")) {
        let j: { file: string; boxes: Array<{ text: string }> };
        try { j = JSON.parse(line); } catch { continue; }
        const t = (Number(/f(\d+)\.jpg$/.exec(j.file)?.[1] ?? 1) - 1) / 2;
        for (const b of j.boxes) for (const n of numbersIn(b.text)) {
          const key = `${n.value.toPrecision(3)}`;
          if ((!n.unit && n.value < 13) || near(n.value) || seen.has(key)) continue;
          seen.add(key);
          findings.push({ check: "number", scene: sceneAt(t), atS: t, what: `"${n.raw}" on screen at ${t.toFixed(1)} s ("${b.text.slice(0, 60)}") is not a figure the narration says or the fact sheet holds — check it (signage in real footage is fine)`, severity: "look" });
        }
      }
    }
  }

  // period and faces (cheap model checks on one frame of each placed picture)
  if (o.models !== false) {
    const { periodCheck, reviewPictures } = await import("@opumia/resolver");
    const fdir = path.join(o.job, "checks", "frames");
    mkdirSync(fdir, { recursive: true });
    const frameOf = (m: string) => {
      const src = path.join(o.job, "public", m), out = path.join(fdir, `${m.replace(/[^\w.-]+/g, "_")}.jpg`);
      if (!existsSync(out) && existsSync(src)) spawnSync("ffmpeg", ["-v", "error", "-y", ...(/\.(mp4|mov|webm)$/i.test(m) ? ["-ss", "1"] : []), "-i", src, "-frames:v", "1", "-vf", "scale=960:-2", out]);
      return existsSync(out) ? out : null;
    };
    const pressOf = (m: string) => fair.find((f) => f.file === m && f.kind === "press");
    const items: Array<{ scene: string; media: string; frame: string; year?: number }> = [];
    for (const s of plan.scenes) for (const m of sceneMedia(o.job, s.id)) { if (!/^(v|img)\//.test(m) || /_(cut|depth|mask)\./.test(m)) continue; const fr = frameOf(m); if (fr) items.push({ scene: s.id, media: m, frame: fr, ...(s.year ? { year: s.year } : {}) }); }
    const dated = items.filter((x) => x.year && x.year < 2009 && !pressOf(x.media));
    if (dated.length) {
      const r = await periodCheck(dated.map((x) => ({ frameFile: x.frame, year: x.year! }))).catch(() => []);
      r.forEach((v, k) => { if (!v.ok) findings.push({ check: "period", scene: dated[k]!.scene, what: `${dated[k]!.media} looks ${v.earliestYear} or later under a ${dated[k]!.year} line: ${v.evidence}`, severity: "fix" }); });
    }
    const named = plan.scenes.flatMap((s) => (s.entities ?? []).filter((e) => e.type === "person").map((e) => ({ scene: s.id, name: e.name })));
    const said = (s: string) => plan.scenes.find((x) => x.id === s);
    const lastName = (n: string) => n.split(/\s+/).at(-1)!.toLowerCase();
    const realExists = (n: string) => [...credits.map((c) => `${c.source} ${c.url ?? ""} ${c.note ?? ""} ${c.file}`), ...fair.map((f) => `${f.title} ${f.file}`)].some((t) => t.toLowerCase().includes(lastName(n)));
    const ofPerson = (m: string, n: string) => { const f = fair.find((x) => x.file === m); const c = credits.find((x) => x.file === m); return `${f?.title ?? ""} ${c?.note ?? ""} ${c?.url ?? ""} ${m}`.toLowerCase().includes(lastName(n)); };
    const faceItems = items.filter((x) => named.some((p) => p.scene === x.scene && realExists(p.name) && !ofPerson(x.media, p.name)));
    if (faceItems.length) {
      const r = await reviewPictures(faceItems.map((x) => ({ frameFile: x.frame, intent: said(x.scene)?.idea ?? "", line: said(x.scene)?.words ?? "", era: String(said(x.scene)?.year ?? "") }))).catch(() => []);
      r.forEach((v, k) => { const x = faceItems[k]!; if (v.face) findings.push({ check: "face", scene: x.scene, what: `${x.media} shows a face (${v.shows}) under a line naming ${named.filter((p) => p.scene === x.scene).map((p) => p.name).join(", ")} — real material of them is in the film, so a stranger may not stand in`, severity: "fix" }); });
    }
  }

  // the closing title: over the film's strongest footage, as the channel closes (local referee, no model)
  const closing = await closingFinding(o.root, o.job, plan);
  if (closing) findings.push(closing);

  // stretches too dark to see (the channel's darkest 5 % of frames: data/quality-profile/<channel>-lit-band.json)
  if (existsSync(video)) {
    const bar = darkBar(o.root, o.channel);
    for (const d of darkStretches(video, bar)) findings.push({ check: "dark", scene: sceneAt(d.from), atS: d.from, what: `${d.from.toFixed(1)}–${d.to.toFixed(1)} s: almost nothing can be seen (at most ${(d.lit * 100).toFixed(1)} % of the frame lit; the channel's darkest 5 % of frames show ${(bar * 100).toFixed(1)} %) — lift it or choose footage with a lit subject`, severity: "fix" });
  }

  // sameness to our earlier films and line fit
  if (existsSync(video)) {
    const py = process.env.OPUMIA_PY ?? path.join(process.env.HOME ?? "", "lechi_tts", "venv", "bin", "python");
    const len = jread<{ seconds?: number }>(path.join(o.job, "src", "length.json"), {}).seconds ?? timed.durationS;
    const r = spawnSync(py, ["-I", path.join(o.root, "tools/world/world_check.py"), path.basename(o.job), video, path.join(o.job, "timed-script.json"), "--no-save", "--len", String(Math.floor(len))], { cwd: o.root, encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 24 });
    const out = `${r.stdout ?? ""}`.trim().split("\n").slice(-12).join("\n");
    if (out) findings.push({ check: "sameness", what: `world check (line fit, sameness to our earlier films):\n${out}`, severity: /FAIL|too close|OUTSIDE/i.test(out) ? "fix" : "look" });
  }

  const usd = usageLedger().reduce((t, r) => t + r.usd, 0) - usd0;
  const text = findings.length ? findings.map((f) => `- [${f.severity === "fix" ? "FIX" : "look"}] ${f.check}${f.scene ? ` ${f.scene}` : ""}: ${f.what}`).join("\n") : "- nothing found";
  writeFileSync(path.join(o.job, "FINDINGS.md"), `# Checks before the finisher\n\n${text}\n`);
  writeFileSync(path.join(o.job, "findings.json"), JSON.stringify(findings, null, 1));
  log(`  checks: ${findings.filter((f) => f.severity === "fix").length} to fix, ${findings.filter((f) => f.severity === "look").length} to look at ($${usd.toFixed(2)})`);
  return { findings, text, usd };
}
