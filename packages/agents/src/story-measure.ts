/**
 * Story measurement: what every sentence of a narration DOES, measured the same way on our scripts and on the
 * reference channel's real films. Not "which one is real" (the blind story judge cannot tell a bland rewrite
 * from the real thing) but numbers a script either sits inside the channel's range for, or does not — and each
 * miss points at the sentences to rewrite.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHANNELS } from "@opumia/ingest";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

export const LINE_KINDS = ["scene", "story", "fact", "explain", "motive", "quote", "question", "address", "tease", "maxim"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

const LABEL_SYSTEM = `You label documentary narration, one label per numbered line. Judge only what the line does:
- scene: puts the viewer at a specific moment — a named person or company doing, saying or deciding something at a particular time or place ("It's 2009, and Brian Acton applies for a job at Facebook.").
- story: carries the events forward in general narration, without a specific moment ("Over the next few years the app kept growing.").
- fact: reports a figure, date, size or record as information ("By 2013 it had 400 million users.").
- explain: tells the viewer what something means or why it matters ("Which basically meant they had no way to make money.", "In other words, …").
- motive: what someone wanted, feared, felt or believed ("Koum hated advertising.").
- quote: a direct quotation or a closely reported statement attributed to someone.
- question: a question put to the viewer or raised by the narrator.
- address: speaks to the viewer directly or as the narrator in the first person ("You are being programmed.", "I went down a rabbit hole.", "We need to go back.").
- tease: promises or hints at something coming later ("But that decision would come back to haunt him.").
- maxim: a general lesson, moral or saying not tied to the events ("If you don't disrupt yourself, someone else will.").
When two fit, choose the more specific (question > address > quote > tease > maxim > motive > explain > scene > fact > story).`;

const Labels = z.object({ lines: z.array(z.object({ i: z.number(), kind: z.enum(LINE_KINDS) })) });

/** One Haiku call per 60 lines. Unlabelled lines fall back to "story". */
export async function labelLines(lines: string[]): Promise<LineKind[]> {
  const out = new Array<LineKind>(lines.length).fill("story");
  const parts: Array<{ from: number; items: string[] }> = [];
  for (let i = 0; i < lines.length; i += 60) parts.push({ from: i, items: lines.slice(i, i + 60) });
  await Promise.all(
    parts.map(async (p) => {
      const res = await structured({ stage: "story.label", model: MODELS.haiku, system: [plain(LABEL_SYSTEM)], user: p.items.map((t, k) => `[${k}] ${t.slice(0, 400)}`).join("\n"), schema: Labels, effort: "low", maxTokens: 3000 }).catch(() => null);
      for (const l of res?.data.lines ?? []) if (l.i >= 0 && l.i < p.items.length) out[p.from + l.i] = l.kind;
    }),
  );
  return out;
}

export interface StoryProfile {
  lines: number;
  /** Share of lines of each kind. */
  share: Record<LineKind, number>;
  /** Share of lines that talk to the viewer or as the narrator (kind "address", or "you/your", or "I/we"). */
  viewerShare: number;
  /** Share of lines that say "you/your" or speak as "I/we". */
  youShare: number;
  firstPersonShare: number;
  /** Opening (first six lines). */
  open: { question: boolean; address: boolean; scene: boolean; kinds: LineKind[] };
  /** Ending (last three lines). */
  end: { maxim: boolean; address: boolean; question: boolean; callback: boolean; kinds: LineKind[] };
}

const YOU = /\b(you|your|you're|you've|yourself)\b/i;
const FIRST = /\b(I|I'm|I've|we|we're|we've|our|us|let's|me|my)\b/;
const content = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 4));

