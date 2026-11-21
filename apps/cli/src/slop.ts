/**
 * Objective slop metrics: the same measurements run on a finished film and on the reference channel
 * (data/exemplars/<channel>/index.json). No model opinion — numbers a film either meets or misses.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RenderManifest, ResolutionReport, Storyboard, TimedScript, type SlopMetric } from "@opumia/contracts";
import { measureLook, measurePace, measureProsody, measureSound, r3 } from "@opumia/senses";
import type { ExemplarIndex } from "./exemplars.js";

const readJson = async <T>(f: string): Promise<T | null> => readFile(f, "utf8").then((t) => JSON.parse(t) as T, () => null);

export interface FilmFacts {
  job: string;
  primaries: string[];
  sfx: string[];
  music: string[];
}

export async function filmFacts(jobDir: string): Promise<FilmFacts | null> {
  const res = await readJson<unknown>(path.join(jobDir, "resolution.json"));
  const sb = await readJson<unknown>(path.join(jobDir, "storyboard.json"));
  if (!res || !sb) return null;
  const r = ResolutionReport.parse(res);
  const s = Storyboard.parse(sb);
  return { job: path.basename(jobDir), primaries: r.media.filter((m) => m.role === "primary" || m.role === "layer").map((m) => m.ref.split("#")[0]!.split("@")[0]!), sfx: s.shots.flatMap((x) => x.sfx.map((f) => f.assetId)), music: s.music.map((m) => m.assetId) };
}

export async function filmMetrics(jobDir: string, video: string, ex: ExemplarIndex | null, others: FilmFacts[] = []): Promise<SlopMetric[]> {
  const out: SlopMetric[] = [];
  const add = (id: string, label: string, value: number, target: string, pass: boolean) => out.push({ id, label, value: r3(value), target, pass });
  const b = ex?.looks.band;

  // --- Picture: brightness, colour, movement — against the channel's own films (p25 is the floor).
  const look = await measureLook(video, { fps: 4 });
  if (b) {
    add("luma", "Brightness", look.luma, `≥ ${b.luma.p25} (channel ${b.luma.p25}–${b.luma.p75})`, look.luma >= b.luma.p25 * 0.97);
    add("colourfulness", "Colourfulness", look.colourfulness, `≥ ${b.colourfulness.p25} (channel ${b.colourfulness.p25}–${b.colourfulness.p75})`, look.colourfulness >= b.colourfulness.p25 * 0.95);
    add("hue_spread", "Colour variety", look.hueSpread, `≥ ${b.hueSpread.p25}`, look.hueSpread >= b.hueSpread.p25 * 0.95);
    add("motion", "On-screen movement", look.motion * 100, `≥ ${r3(b.motion.p25 * 100)} (channel ${r3(b.motion.p25 * 100)}–${r3(b.motion.p75 * 100)})`, look.motion >= b.motion.p25 * 0.95);
    add("still_share", "Near-still time", look.stillShare, `≤ ${r3(Math.max(0.01, b.stillShare.p75 * 1.5))}`, look.stillShare <= Math.max(0.01, b.stillShare.p75 * 1.5));
    add("dark_share", "Very dark frames", look.darkShare, `≤ ${r3(Math.max(0.03, b.darkShare.p75 * 1.5))}`, look.darkShare <= Math.max(0.03, b.darkShare.p75 * 1.5));
  }

  // --- Edit: how many shots are plain footage with only a slow zoom, and how many carry designed treatment.
  const sbRaw = await readJson<unknown>(path.join(jobDir, "storyboard.json"));
  const mRaw = await readJson<unknown>(path.join(jobDir, "manifest.json"));
  if (sbRaw && mRaw) {
    const sb = Storyboard.parse(sbRaw);
    const m = RenderManifest.parse(mRaw);
    const designedShots = new Set(m.video.filter((l) => l.sourceKind === "designed" && !["captions", "atmosphere", "chapter_card"].includes(l.ref)).map((l) => l.shotId));
    const treated = sb.shots.filter((s) => designedShots.has(s.id)).length / Math.max(1, sb.shots.length);
    const slowZoom = sb.shots.filter((s) => !designedShots.has(s.id) && (s.camera.type === "ken_burns" || s.camera.type === "static")).length / Math.max(1, sb.shots.length);
    add("designed_share", "Shots with designed treatment", treated, "≥ 0.7 (the channel designs nearly every shot)", treated >= 0.7);
    add("slow_zoom_share", "Plain footage with only a slow zoom or static", slowZoom, "≤ 0.2", slowZoom <= 0.2);
  }

  // --- Reuse inside the film and against other films of the set.
  const me = await filmFacts(jobDir);
  if (me) {
    const dup = me.primaries.length - new Set(me.primaries).size;
    add("repeat_in_film", "Pictures used more than once in the film", dup, "0", dup === 0);
    for (const o of others.filter((x) => x.job !== me.job)) {
      const sharedPic = [...new Set(me.primaries)].filter((x) => o.primaries.includes(x)).length;
      const sharedSfx = [...new Set(me.sfx)].filter((x) => o.sfx.includes(x)).length;
      add(`shared_pictures:${o.job}`, `Pictures shared with ${o.job}`, sharedPic, "0", sharedPic === 0);
      add(`shared_sfx:${o.job}`, `Sound effects shared with ${o.job}`, sharedSfx / Math.max(1, new Set(me.sfx).size), "≤ 0.34 of the film's effects", sharedSfx / Math.max(1, new Set(me.sfx).size) <= 0.34);
      const sharedMusic = me.music.filter((x) => o.music.includes(x)).length;
      add(`shared_music:${o.job}`, `Music beds shared with ${o.job}`, sharedMusic, "0", sharedMusic === 0);
    }
  }

  // --- Voice: pace, pitch travel, dynamics and pauses against the reference narrator.
  const narr = path.join(jobDir, "narration.mp3");
  const tsRaw = await readJson<unknown>(path.join(jobDir, "timed-script.json"));
  const n = ex?.narrator;
  if (n && tsRaw) {
    const ts = TimedScript.parse(tsRaw);
    const pace = measurePace(ts.segments.flatMap((s) => s.words.map((w) => ({ word: w.word, start: w.startS, end: w.endS }))));
    add("voice_wpm", "Narration pace (wpm)", pace.wpm, `${n.wpm.p25}–${r3(n.wpm.p75 * 1.05)}`, pace.wpm >= n.wpm.p25 * 0.97 && pace.wpm <= n.wpm.p75 * 1.08);
    add("voice_pace_variety", "Pace variety between sentences", pace.sentenceWpmStd, `≥ ${r3(n.sentenceWpmStd * 0.7)}`, pace.sentenceWpmStd >= n.sentenceWpmStd * 0.7);
    const p = await measureProsody(narr).catch(() => null);
    if (p) {
      add("voice_pitch_travel", "Pitch travel (semitones)", p.f0RangeSt, `≥ ${n.prosody.f0RangeSt.p25}`, p.f0RangeSt >= n.prosody.f0RangeSt.p25 * 0.95);
      add("voice_melody", "Phrase melody (semitones)", p.melodySt, `≥ ${n.prosody.melodySt.p25}`, p.melodySt >= n.prosody.melodySt.p25 * 0.95);
      add("voice_dynamics", "Voice dynamics (dB)", p.energyStdDb, `≥ ${n.prosody.energyStdDb.p25}`, p.energyStdDb >= n.prosody.energyStdDb.p25 * 0.9);
    }
    // Pauses of ≥ 0.25 s between words (same definition as the reference narrator's word timings).
    if (n.wordGapPausesPerMin) {
      const w = ts.segments.flatMap((sg) => sg.words);
      let g = 0;
      for (let k = 0; k + 1 < w.length; k++) if (w[k + 1]!.startS - w[k]!.endS >= 0.25) g++;
      const perMin = (g / Math.max(1, ts.durationS)) * 60;
      add("voice_pauses", "Pauses per minute (≥ 0.25 s)", perMin, `≤ ${r3(Math.max(4, n.wordGapPausesPerMin.p75 * 1.3))} (narrator ${n.wordGapPausesPerMin.p25}–${n.wordGapPausesPerMin.p75})`, perMin <= Math.max(4, n.wordGapPausesPerMin.p75 * 1.3));
    }
    // Listen-back result, when the narration was verified.
    const rep = await readJson<{ wer: number | null; unresolved: string[]; pronunciation: Array<{ ok: boolean }> }>(path.join(jobDir, "narration.report.json"));
    if (rep) {
      add("voice_unresolved", "Narration lines with an unresolved word or pronunciation problem", rep.unresolved.length, "0", rep.unresolved.length === 0);
      if (rep.wer !== null) add("voice_wer", "Word error against the script", rep.wer, "≤ 0.01", rep.wer <= 0.01);
    }
  }

  // --- Sound effects: variety of character inside the film.
  const audioDir = path.join(jobDir, "audio");
  const sfxFiles = (await readdir(audioDir).catch(() => [] as string[])).filter((f) => f.startsWith("sfx_"));
  if (sfxFiles.length >= 3) {
    const fam = new Map<string, number>();
    for (const f of sfxFiles.slice(0, 24)) {
      const c = await measureSound(path.join(audioDir, f)).catch(() => null);
      if (c) fam.set(c.family, (fam.get(c.family) ?? 0) + 1);
    }
    const top = Math.max(...fam.values()) / Math.max(1, [...fam.values()].reduce((t, v) => t + v, 0));
    add("sfx_variety", "Share of the most-used sound family", top, "≤ 0.6", top <= 0.6);
  }
  return out;
}
