/**
 * Ears with taste (owner, 2026-11-23: "a judge and agents that create films should see and listen and have taste").
 * Claude cannot listen, so the platform listens with two local audio models (tools/audio/embed_audio.py: AudioSet AST +
 * wav2vec2; nothing downloaded) and two trained heads, the same way the picture taste works:
 *
 *  - VOICE (humanness): does a stretch of narration sound like a human narrator telling a story, or synthetic? Real:
 *    narration of all five reference channels where the voice sits ≥ 18 dB over the music (their own sound analysis),
 *    so it is near-clean speech of several real narrators — the head learns human delivery, not one man's voice. Ours:
 *    our narrations. Never a measure of pace (owner).
 *  - MIX: does a stretch of the soundtrack (voice, music, effects together) sound like the channel's? Real:
 *    MagnatesMedia's films; ours: our finished films.
 *
 * Each head reports its held-out AUC and where the real channel's own stretches score (p10, median), so a score is read
 * against the channel. Models: data/sound-taste/<channel>-<kind>.json.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { embedPython } from "@opumia/ingest";
import type { ChannelId } from "@opumia/contracts";
import { CHANNELS } from "@opumia/ingest";

export const AUDIO_DIM = 1792;
export type SoundKind = "voice" | "mix" | "bed";
/** "bed" (build list 6, G3): the soundtrack WITHOUT the voice — every window separated by demucs htdemucs (two stems,
 *  the same separation as Reference sound.json) and only the music and effects embedded. The "mix" head scored our
 *  synthetic narrator as much as the mix (stem swaps: our voice over Ponzi's bed −0.13, Ponzi's voice over ours −0.15),
 *  so it rewarded a bed loud enough to hide him. Voice is judged by the "voice" head, the level under it by
 *  bed-level.ts (the channel's 37-film band); "bed" judges the music and effects alone. */
export interface AudioItem { file: string; t: number; dur: number }
export interface SoundTasteModel { kind: SoundKind; channel: string; w: number[]; b: number; auc: number; trained: { real: number; ours: number }; calibration: { real: { p10: number; median: number }; ours: { median: number } }; builtAt: string }

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Embed audio windows (memoised by file, time, length and mtime in data/.cache/audio-embed/). */
export async function embedAudio(o: { root: string; data: string; items: AudioItem[]; log?: (s: string) => void }): Promise<Array<Float32Array | null>> {
  const cacheDir = path.join(o.data, ".cache", "audio-embed");
  await mkdir(cacheDir, { recursive: true });
  const key = (it: AudioItem) => createHash("sha1").update(`v2|${it.file}|${it.t.toFixed(2)}|${it.dur}|${existsSync(it.file) ? statSync(it.file).mtimeMs : 0}`).digest("hex");
  const out: Array<Float32Array | null> = new Array(o.items.length).fill(null);
  const todo: number[] = [];
  for (const [i, it] of o.items.entries()) {
    const f = path.join(cacheDir, `${key(it)}.f32`);
    if (existsSync(f)) {
      const b = await readFile(f);
      out[i] = b.length ? new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice() : null;
    } else todo.push(i);
  }
  if (todo.length) {
    const tmp = path.join(cacheDir, `batch-${process.pid}-${Date.now()}`);
    await new Promise<void>((res, rej) => {
      const p = spawn(embedPython(), ["-I", path.join(o.root, "tools/audio/embed_audio.py"), "--out", tmp], { stdio: ["pipe", "ignore", "pipe"] });
      p.stderr.on("data", (d: Buffer) => { const s = d.toString().trim(); if (/^\d+\/\d+$/.test(s)) o.log?.(`    ears: ${s}`); });
      p.on("error", rej);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error(`embed_audio exited ${c}`))));
      p.stdin.end(todo.map((i) => JSON.stringify(o.items[i])).join("\n") + "\n");
    });
    const f16 = await readFile(`${tmp}.f16`);
    const ok = await readFile(`${tmp}.ok`);
    for (const [k, i] of todo.entries()) {
      let v: Float32Array | null = null;
      if (ok[k]) {
        v = new Float32Array(AUDIO_DIM);
        for (let d = 0; d < AUDIO_DIM; d++) {
          const h = f16[(k * AUDIO_DIM + d) * 2]! | (f16[(k * AUDIO_DIM + d) * 2 + 1]! << 8);
          const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
          v[d] = e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
        }
      }
      out[i] = v;
      await writeFile(path.join(cacheDir, `${key(o.items[i]!)}.f32`), v ? Buffer.from(v.buffer) : Buffer.alloc(0));
    }
  }
  return out;
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]! : 0; };

