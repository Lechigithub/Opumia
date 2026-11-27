// Fresh eyes after the finisher (owner, 2026-11-26): the platform's own reviewers, which made none of the film, run
// on the finished file at the same time — the viewer QA agent (watches it start to end like a viewer), the final-cut
// judge (each 8 s stretch blind beside real channel stretches) and the packaging agent (thumbnail from real pictures
// and frames of the film, title, description, tags, pinned comment). Their issues go back to the finisher once.
// The adapter turns the film agent's plan and ledgers into the shapes those agents read (shots, pictures, tokens).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPlan, type FilmPlan } from "./plan.js";
import { ledgers } from "./gate.js";
import { sceneMedia } from "./checks.js";

const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
type Credit = { file: string; kind: string; source: string; url?: string; license: string; note?: string; scene?: string };
type FairUse = { file: string; kind: string; video: string; title: string; channel: string; inS: number; seconds: number };
const HEX = /^#[0-9a-fA-F]{6}$/;
const mixHex = (a: string, b: string, t: number) => "#" + [0, 2, 4].map((i) => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * (1 - t) + parseInt(b.slice(1 + i, 3 + i), 16) * t).toString(16).padStart(2, "0")).join("");

/** The planner's shots as a storyboard (one shot per scene, its named subjects). */
export function boardOf(plan: FilmPlan, timed: { segments: Array<{ id: string; startS: number; endS: number }> }, lengthS: number, channel: string) {
  const segAt = (t: number) => timed.segments.find((s) => t >= s.startS && t < s.endS)?.id ?? timed.segments.at(-1)?.id ?? "seg";
  return {
    schemaVersion: 1 as const, id: "film-agent", scriptId: "film-agent", styleProfileId: channel, aspect: "16:9", durationS: lengthS,
    shots: plan.scenes.map((s, i) => ({ schemaVersion: 2 as const, id: s.id, scriptSegmentId: segAt(s.from), index: i, startS: s.from, endS: s.to, intent: s.idea, lineLink: "literal" as const, source: { kind: "query" as const, query: (s.seen || s.idea).slice(0, 200), mustBe: "any" as const }, camera: { type: "static" }, overlays: [], sfx: [], transitionIn: "cut" as const, ...(s.entities?.length ? { entities: s.entities.map((e) => ({ ...e, ...(s.year ? { year: s.year } : {}) })) } : {}) })),
    music: [], generatedAt: new Date().toISOString(),
  };
}

/** Every picture a scene draws, with its recorded source, as resolved media. */
export function resolutionOf(job: string, plan: FilmPlan) {
  const credits = ledgers<Credit>(job, "credits"), fair = ledgers<FairUse>(job, "fair-use");
  const media = plan.scenes.flatMap((s) => sceneMedia(job, s.id).filter((m) => /^(v|img)\//.test(m)).map((m) => {
    const raw = path.basename(m).replace(/\.\w+$/, "").replace(/_(cut|crop\w*|depth|mask)$/, "");
    const c = credits.find((x) => path.basename(x.file).replace(/\.\w+$/, "") === raw) ?? credits.find((x) => raw.includes(path.basename(x.file).replace(/\.\w+$/, "")));
    const f = fair.find((x) => x.file === m);
    const host = (() => { try { return c?.url ? new URL(c.url).hostname : ""; } catch { return ""; } })();
    const provider = /pexels/.test(host) ? "pexels" : /pixabay/.test(host) ? "pixabay" : /wikimedia|wikipedia/.test(host) ? "commons" : /youtube|youtu\.be/.test(host) ? "youtube" : /archive\.org/.test(host) ? "archive" : "web";
    return {
      shotId: s.id, role: "primary" as const, origin: f ? ("press" as const) : provider === "commons" || provider === "archive" ? ("archival" as const) : ("stock" as const),
      depicts: s.seen.slice(0, 120), ref: c?.url ?? m, provider, kind: /\.(mp4|mov|webm)$/i.test(m) ? ("video" as const) : ("image" as const),
      localPath: path.join(job, "public", m), publicPath: m, license: c?.license ?? "see LICENSES.md", attributionRequired: /cc[- ]?by|attribution/i.test(c?.license ?? ""),
      ...(c?.note || c?.source ? { attributionText: `${c?.note ?? ""} ${c?.source ?? ""}`.trim() } : {}), ...(c?.url ? { sourceUrl: c.url } : {}),
      ...(f ? { fairUse: { sourceTitle: f.title, channel: f.channel, atS: f.inS, usedS: f.seconds, reason: "short muted excerpt under commentary" } } : {}),
      aiGenerated: false as const, score: 1, query: s.seen.slice(0, 80),
    };
  }));
  return { schemaVersion: 1 as const, storyboardId: "film-agent", media, unresolved: [], stats: { library: 0, stock: media.filter((m) => m.origin === "stock").length, archival: media.filter((m) => m.origin === "archival").length, designed: 0 }, generatedAt: new Date().toISOString() };
}

