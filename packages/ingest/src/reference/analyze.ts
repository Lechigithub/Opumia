import { readdir } from "node:fs/promises";
import path from "node:path";
import { StyleProfile, type Stat } from "@opumia/contracts";
import { readCsv } from "../util/csv.js";
import { readJsonSafe, writeStableJson } from "../util/fs.js";
import { median, summarize } from "../util/stats.js";
import { CHANNELS, type ChannelConfig } from "./channels.js";
import { inspectReference, type RefVideo } from "./inspect.js";

interface Measures {
  cuts_min?: number;
  shot_med?: number;
  shot_cv?: number;
  face_share?: number;
  sat?: number;
  grey?: number;
  luma?: number;
  contrast?: number;
  motion?: number;
  still_share?: number;
  stock?: number;
  real?: number;
  designed?: number;
}

interface PerVideo {
  v: RefVideo;
  m: Measures;
  cutsFirst60s?: number;
  wpm?: number;
  sound?: Record<string, number>;
}

interface Pretrain {
  words?: Array<{ word: string; start: number; end: number }>;
  shots?: Array<{ t0: number; t1: number; f?: { faces?: number; sat?: number; grey?: number; luma?: number; contrast?: number } }>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function wpmOf(words: Array<{ start: number; end: number }> | undefined): number | undefined {
  if (!words || words.length < 50) return undefined;
  const span = words[words.length - 1]!.end - words[0]!.start;
  return span > 30 ? (words.length / span) * 60 : undefined;
}

/** Measures from Reference/.analysis/meta/<PFX>-<date>.json keyed by folder. */
async function loadMetaMeasures(refRoot: string, prefix: string): Promise<Map<string, { measures: Measures; chapters: number }>> {
  const dir = path.join(refRoot, ".analysis", "meta");
  const out = new Map<string, { measures: Measures; chapters: number }>();
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".json")).sort();
  for (const f of files) {
    const j = await readJsonSafe<{ folder?: string; measures?: Measures; chapters?: unknown[] }>(path.join(dir, f), 0);
    if (j.ok && j.value.folder && j.value.measures) out.set(j.value.folder, { measures: j.value.measures, chapters: j.value.chapters?.length ?? 0 });
  }
  return out;
}

async function analyzeStandard(refRoot: string, ch: ChannelConfig, vs: RefVideo[]): Promise<{ rows: PerVideo[]; sources: string[] }> {
  const meta = ch.metaPrefix ? await loadMetaMeasures(refRoot, ch.metaPrefix) : new Map();
  const rows: PerVideo[] = [];
  for (const v of vs) {
    const row: PerVideo = { v, m: {} };
    const mm = meta.get(v.relDir);
    if (mm) row.m = mm.measures;
    // screen.json (Logically Answered) carries the same measures shape; use it as a fallback.
    if (!mm) {
      const sc = await readJsonSafe<{ measures?: Measures }>(path.join(v.dir, "screen.json"), 0);
      if (sc.ok && sc.value.measures) row.m = sc.value.measures;
    }
    if (v.shotFile) {
      const p = await readJsonSafe<Pretrain>(v.shotFile, 0);
      if (p.ok) {
        const shots = p.value.shots ?? [];
        row.wpm = wpmOf(p.value.words);
        if (shots.length) {
          row.cutsFirst60s = shots.filter((s) => s.t0 > 0 && s.t0 < 60).length;
          // Fallback pacing/look when .analysis meta is missing.
          if (row.m.cuts_min === undefined && v.durationS) row.m.cuts_min = (shots.length - 1) / (v.durationS / 60);
          if (row.m.shot_med === undefined) row.m.shot_med = median(shots.map((s) => s.t1 - s.t0)) ?? undefined;
          const avg = (k: "sat" | "grey" | "luma" | "contrast") => {
            const xs = shots.map((s) => s.f?.[k]).filter((x): x is number => typeof x === "number");
            return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
          };
          row.m.sat ??= avg("sat");
          row.m.grey ??= avg("grey");
          row.m.luma ??= avg("luma");
          row.m.contrast ??= avg("contrast");
          if (row.m.face_share === undefined) row.m.face_share = shots.filter((s) => (s.f?.faces ?? 0) > 0).length / shots.length;
        }
      }
    }
    if (v.soundFile) {
      const s = await readJsonSafe<{ measures?: Record<string, number> }>(v.soundFile, 0);
      if (s.ok && s.value.measures) row.sound = s.value.measures;
    }
    rows.push(row);
  }
  const sources = [`${ch.dir}/*/<id>.info.json`, `${ch.dir}/*/pretrain.json`, `${ch.dir}/*/sound.json`];
  if (meta.size) sources.push(`.analysis/meta/${ch.metaPrefix}-*.json`);
  if (ch.id === "logically-answered") sources.push(`${ch.dir}/*/screen.json`);
  return { rows, sources };
}

