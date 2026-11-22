/**
 * The full reference index: every shot of every analysed reference film (67,906 shots in 154 films across five
 * channels; Big Company has no shot analysis) with what is on screen, what is said over it, where it sits in the film,
 * how it is cut in, and a SigLIP 2 picture embedding — plus every reference thumbnail. Built from Reference/ read-only:
 * `<film>/pretrain.json` (shots, words, on-screen text, look), `.analysis/edit_graphs` (picture kind, text overlay),
 * `.analysis/motion` (transitions), `.analysis/meta` (title, views, chapters).
 *
 * Output (data/reference-index/, generated):
 *   shots.jsonl     one ReferenceShot per line, stable order (film id, then shot index)
 *   shots.f16/.ok   N × 1152 float16 embeddings (mid-shot frame), same order; .ok marks rows that were read
 *   thumbs.jsonl    one ReferenceThumb per line;  thumbs.f16/.ok
 *   manifest.json   counts, model, fingerprint of the inputs
 * Embeddings come from tools/siglip/embed.py — the same function embeds our own pictures (senses/embed.ts).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChannelId } from "@opumia/contracts";
import { CHANNELS } from "./channels.js";

export interface ReferenceShot {
  id: string;
  channel: ChannelId;
  film: string;
  i: number;
  t0: number;
  t1: number;
  /** Position in the film, 0–1 (shot start / film length). */
  pos: number;
  /** Chapter index (0 = before the first named chapter) and the shot's position inside its chapter, 0–1. */
  chapter: number;
  chapterPos: number;
  /** Seconds since the chapter started. */
  sinceChapter: number;
  /** The words spoken over the shot. */
  line: string;
  words: number;
  picture: string;
  overlay: string;
  /** How the shot is entered (cut, dissolve, whip, flash, dip, …); "" where the reference's transition analysis did not sample this boundary. */
  transitionIn: string;
  faces: number;
  faceH: number;
  sat: number;
  grey: number;
  luma: number;
  contrast: number;
  motion: number;
  /** On-screen text (OCR) and how much of the frame it covers. */
  text: string;
  textArea: number;
  /** The cut into this shot against the voice: seconds to the nearest word boundary, and whether it falls in a pause (≥ 0.15 s between words). */
  cutToWord: number;
  cutInPause: boolean;
  /** Strong sound hit on the cut (±0.2 s) or inside the shot: its class (demucs analysis of the real film), else "". */
  hitOnCut: string;
  hitInShot: string;
  /** Music bed and voice level over the shot (dB, demucs stems, 100 ms envelope). */
  bedDb: number;
  voiceDb: number;
  /** A music drop-out overlaps the shot; a music cue change falls inside it. */
  musicDrop: boolean;
  cueChange: boolean;
}

/** Per-film sound events of a reference film (sound.json). */
export interface ReferenceAudio { film: string; channel: ChannelId; hits: Array<{ t: number; cls: string; peak: number }>; drops: Array<[number, number]>; cues: number[] }

export interface ReferenceThumb { id: string; channel: ChannelId; film: string; title: string; views: number; uploadDate: string; file: string }

export interface ReferenceFilm { id: string; channel: ChannelId; title: string; views: number; uploadDate: string; durS: number; chapters: Array<[number, string]>; shots: number }

export interface ReferenceIndexManifest { schemaVersion: 1; model: string; dim: 1152; films: ReferenceFilm[]; shots: number; thumbs: number; embedded: { shots: number; thumbs: number }; fingerprint: string; generatedAt: string }

export const SIGLIP_MODEL = "google/siglip2-so400m-patch14-384";

const r3 = (x: number) => Math.round(x * 1000) / 1000;

interface Meta { id: string; channel: string; folder: string; title: string; upload_date: string; views: number; chapters?: Array<[number, string]>; dur: number; thumbnail?: string }
interface Pretrain { words: Array<{ word: string; start: number; end: number }>; shots: Array<{ t0: number; t1: number; m?: number; f?: null | { faces: number; face_h: number; sat: number; grey: number; luma: number; contrast: number }; text?: Array<{ text: string; box: [number, number, number, number] }> }> }
interface EditGraph { shots: Array<{ picture: string; overlay: string }> }
interface Motion { transitions: Array<{ t: number; kind: string }> }
interface Sound { hits?: Array<{ t: number; cls: string; peak_over: number }>; drops?: Array<[number, number]>; cues_s?: number[]; voice_db_100ms?: number[]; bed_db_100ms?: number[] }

/** Python with torch + transformers for the embedder: OPUMIA_PYTHON, else the first known environment that has them. */
export function embedPython(): string {
  if (process.env.OPUMIA_PYTHON) return process.env.OPUMIA_PYTHON;
  const home = process.env.HOME ?? "";
  for (const p of [path.join(home, "lechi_tts/venv/bin/python"), path.join(process.cwd(), ".venv/bin/python")]) if (existsSync(p)) return p;
  return "python3";
}