/** The world's colours and type as design tokens (the thumbnail's renderer reads them). */
export function designOf(plan: FilmPlan, topic: string, channel: string) {
  const p = plan.palette ?? {};
  const primary = HEX.test(p.primary ?? "") ? p.primary! : "#2f6fb0", accent = HEX.test(p.accent ?? "") ? p.accent! : "#d8402f";
  const surface = HEX.test(p.surface ?? "") ? p.surface! : "#0b0f14", text = HEX.test(p.text ?? "") ? p.text! : "#f4f1ea";
  return {
    schemaVersion: 2 as const, id: "film-agent", channelId: channel, topic, concept: plan.world.slice(0, 400),
    palette: { primary, primarySoft: mixHex(primary, "#ffffff", 0.35), accent, accentDeep: mixHex(accent, "#000000", 0.35), surface, surfaceAlt: mixHex(surface, "#ffffff", 0.08), paper: "#efe9dc", marker: accent, text, textMuted: mixHex(text, surface, 0.4) },
    fonts: { display: plan.fonts?.display ?? "Archivo Black, sans-serif", body: plan.fonts?.body ?? "Inter, sans-serif" },
    texture: { grain: 0.12, vignette: 0.35 }, acts: [{ name: "film", tint: primary, tintStrength: 0.1, saturation: 1, contrast: 1.05 }], generatedAt: new Date().toISOString(),
  };
}

export interface AfterReport { referee?: { score: number; bar: number; pass: boolean; low: string[] }; viewer?: { verdict: string; summary: string; issues: Array<{ atS: number; what: string; severity: number }> }; judge?: { picked: number; fair: number; pass: boolean; tells: string[] }; packaging?: { thumbnail: string | null; title?: string }; usd: number; text: string }

