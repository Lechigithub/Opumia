import { readdir } from "node:fs/promises";
import path from "node:path";
import { CHANNELS, readJsonSafe } from "@opumia/ingest";

/**
 * Style data learned from the reference films (deterministic, no model calls):
 * - captionPolicy: does the channel burn word captions into long-form? (OCR text in the lower band,
 *   with the channel watermark — text repeated across a film — removed)
 * - visualGrammar: what the editor actually showed for each kind of line (hand-labelled reference shots
 *   joined with the words spoken over them)
 * - beatLibrary: real narration passages per story role (cold open, chapter openings by role, twist, ending)
 */

interface Shot { t0: number; t1: number; text?: Array<{ text: string; box: [number, number, number, number] }> }
interface Word { word: string; start: number; end: number }
interface Pretrain { words?: Word[]; shots?: Shot[] }

export interface CaptionPolicy { burnLongForm: boolean; bottomTextShare: number; films: number }
export interface GrammarRow { film: string; /** Shot time range in the reference film (s), for exemplar frames. */ t0?: number; t1?: number; line: string; designed: boolean; kind: string; layout: string; motion: string; elements: string[]; shows: string; link: string; quality: number }
export interface BeatPassage { role: string; film: string; text: string }

async function filmDirs(reference: string, channelId: string): Promise<Array<{ date: string; dir: string }>> {
  const ch = CHANNELS.find((c) => c.id === channelId);
  if (!ch || ch.layout !== "standard") return [];
  const base = path.join(reference, ch.dir);
  const names = (await readdir(base).catch(() => [] as string[])).filter((n) => /^\d{8} - /.test(n)).sort();
  return names.map((n) => ({ date: n.slice(0, 8), dir: path.join(base, n) }));
}

export async function captionPolicy(reference: string, channelId: string): Promise<CaptionPolicy> {
  const shares: number[] = [];
  for (const f of await filmDirs(reference, channelId)) {
    const p = await readJsonSafe<Pretrain>(path.join(f.dir, "pretrain.json"), 0);
    const shots = p.ok ? (p.value.shots ?? []) : [];
    if (shots.length < 50) continue;
    const low = shots.map((s) => (s.text ?? []).filter((x) => x.text && x.text.trim().length > 2 && x.box[1] > 0.72 && x.box[3] - x.box[1] < 0.12));
    // Watermark: a lower-band string that recurs in > 20 % of the film's shots.
    const freq = new Map<string, number>();
    for (const l of low) for (const t of new Set(l.map((x) => x.text.trim().toUpperCase()))) freq.set(t, (freq.get(t) ?? 0) + 1);
    const mark = new Set([...freq.entries()].filter(([, n]) => n > shots.length * 0.2).map(([t]) => t));
    // A caption is sentence-like text (≥ 3 words) that is not the watermark.
    const cap = low.filter((l) => l.some((x) => !mark.has(x.text.trim().toUpperCase()) && x.text.trim().split(/\s+/).length >= 3)).length;
    shares.push(cap / shots.length);
  }
  const med = shares.length ? [...shares].sort((a, b) => a - b)[Math.floor(shares.length / 2)]! : 0;
  return { burnLongForm: med > 0.5, bottomTextShare: Math.round(med * 1000) / 1000, films: shares.length };
}

export async function visualGrammar(reference: string, channelId: string, prefix: string | null): Promise<GrammarRow[]> {
  if (!prefix) return [];
  const dir = path.join(reference, ".analysis", "designed");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^answer_\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const films = new Map((await filmDirs(reference, channelId)).map((f) => [f.date, f.dir]));
  const cache = new Map<string, Pretrain | null>();
  const rows: GrammarRow[] = [];
  for (const f of files) {
    const j = await readJsonSafe<Array<{ id: string; designed: boolean; sponsor?: boolean; kind: string; layout: string; motion: string; elements?: string[]; shows: string; line_link: string; quality?: number }>>(path.join(dir, f), 0);
    if (!j.ok || !Array.isArray(j.value)) continue;
    for (const r of j.value) {
      const m = /^([A-Z]+)-(\d{8})\|(\d+)$/.exec(r.id);
      if (!m || m[1] !== prefix || r.sponsor) continue;
      const fdir = films.get(m[2]!);
      if (!fdir) continue;
      if (!cache.has(fdir)) {
        const p = await readJsonSafe<Pretrain>(path.join(fdir, "pretrain.json"), 0);
        cache.set(fdir, p.ok ? p.value : null);
      }
      const pt = cache.get(fdir);
      const shot = pt?.shots?.[Number(m[3])];
      if (!shot || !pt?.words) continue;
      const line = pt.words.filter((w) => w.start >= shot.t0 - 0.4 && w.start < shot.t1 + 0.2).map((w) => w.word).join(" ").trim();
      if (line.split(/\s+/).length < 2) continue;
      rows.push({ film: `${m[1]}-${m[2]}`, t0: shot.t0, t1: shot.t1, line: line.slice(0, 220), designed: r.designed, kind: r.kind, layout: r.layout, motion: r.motion, elements: (r.elements ?? []).slice(0, 6), shows: r.shows, link: r.line_link, quality: r.quality ?? 3 });
    }
  }
  return rows.sort((a, b) => a.film.localeCompare(b.film) || a.line.localeCompare(b.line));
}

