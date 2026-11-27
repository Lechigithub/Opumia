// The channel's whole-film structure, measured (2026-11-27, owner: the writer must write a film of any length the way
// the reference would). From Reference/.analysis/story/<film>.json (hook, thesis, story chapters with roles, the twist,
// open loops, decision beats, the ending) and .analysis/meta (published YouTube chapters, duration) — read only.
// Measured on 31 MagnatesMedia films (3–79 min): published chapters run 128–280 s (median 192, not the 90–150 s the
// platform assumed), the intro before chapter 1 about 50 s, the hook ends about 36 s in; a new open question about every
// 5 minutes (not "a revelation every half minute"), paid about 2 minutes later; the twist near the middle; half the
// endings call back to the opening.
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface StructureBand { p25: number; p50: number; p75: number }
export interface StructureProfile {
  schemaVersion: 1; channel: string; films: number; minutes: StructureBand;
  chapterS: StructureBand; chaptersPer10Min: number; introS: StructureBand; hookEndsS: StructureBand; thesisS: StructureBand; hookTypes: Record<string, number>;
  beatS: StructureBand; twistAt: StructureBand; openLoopsPer10Min: StructureBand; loopPaidAfterS: StructureBand; decisionsPer10Min: StructureBand;
  endings: Record<string, number>; callbackShare: number; arc: string[][];
}

const SPONSOR = /sponsor|\bad\b|brought to you|nordvpn|skillshare|squarespace|audible|surfshark|guardio|brilliant|curiositystream|honey|raid|patreon|merch/i;
const pct = (a: number[], q: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q, l = Math.floor(i); return s[l]! + (s[Math.ceil(i)]! - s[l]!) * (i - l); };
const band = (a: number[]): StructureBand => ({ p25: Math.round(pct(a, 0.25) * 100) / 100, p50: Math.round(pct(a, 0.5) * 100) / 100, p75: Math.round(pct(a, 0.75) * 100) / 100 });
const share = (xs: string[]) => { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; for (const k of Object.keys(c)) c[k] = Math.round((c[k]! / xs.length) * 100) / 100; return c; };

interface StoryFile { film: string; hook: { until_s: number; type: string }; thesis?: { t0: number }; chapters?: Array<{ t0: number; role: string }>; twist?: { t0: number } | null; open_loops?: Array<{ opened_t0: number; paid_t0?: number }>; decision_beats?: unknown[]; ending: { type: string; callback?: boolean } }