export async function freshEyes(o: { root: string; job: string; channel: string; topic: string; lengthS: number; log?: (s: string) => void; skip?: Array<"viewer" | "judge" | "package"> }): Promise<AfterReport> {
  const log = o.log ?? (() => {});
  const plan = readPlan(o.job)!;
  const film = path.join(o.job, "film_16x9.mp4");
  if (!existsSync(film)) return { usd: 0, text: "no film_16x9.mp4 — fresh eyes skipped" };
  const agents = await import("@opumia/agents");
  const usd0 = agents.usageLedger().reduce((t, r) => t + r.usd, 0);
  const timed = jread<{ title?: string; durationS: number; segments: Array<{ id: string; startS: number; endS: number; text: string; words: Array<{ word: string; startS: number }> }> }>(path.join(o.job, "timed-script.json"), { durationS: 0, segments: [] });
  const words = timed.segments.flatMap((s) => s.words ?? []);
  const findings = existsSync(path.join(o.job, "FINDINGS.md")) ? readFileSync(path.join(o.job, "FINDINGS.md"), "utf8") : "";
  const data = path.join(o.root, "data"), reference = path.resolve(o.root, process.env.OPUMIA_REFERENCE_DIR ?? "Reference"), library = path.resolve(o.root, process.env.OPUMIA_LIBRARY_DIR ?? "Library");
  // the blind final-cut judge is off by default: on held-back channel films it called real stretches the imitation 45 %
  // of the time and ours 32 % (referee calibration, 2026-11-26) — no better than chance, so its verdict is not used
  const skip = new Set(o.skip ?? ["judge"]);
  const rep: AfterReport = { usd: 0, text: "" };

  const viewer = skip.has("viewer") ? null : (async () => {
    const { watchFile } = await import("@opumia/motion-engine");
    const v = await agents.qaAgent({ channel: o.channel, title: plan.title ?? o.topic, durationS: o.lengthS, qaText: findings || "(no measured findings)", shots: plan.scenes.map((s) => ({ id: s.id, startS: s.from, endS: s.to })), words, watch: (a, b) => watchFile({ video: film, fromS: a, toS: b, outDir: path.join(o.job, "watch", "viewer") }), memoryDir: path.join(data, "agents", "qa"), log: () => {} });
    rep.viewer = { verdict: v.verdict, summary: v.summary, issues: v.issues.map((x) => ({ atS: x.atS, what: x.what, severity: x.severity })) };
    writeFileSync(path.join(o.job, "qa.viewer.json"), JSON.stringify(v, null, 1));
  })().catch((e: Error) => log(`  viewer QA failed: ${e.message.slice(0, 160)}`));

  const judge = skip.has("judge") ? null : (async () => {
    const clips: Array<{ fromS: number; toS: number; said: string }> = [];
    for (let t = 0; t + 6 < timed.durationS; t += 8) clips.push({ fromS: t, toS: Math.min(timed.durationS, t + 8), said: words.filter((w) => w.startS >= t && w.startS < t + 8).map((w) => w.word).join(" ") });
    const fj = await agents.judgeClips({ data, reference, root: o.root, channel: o.channel as never, video: film, clips, workDir: path.join(o.job, "final-judge"), log: () => {} });
    const picked = fj.clips.filter((c) => c.picked).length / Math.max(1, fj.clips.length), fair = fj.calibration?.realPickedAsImitation ?? 1 / 3;
    rep.judge = { picked, fair, pass: picked <= fair + 0.2, tells: [...new Set(fj.clips.flatMap((c) => c.tells))].slice(0, 6) };
    writeFileSync(path.join(o.job, "final-judge.json"), JSON.stringify(fj, null, 1));
  })().catch((e: Error) => log(`  final-cut judge failed: ${e.message.slice(0, 160)}`));

  const pack = skip.has("package") ? null : (async () => {
    const { buildPublishingPackage } = await import("../publish.js");
    const r = await buildPublishingPackage({ jobDir: o.job, data, library, channel: o.channel, job: path.basename(o.job), facts: jread(path.join(o.job, "facts.json"), {}) as never, script: timed as never, design: designOf(plan, o.topic, o.channel) as never, resolution: resolutionOf(o.job, plan) as never, board: boardOf(plan, timed, o.lengthS, o.channel) as never, index: jread(path.join(data, "library-index.json"), {}) as never, publicDir: path.join(o.job, "public"), log: () => {} });
    rep.packaging = { thumbnail: r.thumbnailPath, title: jread<{ title?: string }>(path.join(o.job, "publish.json"), {}).title };
  })().catch((e: Error) => log(`  packaging failed: ${e.message.slice(0, 160)}`));

  const referee = (async () => {
    const { refereeConfig, refereeScore } = await import("../referee/score.js");
    if (!refereeConfig(data, o.channel)) return;
    const v = await refereeScore({ root: o.root, data, reference, channel: o.channel, video: film });
    rep.referee = { score: v.score, bar: v.bar, pass: v.pass, low: v.stretches.filter((s) => s.low).map((s) => `${s.from.toFixed(0)}–${s.to.toFixed(0)} s (${s.score})`) };
  })().catch((e: Error) => log(`  referee failed: ${e.message.slice(0, 160)}`));
  await Promise.all([viewer, judge, pack, referee]);
  rep.usd = agents.usageLedger().reduce((t, r) => t + r.usd, 0) - usd0;
  const lines: string[] = [];
  if (rep.viewer) lines.push(`Viewer QA: ${rep.viewer.verdict} — ${rep.viewer.summary}`, ...rep.viewer.issues.filter((x) => x.severity >= 5).map((x) => `- ${x.atS.toFixed(1)} s (severity ${x.severity}): ${x.what}`));
  if (rep.referee) lines.push(`Referee: ${rep.referee.score} against the channel (every held-back channel film ≥ ${rep.referee.bar}) — ${rep.referee.pass ? "reads like the channel" : "does NOT read like the channel yet"}`, ...rep.referee.low.map((x) => `- the referee's weakest moment: ${x} — below the channel's weakest tenth`));
  if (rep.judge) lines.push(`Final-cut judge: picked out as the imitation in ${Math.round(rep.judge.picked * 100)} % of stretches (a real stretch: ${Math.round(rep.judge.fair * 100)} %) — ${rep.judge.pass ? "passes" : "VETO"}${rep.judge.tells.length ? `; tells: ${rep.judge.tells.join("; ")}` : ""}`);
  if (rep.packaging) lines.push(`Package: "${rep.packaging.title ?? "?"}", thumbnail ${rep.packaging.thumbnail ? "made" : "not made"}`);
  rep.text = lines.join("\n");
  writeFileSync(path.join(o.job, "after.json"), JSON.stringify(rep, null, 1));
  log(`  fresh eyes: ${rep.text.split("\n").filter((l) => !l.startsWith("- ")).join(" | ")} ($${rep.usd.toFixed(2)})`);
  return rep;
}