export function storyProfile(lines: string[], kinds: LineKind[]): StoryProfile {
  const n = Math.max(1, lines.length);
  const share = Object.fromEntries(LINE_KINDS.map((k) => [k, Math.round((kinds.filter((x) => x === k).length / n) * 1000) / 1000])) as Record<LineKind, number>;
  const head = kinds.slice(0, 6);
  const tail = kinds.slice(-3);
  const first = content(lines.slice(0, 4).join(" "));
  const last = content(lines.slice(-3).join(" "));
  const overlap = [...last].filter((w) => first.has(w)).length;
  return {
    lines: lines.length,
    share,
    viewerShare: Math.round((lines.filter((t, i) => kinds[i] === "address" || YOU.test(t) || FIRST.test(t)).length / n) * 1000) / 1000,
    youShare: Math.round((lines.filter((t) => YOU.test(t)).length / n) * 1000) / 1000,
    firstPersonShare: Math.round((lines.filter((t) => FIRST.test(t)).length / n) * 1000) / 1000,
    open: { question: head.includes("question"), address: head.includes("address") || lines.slice(0, 6).some((t) => YOU.test(t)), scene: head.includes("scene"), kinds: head },
    end: { maxim: tail.includes("maxim"), address: tail.includes("address") || lines.slice(-3).some((t) => YOU.test(t) || FIRST.test(t)), question: tail.includes("question"), callback: overlap >= 2, kinds: tail },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The channel's own range, and what a script misses

type Range = { p10: number; p50: number; p90: number };
export interface StoryBand {
  schemaVersion: 1;
  channel: string;
  films: number;
  kinds: Record<LineKind, Range>;
  viewer: Range;
  /** How real films of the channel are structured (their own section sequences) — examples, never a menu. */
  structures: string[];
}

const rangeOf = (xs: number[]): Range => {
  const v = [...xs].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0;
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
};

interface StoryFile { chapters?: Array<{ t0: number; title?: string; role?: string }> }

/**
 * The channel's story band: every reference film's narration (sponsor reads and outros left out) is labelled
 * line by line with `labelLines` — the same function that measures our scripts — and the spread across films
 * is stored in data/story-profile/<channel>.json. Built once (about 2,500 lines through Haiku); read afterwards.
 */
export async function ensureStoryBand(o: { reference: string; data: string; channelId: string; log?: (s: string) => void }): Promise<StoryBand | null> {
  const file = path.join(o.data, "story-profile", `${o.channelId}.json`);
  const hit = await readFile(file, "utf8").then((t) => JSON.parse(t) as StoryBand, () => null);
  if (hit) return hit;
  const prefix = CHANNELS.find((c) => c.id === o.channelId)?.metaPrefix ?? "";
  const analysis = path.join(o.reference, ".analysis");
  const files = (await readdir(path.join(analysis, "story_in")).catch(() => [] as string[])).filter((f) => (prefix ? f.startsWith(`${prefix}-`) : /^\d{2}\.txt$/.test(f))).sort();
  if (files.length < 5) return null;
  o.log?.(`  story band: measuring ${files.length} reference films line by line (once)…`);
  const profiles: StoryProfile[] = [];
  const structures: string[] = [];
  for (let i = 0; i < files.length; i += 6) {
    await Promise.all(
      files.slice(i, i + 6).map(async (f, k) => {
        const raw = await readFile(path.join(analysis, "story_in", f), "utf8").catch(() => "");
        const label = await readFile(path.join(analysis, "story", f.replace(/\.txt$/, ".json")), "utf8").then((t) => JSON.parse(t) as StoryFile, () => ({}) as StoryFile);
        const ch = [...(label.chapters ?? [])].sort((a, b) => a.t0 - b.t0);
        const skip = ch.map((c, n) => ({ from: c.t0, to: ch[n + 1]?.t0 ?? Infinity, drop: /sponsor|outro/i.test(c.role ?? "") })).filter((c) => c.drop);
        const lines = raw.split(/\r?\n/).flatMap((l) => {
          const m = /^\[\d+\]\s+([\d.]+)s\s+(.*)$/.exec(l);
          return m && !skip.some((x) => Number(m[1]) >= x.from && Number(m[1]) < x.to) ? [m[2]!.trim()] : [];
        });
        if (lines.length < 40) return;
        const mid = lines.slice(25, -15);
        const step = Math.max(1, Math.floor(mid.length / 50));
        const sample = [...lines.slice(0, 25), ...mid.filter((_, n) => n % step === 0).slice(0, 50), ...lines.slice(-15)];
        profiles.push(storyProfile(sample, await labelLines(sample)));
        const title = /^#\s*[^:]+:\s*(.+?)\s*\(/.exec(raw)?.[1] ?? f;
        const seq = ch.filter((c) => !/sponsor|outro/i.test(c.role ?? "") && c.title).map((c) => c.title!);
        if ((i + k) % 4 === 0 && seq.length >= 4) structures.push(`"${title}": ${seq.join(" → ")}`);
      }),
    );
  }
  if (profiles.length < 5) return null;
  const band: StoryBand = { schemaVersion: 1, channel: o.channelId, films: profiles.length, kinds: Object.fromEntries(LINE_KINDS.map((k) => [k, rangeOf(profiles.map((p) => p.share[k]))])) as Record<LineKind, Range>, viewer: rangeOf(profiles.map((p) => p.viewerShare)), structures: structures.sort().slice(0, 8) };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(band, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
  return band;
}

export interface StoryIssue {
  kind: "explain_low" | "viewer_low" | "quote_heavy" | "fact_heavy" | "maxim_heavy";
  detail: string;
  /** Line numbers (0-based) the rewrite should start from. */
  lines: number[];
}

/**
 * What a script misses against the channel's band. One line of a short script is several per cent, so every
 * limit carries a tolerance of one line; a miss is a clear miss.
 */
export function storyIssues(lines: string[], kinds: LineKind[], band: StoryBand): { profile: StoryProfile; issues: StoryIssue[] } {
  const profile = storyProfile(lines, kinds);
  const n = Math.max(1, lines.length);
  const tol = Math.max(0.03, 1 / n);
  const pc = (x: number) => `${Math.round(x * 100)} %`;
  const at = (k: LineKind) => kinds.map((x, i) => (x === k ? i : -1)).filter((i) => i >= 0);
  const issues: StoryIssue[] = [];
  if (profile.share.explain < band.kinds.explain.p10 - tol)
    issues.push({ kind: "explain_low", detail: `only ${pc(profile.share.explain)} of the lines tell the viewer what something means or why it matters; the channel's films run ${pc(band.kinds.explain.p10)}–${pc(band.kinds.explain.p90)}. After the facts and events listed, say what it meant in plain words ("which basically meant…", "in other words…", "and that was a problem, because…") — fold it into the story, do not add length.`, lines: [...at("fact"), ...at("story")].sort((a, b) => a - b).filter((i) => kinds[i + 1] !== "explain") });
  if (profile.viewerShare < Math.max(band.viewer.p10 - tol, 1 / n - 1e-9))
    issues.push({ kind: "viewer_low", detail: `only ${pc(profile.viewerShare)} of the lines talk to the viewer or speak as the narrator; the channel's films run ${pc(band.viewer.p10)}–${pc(band.viewer.p90)} ("you", "your", "we", "I"). The narrator is a person telling ONE viewer a story: bring the viewer in ("you've probably used one", "think about what that means for you", "we need to go back") where it is natural.`, lines: [] });
  if (profile.share.quote > band.kinds.quote.p90 + tol) {
    const q = at("quote");
    const keep = Math.max(1, Math.floor((band.kinds.quote.p90 + tol) * n));
    issues.push({ kind: "quote_heavy", detail: `${pc(profile.share.quote)} of the lines are quotations; the channel's films run ${pc(band.kinds.quote.p10)}–${pc(band.kinds.quote.p90)}. Keep the ${keep} strongest and TELL the rest as story in the narrator's own voice (what the person did, wanted or faced) — a script strung together from quotes reads as a summary.`, lines: q });
  }
  if (profile.share.fact > band.kinds.fact.p90 + tol) issues.push({ kind: "fact_heavy", detail: `${pc(profile.share.fact)} of the lines only report a figure or a date; the channel's films run ${pc(band.kinds.fact.p10)}–${pc(band.kinds.fact.p90)}. Turn the listed lines into story or meaning: who did what, and what it led to — keep only the figures the story turns on.`, lines: at("fact") });
  if (profile.share.maxim > band.kinds.maxim.p90 + tol) issues.push({ kind: "maxim_heavy", detail: `${pc(profile.share.maxim)} of the lines are general sayings or morals; the channel's films run ${pc(band.kinds.maxim.p10)}–${pc(band.kinds.maxim.p90)}. Replace them with something specific to this story.`, lines: at("maxim") });
  return { profile, issues };
}

// ---------------------------------------------------------------------------------------------------------
// The reference films as a library (whole narrations, sponsor reads and outros left out)

export interface ReferenceFilm {
  id: string;
  title: string;
  minutes: number;
  /** One line on what kind of story it is. */
  note: string;
  /** Its own section sequence. */
  sections: string[];
  lines: string[];
}

/** Built once from the reference analysis into data/story-profile/<channel>-films.json (so it also exists in the cloud). */
export async function ensureReferenceFilms(o: { reference: string; data: string; channelId: string }): Promise<ReferenceFilm[]> {
  const file = path.join(o.data, "story-profile", `${o.channelId}-films.json`);
  const hit = await readFile(file, "utf8").then((t) => JSON.parse(t) as ReferenceFilm[], () => null);
  if (hit) return hit;
  const prefix = CHANNELS.find((c) => c.id === o.channelId)?.metaPrefix ?? "";
  const analysis = path.join(o.reference, ".analysis");
  const files = (await readdir(path.join(analysis, "story_in")).catch(() => [] as string[])).filter((f) => (prefix ? f.startsWith(`${prefix}-`) : /^\d{2}\.txt$/.test(f))).sort();
  const out: ReferenceFilm[] = [];
  for (const f of files) {
    const raw = await readFile(path.join(analysis, "story_in", f), "utf8").catch(() => "");
    const label = await readFile(path.join(analysis, "story", f.replace(/\.txt$/, ".json")), "utf8").then((t) => JSON.parse(t) as StoryFile & { notes?: string }, () => ({}) as StoryFile & { notes?: string });
    const ch = [...(label.chapters ?? [])].sort((a, b) => a.t0 - b.t0);
    const skip = ch.map((c, n) => ({ from: c.t0, to: ch[n + 1]?.t0 ?? Infinity, drop: /sponsor|outro/i.test(c.role ?? "") })).filter((c) => c.drop);
    const lines = raw.split(/\r?\n/).flatMap((l) => {
      const m = /^\[\d+\]\s+([\d.]+)s\s+(.*)$/.exec(l);
      return m && !skip.some((x) => Number(m[1]) >= x.from && Number(m[1]) < x.to) ? [m[2]!.trim()] : [];
    });
    if (lines.length < 40) continue;
    const head = /^#\s*[^:]+:\s*(.+?)\s*\(([\d.]+)\s*min\)/.exec(raw);
    out.push({ id: f.replace(/\.txt$/, ""), title: head?.[1] ?? f, minutes: Number(head?.[2] ?? 0), note: (label.notes ?? "").slice(0, 240), sections: ch.filter((c) => !/sponsor|outro/i.test(c.role ?? "") && c.title).map((c) => c.title!), lines });
  }
  if (out.length) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(out) + "\n");
    await rename(`${file}.tmp`, file);
  }
  return out;
}