export function buildStructureProfile(o: { reference: string; data: string; channel?: string; prefix?: string }): StructureProfile {
  const channel = o.channel ?? "magnates-media", prefix = o.prefix ?? "MM-";
  const storyDir = path.join(o.reference, ".analysis", "story"), metaDir = path.join(o.reference, ".analysis", "meta");
  const metas = readdirSync(metaDir).filter((f) => f.startsWith(prefix));
  const rows = readdirSync(storyDir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).flatMap((f) => {
    const s = JSON.parse(readFileSync(path.join(storyDir, f), "utf8")) as StoryFile;
    const mf = metas.find((m) => m.startsWith(s.film));
    if (!mf) return [];
    const m = JSON.parse(readFileSync(path.join(metaDir, mf), "utf8")) as { dur?: number; chapters?: Array<[number, string]> };
    return m.dur ? [{ s, dur: m.dur, yt: (m.chapters ?? []).filter(([, n]) => !SPONSOR.test(n)).map(([t]) => t) }] : [];
  });
  const withCh = rows.filter((r) => r.yt.length > 1);
  const chapterLens = withCh.flatMap((r) => r.yt.slice(1).map((t, i) => (r.yt[i + 2] ?? r.dur) - t));
  const beats = rows.flatMap((r) => { const t = (r.s.chapters ?? []).map((c) => c.t0); return t.map((x, i) => (t[i + 1] ?? r.dur) - x); });
  const arc: string[][] = [[], [], [], [], []];
  for (const r of rows) { const ch = r.s.chapters ?? []; ch.forEach((c, i) => arc[Math.min(4, Math.floor((5 * i) / Math.max(1, ch.length)))]!.push(c.role)); }
  const top = (xs: string[]) => Object.entries(share(xs)).sort((a, b) => b[1] - a[1]).filter(([k]) => k !== "sponsor").slice(0, 3).map(([k]) => k);
  return {
    schemaVersion: 1, channel, films: rows.length, minutes: band(rows.map((r) => r.dur / 60)),
    chapterS: band(chapterLens), chaptersPer10Min: Math.round(pct(withCh.map((r) => r.yt.length / (r.dur / 600)), 0.5) * 10) / 10,
    introS: band(withCh.map((r) => r.yt[1]!)), hookEndsS: band(rows.map((r) => r.s.hook.until_s)),
    thesisS: band(rows.flatMap((r) => (r.s.thesis ? [r.s.thesis.t0] : []))), hookTypes: share(rows.map((r) => r.s.hook.type)),
    beatS: band(beats), twistAt: band(rows.flatMap((r) => (r.s.twist ? [r.s.twist.t0 / r.dur] : []))),
    openLoopsPer10Min: band(rows.map((r) => (r.s.open_loops ?? []).length / (r.dur / 600))),
    loopPaidAfterS: band(rows.flatMap((r) => (r.s.open_loops ?? []).flatMap((l) => (l.paid_t0 !== undefined ? [l.paid_t0 - l.opened_t0] : [])))),
    decisionsPer10Min: band(rows.map((r) => (r.s.decision_beats ?? []).length / (r.dur / 600))),
    endings: share(rows.map((r) => r.s.ending.type)), callbackShare: Math.round((rows.filter((r) => r.s.ending.callback).length / Math.max(1, rows.length)) * 100) / 100,
    arc: arc.map(top),
  };
}

