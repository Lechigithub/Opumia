/**
 * Senses for the moving film (build list C11, C12): agents watch a low-resolution clip of a stretch of the film with
 * its sound, and listen to the mix — instead of judging three still frames per shot.
 *
 *  watchClip   renders frames [from, to) of the manifest at a reduced scale (muted Remotion render), muxes the
 *              matching slice of the pre-master mix, and returns the clip, a strip of evenly spaced frames, and
 *              the measured motion of the stretch (senses measureLook) — the clip is something a person can play.
 *  listen      measures a stretch of the mix from its stems: loudness, voice over bed (dB, while speaking), the bed
 *              level in the pauses, the quietest floor, sound hits on the bed stem (onsets well over its local level)
 *              and where they fall against the cuts, music drop-outs, and silent gaps.
 * Both cache in out/<job>/watch/ (the pre-master stems are made once per manifest).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { FilmDesignSystem, RenderManifest } from "@opumia/contracts";
import { measureLook, pcm, run } from "@opumia/senses";
import { premixStems } from "./audio.js";
import { GL, serveUrlFor, type Look } from "./render.js";

const keyOf = (m: RenderManifest) => createHash("sha1").update(JSON.stringify(m)).digest("hex").slice(0, 12);

/** The stems for this exact manifest (made once). */
export async function stemsFor(m: RenderManifest, jobDir: string): Promise<{ mix: string; voice: string; bed: string }> {
  const dir = path.join(jobDir, "watch", `stems-${keyOf(m)}`);
  const out = { mix: path.join(dir, "premix.wav"), voice: path.join(dir, "stem-voice.wav"), bed: path.join(dir, "stem-bed.wav") };
  if (existsSync(out.mix) && existsSync(out.voice) && existsSync(out.bed)) return out;
  await mkdir(dir, { recursive: true });
  return premixStems(m, dir);
}

export interface Clip { file: string; strip: string; fromS: number; toS: number; frames: string[]; motion: { motion: number; stillShare: number; cutsPerMin: number; colourfulness: number } | null }

export async function watchClip(o: { manifest: RenderManifest; look: Look; design?: FilmDesignSystem; publicDir: string; jobDir: string; fromS: number; toS: number; scale?: number; stripFrames?: number; log?: (s: string) => void }): Promise<Clip> {
  const m = o.manifest;
  const fps = m.fps;
  const from = Math.max(0, Math.floor(o.fromS * fps));
  const to = Math.min(m.durationFrames - 1, Math.ceil(o.toS * fps) - 1);
  if (to <= from) throw new Error(`empty range ${o.fromS}–${o.toS} s`);
  const dir = path.join(o.jobDir, "watch");
  await mkdir(dir, { recursive: true });
  const tag = `${keyOf(m)}-${from}-${to}`;
  const silent = path.join(dir, `clip-${tag}.silent.mp4`);
  const file = path.join(dir, `clip-${tag}.mp4`);
  const strip = path.join(dir, `clip-${tag}.strip.jpg`);
  if (!existsSync(file)) {
    const url = await serveUrlFor(o.publicDir, o.log ?? (() => {}), false);
    const inputProps = { manifest: m, look: o.look, ...(o.design ? { design: o.design } : {}) };
    const composition = await selectComposition({ serveUrl: url, id: "Documentary", inputProps });
    await renderMedia({ chromiumOptions: GL, composition, serveUrl: url, codec: "h264", crf: 26, pixelFormat: "yuv420p", muted: true, frameRange: [from, to], scale: o.scale ?? 1 / 3, outputLocation: silent, inputProps, timeoutInMilliseconds: 180_000 });
    const stems = await stemsFor(m, o.jobDir);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", silent, "-ss", (from / fps).toFixed(3), "-t", ((to + 1 - from) / fps).toFixed(3), "-i", stems.mix, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", file]);
  }
  const n = o.stripFrames ?? 8;
  const len = (to + 1 - from) / fps;
  if (!existsSync(strip)) {
    const step = len / n;
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `fps=${(1 / step).toFixed(4)},scale=320:-2,tile=${Math.min(n, 4)}x${Math.ceil(n / 4)}`, "-frames:v", "1", strip]);
  }
  const look = await measureLook(file).catch(() => null);
  return {
    file, strip, fromS: from / fps, toS: (to + 1) / fps,
    frames: Array.from({ length: n }, (_, i) => `${((from / fps) + (len / n) * (i + 0.5)).toFixed(1)} s`),
    motion: look ? { motion: look.motion, stillShare: look.stillShare, cutsPerMin: look.cutsPerMin, colourfulness: look.colourfulness } : null,
  };
}

export interface Listening {
  fromS: number;
  toS: number;
  /** integrated loudness of the stretch (LUFS, pre-master — relative, the master is normalised later) */
  lufs: number;
  voiceOverBedDb: number;
  bedInPausesDb: number;
  floorBelowSpeechDb: number;
  hits: Array<{ t: number; overDb: number; onCut: boolean }>;
  hitsPerMin: number;
  hitsOnCut: number;
  musicDrops: Array<[number, number]>;
  silentGaps: Array<[number, number]>;
  notes: string[];
}