async function analyzeBigCompany(refRoot: string, ch: ChannelConfig, vs: RefVideo[]): Promise<{ rows: PerVideo[]; sources: string[] }> {
  const ad = path.join(refRoot, ch.dir, "Analysis Data");
  const stats = new Map((await readCsv(path.join(ad, "editing_stats.csv"))).map((r) => [r.rank ?? "", r]));
  const rows: PerVideo[] = [];
  for (const v of vs) {
    const row: PerVideo = { v, m: {} };
    const st = v.filmNo ? stats.get(v.filmNo) : undefined;
    const n = (x?: string) => (x !== undefined && x !== "" && Number.isFinite(Number(x)) ? Number(x) : undefined);
    if (st) {
      row.m.cuts_min = n(st.cuts_per_min);
      row.m.shot_med = n(st.median_shot);
      row.cutsFirst60s = n(st.cuts_first_60s);
      const lufs = n(st.loudness_LUFS);
      if (lufs !== undefined) row.sound = { integrated_lufs: lufs };
    }
    if (v.shotFile) {
      const f = await readJsonSafe<{ shots?: Array<{ faces?: number; sat?: number; grey?: number; luma?: number; contrast?: number }> }>(v.shotFile, 0);
      const shots = f.ok ? (f.value.shots ?? []) : [];
      if (shots.length) {
        const avg = (k: "sat" | "grey" | "luma" | "contrast") => {
          const xs = shots.map((s) => s[k]).filter((x): x is number => typeof x === "number");
          return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
        };
        row.m.sat = avg("sat");
        row.m.grey = avg("grey");
        row.m.luma = avg("luma");
        row.m.contrast = avg("contrast");
        row.m.face_share = shots.filter((s) => (s.faces ?? 0) > 0).length / shots.length;
      }
    }
    if (v.transcriptFile?.endsWith(".json")) {
      const w = await readJsonSafe<{ words?: Array<{ start: number; end: number }> }>(v.transcriptFile, 0);
      if (w.ok) row.wpm = wpmOf(w.value.words);
    }
    rows.push(row);
  }
  return {
    rows,
    sources: [`${ch.dir}/video_index.csv`, `${ch.dir}/Videos/*/*.info.json`, `${ch.dir}/Analysis Data/editing_stats.csv`, `${ch.dir}/Analysis Data/feats/*_feats.json`, `${ch.dir}/Analysis Data/words/*_words.json`],
  };
}

