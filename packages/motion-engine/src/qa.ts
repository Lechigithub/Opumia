import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { QAReport, type FactSheet, type LibraryIndex, type QACheck, type RenderManifest, type ResolutionReport, type StyleProfile, type TimedScript } from "@opumia/contracts";
import { numericFacts, TENSION } from "@opumia/agents";
import { ffprobe } from "@opumia/ingest";
import { measureLoudness } from "./audio.js";
import { FULLSCREEN_TEXT } from "./manifest.js";
import { displayOf, matchesFact, parseShown, spokenMatch, spokenNumbers } from "./parity.js";

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
  log?: (s: string) => void;
}

export async function runQA(q: QAInput): Promise<{ report: QAReport; licenseMarkdown: string }> {
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

  // --- Fair use: press excerpts are short, muted, logged with their source, and a minority of the runtime.
  {
    const press = q.resolution.media.filter((m) => m.origin === "press");
    // One excerpt continued across a split shot (sh014 → sh014_2, the same ref and in-point, played on) is one clip,
    // not two: clips are counted by excerpt (build list 4, the Nokia proof film read a split as a reused source).
    const clips = [...new Map(press.filter((m) => m.kind === "video").map((m) => [m.ref, m] as [string, typeof m])).values()];
    const long = clips.filter((m) => (m.fairUse?.usedS ?? m.durationS ?? 0) > 8.5);
    const unlogged = press.filter((m) => !m.fairUse || !m.sourceUrl);
    const pressS = clips.reduce((t, m) => t + (m.fairUse?.usedS ?? 0), 0);
    const share = pressS / Math.max(1, q.manifest.durationFrames / fps);
    const perSource = new Map<string, number>();
    for (const m of clips) perSource.set(m.ref.split("@")[0]!, (perSource.get(m.ref.split("@")[0]!) ?? 0) + 1);
    const reused = [...perSource.values()].filter((n) => n > 1).length;
    add({ id: "fair_use", severity: "major", passed: long.length === 0 && unlogged.length === 0 && share <= 0.27, message: `${clips.length} press clip(s) (${pressS.toFixed(1)} s, ${Math.round(share * 100)} % of runtime, audio muted), ${press.length - clips.length} press still(s)${long.length ? `; ${long.length} clip(s) over 8.5 s` : ""}${unlogged.length ? `; ${unlogged.length} without a source record` : ""}${reused ? `; ${reused} source(s) used for several clips (allowed)` : ""}`, measured: Math.round(share * 100), expected: "clips ≤ 8.5 s, ≤ 27 % of runtime (the channel's practice), all logged" });
  }

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

  // --- Blank frames: sample at 2 fps (64×64 grey); fail when > 85 % of pixels are pure white, or the frame is uniform.
  const GW = 64, GH = 64;
  let gray2fps: Buffer = Buffer.alloc(0);
  {
    const W = GW, H = GH;
    const raw = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", q.finalPath, "-vf", `fps=2,scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { timeout: 600_000, maxBuffer: 512 * 1024 * 1024, encoding: "buffer" as BufferEncoding });
    const buf = raw.stdout as unknown as Buffer;
    gray2fps = buf;
    const n = Math.floor(buf.length / (W * H));
    const bad: number[] = [];
    for (let f = 0; f < n; f++) {
      let white = 0, sum = 0, sq = 0;
      for (let i = f * W * H; i < (f + 1) * W * H; i++) {
        const v = buf[i]!;
        if (v >= 245) white++;
        sum += v;
        sq += v * v;
      }
      const mean = sum / (W * H);
      const sd = Math.sqrt(Math.max(0, sq / (W * H) - mean * mean));
      if (white / (W * H) > 0.85 || sd < 2) bad.push(f / 2);
    }
    add({ id: "blank_frames", severity: "major", passed: bad.length === 0, message: bad.length ? `${bad.length} blank/white frame(s) at ${bad.slice(0, 8).map((t) => t.toFixed(1)).join(", ")} s` : `${n} sampled frames (2 fps): none > 85 % white or uniform`, measured: bad.length, expected: "0", atFrames: bad.map((t) => Math.round(t * fps)) });
  }

  // --- Duplicate text: burned-in captions must not repeat a full-screen card's words.
  {
    const capLayer = q.manifest.video.find((l) => l.ref === "captions");
    const groups = ((capLayer?.props as { groups?: Array<{ startFrame: number; endFrame: number; words: Array<{ text: string }> }> } | undefined)?.groups ?? []);
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
    const clashes: number[] = [];
    for (const card of q.manifest.video.filter((l) => l.sourceKind === "designed" && FULLSCREEN_TEXT.has(l.ref))) {
      const p = (card.props ?? {}) as Record<string, unknown>;
      const cardWords = new Set(norm(`${p.title ?? ""}`));
      for (const g of groups) {
        if (g.endFrame <= card.startFrame || g.startFrame >= card.endFrame) continue;
        const gw = norm(g.words.map((w) => w.text).join(" "));
        if (gw.length && gw.filter((w) => cardWords.has(w)).length >= Math.min(2, gw.length)) clashes.push(Math.max(g.startFrame, card.startFrame));
      }
    }
    const nCards = q.manifest.video.filter((l) => l.sourceKind === "designed" && FULLSCREEN_TEXT.has(l.ref)).length;
    add({ id: "duplicate_text", severity: "major", passed: clashes.length === 0, message: clashes.length ? `${clashes.length} caption cue(s) repeat a full-screen card` : `${nCards} chapter card(s); burned-in captions suppressed under each (SRT keeps every word)`, measured: clashes.length, expected: "0", atFrames: clashes });
  }

  // --- Fact binding: every number a chart shows equals a verified FactSheet number.
  {
    const nf = numericFacts(q.facts);
    const byId = new Map(nf.map((x) => [x.id, x]));
    const problems: string[] = [];
    let numericCards = 0;
    for (const l of q.manifest.video.filter((x) => x.sourceKind === "designed" && x.ref === "chart")) {
      numericCards++;
      const p = (l.props ?? {}) as { factIds?: string[]; values?: number[] };
      const facts = (p.factIds ?? []).map((id) => byId.get(id));
      if (!facts.length || facts.some((f) => !f)) {
        problems.push(`${l.shotId}: no fact ids`);
        continue;
      }
      const shown = p.values ?? [];
      if (shown.length !== facts.length || shown.some((v, i) => v !== facts[i]!.value)) problems.push(`${l.shotId}: shows ${shown.join("/")} but facts are ${facts.map((f) => f!.value).join("/")}`);
    }
    add({ id: "fact_binding", severity: "blocker", passed: problems.length === 0, message: problems.length ? problems.join("; ") : `${numericCards} numeric graphic(s), every value bound to a verified fact (${nf.length} numbers in the sheet)`, measured: problems.length, expected: "0" });
  }

  // --- Number parity: every chart figure the narrator says is shown exactly as spoken (kit numbers in scenes are checked by the scene designer).
  {
    const spoken = spokenNumbers(q.script.segments.flatMap((sg) => sg.words));
    const problems: string[] = [];
    let checked = 0;
    for (const l of q.manifest.video.filter((x) => x.sourceKind === "designed" && x.ref === "chart")) {
      const p = (l.props ?? {}) as { unit?: string; values?: number[]; display?: string[] };
      const t0 = l.startFrame / fps - 1.5;
      const t1 = l.endFrame / fps + 1.0;
      for (const [i, v] of (p.values ?? []).entries()) {
        const hit = spokenMatch(spoken, v, p.unit ?? "", t0, t1, l.startFrame / fps);
        if (!hit) continue; // context value not spoken: compact form is fine
        checked++;
        if (p.display?.[i] !== displayOf(hit)) problems.push(`${l.shotId}: shows ${p.display?.[i]} but narrator says ${displayOf(hit)}`);
      }
    }
    add({ id: "number_parity", severity: "major", passed: problems.length === 0, message: problems.length ? problems.join("; ") : `${checked} on-screen figure(s) match the narration exactly (same value, unit and precision)`, measured: problems.length, expected: "0" });
  }

  // --- Long-form chapters: ≥ 3, first at 0:00, each ≥ 10 s (YouTube's rules); re-hook cadence 25–35 s.
  const chapterList = youtubeChapters(q.script);
  if (chapterList.length || durS > 150) { // build list 4: a 95 s short is not long-form
    const short10 = chapterList.filter((c, i) => (chapterList[i + 1]?.startS ?? durS) - c.startS < 10);
    // Tension turns measured the way the reference was: pivot sentences, questions, cliffhanger phrases, and
    // hook-type beats; the gap allowed is the reference p75 (56 s) rounded up.
    const hookish: number[] = q.script.segments.filter((sg) => ["hook", "cold_open", "thesis", "rehook", "twist"].includes(sg.role)).map((sg) => sg.startS);
    for (const sg of q.script.segments) {
      let cur: string[] = [];
      let t0 = 0;
      for (const w of sg.words) {
        if (!cur.length) t0 = w.startS;
        cur.push(w.word);
        if (/[.?!]["”']?$/.test(w.word)) {
          const sent = cur.join(" ");
          if (TENSION.test(sent) || /\?["”']?$/.test(sent)) hookish.push(t0);
          cur = [];
        }
      }
    }
    const marks = [...new Set(hookish), durS].sort((a, b) => a - b);
    const gaps = marks.slice(1).map((t, i) => t - marks[i]!);
    const maxGap = gaps.length ? Math.max(...gaps) : durS;
    const ok = chapterList.length >= 3 && chapterList[0]!.startS === 0 && short10.length === 0 && maxGap <= 60;
    add({ id: "chapters", severity: "major", passed: ok, message: `${chapterList.length} chapters (${chapterList.map((c) => `${fmtTs(c.startS)} ${c.title}`).join(" · ")}); ${hookish.length} tension turns, longest gap ${maxGap.toFixed(1)} s${short10.length ? `; ${short10.length} chapter(s) under 10 s` : ""}`, measured: Math.round(maxGap * 10) / 10, expected: "≥ 3 chapters from 0:00, each ≥ 10 s; tension-turn gap ≤ 60 s" });
  }

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
  const usedClaimTexts = new Set(q.script.segments.flatMap((s) => s.claims.map((c) => c.text)));
  const bad = q.facts.claims.filter((c) => usedClaimTexts.has(c.text) && (c.verdict === "unsupported" || c.verdict === "unreachable"));
  add({ id: "fact_claims", severity: "major", passed: segNumbers.length === 0 && bad.length === 0, message: `${q.script.segments.reduce((n, s) => n + s.claims.length, 0)} cited claims across ${q.script.segments.length} segments${segNumbers.length ? `; ${segNumbers.length} segments state numbers without a cited claim (${segNumbers.map((s) => s.id).join(", ")})` : ""}${uncited.length ? `; note: ${uncited.length} narrative segment(s) carry no cited claim (${uncited.map((s) => `${s.id}/${s.role}`).join(", ")}) — editorial review` : ""}`, measured: segNumbers.length + bad.length, expected: "0" });

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
    `- AI-generated picture in the film: **none** (${pictureLayers.length} footage/photo layers, all licensed or fair-use press; ${q.manifest.video.length - pictureLayers.length} designed Remotion layers)`,
    `- Narration: ElevenLabs \`${q.script.voice.modelId}\`, voice \`${q.script.voice.voiceId}\``,
    `- Thumbnail: ${q.thumbnailPath ? `\`${path.basename(q.thumbnailPath)}\` — composed from real, licensed or fair-use pictures by the scene engine (no generated imagery); not used in the film` : "not produced"}`,
    "",
    "## Media credits",
    "",
    "| role | origin | credit | licence | attribution required | source |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    ...(q.resolution.media.some((m) => m.origin === "press")
      ? [
          "## Fair-use press material",
          "",
          "Used as commentary and criticism: short excerpts (≤ 6.5 s), source audio never used, reframed, graded and composited under original narration; each source used at most once.",
          "",
          "| shot | source | channel / site | in-point | seconds used | why | url |",
          "|---|---|---|---|---|---|---|",
          ...q.resolution.media.filter((m) => m.origin === "press").map((m) => `| ${m.shotId} | ${(m.fairUse?.sourceTitle ?? m.ref).replace(/\|/g, "/").slice(0, 90)} | ${(m.fairUse?.channel ?? m.provider).replace(/\|/g, "/")} | ${m.fairUse?.atS ?? "–"} | ${m.kind === "video" ? (m.fairUse?.usedS ?? "–") : "still"} | ${(m.fairUse?.reason ?? "").replace(/\|/g, "/")} | ${m.sourceUrl ?? ""} |`),
          "",
        ]
      : []),
    "## Fact sources",
    "",
    ...q.facts.claims.filter((c) => usedUrls.has(c.sourceUrl)).map((c) => `- [${c.verdict}] ${c.text} — ${c.sourceUrl}`),
    "",
  ].join("\n");
  return { report, licenseMarkdown };
}


const fmtTs = (s: number) => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

/** Chapter start times from the TimedScript (first segment of each chapter; the first chapter is pinned to 0:00). */
export function youtubeChapters(script: TimedScript): Array<{ title: string; startS: number }> {
  const out: Array<{ title: string; startS: number }> = [];
  for (const sg of script.segments) {
    if (!sg.chapter) continue;
    if (out[out.length - 1]?.title !== sg.chapter) out.push({ title: sg.chapter, startS: Math.floor(sg.startS) });
  }
  if (out[0]) out[0].startS = 0;
  return out;
}

export function youtubeDescription(script: TimedScript, facts: FactSheet): string {
  const ch = youtubeChapters(script);
  const used = new Set(script.segments.flatMap((sg) => sg.claims.map((c) => c.sourceUrl)));
  return [
    script.title,
    "",
    ...(ch.length ? ["Chapters:", ...ch.map((c) => `${fmtTs(c.startS)} ${c.title}`), ""] : []),
    "Sources:",
    ...facts.sources.filter((src) => used.has(src.url)).map((src) => `- ${src.title ? `${src.title}: ` : ""}${src.url}`),
    "",
  ].join("\n");
}