const db = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -120);

function envelope(x: Float32Array, sr: number, win = 0.1): number[] {
  const n = Math.floor(sr * win);
  const out: number[] = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += x[j]! * x[j]!;
    out.push(db(Math.sqrt(s / n)));
  }
  return out;
}

const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]! : -120;
};

/** Listen to a stretch of the mix from its stems. Cut times (seconds) let hits be checked against the picture. */
export async function listen(o: { manifest: RenderManifest; jobDir: string; fromS: number; toS: number; cutsS?: number[]; reference?: { voiceOverBedDb?: { p10: number; median: number; p90: number }; hitsPerMin?: { p10: number; median: number; p90: number } } }): Promise<Listening> {
  const stems = await stemsFor(o.manifest, o.jobDir);
  const sr = 16000;
  const t = Math.max(0.5, o.toS - o.fromS);
  const [v, b] = await Promise.all([pcm(stems.voice, { ss: o.fromS, t, sr }), pcm(stems.bed, { ss: o.fromS, t, sr })]);
  const ve = envelope(v, sr), be = envelope(b, sr);
  const speechLevel = pctl(ve, 0.9);
  const speaking = ve.map((x) => x > speechLevel - 18);
  const vob = pctl(ve.filter((_, i) => speaking[i]), 0.5) - pctl(be.filter((_, i) => speaking[i]), 0.5);
  const pausesBed = be.filter((_, i) => !speaking[i]);
  const mixEnv = ve.map((x, i) => db(Math.sqrt(10 ** (x / 10) + 10 ** ((be[i] ?? -120) / 10))));
  // hits: a 100 ms bed frame ≥ 9 dB over the bed's median of the previous second
  const hits: Listening["hits"] = [];
  for (let i = 10; i < be.length; i++) {
    const base = pctl(be.slice(i - 10, i), 0.5);
    const over = be[i]! - base;
    if (over >= 9 && be[i]! > speechLevel - 24 && (!hits.length || i / 10 - (hits.at(-1)!.t - o.fromS) > 0.6)) {
      const at = o.fromS + i / 10;
      hits.push({ t: Math.round(at * 100) / 100, overDb: Math.round(over * 10) / 10, onCut: (o.cutsS ?? []).some((c) => Math.abs(c - at) <= 0.2) });
    }
  }
  // music drop-outs: the bed falls ≥ 10 dB under its running level for ≥ 0.8 s
  const drops: Array<[number, number]> = [];
  const gaps: Array<[number, number]> = [];
  const bedMed = pctl(be, 0.5);
  let ds = -1, gs = -1;
  for (let i = 0; i <= be.length; i++) {
    const low = i < be.length && be[i]! < bedMed - 10;
    if (low && ds < 0) ds = i;
    if (!low && ds >= 0) { if (i - ds >= 8) drops.push([o.fromS + ds / 10, o.fromS + i / 10]); ds = -1; }
    const silent = i < be.length && mixEnv[i]! < speechLevel - 40;
    if (silent && gs < 0) gs = i;
    if (!silent && gs >= 0) { if (i - gs >= 4) gaps.push([o.fromS + gs / 10, o.fromS + i / 10]); gs = -1; }
  }
  const lufsOut = await run("ffmpeg", ["-hide_banner", "-nostats", "-ss", o.fromS.toFixed(2), "-t", t.toFixed(2), "-i", stems.mix, "-af", "ebur128", "-f", "null", "-"]).catch(() => null);
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec((lufsOut?.stderr ?? "").slice((lufsOut?.stderr ?? "").lastIndexOf("Summary:")))?.[1] ?? NaN);
  const hpm = (hits.length / t) * 60;
  const notes: string[] = [];
  const ref = o.reference;
  if (ref?.voiceOverBedDb && vob < ref.voiceOverBedDb.p10) notes.push(`the bed is loud under the voice (voice ${vob.toFixed(1)} dB over it; the channel ${ref.voiceOverBedDb.p10}–${ref.voiceOverBedDb.p90} dB)`);
  if (ref?.voiceOverBedDb && vob > ref.voiceOverBedDb.p90) notes.push(`the bed is buried under the voice (voice ${vob.toFixed(1)} dB over it; the channel ${ref.voiceOverBedDb.p10}–${ref.voiceOverBedDb.p90} dB)`);
  if (ref?.hitsPerMin && t >= 20 && hpm > ref.hitsPerMin.p90 * 1.3) notes.push(`${hpm.toFixed(1)} hits a minute — busier than the channel's busiest films (${ref.hitsPerMin.p90})`);
  if (gaps.length) notes.push(`${gaps.length} silent gap(s) (${gaps.map(([a, b2]) => `${a.toFixed(1)}–${b2.toFixed(1)} s`).join(", ")}) — the track falls to near silence`);
  return {
    fromS: o.fromS, toS: o.toS, lufs, voiceOverBedDb: Math.round(vob * 10) / 10, bedInPausesDb: Math.round((pctl(pausesBed, 0.5) - speechLevel) * 10) / 10,
    floorBelowSpeechDb: Math.round((speechLevel - pctl(mixEnv, 0.01)) * 10) / 10,
    hits, hitsPerMin: Math.round(hpm * 10) / 10, hitsOnCut: hits.filter((h) => h.onCut).length, musicDrops: drops, silentGaps: gaps, notes,
  };
}

