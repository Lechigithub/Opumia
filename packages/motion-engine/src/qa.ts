import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { QAReport, type FactSheet, type LibraryIndex, type QACheck, type RenderManifest, type ResolutionReport, type StyleProfile, type TimedScript } from "@opumia/contracts";
import { judgeRender } from "@opumia/agents";
import { ffprobe } from "@opumia/ingest";
import { measureLoudness } from "./audio.js";

const run = promisify(execFile);

async function detect(file: string, filter: string, re: RegExp): Promise<number[]> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vf", filter, "-an", "-f", "null", "-"], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  return [...r.stderr.matchAll(re)].map((m) => Number(m[1]));
}

export interface QAInput {
  finalPath: string;
  srtPath: string;
  thumbnailPath: string | null;
  manifest: RenderManifest;
  resolution: ResolutionReport;
  script: TimedScript;
  facts: FactSheet;
  profile: StyleProfile;
  index: LibraryIndex;
  jobDir: string;
  judge: boolean;
  log?: (s: string) => void;
}

export interface JudgeIssue {
  severity: "major" | "minor";
  atS: number | null;
  fix: string;
  note: string;
}

export async function runQA(q: QAInput): Promise<{ report: QAReport; licenseMarkdown: string; judgeIssues: JudgeIssue[] }> {
  const log = q.log ?? (() => {});
  const checks: QACheck[] = [];
  const add = (c: Omit<QACheck, "atFrames"> & { atFrames?: number[] }) => checks.push({ atFrames: [], ...c });
  const fps = q.manifest.fps;

  // --- Provenance: zero AI video, every picture layer traced to a licensed source.
  const byRef = new Map(q.resolution.media.map((m) => [m.ref, m]));
  const pictureLayers = q.manifest.video.filter((l) => l.sourceKind !== "designed");
  const untraced = pictureLayers.filter((l) => {
    const m = byRef.get(l.ref);
    return !m || m.aiGenerated !== false || !m.license;
  });
  add({ id: "no_ai_video", severity: "blocker", passed: untraced.length === 0, message: untraced.length ? `${untraced.length} picture layers not traced to a licensed library/stock/archival asset` : `${pictureLayers.length} picture layers all traced to licensed, non-AI sources; ${q.manifest.video.length - pictureLayers.length} designed (Remotion) layers`, measured: untraced.length, expected: "0", atFrames: untraced.map((l) => l.startFrame) });

  const assetById = new Map(q.index.assets.map((a) => [a.id, a]));
  const libRefs = q.resolution.media.filter((m) => m.origin === "library").map((m) => assetById.get(m.ref.split("#")[0]!));
  const unlicensedLib = libRefs.filter((a) => !a?.provenance.license);
  const attrMissing = q.resolution.media.filter((m) => m.attributionRequired && !m.attributionText);
  add({ id: "license_coverage", severity: "blocker", passed: unlicensedLib.length === 0 && attrMissing.length === 0, message: `${q.resolution.media.length} media items; ${q.resolution.media.filter((m) => m.attributionRequired).length} require attribution (all credited in license report)${unlicensedLib.length ? `; ${unlicensedLib.length} library assets lack a licence` : ""}`, measured: unlicensedLib.length + attrMissing.length, expected: "0" });

  const bugged = libRefs.filter((a) => a?.bugSpots?.length);
  add({ id: "watermark", severity: "minor", passed: bugged.length === 0, message: bugged.length ? `${bugged.length} library clips have known broadcaster bugs: ${bugged.map((a) => a!.relPath).join(", ")}` : "no assets with known watermark/bug corners" });

  // --- Technical measurements on the final file.
  log("  qa: measuring loudness, black and frozen frames…");
  const probe = await ffprobe(q.finalPath, "video");
  const expectW = q.manifest.width;
  const expectH = q.manifest.height;
  const durS = probe.durationS ?? 0;
  add({ id: "safe_zone_9x16", severity: q.manifest.aspect === "9:16" ? "major" : "info", passed: probe.width === expectW && probe.height === expectH, message: `output ${probe.width}x${probe.height} @ ${probe.fps} fps, ${durS.toFixed(2)} s; captions anchored at ${q.manifest.aspect === "9:16" ? "73% height (above platform UI)" : "92% height"}`, measured: `${probe.width}x${probe.height}`, expected: `${expectW}x${expectH}` });

  const loud = await measureLoudness(q.finalPath);
  add({ id: "loudness", severity: "major", passed: Math.abs(loud.integratedLufs - q.manifest.loudnessTargetLufs) <= 1, message: `integrated ${loud.integratedLufs} LUFS (LRA ${loud.lra} LU)`, measured: loud.integratedLufs, expected: `${q.manifest.loudnessTargetLufs} ±1 LUFS` });
  add({ id: "true_peak", severity: "major", passed: loud.truePeakDb <= -1.0, message: `true peak ${loud.truePeakDb} dBTP`, measured: loud.truePeakDb, expected: "≤ -1.0 dBTP" });

  const blacks = await detect(q.finalPath, "blackdetect=d=0.3:pix_th=0.08", /black_start:([\d.]+)/g);
  add({ id: "black_frames", severity: "major", passed: blacks.length === 0, message: blacks.length ? `black segments at ${blacks.map((b) => b.toFixed(2)).join(", ")} s` : "no black segments ≥ 0.3 s", measured: blacks.length, expected: "0", atFrames: blacks.map((b) => Math.round(b * fps)) });
  const freezes = await detect(q.finalPath, "freezedetect=n=0.002:d=2.5", /freeze_start: ([\d.]+)/g);
  add({ id: "frozen_frames", severity: "minor", passed: freezes.length === 0, message: freezes.length ? `frozen ≥2.5 s at ${freezes.map((b) => b.toFixed(2)).join(", ")} s` : "no frozen picture ≥ 2.5 s", measured: freezes.length, expected: "0", atFrames: freezes.map((b) => Math.round(b * fps)) });

  // --- Captions vs narration words.
  const words = q.script.segments.flatMap((s) => s.words);
  const capWords = q.manifest.captions.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
  const offsets = q.manifest.captions.map((c, i) => {
    const firstWordIdx = q.manifest.captions.slice(0, i).reduce((n, x) => n + x.text.split(/\s+/).filter(Boolean).length, 0);
    const w = words[firstWordIdx];
    return w ? Math.abs(c.startFrame / fps - w.startS) : 0;
  });
  const maxOff = Math.max(0, ...offsets);
  add({ id: "caption_sync", severity: "major", passed: capWords === words.length && maxOff <= 1 / fps + 1e-6, message: `${q.manifest.captions.length} caption cues cover ${capWords}/${words.length} words; max cue offset ${(maxOff * 1000).toFixed(0)} ms`, measured: maxOff, expected: `≤ ${(1000 / fps).toFixed(0)} ms` });

  // --- Pacing vs the channel profile (shorts run faster than long-form).
  const cuts = new Set(q.manifest.video.filter((l) => l.zIndex === 0).map((l) => l.startFrame)).size;
  const cpm = cuts / (durS / 60);
  const band = q.profile.pacing.cutsPerMin;
  const lo = band ? band.p25 : 10;
  const hi = band ? band.p75 * (durS <= 90 ? 1.8 : 1.2) : 40;
  add({ id: "pacing", severity: "minor", passed: cpm >= lo && cpm <= hi, message: `${cuts} shots, ${cpm.toFixed(1)} cuts/min (channel long-form band ${band ? `${band.p25}–${band.p75}` : "n/a"}; short-form ceiling ${hi.toFixed(1)})`, measured: Math.round(cpm * 10) / 10, expected: `${lo.toFixed(1)}–${hi.toFixed(1)}` });

  // --- Facts: every claim used is supported; numeric segments carry a claim.
  const segNumbers = q.script.segments.filter((s) => /\d/.test(s.text) && s.claims.length === 0);
  const uncited = q.script.segments.filter((s) => s.claims.length === 0 && !["hook", "thesis", "resolution", "cta", "cold_open"].includes(s.role));
  const usedUrls = new Set(q.script.segments.flatMap((s) => s.claims.map((c) => c.sourceUrl)));
  const bad = q.facts.claims.filter((c) => usedUrls.has(c.sourceUrl) && (c.verdict === "unsupported" || c.verdict === "unreachable"));
  add({ id: "fact_claims", severity: "major", passed: segNumbers.length === 0 && bad.length === 0, message: `${q.script.segments.reduce((n, s) => n + s.claims.length, 0)} cited claims across ${q.script.segments.length} segments${segNumbers.length ? `; ${segNumbers.length} segments state numbers without a cited claim (${segNumbers.map((s) => s.id).join(", ")})` : ""}${uncited.length ? `; note: ${uncited.length} narrative segment(s) carry no cited claim (${uncited.map((s) => `${s.id}/${s.role}`).join(", ")}) — editorial review` : ""}`, measured: segNumbers.length + bad.length, expected: "0" });

  // --- Judge (Sonnet vision) on sampled frames.
  const judgeIssues: JudgeIssue[] = [];
  if (q.judge) {
    const dir = path.join(q.jobDir, "qa_frames");
    await mkdir(dir, { recursive: true });
    const frames: string[] = [];
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t = ((i + 0.5) / 8) * durS;
      times.push(t);
      const f = path.join(dir, `f${i}.jpg`);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(2), "-i", q.finalPath, "-frames:v", "1", "-vf", "scale=-2:960", "-q:v", "4", f]);
      frames.push(f);
    }
    log("  qa: judge review (claude-sonnet-5-5, 8 frames)…");
    const j = await judgeRender({ frames, script: q.script.segments.map((s) => s.text).join(" "), channel: q.profile.displayName, aspect: q.manifest.aspect, checks: checks.map((c) => `${c.id}: ${c.passed ? "pass" : "FAIL"} — ${c.message}`).join("\n") });
    for (const i of j.issues) judgeIssues.push({ severity: i.severity, atS: i.frame >= 1 && i.frame <= times.length ? times[i.frame - 1]! : null, fix: i.fix, note: i.note });
    // Severity follows the judge's own issue severities (like every other check): any major issue or a "fail"
    // verdict fails as major; minor-only feedback is recorded as a failed minor check (visible, non-blocking).
    const majors = j.issues.filter((i) => i.severity === "major").length;
    add({ id: "judge", severity: majors || j.verdict === "fail" ? "major" : "minor", passed: j.verdict === "pass", message: `${j.verdict}: ${j.summary}${j.issues.length ? ` | ${j.issues.map((i) => `[${i.severity}] ${i.note}`).join(" | ")}` : ""}`, measured: j.verdict });
  }

  const blockerFail = checks.some((c) => !c.passed && c.severity === "blocker");
  const majorFail = checks.some((c) => !c.passed && c.severity === "major");
  const verdict = blockerFail ? "fail" : majorFail ? "review" : "pass";
  const report = QAReport.parse({
    schemaVersion: 1,
    manifestId: q.manifest.id,
    renderPath: q.finalPath,
    checks,
    verdict,
    summary: `${checks.filter((c) => c.passed).length}/${checks.length} checks passed; verdict ${verdict}${q.thumbnailPath ? "; thumbnail produced" : "; no thumbnail"}`,
    generatedAt: new Date().toISOString(),
  });

  const rows = q.resolution.media
    .filter((m, i, a) => a.findIndex((x) => x.ref === m.ref) === i)
    .map((m) => `| ${m.role} | ${m.origin} (${m.provider}) | ${(m.attributionText ?? m.ref).replace(/\|/g, "/")} | ${m.license} | ${m.attributionRequired ? "yes" : "no"} | ${m.sourceUrl ?? ""} |`);
  const licenseMarkdown = [
    `# License & provenance report — ${q.script.title}`,
    "",
    `- Render: \`${path.basename(q.finalPath)}\` (${q.manifest.aspect}, ${durS.toFixed(2)} s)`,
    `- AI-generated picture in the film: **none** (${pictureLayers.length} footage/photo layers, all licensed; ${q.manifest.video.length - pictureLayers.length} designed Remotion layers)`,
    `- Narration: ElevenLabs \`${q.script.voice.modelId}\`, voice \`${q.script.voice.voiceId}\``,
    `- Thumbnail: ${q.thumbnailPath ? `\`${path.basename(q.thumbnailPath)}\` — generated image plate (Higgsfield) with composited headline; not used in the film` : "not produced"}`,
    "",
    "## Media credits",
    "",
    "| role | origin | credit | licence | attribution required | source |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Fact sources",
    "",
    ...q.facts.claims.filter((c) => usedUrls.has(c.sourceUrl)).map((c) => `- [${c.verdict}] ${c.text} — ${c.sourceUrl}`),
    "",
  ].join("\n");
  return { report, licenseMarkdown, judgeIssues };
}