function fit(X: Float32Array[], y: number[], iters = 300, lambda = 2e-3): { w: number[]; b: number } {
  const n = X.length, D = AUDIO_DIM;
  const pos = y.filter((v) => v === 1).length;
  const wp = n / (2 * Math.max(1, pos)), wn = n / (2 * Math.max(1, n - pos));
  const w = new Float64Array(D), vW = new Float64Array(D);
  let b = 0, vB = 0;
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(D);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i]!;
      let z = b;
      for (let d = 0; d < D; d++) z += w[d]! * x[d]!;
      const e = (sigmoid(z) - y[i]!) * (y[i] ? wp : wn);
      for (let d = 0; d < D; d++) g[d]! += e * x[d]!;
      gb += e;
    }
    for (let d = 0; d < D; d++) { vW[d] = 0.9 * vW[d]! - 2 * (g[d]! / n + lambda * w[d]!); w[d]! += vW[d]!; }
    vB = 0.9 * vB - 2 * (gb / n);
    b += vB;
  }
  return { w: [...w], b };
}
const score = (m: { w: number[]; b: number }, x: Float32Array) => { let z = m.b; for (let d = 0; d < AUDIO_DIM; d++) z += m.w[d]! * x[d]!; return sigmoid(z); };
function auc(s: number[], y: number[]) {
  const p = s.map((v, i) => ({ v, y: y[i]! })).sort((a, b) => a.v - b.v);
  let r = 0, np = 0, nn = 0;
  p.forEach((q, i) => { if (q.y) { r += i + 1; np++; } else nn++; });
  return np && nn ? (r - (np * (np + 1)) / 2) / (np * nn) : 0.5;
}

/** Real narration windows (voice ≥ 18 dB over the music) from all reference channels, and the channel's own mix windows. */
function realWindows(reference: string, kind: SoundKind, channel: string, n: number): Array<AudioItem & { group: string }> {
  const out: Array<AudioItem & { group: string }> = [];
  const dirs = kind === "voice" ? CHANNELS.map((c) => c.dir) : [CHANNELS.find((c) => c.id === channel)?.dir ?? ""]; // mix and bed: the channel itself
  for (const cd of dirs) {
    const root = path.join(reference, cd);
    if (!cd || !existsSync(root)) continue;
    const films = readdirSync(root).filter((f) => existsSync(path.join(root, f, "sound.json"))).sort().slice(0, 14);
    for (const f of films) {
      const mp4 = readdirSync(path.join(root, f)).find((x) => x.endsWith(".mp4"));
      if (!mp4) continue;
      const video = path.join(root, f, mp4);
      const snd = JSON.parse(readFileSync(path.join(root, f, "sound.json"), "utf8")) as { voice_db_100ms?: number[]; bed_db_100ms?: number[]; minutes?: number };
      const v = snd.voice_db_100ms ?? [], b = snd.bed_db_100ms ?? [];
      const len = kind === "voice" ? 4 : 8;
      const per = kind === "voice" ? Math.ceil(n / (dirs.length * 6)) : Math.ceil(n / films.length);
      let got = 0;
      for (let i = Math.floor(v.length * 0.05); i + len * 10 < v.length * 0.95 && got < per; i += 37) {
        if (kind === "voice") {
          let clean = 0;
          for (let k = i; k < i + len * 10; k++) if ((v[k] ?? -90) - (b[k] ?? -90) >= 18 && (v[k] ?? -90) > -35) clean++;
          if (clean < len * 10 * 0.85) continue;
        }
        out.push({ file: video, t: i / 10, dur: len, group: `${cd}/${f}` });
        got++;
        i += 120;
      }
    }
  }
  return out.slice(0, n);
}
function ourWindows(root: string, kind: SoundKind, n: number): Array<AudioItem & { group: string }> {
  const outDir = path.join(root, "out");
  const out: Array<AudioItem & { group: string }> = [];
  for (const j of readdirSync(outDir).filter((x) => !x.startsWith("_") && existsSync(path.join(outDir, x, "timing.json")) || existsSync(path.join(outDir, x, "narration.mp3")))) {
    const dir = path.join(outDir, j);
    if (!statSync(dir).isDirectory()) continue;
    const file = kind === "voice" ? path.join(dir, "narration.mp3") : readdirSync(dir).filter((f) => /_(16x9|9x16)\.mp4$/.test(f)).map((f) => path.join(dir, f))[0];
    if (!file || !existsSync(file)) continue;
    const len = kind === "voice" ? 4 : 8;
    for (let t = 1; t < (kind === "voice" ? 80 : 85); t += kind === "voice" ? 9 : 14) out.push({ file, t, dur: len, group: j });
  }
  return out.slice(0, n);
}