/** Plain text of a listening, for an agent. */
export function listeningText(l: Listening): string {
  return [
    `${l.fromS.toFixed(1)}–${l.toS.toFixed(1)} s: loudness ${Number.isFinite(l.lufs) ? l.lufs.toFixed(1) : "?"} LUFS (pre-master), voice ${l.voiceOverBedDb} dB over the bed while speaking, bed in the pauses ${l.bedInPausesDb} dB vs speech, floor ${l.floorBelowSpeechDb} dB below speech.`,
    `hits: ${l.hits.length} (${l.hitsPerMin}/min), ${l.hitsOnCut} on a cut${l.hits.length ? ` — ${l.hits.map((h) => `${h.t.toFixed(1)} s +${h.overDb} dB${h.onCut ? " (cut)" : ""}`).join(", ")}` : ""}`,
    l.musicDrops.length ? `music drops out: ${l.musicDrops.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`).join(", ")}` : "no music drop-out",
    ...l.notes.map((n) => `! ${n}`),
  ].join("\n");
}

export async function writeListening(file: string, l: Listening) {
  await writeFile(file, JSON.stringify(l, null, 1) + "\n");
  return readFile(file, "utf8");
}

/**
 * Watch a stretch of a finished film file (build list B10): a strip of evenly spaced frames from the mp4 itself,
 * its loudness, near-silences, and the cuts in it (scene changes) — what a viewer gets, after mastering.
 */
export async function watchFile(o: { video: string; fromS: number; toS: number; outDir: string; stripFrames?: number }): Promise<{ strip: string; text: string }> {
  await mkdir(o.outDir, { recursive: true });
  const t = Math.max(0.5, o.toS - o.fromS);
  const n = o.stripFrames ?? 8;
  const key = createHash("sha1").update(`${path.resolve(o.video)}|${o.fromS}|${o.toS}|${n}`).digest("hex").slice(0, 12);
  const strip = path.join(o.outDir, `film_${key}.jpg`);
  if (!existsSync(strip)) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", o.fromS.toFixed(2), "-t", t.toFixed(2), "-i", o.video, "-vf", `fps=${(n / t).toFixed(4)},scale=320:-2,tile=4x${Math.ceil(n / 4)}`, "-frames:v", "1", strip]);
  const lo = await run("ffmpeg", ["-hide_banner", "-nostats", "-ss", o.fromS.toFixed(2), "-t", t.toFixed(2), "-i", o.video, "-af", "ebur128=peak=true,silencedetect=n=-45dB:d=0.4", "-f", "null", "-"]).catch(() => null);
  const err = lo?.stderr ?? "";
  const sum = err.slice(err.lastIndexOf("Summary:"));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1] ?? NaN);
  const lra = Number(/LRA:\s+(-?[\d.]+) LU/.exec(sum)?.[1] ?? NaN);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(sum)?.[1] ?? NaN);
  const silences = [...err.matchAll(/silence_start: (-?[\d.]+)[\s\S]*?silence_end: (-?[\d.]+)/g)].map((m) => [o.fromS + Number(m[1]), o.fromS + Number(m[2])] as [number, number]);
  const sc = await run("ffmpeg", ["-hide_banner", "-nostats", "-ss", o.fromS.toFixed(2), "-t", t.toFixed(2), "-i", o.video, "-vf", "scale=160:-2,select='gt(scene,0.32)',showinfo", "-an", "-f", "null", "-"]).catch(() => null);
  const cuts = [...(sc?.stderr ?? "").matchAll(/pts_time:([\d.]+)/g)].map((m) => o.fromS + Number(m[1]));
  const step = t / n;
  const text = [
    `${o.fromS.toFixed(1)}–${o.toS.toFixed(1)} s of the finished film; frames left to right, top to bottom at ${Array.from({ length: n }, (_, k) => (o.fromS + step * (k + 0.5)).toFixed(1)).join(", ")} s.`,
    `sound: ${Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : "loudness ?"}, range ${Number.isFinite(lra) ? lra.toFixed(1) : "?"} LU, peak ${Number.isFinite(peak) ? peak.toFixed(1) : "?"} dBFS${silences.length ? `; near-silence ${silences.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`).join(", ")}` : ""}.`,
    `picture: ${cuts.length} cut(s) detected${cuts.length ? ` at ${cuts.map((c) => c.toFixed(1)).join(", ")} s` : ""}.`,
  ].join("\n");
  return { strip, text };
}