/** Run tools/siglip/embed.py over items; writes <out>.f16 and <out>.ok. */
export function runEmbedder(o: { root: string; out: string; items: Array<{ file: string; t: number | null }>; log?: (s: string) => void }): Promise<{ rows: number; read: number; seconds: number }> {
  return new Promise((res, rej) => {
    const p = spawn(embedPython(), ["-I", path.join(o.root, "tools/siglip/embed.py"), "--out", o.out], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => {
      err += d;
      const last = String(d).trim().split("\n").filter((l) => /\d+\/\d+ ·/.test(l)).at(-1);
      if (last) o.log?.(`    ${last}`);
    });
    p.on("error", rej);
    p.on("close", (code) => {
      if (code !== 0) return rej(new Error(`embedder failed (${code}): ${err.slice(-600)}`));
      try {
        res(JSON.parse(out.trim().split("\n").at(-1)!));
      } catch {
        rej(new Error(`embedder gave no result: ${out.slice(-300)}`));
      }
    });
    p.stdin.end(o.items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  });
}

async function atomic(file: string, text: string) {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

export async function buildReferenceIndex(o: { root: string; reference: string; data: string; embed?: boolean; log?: (s: string) => void }): Promise<ReferenceIndexManifest> {
  const log = o.log ?? (() => {});
  const an = path.join(o.reference, ".analysis");
  const outDir = path.join(o.data, "reference-index");
  await mkdir(outDir, { recursive: true });
  const byPrefix = new Map(CHANNELS.filter((c) => c.metaPrefix).map((c) => [c.metaPrefix!, c.id]));
  const metaFiles = (await readdir(path.join(an, "meta"))).filter((f) => f.endsWith(".json")).sort();
  const films: ReferenceFilm[] = [];
  const shots: ReferenceShot[] = [];
  const thumbs: ReferenceThumb[] = [];
  const audio: ReferenceAudio[] = [];
  const shotItems: Array<{ file: string; t: number | null }> = [];
  const hash = createHash("sha1");
  for (const mf of metaFiles) {
    const meta = JSON.parse(await readFile(path.join(an, "meta", mf), "utf8")) as Meta;
    const channel = byPrefix.get(meta.id.split("-")[0]!);
    if (!channel) continue;
    const dir = path.join(o.reference, meta.folder);
    const pre = await readFile(path.join(dir, "pretrain.json"), "utf8").then((t) => JSON.parse(t) as Pretrain, () => null);
    const eg = await readFile(path.join(an, "edit_graphs", `${meta.id}.json`), "utf8").then((t) => JSON.parse(t) as EditGraph, () => null);
    if (!pre || !eg || eg.shots.length !== pre.shots.length) {
      log(`  skip ${meta.id}: no aligned shot analysis`);
      continue;
    }
    const mo = await readFile(path.join(an, "motion", `${meta.id}.json`), "utf8").then((t) => JSON.parse(t) as Motion, () => null);
    const mp4 = (await readdir(dir)).find((f) => f.endsWith(".mp4"));
    const snd = await readFile(path.join(dir, "sound.json"), "utf8").then((t) => JSON.parse(t) as Sound, () => null);
    const hits = (snd?.hits ?? []).map((h) => ({ t: h.t, cls: h.cls, peak: h.peak_over }));
    if (snd) audio.push({ film: meta.id, channel, hits, drops: snd.drops ?? [], cues: snd.cues_s ?? [] });
    const env = (a: number[] | undefined, t0: number, t1: number) => {
      if (!a?.length) return 0;
      const xs = a.slice(Math.floor(t0 * 10), Math.max(Math.floor(t0 * 10) + 1, Math.ceil(t1 * 10)));
      return xs.length ? r3(xs.reduce((x, y) => x + y, 0) / xs.length) : 0;
    };
    // word boundaries and pauses
    const bounds: number[] = [];
    const pauses: Array<[number, number]> = [];
    pre.words.forEach((wd, k) => {
      bounds.push(wd.start, wd.end);
      const nx = pre.words[k + 1];
      if (nx && nx.start - wd.end >= 0.15) pauses.push([wd.end, nx.start]);
    });
    bounds.sort((a, b) => a - b);
    const nearestBound = (t: number) => {
      let lo = 0, hi = bounds.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (bounds[m]! < t) lo = m + 1; else hi = m; }
      return Math.min(Math.abs((bounds[lo] ?? Infinity) - t), Math.abs((bounds[lo - 1] ?? Infinity) - t));
    };
    hash.update(`${meta.id}|${pre.shots.length}|${meta.views}|${mp4}`);
    const chapters = (meta.chapters ?? []).filter((c) => Number.isFinite(c[0])).sort((a, b) => a[0] - b[0]);
    const dur = meta.dur || pre.shots.at(-1)!.t1;
    films.push({ id: meta.id, channel, title: meta.title, views: meta.views, uploadDate: meta.upload_date, durS: dur, chapters, shots: pre.shots.length });
    let w = 0;
    pre.shots.forEach((s, i) => {
      const said: string[] = [];
      while (w < pre.words.length && (pre.words[w]!.start + pre.words[w]!.end) / 2 < s.t0) w++;
      for (let k = w; k < pre.words.length && (pre.words[k]!.start + pre.words[k]!.end) / 2 < s.t1; k++) said.push(pre.words[k]!.word.trim());
      let ch = 0;
      for (let k = 0; k < chapters.length; k++) if (chapters[k]![0] <= s.t0 + 0.01) ch = k + 1;
      const cStart = ch ? chapters[ch - 1]![0] : 0;
      const cEnd = ch < chapters.length ? chapters[ch]![0] : dur;
      const tr = mo?.transitions.find((t) => Math.abs(t.t - s.t0) < 0.25);
      const text = (s.text ?? []).map((x) => x.text.trim()).filter(Boolean);
      const area = (s.text ?? []).reduce((a, x) => a + Math.max(0, (x.box[2] - x.box[0]) * (x.box[3] - x.box[1])), 0);
      shots.push({
        id: `${meta.id}:${i}`, channel, film: meta.id, i, t0: r3(s.t0), t1: r3(s.t1), pos: r3(s.t0 / dur),
        chapter: ch, chapterPos: r3(Math.min(1, Math.max(0, (s.t0 - cStart) / Math.max(1, cEnd - cStart)))), sinceChapter: r3(s.t0 - cStart),
        line: said.join(" "), words: said.length, picture: eg.shots[i]!.picture, overlay: eg.shots[i]!.overlay,
        transitionIn: i === 0 ? "start" : tr?.kind ?? "",
        faces: s.f?.faces ?? 0, faceH: s.f?.face_h ?? 0, sat: s.f?.sat ?? 0, grey: s.f?.grey ?? 0, luma: s.f?.luma ?? 0, contrast: s.f?.contrast ?? 0, motion: r3(s.m ?? 0),
        text: text.join(" | ").slice(0, 200), textArea: r3(Math.min(1, area)),
        cutToWord: r3(Math.min(9, nearestBound(s.t0))), cutInPause: pauses.some(([a, b]) => s.t0 >= a - 0.03 && s.t0 <= b + 0.03),
        hitOnCut: hits.find((h) => Math.abs(h.t - s.t0) <= 0.2)?.cls ?? "", hitInShot: hits.find((h) => h.t > s.t0 + 0.2 && h.t < s.t1 - 0.2)?.cls ?? "",
        bedDb: env(snd?.bed_db_100ms, s.t0, s.t1), voiceDb: env(snd?.voice_db_100ms, s.t0, s.t1),
        musicDrop: (snd?.drops ?? []).some(([a, b]) => a < s.t1 && b > s.t0), cueChange: (snd?.cues_s ?? []).some((c) => c >= s.t0 && c < s.t1),
      });
      if (mp4) shotItems.push({ file: path.join(dir, mp4), t: r3((s.t0 + s.t1) / 2) });
      else shotItems.push({ file: "", t: 0 });
    });
    const tf = meta.thumbnail ? path.join(o.reference, meta.thumbnail) : path.join(dir, "thumbnail.jpg");
    if (existsSync(tf)) thumbs.push({ id: meta.id, channel, film: meta.id, title: meta.title, views: meta.views, uploadDate: meta.upload_date, file: path.relative(o.reference, tf) });
  }
  const fingerprint = hash.digest("hex").slice(0, 16);
  await atomic(path.join(outDir, "shots.jsonl"), shots.map((s) => JSON.stringify(s)).join("\n") + "\n");
  await atomic(path.join(outDir, "audio.jsonl"), audio.map((s) => JSON.stringify(s)).join("\n") + "\n");
  await atomic(path.join(outDir, "thumbs.jsonl"), thumbs.map((s) => JSON.stringify(s)).join("\n") + "\n");
  const prev = await readFile(path.join(outDir, "manifest.json"), "utf8").then((t) => JSON.parse(t) as ReferenceIndexManifest, () => null);
  const embedded = { shots: 0, thumbs: 0 };
  const fresh = prev?.fingerprint === fingerprint && existsSync(path.join(outDir, "shots.f16")) && existsSync(path.join(outDir, "thumbs.f16"));
  if (fresh) Object.assign(embedded, prev!.embedded);
  else if (o.embed !== false) {
    log(`  embedding ${thumbs.length} reference thumbnails…`);
    embedded.thumbs = (await runEmbedder({ root: o.root, out: path.join(outDir, "thumbs"), items: thumbs.map((t) => ({ file: path.join(o.reference, t.file), t: null })), log })).read;
    log(`  embedding ${shots.length} reference shots (mid-shot frame)…`);
    embedded.shots = (await runEmbedder({ root: o.root, out: path.join(outDir, "shots"), items: shotItems, log })).read;
  }
  const manifest: ReferenceIndexManifest = { schemaVersion: 1, model: SIGLIP_MODEL, dim: 1152, films, shots: shots.length, thumbs: thumbs.length, embedded, fingerprint, generatedAt: new Date().toISOString() };
  await atomic(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  return manifest;
}