/** The music-and-effects stem of each window (demucs, memoised in data/.cache/beds/). */
export async function separateBeds(o: { root: string; data: string; items: AudioItem[]; log?: (s: string) => void }): Promise<Array<AudioItem | null>> {
  const { execFile } = await import("node:child_process");
  const { embedPython } = await import("@opumia/ingest");
  const dir = path.join(o.data, ".cache", "beds");
  await mkdir(dir, { recursive: true });
  const key = (it: AudioItem) => createHash("sha1").update(`${it.file}|${it.t}|${it.dur}|${statSync(it.file).mtimeMs}`).digest("hex").slice(0, 16);
  const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26, timeout: 60 * 60_000 }, (e) => (e ? rej(e) : res())));
  const todo = o.items.filter((it) => existsSync(it.file) && !existsSync(path.join(dir, "htdemucs", key(it), "no_vocals.wav")));
  for (const it of todo) await run("ffmpeg", ["-v", "error", "-y", "-ss", String(it.t), "-t", String(it.dur), "-i", it.file, "-ac", "2", "-ar", "44100", path.join(dir, `${key(it)}.wav`)]).catch(() => {});
  for (let i = 0; i < todo.length; i += 24) {
    const batch = todo.slice(i, i + 24).map((it) => path.join(dir, `${key(it)}.wav`)).filter((f) => existsSync(f));
    if (!batch.length) continue;
    o.log?.(`  separating beds ${i + batch.length}/${todo.length}`);
    await run(embedPython(), ["-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs", "--shifts", "0", "--overlap", "0.1", "-o", dir, ...batch]).catch((e: Error) => o.log?.(`  ! demucs: ${e.message.slice(0, 120)}`));
  }
  return o.items.map((it) => { if (!existsSync(it.file)) return null; const f = path.join(dir, "htdemucs", key(it), "no_vocals.wav"); return existsSync(f) ? { file: f, t: 0, dur: it.dur } : null; });
}

/** Train a head (real vs ours), held out by film. */
export async function trainSoundTaste(o: { root: string; data: string; reference: string; channel: ChannelId; kind: SoundKind; log?: (s: string) => void }): Promise<SoundTasteModel> {
  const real = realWindows(o.reference, o.kind, o.channel, o.kind === "voice" ? 200 : o.kind === "bed" ? 200 : 160);
  const ours = ourWindows(o.root, o.kind, 220);
  o.log?.(`  ears (${o.kind}): ${real.length} real windows, ${ours.length} of ours — listening…`);
  const items = [...real, ...ours];
  const sepd = o.kind === "bed" ? await separateBeds({ root: o.root, data: o.data, items, ...(o.log ? { log: o.log } : {}) }) : null;
  const embedItems = sepd ? items.map((it, i) => sepd[i] ?? { ...it, file: "/nonexistent" }) : items;
  const vecs = await embedAudio({ root: o.root, data: o.data, items: embedItems.filter((x) => existsSync(x.file)), ...(o.log ? { log: o.log } : {}) }).then((v) => { const out: Array<Float32Array | null> = []; let k = 0; for (const x of embedItems) out.push(existsSync(x.file) ? v[k++] ?? null : null); return out; });
  const rows = items.map((it, i) => ({ it, v: vecs[i], y: i < real.length ? 1 : 0 })).filter((r): r is { it: (typeof items)[number]; v: Float32Array; y: number } => Boolean(r.v));
  const held = (g: string) => parseInt(createHash("sha1").update(g).digest("hex").slice(0, 4), 16) % 4 === 0;
  const tr = rows.filter((r) => !held(r.it.group)), te = rows.filter((r) => held(r.it.group));
  const m = fit(tr.map((r) => r.v), tr.map((r) => r.y));
  const sTe = te.map((r) => score(m, r.v));
  const a = auc(sTe, te.map((r) => r.y));
  const realS = te.filter((r) => r.y === 1).map((r) => score(m, r.v));
  const oursS = te.filter((r) => r.y === 0).map((r) => score(m, r.v));
  const model: SoundTasteModel = { kind: o.kind, channel: o.channel, w: m.w, b: m.b, auc: Math.round(a * 1000) / 1000, trained: { real: rows.filter((r) => r.y).length, ours: rows.filter((r) => !r.y).length }, calibration: { real: { p10: Math.round(pct(realS, 0.1) * 1000) / 1000, median: Math.round(pct(realS, 0.5) * 1000) / 1000 }, ours: { median: Math.round(pct(oursS, 0.5) * 1000) / 1000 } }, builtAt: new Date().toISOString() };
  const f = path.join(o.data, "sound-taste", `${o.channel}-${o.kind}.json`);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify(model) + "\n");
  await rename(f + ".tmp", f);
  return model;
}

export async function loadSoundTaste(data: string, channel: string, kind: SoundKind): Promise<SoundTasteModel | null> {
  return readFile(path.join(data, "sound-taste", `${channel}-${kind}.json`), "utf8").then((t) => JSON.parse(t) as SoundTasteModel, () => null);
}

/** Score windows of our sound: 0–1, read against the real channel's held-out p10 / median. */
export async function scoreSoundTaste(o: { root: string; data: string; channel: string; kind: SoundKind; items: AudioItem[] }): Promise<{ scores: number[]; median: number; realP10: number; realMedian: number; below: boolean } | null> {
  const m = await loadSoundTaste(o.data, o.channel, o.kind);
  if (!m || !o.items.length) return null;
  const sepd = o.kind === "bed" ? await separateBeds({ root: o.root, data: o.data, items: o.items }) : null;
  const its = sepd ? sepd.filter((x): x is AudioItem => Boolean(x)) : o.items;
  const vecs = await embedAudio({ root: o.root, data: o.data, items: its });
  const scores = vecs.map((v) => (v ? Math.round(score(m, v) * 1000) / 1000 : NaN)).filter(Number.isFinite);
  const median = pct(scores, 0.5);
  return { scores, median, realP10: m.calibration.real.p10, realMedian: m.calibration.real.median, below: median < m.calibration.real.p10 };
}