/** Grammar as prompt text: per line type, how often the editor designs and what it shows, plus exemplars. */
export function grammarText(rows: GrammarRow[]): string {
  if (!rows.length) return "";
  const links = [...new Set(rows.map((r) => r.link))].sort();
  const table = links.map((l) => {
    const rs = rows.filter((r) => r.link === l);
    const des = rs.filter((r) => r.designed);
    const kinds = new Map<string, number>();
    for (const r of des) kinds.set(r.kind.replace(/^other:/, ""), (kinds.get(r.kind.replace(/^other:/, "")) ?? 0) + 1);
    const top = [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(", ");
    return `- ${l} lines (${rs.length} sampled): ${Math.round((des.length / rs.length) * 100)} % designed${top ? ` — ${top}` : ""}`;
  });
  // Exemplars: the best-rated shots, spread across films and line types.
  const pickN = (pred: (r: GrammarRow) => boolean, n: number) => {
    const out: GrammarRow[] = [];
    const perFilm = new Map<string, number>();
    for (const r of [...rows].filter(pred).sort((a, b) => b.quality - a.quality || a.film.localeCompare(b.film) || a.line.localeCompare(b.line))) {
      if ((perFilm.get(r.film) ?? 0) >= 2) continue;
      perFilm.set(r.film, (perFilm.get(r.film) ?? 0) + 1);
      out.push(r);
      if (out.length >= n) break;
    }
    return out;
  };
  const footage = pickN((r) => !r.designed && r.link === "literal" && !/^plain footage/i.test(r.shows), 22);
  const designed = pickN((r) => r.designed, 34);
  const fmt = (r: GrammarRow) => `- "${r.line}" → ${r.designed ? `[${r.kind}] ${r.layout}; motion: ${r.motion}; elements: ${r.elements.join(", ") || "—"}` : `[footage]`} — shows: ${r.shows}`;
  return [
    `\n# 8. VISUAL GRAMMAR (what the editor showed over the line; ${rows.length} hand-labelled reference shots)`,
    `Rule of the channel: the picture shows the SPECIFIC thing the line names — the real person, the real logo, the real product, the actual headline — not a generic mood. Generic stock is used only for mood and process lines.`,
    ...table,
    `\n## 8a. FOOTAGE OVER LITERAL LINES (how specific the picture is)`,
    ...footage.map(fmt),
    `\n## 8b. DESIGNED SHOTS (layout, motion and elements — reproduce them as closely as you can with this film's own pictures and words)`,
    ...designed.map(fmt),
  ].join("\n");
}

interface StoryLabel { film: string; hook?: { until_s?: number; type?: string }; thesis?: { i?: number }; chapters?: Array<{ t0: number; role?: string; title?: string }>; twist?: { i?: number }; ending?: unknown }

/** Real passages per story role (≈ 60–90 words each), from the sentence transcripts. */
export async function beatLibrary(reference: string, storyFiles: string[]): Promise<BeatPassage[]> {
  const analysis = path.join(reference, ".analysis");
  const out: BeatPassage[] = [];
  for (const f of storyFiles) {
    const j = await readJsonSafe<StoryLabel>(path.join(analysis, "story", f), 0);
    if (!j.ok) continue;
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(analysis, "story_in", f.replace(/\.json$/, ".txt")), "utf8").catch(() => "");
    const sents: Array<{ i: number; t: number; text: string }> = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\[(\d+)\]\s+([\d.]+)s\s+(.*)$/.exec(line);
      if (m) sents.push({ i: Number(m[1]), t: Number(m[2]), text: m[3]!.trim() });
    }
    if (sents.length < 20) continue;
    const take = (from: number, words = 80) => {
      const xs: string[] = [];
      let n = 0;
      for (const s of sents.filter((x) => x.i >= from)) {
        xs.push(s.text);
        n += s.text.split(/\s+/).length;
        if (n >= words) break;
      }
      return xs.join(" ");
    };
    const film = j.value.film;
    const thesisI = j.value.thesis?.i ?? 3;
    out.push({ role: `cold_open (${j.value.hook?.type ?? "?"})`, film, text: take(0, 95) });
    out.push({ role: "after_thesis", film, text: take(thesisI + 1, 70) });
    for (const c of (j.value.chapters ?? []).slice(1, 6)) {
      const first = sents.find((s) => s.t >= c.t0);
      if (first && c.role) out.push({ role: `chapter_open (${c.role})`, film, text: take(first.i, 70) });
    }
    if (typeof j.value.twist?.i === "number") out.push({ role: "twist", film, text: take(Math.max(0, j.value.twist.i - 1), 75) });
    const tail = sents.filter((s) => !/subscribe|patreon|sponsor|thanks for watching|see you/i.test(s.text)).slice(-6);
    if (tail.length) out.push({ role: "ending", film, text: tail.map((s) => s.text).join(" ").slice(0, 600) });
  }
  return out;
}

/** A balanced handful of real passages per role for the writer and the editor. */
export function beatText(beats: BeatPassage[], perRole = 3): string {
  if (!beats.length) return "";
  const roles = [...new Set(beats.map((b) => b.role.replace(/ \(.*\)$/, "")))].sort();
  const lines: string[] = [`\n# 9. BEAT LIBRARY (real narration per story role — match its voice and structure exactly; never reuse a line word for word)`];
  for (const r of roles) {
    const xs = beats.filter((b) => b.role.startsWith(r)).sort((a, b) => a.film.localeCompare(b.film));
    const step = Math.max(1, Math.floor(xs.length / perRole));
    const pick = xs.filter((_, k) => k % step === 0).slice(0, perRole);
    lines.push(`## ${r}`, ...pick.map((b) => `- [${b.film} ${b.role}] ${b.text}`));
  }
  return lines.join("\n");
}
