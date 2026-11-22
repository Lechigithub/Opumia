/**
 * Production side of the blank-slate art director (build list 2, step 5): the font catalogue, the channel's real frames,
 * the film's own palette, and rendering kit samples on the film's own shots with every measure attached (legibility
 * on a phone, design fundamentals, trained taste, likeness to our produced films).
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { embedPictures, filmDesignerAgent, filmLook, loadTaste, producedJobs, scoreTaste, type FilmDesignerReport } from "@opumia/agents";
import type { ChannelId, FilmDesignSystem, ResolutionReport, ScenePlan, Storyboard, TimedScript } from "@opumia/contracts";
import { buildManifest, lookFromProfile, renderShotPreviews, watchClip, type Look } from "@opumia/motion-engine";
import { designIssues, measureDesign, measureLegibility, run } from "@opumia/senses";

/** Every Google font the renderer can load (import names), read from the installed package. */
export function googleFonts(): string[] {
  const req = createRequire(path.join(process.cwd(), "packages", "motion-engine", "package.json"));
  const dir = path.join(path.dirname(req.resolve("@remotion/google-fonts/package.json")), "dist", "esm");
  return readdirSync(dir).filter((f) => /^[A-Z][A-Za-z0-9]+\.mjs$/.test(f) && !f.includes("-")).map((f) => f.replace(/\.mjs$/, "")).sort();
}