async function techniquesFor(libraryRoot: string, ch: ChannelConfig): Promise<Record<string, number>> {
  const j = await readJsonSafe<Record<string, { moments?: unknown[] }>>(path.join(libraryRoot, "moments", ch.dir, "index.json"), 0);
  if (!j.ok) return {};
  return Object.fromEntries(
    Object.entries(j.value)
      .map(([k, v]) => [k, v.moments?.length ?? 0] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

const pct = (s: Stat | null) => (s ? `${Math.round(s.p50 * 100)}%` : "n/a");

function directives(p: Omit<StyleProfile, "directives">): string[] {
  const d: string[] = [];
  const { pacing, narration, visualMix, audio, look, format } = p;
  if (pacing.cutsPerMin) d.push(`Pacing: target ${r2(pacing.cutsPerMin.p25)}–${r2(pacing.cutsPerMin.p75)} cuts/min (median ${r2(pacing.cutsPerMin.p50)}).`);
  if (pacing.shotMedianS) d.push(`Median shot length ≈ ${r2(pacing.shotMedianS.p50)} s; hold designed graphics longer than stock B-roll.`);
  if (pacing.cutsFirst60s) d.push(`Cold open: ~${Math.round(pacing.cutsFirst60s.p50)} cuts in the first 60 s.`);
  if (narration.wordsPerMin) d.push(`Narration pace ≈ ${Math.round(narration.wordsPerMin.p50)} wpm (ElevenLabs speed/stability tuned to match).`);
  if (visualMix.stock || visualMix.designed)
    d.push(`Visual mix (screen share, median): stock ${pct(visualMix.stock)}, real/archival ${pct(visualMix.real)}, designed ${pct(visualMix.designed)}, stills ${pct(visualMix.still)}.`);
  if (look.saturation && look.greyShare) d.push(`Grade: saturation ≈ ${r2(look.saturation.p50)}, greyscale share ≈ ${pct(look.greyShare)}, luma ≈ ${look.luma ? r2(look.luma.p50) : "n/a"}.`);
  if (look.faceShare) d.push(`Faces on screen in ≈ ${pct(look.faceShare)} of shots.`);
  if (audio.integratedLufs) d.push(`Master to ≈ ${r2(audio.integratedLufs.p50)} LUFS integrated.`);
  if (audio.voiceOverBedDb) d.push(`Voice sits ≈ ${r2(audio.voiceOverBedDb.p50)} dB over the music bed; ducking ≈ ${audio.duckingDb ? r2(audio.duckingDb.p50) : "n/a"} dB.`);
  if (audio.strongHitsPerMin) d.push(`SFX hits ≈ ${r2(audio.strongHitsPerMin.p50)}/min; music cue changes ≈ ${audio.cueChangesPer10Min ? r2(audio.cueChangesPer10Min.p50) : "n/a"} per 10 min; drops ≈ ${audio.musicDropsPer10Min ? r2(audio.musicDropsPer10Min.p50) : "n/a"} per 10 min.`);
  if (format.durationMin) d.push(`Long-form runtime ${r2(format.durationMin.p25)}–${r2(format.durationMin.p75)} min.`);
  const top = Object.entries(p.techniques).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  if (top.length) d.push(`Signature designed moments: ${top.join(", ")}.`);
  d.push("All picture comes from Library/stock/archival/designed sources — never AI-generated video.");
  return d;
}

export async function analyzeStyles(opts: { referenceRoot: string; libraryRoot: string; dataDir: string; log?: (s: string) => void }) {
  const log = opts.log ?? (() => {});
  const { status, videos } = await inspectReference(opts.referenceRoot);
  const outDir = path.join(opts.dataDir, "style-profiles");
  const results: Array<{ id: string; path: string; write: string; videos: number }> = [];

  for (const ch of CHANNELS) {
    const vs = videos.get(ch.id) ?? [];
    const { rows, sources } = ch.layout === "standard" ? await analyzeStandard(opts.referenceRoot, ch, vs) : await analyzeBigCompany(opts.referenceRoot, ch, vs);
    const col = (f: (r: PerVideo) => number | undefined | null) => summarize(rows.map(f));
    const snd = (k: string) => col((r) => r.sound?.[k]);
    const titles = vs.map((v) => v.title).sort();
    const corpus = status.channels[ch.id]!;
    const techniques = await techniquesFor(opts.libraryRoot, ch);

    const base: Omit<StyleProfile, "directives"> = {
      schemaVersion: 1,
      id: ch.id,
      displayName: ch.displayName,
      draft: true,
      generatedAt: new Date().toISOString(),
      corpus,
      format: {
        primaryAspect: "16:9",
        durationMin: summarize(vs.map((v) => (v.durationS ? v.durationS / 60 : null))),
        fps: [...new Set(vs.map((v) => v.fps).filter((x): x is number => typeof x === "number"))].sort((a, b) => a - b),
        resolution: [...new Set(vs.filter((v) => v.width && v.height).map((v) => `${v.width}x${v.height}`))].sort(),
      },
      pacing: {
        cutsPerMin: col((r) => r.m.cuts_min),
        shotMedianS: col((r) => r.m.shot_med),
        shotCv: col((r) => r.m.shot_cv),
        cutsFirst60s: col((r) => r.cutsFirst60s),
      },
      look: {
        saturation: col((r) => r.m.sat),
        greyShare: col((r) => r.m.grey),
        luma: col((r) => r.m.luma),
        contrast: col((r) => r.m.contrast),
        faceShare: col((r) => r.m.face_share),
        motion: col((r) => r.m.motion),
      },
      visualMix: {
        stock: col((r) => r.m.stock),
        real: col((r) => r.m.real),
        designed: col((r) => r.m.designed),
        still: col((r) => r.m.still_share),
      },
      audio: {
        integratedLufs: snd("integrated_lufs"),
        voiceOverBedDb: snd("voice_over_bed_db"),
        duckingDb: snd("ducking_db"),
        speechShare: snd("speech_share"),
        strongHitsPerMin: snd("strong_hits_per_min"),
        musicDropsPer10Min: snd("music_drops_per_10min"),
        cueChangesPer10Min: snd("cue_changes_per_10min"),
      },
      narration: {
        wordsPerMin: col((r) => r.wpm),
        chaptersPerVideo: summarize(vs.map((v) => v.chapters || null)),
      },
      techniques,
      titles: {
        examples: titles.slice(0, 12),
        chars: summarize(titles.map((t) => t.length)),
        questionShare: titles.length ? r2(titles.filter((t) => /[?？]/.test(t)).length / titles.length) : null,
        numberShare: titles.length ? r2(titles.filter((t) => /\d/.test(t)).length / titles.length) : null,
      },
      audience: { views: summarize(vs.map((v) => v.views)) },
      sources: [...sources, ...(Object.keys(techniques).length ? [`Library/moments/${ch.dir}/index.json`] : [])],
    };
    const profile: StyleProfile = { ...base, directives: directives(base) };
    const outPath = path.join(outDir, `${ch.id}.json`);
    const write = await writeStableJson(outPath, StyleProfile, profile, [opts.referenceRoot, opts.libraryRoot]);
    results.push({ id: ch.id, path: outPath, write, videos: rows.length });
    log(`  ${ch.displayName.padEnd(20)} ${String(rows.length).padStart(3)} videos  ${write}`);
  }
  return { results, status };
}