/** The profile, built once from the reference and kept in data/story-profile/<channel>-structure.json. */
export function structureProfile(o: { reference: string; data: string; channel?: string }): StructureProfile | null {
  const channel = o.channel ?? "magnates-media";
  const f = path.join(o.data, "story-profile", `${channel}-structure.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as StructureProfile;
  if (channel !== "magnates-media" || !existsSync(path.join(o.reference, ".analysis", "story"))) return null;
  const p = buildStructureProfile({ reference: o.reference, data: o.data, channel });
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(p, null, 1));
  renameSync(`${f}.tmp`, f);
  return p;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
/** What the writer is told about a long film's structure, at this film's length. */
export function structureBrief(p: StructureProfile, durationS: number, chapters: number): string {
  const min = durationS / 60;
  const loops = Math.max(1, Math.round((p.openLoopsPer10Min.p50 * min) / 10));
  const decisions = Math.max(1, Math.round((p.decisionsPer10Min.p50 * min) / 10));
  return [
    `A ${Math.round(min)}-minute film, structured the way the channel's real films are (measured on ${p.films} of them):`,
    `- An intro of about ${Math.round(p.introS.p50)} s (${Math.round(p.introS.p25)}–${Math.round(p.introS.p75)}) before chapter 1: the hook lands by about ${Math.round(p.hookEndsS.p50)} s and the thesis by about ${Math.round(p.thesisS.p75)} s. The channel's hooks are irony, a question, a claim, a reversal, a flash-forward, a mystery, the stakes.`,
    `- ${chapters} chapters with titles, each ${mmss(p.chapterS.p25)}–${mmss(p.chapterS.p75)} long (typically ${mmss(p.chapterS.p50)}), each made of story beats of about ${mmss(p.beatS.p50)}.`,
    `- The arc by fifths of the film: ${p.arc.map((r, i) => `${i + 1}) ${r.join(" / ")}`).join("; ")}.`,
    `- The twist near the middle (${Math.round(p.twistAt.p25 * 100)}–${Math.round(p.twistAt.p75 * 100)} % of the way through).`,
    `- About ${loops} open question${loops > 1 ? "s" : ""} the viewer carries (one roughly every ${Math.round(600 / p.openLoopsPer10Min.p50 / 60)} minutes), each paid off later (typically ${mmss(p.loopPaidAfterS.p50)} on; some only at the end); about ${decisions} moments where someone decides something.`,
    `- An ending the channel uses: ${Object.entries(p.endings).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k.replace(/_/g, " ")} ${Math.round(v * 100)} %`).join(", ")}; ${Math.round(p.callbackShare * 100)} % call back to the opening.`,
  ].join("\n");
}

/** What is wrong with a long script's structure (segments carry chapter titles and roles). Empty for a short film. */
export function structureIssues(segments: Array<{ role: string; chapter?: string; text: string }>, durationS: number, wpm: number, p: StructureProfile, chapters: number): Array<{ kind: string; detail: string }> {
  if (!chapters) return [];
  const out: Array<{ kind: string; detail: string }> = [];
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const total = segments.reduce((n, s) => n + words(s.text), 0);
  const secs = (w: number) => (w / wpm) * 60;
  // chapters: count and length against the channel's (the intro is the words before the first titled chapter)
  const order: string[] = [];
  const size = new Map<string, number>();
  for (const s of segments) { const c = (s.chapter ?? "").trim(); if (!c) continue; if (!size.has(c)) order.push(c); size.set(c, (size.get(c) ?? 0) + words(s.text)); }
  const lo = Math.max(2, Math.round((durationS - p.introS.p50) / p.chapterS.p75)), hi = Math.max(lo, Math.round((durationS - p.introS.p50) / p.chapterS.p25));
  const body = order.slice(1);
  if (body.length < lo || body.length > hi) out.push({ kind: "chapter_count", detail: `${body.length} chapters after the intro; a film of this length has ${lo}–${hi} (the channel's chapters run ${mmss(p.chapterS.p25)}–${mmss(p.chapterS.p75)}).` });
  const short = body.filter((c) => secs(size.get(c)!) < p.chapterS.p25 * 0.6), long = body.filter((c) => secs(size.get(c)!) > p.chapterS.p75 * 1.5);
  if (short.length) out.push({ kind: "chapter_too_short", detail: `chapters too short to be a chapter of the channel's (under ${mmss(p.chapterS.p25 * 0.6)}): ${short.map((c) => `"${c}" ${mmss(secs(size.get(c)!))}`).join(", ")} — merge them or give them a story beat of their own.` });
  if (long.length) out.push({ kind: "chapter_too_long", detail: `chapters longer than the channel runs (over ${mmss(p.chapterS.p75 * 1.5)}): ${long.map((c) => `"${c}" ${mmss(secs(size.get(c)!))}`).join(", ")} — split at a turn.` });
  // the thesis early, the twist near the middle (by word position)
  let at = 0; const pos: Record<string, number> = {};
  for (const s of segments) { if (pos[s.role] === undefined) pos[s.role] = at; at += words(s.text); }
  if (pos.thesis === undefined || secs(pos.thesis) > p.thesisS.p75 * 1.5) out.push({ kind: "thesis_late", detail: `the thesis (what this film is about and why it matters) must land within about ${Math.round(p.thesisS.p75 * 1.5)} s; ${pos.thesis === undefined ? "there is no thesis segment" : `yours starts at ${mmss(secs(pos.thesis))}`}.` });
  const twist = pos.twist !== undefined ? pos.twist / Math.max(1, total) : null;
  if (twist === null || twist < p.twistAt.p25 * 0.7 || twist > Math.min(0.85, p.twistAt.p75 * 1.3)) out.push({ kind: "twist_position", detail: `the channel's twist falls ${Math.round(p.twistAt.p25 * 100)}–${Math.round(p.twistAt.p75 * 100)} % of the way through; ${twist === null ? "yours has no twist segment" : `yours is at ${Math.round(twist * 100)} %`}.` });
  return out;
}