/** Dominant colours of the film's own pictures: 2×2 averages of a frame of each, merged when close. */
async function paletteOf(files: string[]): Promise<string[]> {
  const cols: Array<[number, number, number]> = [];
  for (const f of files.slice(0, 24)) {
    const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-frames:v", "1", "-vf", "scale=3:3:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer" } as never).catch(() => null);
    const b = (r as unknown as { stdout?: Buffer } | null)?.stdout;
    if (b) for (let i = 0; i + 2 < b.length; i += 3) cols.push([b[i]!, b[i + 1]!, b[i + 2]!]);
  }
  const groups: Array<{ c: [number, number, number]; n: number }> = [];
  for (const c of cols) {
    const g = groups.find((x) => Math.hypot(x.c[0] - c[0], x.c[1] - c[1], x.c[2] - c[2]) < 42);
    if (g) (g.c = [(g.c[0] * g.n + c[0]) / (g.n + 1), (g.c[1] * g.n + c[1]) / (g.n + 1), (g.c[2] * g.n + c[2]) / (g.n + 1)]), g.n++;
    else groups.push({ c, n: 1 });
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return groups.sort((a, b) => b.n - a.n).slice(0, 8).map((g) => `#${hex(g.c[0])}${hex(g.c[1])}${hex(g.c[2])} (${Math.round((g.n / Math.max(1, cols.length)) * 100)} %)`);
}

export async function runFilmDesigner(o: { root: string; data: string; library: string; jobDir: string; job: string; channel: ChannelId; title: string; brief: string; board: Storyboard; scenes: ScenePlan | null; resolution: ResolutionReport; timed: TimedScript; design: FilmDesignSystem; look: Look; log: (s: string) => void }): Promise<FilmDesignerReport> {
  const kitDir = path.join(o.jobDir, "design", "film");
  const pub = path.join(o.jobDir, "public");
  const words = o.timed.segments.flatMap((s) => s.words);
  const lineOf = (sh: { startS: number; endS: number }) => words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
  const prim = (id: string) => o.resolution.media.find((m) => m.shotId === id && m.role === "primary");
  const shots = o.board.shots.map((s) => ({ id: s.id, line: lineOf(s), picture: prim(s.id)?.depicts ?? prim(s.id)?.query ?? "(no footage: a designed stage)" }));
  const exDir = path.join(o.data, "exemplars", o.channel);
  const ex = await readFile(path.join(exDir, "index.json"), "utf8").then((t) => JSON.parse(t) as { shots: Array<{ kind: string; layout: string; line: string; frames: string[]; designed: boolean }> }, () => ({ shots: [] }));
  const reference = ex.shots.filter((x) => x.frames.length && x.designed).map((x) => ({ kind: x.kind, frame: path.join(exDir, x.frames.at(-1)!), line: `${x.line} [${x.layout}]` }));
  const tm = await loadTaste(o.data, o.channel, "shot").catch(() => null);
  // our produced films' looks (frames, once a second), for "too close to an earlier film"
  const made = await producedJobs(o.data);
  const earlier: Float32Array[] = [];
  for (const j of made) {
    if (j === o.job || !existsSync(path.join("out", j))) continue;
    const f = readdirSync(path.join("out", j)).find((x) => /_(16x9|9x16)\.mp4$/.test(x));
    if (f) earlier.push(...(await filmLook({ root: o.root, data: o.data, video: path.join("out", j, f), film: j })).vecs);
  }
  const samplesDir = path.join(o.jobDir, "design", "samples");
  await mkdir(samplesDir, { recursive: true });
  let round = 0;
  const qb = await readFile(path.join(o.data, "quality-profile", `${o.channel}.json`), "utf8").then((t) => JSON.parse(t) as { design?: { frames: never } }, () => null);
  const manifestFor = (plan: ScenePlan, board: Storyboard) => buildManifest({ storyboard: board, script: o.timed, resolution: o.resolution, libraryRoot: o.library, outputPath: path.join(o.jobDir, "_kit.mp4"), narrationPath: o.timed.voice.audioPath, burnCaptions: false, scenes: new Map<string, unknown>(plan.scenes.map((x) => [x.shotId, x])) });
  const basePlan = (): ScenePlan => o.scenes ?? { schemaVersion: 1, storyboardId: o.board.id, scenes: [], generatedAt: new Date().toISOString() };
  return filmDesignerAgent({
    channel: o.channel, job: o.job, title: o.title, data: o.data, kitDir, brief: o.brief, shots, fonts: googleFonts(), reference,
    palette: () => paletteOf(o.resolution.media.filter((m) => m.role === "primary" || m.role === "layer").map((m) => m.localPath).filter((f) => existsSync(f))),
    renderSamples: async (samples) => {
      round++;
      const base = basePlan();
      const scenes = [...base.scenes.filter((x) => !samples.some((s) => s.shotId === x.shotId)), ...samples.map((s) => ({ shotId: s.shotId, idea: "kit sample", backdrop: prim(s.shotId) ? "footage" : "surface", dim: 0.35, camera: { fromScale: 1.03, toScale: 1.09, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: s.elements }))] as ScenePlan["scenes"];
      const plan: ScenePlan = { ...base, scenes };
      const board: Storyboard = { ...o.board, shots: o.board.shots.map((sh) => (samples.some((s) => s.shotId === sh.id) ? { ...sh, source: { kind: "designed", designed: "scene", props: {} } as never } : sh)) };
      const m = await manifestFor(plan, board);
      const pv = await renderShotPreviews({ manifest: m, look: o.look, design: o.design, publicDir: pub, outDir: path.join(samplesDir, `r${round}`), shotIds: samples.map((s) => s.shotId), fresh: true });
      const out = [];
      for (const p of pv) {
        const mid = p.frames[2]?.path ?? p.frames[1]!.path;
        const els = samples.find((s) => s.shotId === p.shotId)!.elements as Array<Record<string, unknown>>;
        const boxes = els.filter((e) => e.type === "component").map((e) => ({ label: String((e.props as Record<string, unknown> | undefined)?.text ?? e.name ?? "component").slice(0, 30), x: Number(e.x ?? 0), y: Number(e.y ?? 0), w: Number(e.w ?? 0.5), h: Number(e.h ?? 0.18) }));
        const leg = boxes.length ? await measureLegibility(mid, boxes) : [];
        const dz = await measureDesign(mid).catch(() => null);
        const dIssues = dz && qb?.design ? designIssues(dz, (qb.design as { frames: never }).frames, "frame").map((x) => x.kind) : [];
        const t = tm ? (await scoreTaste({ root: o.root, data: o.data, channel: o.channel, kind: "shot", items: [{ file: mid }] }).catch(() => [null]))[0] : null;
        let near = 0;
        if (earlier.length) {
          const v = (await embedPictures({ root: o.root, data: o.data, items: [{ file: mid }] }))[0];
          if (v) for (const e of earlier) { let d = 0; for (let k = 0; k < v.length; k++) d += v[k]! * e[k]!; if (d > near) near = d; }
        }
        const legText = leg.length ? leg.map((l) => `"${l.label}": ${l.issues.length ? `UNREADABLE — ${l.issues.join("; ")}` : `contrast ${l.contrast}:1, ${l.phonePx} px on a phone`}`).join("; ") : "no text box measured";
        out.push({ shotId: p.shotId, mid, sheet: p.sheet, text: `- legibility: ${legText}\n- design: ${dIssues.length ? dIssues.join(", ") : "focal point, depth and colour inside the channel's band"}\n- trained taste: ${t?.score ?? "?"}/10${tm ? ` (the channel's real shots: lowest tenth ${tm.calibration.real.p10}, median ${tm.calibration.real.median})` : ""}\n- likeness to our earlier films: ${earlier.length ? `${near.toFixed(2)}${near > 0.9 ? " — TOO CLOSE: it looks like an earlier film" : ""}` : "no earlier produced film"}` });
      }
      return out;
    },
    renderTransition: async () => {
      // a cut between two shots with footage, the second asking for the film's transition
      const k = o.board.shots.findIndex((s, i) => i > 0 && prim(s.id) && prim(o.board.shots[i - 1]!.id));
      if (k <= 0) return null;
      const board: Storyboard = { ...o.board, shots: o.board.shots.map((sh, i) => (i === k ? { ...sh, transitionIn: "film" } : sh)) };
      const m = await manifestFor(basePlan(), board);
      const cut = board.shots[k]!.startS;
      const c = await watchClip({ manifest: m, look: o.look, design: o.design, publicDir: pub, jobDir: o.jobDir, fromS: Math.max(0, cut - 0.5), toS: cut + 0.5, stripFrames: 12, scale: 0.5 });
      const strip = path.join(samplesDir, `transition_${round}.jpg`);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", c.file, "-vf", "fps=24,scale=240:-2,tile=6x4", "-frames:v", "1", strip]);
      return { strip, text: `every frame across the cut at ${cut.toFixed(2)} s (left to right, top to bottom; the cut in the middle)` };
    },
    memoryDir: path.join(o.data, "agents", "film-designer"),
    log: o.log,
  });
}
