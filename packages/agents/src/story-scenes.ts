/**
 * Build list 5, items 5, 6, 7 and 9: what makes a narration a STORY, measured the same way on the channel's real
 * narrations and on our drafts, at the film's own length.
 *
 *  - item 5, scene and character: every line is labelled for whether it puts us in a MOMENT (a person, a place, a time,
 *    an action) and whether a named person WANTS, FEARS or DECIDES something (`labelSceneLines`, Haiku). Chronology
 *    is read in code (`timeJumps`).
 *  - item 6, narrator filler: phrases that only point at the story ("It sounds absurd", "This is the story of", "In
 *    other words") are refused — learned as the phrases the channel's real narrations (almost) never use
 *    (`ensureFillerBan`).
 *  - item 7, time is kept: a forward jump of more than a few years between adjacent sentences, or inside one sentence,
 *    needs a bridge ("three years later", "for the next three years") or a scene — at most as often as real films do.
 *  - item 9, openings and endings: real films' first and last ~20 s show how the channel opens (on a moment) and
 *    closes (on a consequence, not a restatement); ours is held to the same.
 *
 * The band (`ensureSceneBand`) is built from windows of real narration as long as the film (`lengthPlan`), so a 45 s
 * short and a 20-minute film are each judged against real stretches of their own length.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { lengthBucket } from "./craft-score.js";
import { ROLE_MODEL, plain, structured } from "./llm.js";
import { loadReferenceIndex } from "./reference-index.js";
import type { ReferenceFilm } from "./story-measure.js";

/** `year`/`toYear`: when the line's events happen (named, or known), so chronology is read even when no year is said. */
export interface SceneLabel { moment: boolean; agency: boolean; year?: number; toYear?: number }

const SCENE_SYSTEM = `You read documentary narration one numbered line at a time and mark two things about each line.
- moment: the line puts the viewer AT a specific moment — a particular person or company, at a particular time or place, doing, saying or deciding something ("It's February 2011, and Stephen Elop walks into a London hotel ballroom." / "That night Koum sat in his car outside the Facebook office."). A general summary of events ("Over the next years the company grew") is not a moment, nor is a bare figure or a date.
- agency: a NAMED person wants, fears, decides, refuses, bets, insists or chooses something in this line ("Elop decided to bet everything on Microsoft." / "Ollila feared the engineers would revolt."). A company acting without a person is not agency; an outcome happening to someone is not agency.
Mark both strictly. Most lines are neither.
Also date each line: year = the year the line's events happen (said in the line, or known from the dated facts given or general knowledge: "Then the iPhone arrived" is 2007); toYear = the last year of the events if the line itself covers several years ("Apple launched the iPhone and Nokia hired Elop" = 2007 → 2010), else the same as year. 0 when it cannot be dated (a general explanation).`;
const SceneOut = z.object({ lines: z.array(z.object({ i: z.number(), moment: z.boolean(), agency: z.boolean(), year: z.number(), toYear: z.number() })) });

/** One Haiku call per 60 lines; unlabelled lines count as neither. */
export async function labelSceneLines(lines: string[], datedFacts: string[] = []): Promise<SceneLabel[]> {
  const out: SceneLabel[] = lines.map(() => ({ moment: false, agency: false }));
  const parts: Array<{ from: number; items: string[] }> = [];
  for (let i = 0; i < lines.length; i += 60) parts.push({ from: i, items: lines.slice(i, i + 60) });
  await Promise.all(parts.map(async (p) => {
    const r = await structured({ stage: "story.scenes", model: ROLE_MODEL.labels, system: [plain(SCENE_SYSTEM)], user: `${datedFacts.length ? `DATED FACTS (for dating lines):\n${datedFacts.slice(0, 40).join("\n")}\n\n` : ""}${p.items.map((t, k) => `[${k}] ${t.slice(0, 400)}`).join("\n")}`, schema: SceneOut, effort: "low", maxTokens: 4000 }).catch(() => null);
    for (const l of r?.data.lines ?? []) if (l.i >= 0 && l.i < p.items.length) out[p.from + l.i] = { moment: l.moment, agency: l.agency, ...(l.year >= 1600 && l.year <= 2099 ? { year: Math.round(l.year), toYear: Math.round(l.toYear >= l.year && l.toYear <= 2099 ? l.toYear : l.year) } : {}) };
  }));
  return out;
}

// ---- time (item 7), in code

const YEAR = /\b(1[6-9]\d\d|20\d\d)\b/g;
const BRIDGE = /\b((\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|a few|several|many|some)\s+(more\s+)?(years?|decades?|months?)\s+(later|after|on|passed|went by|of|before)|for the next\s+\w+|over the next\s+\w+|in the years that followed|years went by|fast[- ]forward|meanwhile|by then|until then|since then|all the while|throughout|during (those|that|the next)|we need to go back|let's go back|back in|rewind)\b/i;
export const yearsIn = (t: string) => [...t.matchAll(YEAR)].map((m) => Number(m[1])).filter((y) => y >= 1600 && y <= 2099);

export interface TimeJump { line: number; from: number; to: number; years: number; inside: boolean }
/**
 * Forward jumps of more than `minYears` with no bridge: between the story's current year and the next year a line
 * names (the current year carries over lines that name none), or inside one line that names two years. A backward
 * jump (a flashback) is not counted.
 */
export function timeJumps(lines: string[], minYears = 2, scene?: SceneLabel[]): TimeJump[] {
  const out: TimeJump[] = [];
  let cur: number | null = null;
  lines.forEach((t, i) => {
    // the years the line says, else the years its events happen (labelled)
    const said = yearsIn(t);
    const lab = scene?.[i];
    const ys = said.length ? said : lab?.year ? [lab.year, ...(lab.toYear && lab.toYear !== lab.year ? [lab.toYear] : [])] : [];
    if (!ys.length) return;
    // a moment AT the new year does not tell what happened in between: only a bridge does
    const bridged = BRIDGE.test(t) || (i > 0 && BRIDGE.test(lines[i - 1]!));
    const span = Math.max(...ys) - Math.min(...ys);
    if (ys.length >= 2 && ys[ys.length - 1]! > ys[0]! && span > minYears && !BRIDGE.test(t)) out.push({ line: i, from: ys[0]!, to: ys[ys.length - 1]!, years: span, inside: true });
    else if (cur !== null && ys[0]! - cur > minYears && !bridged) out.push({ line: i, from: cur, to: ys[0]!, years: ys[0]! - cur, inside: false });
    cur = ys[ys.length - 1]!;
  });
  return out;
}

// ---- filler (item 6): learned as the phrases the reference never uses

/** Narrator phrases that point at the story instead of telling it — candidates only; the reference decides. */
const FILLER_SEED = [
  "it sounds absurd", "this is the story of", "in other words", "let that sink in", "here's the thing", "make no mistake", "it's worth noting", "needless to say", "simply put",
  "to put it simply", "believe it or not", "plot twist", "this is where things get interesting", "here's where it gets", "and that's exactly what", "it's no exaggeration", "at the end of the day",
  "the truth is", "it's important to understand", "it's hard to overstate", "it cannot be overstated", "this is a story about", "this is the tale of", "what happened next", "spoiler alert",
  "it sounds crazy", "it sounds strange", "it might sound", "as it turns out", "little did they know", "the rest is history", "in a nutshell", "the irony is", "ironically enough",
  "fair to say", "suffice it to say", "the bottom line is", "it goes without saying", "this begs the question", "let's dive in", "let's break it down", "buckle up",
];

export interface FillerBan { schemaVersion: 1; channel: string; lines: number; banned: string[]; allowed: Array<{ phrase: string; per1000: number }> }

/**
 * A candidate phrase is banned when the channel's real narrations use it at most once in ~3,000 lines. Candidates are
 * the seed list plus the sentence openings our own past scripts leaned on (out/<job>/script.draft.json).
 */
export async function ensureFillerBan(o: { data: string; root: string; channelId: string; films: ReferenceFilm[]; fresh?: boolean }): Promise<FillerBan> {
  const f = path.join(o.data, "story-profile", `${o.channelId}-filler.json`);
  if (!o.fresh && existsSync(f)) return JSON.parse(await readFile(f, "utf8")) as FillerBan;
  const real = o.films.flatMap((x) => x.lines).map((l) => ` ${l.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ")} `);
  const cands = new Set(FILLER_SEED);
  // the openings of our own past sentences (3–4 words) that are narrator talk, not events: they contain no name/figure
  const outDir = path.join(o.root, "out");
  for (const j of await readdir(outDir).catch(() => [] as string[])) {
    const d = await readFile(path.join(outDir, j, "script.draft.json"), "utf8").then((t) => JSON.parse(t) as { segments?: Array<{ text: string }> }, () => null);
    for (const sg of d?.segments ?? [])
      for (const s of sg.text.split(/(?<=[.!?])\s+/)) {
        const w = s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' ]+/g, " ").trim().split(/\s+/);
        if (w.length >= 6 && /^(it|this|that|here|what|and|but|so|which|in|the)$/.test(w[0]!) && !/[A-Z0-9]/.test(s.split(/\s+/).slice(1, 4).join(" "))) cands.add(w.slice(0, 4).join(" "));
      }
  }
  const per1000 = (p: string) => (real.filter((l) => l.includes(` ${p} `)).length / Math.max(1, real.length)) * 1000;
  const scored = [...cands].map((p) => ({ phrase: p, per1000: Math.round(per1000(p) * 100) / 100 }));
  const limit = 0.34; // at most once in ~3,000 real lines
  const ban: FillerBan = { schemaVersion: 1, channel: o.channelId, lines: real.length, banned: scored.filter((s) => s.per1000 <= limit && FILLER_SEED.includes(s.phrase)).map((s) => s.phrase).sort(), allowed: scored.filter((s) => s.per1000 > limit).sort((a, b) => b.per1000 - a.per1000) };
  // our own openings are banned only when the reference never opens a sentence that way AND they are narrator talk
  for (const s of scored) if (!FILLER_SEED.includes(s.phrase) && s.per1000 === 0 && /^(it|this|here|what) (is|was|sounds|seems|turns|gets|happened)\b/.test(s.phrase)) ban.banned.push(s.phrase);
  ban.banned = [...new Set(ban.banned)].sort();
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify(ban, null, 1) + "\n");
  await rename(f + ".tmp", f);
  return ban;
}

export function fillerIn(lines: string[], ban: FillerBan): Array<{ line: number; phrase: string }> {
  const out: Array<{ line: number; phrase: string }> = [];
  lines.forEach((l, i) => {
    const t = ` ${l.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ")} `;
    for (const p of ban.banned) if (t.includes(` ${p} `)) out.push({ line: i, phrase: p });
  });
  return out;
}

// ---- openings and endings (item 9)

const EndOut = z.object({ ending: z.enum(["consequence", "restatement", "twist", "question", "other"]), why: z.string() });
/** How a narration ends, judged against how it opened: a consequence or twist lands; a restatement repeats the opening. */
export async function endingKind(opening: string[], ending: string[]): Promise<{ kind: z.infer<typeof EndOut>["ending"]; why: string }> {
  const r = await structured({ stage: "story.ending", model: ROLE_MODEL.labels, system: [plain("You judge how a documentary narration ENDS. consequence = the last lines land what the story led to (an outcome, a cost, what it means now) that was not already said; twist = a final reveal; question = it closes on a question to the viewer; restatement = the last lines mostly repeat the opening's idea or phrase ('the platform had burned, just as the memo said'); other = none of these.")], user: `OPENING:\n${opening.join("\n")}\n\nENDING:\n${ending.join("\n")}`, schema: EndOut, effort: "low", maxTokens: 600 }).catch(() => null);
  return r ? { kind: r.data.ending, why: r.data.why } : { kind: "other", why: "" };
}

// ---- the profile of one narration window, and the channel's band at a length

export interface SceneProfile { lines: number; moment: number; agency: number; jumpsPer10: number; jumps: TimeJump[]; filler: Array<{ line: number; phrase: string }>; opensOnMoment: boolean; ending?: string }

export function sceneProfile(lines: string[], labels: SceneLabel[], ban: FillerBan | null, openLines: number): SceneProfile {
  const n = Math.max(1, lines.length);
  const jumps = timeJumps(lines, 2, labels);
  return {
    lines: lines.length,
    moment: Math.round((labels.filter((l) => l.moment).length / n) * 1000) / 1000,
    agency: Math.round((labels.filter((l) => l.agency).length / n) * 1000) / 1000,
    jumpsPer10: Math.round((jumps.length / n) * 10 * 100) / 100,
    jumps,
    filler: ban ? fillerIn(lines, ban) : [],
    opensOnMoment: labels.slice(0, Math.max(1, openLines)).some((l) => l.moment),
  };
}

type Range = { p10: number; p25: number; p50: number; p90: number };
const rangeOf = (xs: number[]): Range => {
  const v = [...xs].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0;
  return { p10: q(0.1), p25: q(0.25), p50: q(0.5), p90: q(0.9) };
};
export interface SceneBand { schemaVersion: 1; channel: string; lengthS: number; windows: number; wordsPerSecond: number; moment: Range; agency: Range; jumpsPer10: Range; opensOnMoment: number; endings: Record<string, number> }

/** The channel's words per second of narration (from the reference index) — used only to cut real windows. */
async function channelWordsPerSecond(data: string, channel: string): Promise<number> {
  const ix = await loadReferenceIndex(data);
  const sh = ix?.shots.filter((s) => s.channel === channel) ?? [];
  const w = sh.reduce((a, s) => a + s.words, 0);
  const t = sh.reduce((a, s) => a + (s.t1 - s.t0), 0);
  return t > 60 ? w / t : 3.2;
}
const wordsOf = (l: string) => l.split(/\s+/).filter(Boolean).length;
/** The lines of a window of `words` words starting at line `from`. */
const windowAt = (lines: string[], from: number, words: number) => {
  const out: string[] = [];
  let n = 0;
  for (let i = from; i < lines.length && n < words; i++) (out.push(lines[i]!), (n += wordsOf(lines[i]!)));
  return out;
};
const windowEnding = (lines: string[], words: number) => {
  const out: string[] = [];
  let n = 0;
  for (let i = lines.length - 1; i >= 0 && n < words; i--) (out.unshift(lines[i]!), (n += wordsOf(lines[i]!)));
  return out;
};
export const openingLineCount = (lines: string[], words: number) => {
  let n = 0;
  let k = 0;
  while (k < lines.length && n < words) n += wordsOf(lines[k++]!);
  return Math.max(1, k);
};

/** The band at the film's length: windows of real narration (openings, middles and endings of real films). */
export async function ensureSceneBand(o: { data: string; channelId: string; films: ReferenceFilm[]; lengthS: number; fresh?: boolean; log?: (s: string) => void }): Promise<SceneBand | null> {
  const L = lengthBucket(o.lengthS);
  const f = path.join(o.data, "story-profile", `${o.channelId}-scenes-${L}s.json`);
  if (!o.fresh && existsSync(f)) return JSON.parse(await readFile(f, "utf8")) as SceneBand;
  const wps = await channelWordsPerSecond(o.data, o.channelId);
  const W = Math.round(L * wps);
  const openW = Math.round(Math.min(20, L / 4) * wps);
  const films = [...o.films].filter((x) => x.lines.length >= 30).sort((a, b) => createHash("sha1").update(a.id).digest("hex").localeCompare(createHash("sha1").update(b.id).digest("hex"))).slice(0, 12);
  if (films.length < 5) return null;
  o.log?.(`  scene band: ${films.length} real films, windows of ${L} s (${W} words)…`);
  const profiles: SceneProfile[] = [];
  const opens: boolean[] = [];
  const ends: string[] = [];
  await Promise.all(films.map(async (fm) => {
    const head = windowAt(fm.lines, 0, W);
    const mid = windowAt(fm.lines, Math.floor(fm.lines.length / 2), W);
    const tail = windowEnding(fm.lines, W);
    for (const [k, w] of [head, mid, tail].entries()) {
      const lab = await labelSceneLines(w);
      const p = sceneProfile(w, lab, null, openingLineCount(w, openW));
      profiles.push(p);
      if (k === 0) opens.push(p.opensOnMoment);
    }
    ends.push((await endingKind(windowAt(fm.lines, 0, openW), windowEnding(fm.lines, openW))).kind);
  }));
  const endings: Record<string, number> = {};
  for (const e of ends) endings[e] = Math.round(((endings[e] ?? 0) + 1 / ends.length) * 1000) / 1000;
  const band: SceneBand = { schemaVersion: 1, channel: o.channelId, lengthS: L, windows: profiles.length, wordsPerSecond: Math.round(wps * 100) / 100, moment: rangeOf(profiles.map((p) => p.moment)), agency: rangeOf(profiles.map((p) => p.agency)), jumpsPer10: rangeOf(profiles.map((p) => p.jumpsPer10)), opensOnMoment: Math.round((opens.filter(Boolean).length / Math.max(1, opens.length)) * 1000) / 1000, endings };
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify(band, null, 1) + "\n");
  await rename(f + ".tmp", f);
  return band;
}

export interface SceneIssue { kind: "scene_low" | "character_low" | "filler" | "time_skip" | "opening_no_moment" | "ending_restates" | "dossier_unused"; detail: string; lines: number[] }

/**
 * What a draft misses against the channel at its length. One line is several per cent of a short script, so each
 * limit carries a tolerance of one line. The dossier check holds the writer to the research: when the dossier has
 * moments, at least one (two in a film of two minutes or more) must be told.
 */
export function sceneIssues(o: { lines: string[]; labels: SceneLabel[]; band: SceneBand; ban: FillerBan | null; openLines: number; ending?: { kind: string; why: string } | null; dossierMoments?: Array<{ what: string; when: string; where: string }>; durationS: number }): { profile: SceneProfile; issues: SceneIssue[] } {
  const p = sceneProfile(o.lines, o.labels, o.ban, o.openLines);
  const n = Math.max(1, o.lines.length);
  const tol = 1 / n;
  const pc = (x: number) => `${Math.round(x * 100)} %`;
  const issues: SceneIssue[] = [];
  const not = (k: keyof SceneLabel) => o.labels.map((l, i) => (l[k] ? -1 : i)).filter((i) => i >= 0);
  const lo = (r: Range) => (r.p25 ?? r.p10) || r.p50 / 2;
  if (p.moment < lo(o.band.moment) - tol) issues.push({ kind: "scene_low", detail: `only ${pc(p.moment)} of the lines put the viewer in a MOMENT (a person, a place, a time, doing something); the channel's real ${o.band.lengthS}-second stretches run ${pc(lo(o.band.moment))}–${pc(o.band.moment.p90)}. Tell the story through moments from the fact sheet's scenes: who, where, when, doing what — not a summary of what happened.`, lines: not("moment").slice(0, 6) });
  if (p.agency < lo(o.band.agency) - tol) issues.push({ kind: "character_low", detail: `only ${pc(p.agency)} of the lines show a named person wanting, fearing or deciding something; the channel runs ${pc(lo(o.band.agency))}–${pc(o.band.agency.p90)}. Give the people in the fact sheet their wants and decisions (only as the facts state them, or hedged).`, lines: not("agency").slice(0, 6) });
  if (p.filler.length) issues.push({ kind: "filler", detail: `narrator filler the channel never uses: ${[...new Set(p.filler.map((x) => `"${x.phrase}"`))].join(", ")}. Cut the pointing phrase and tell the thing itself.`, lines: p.filler.map((x) => x.line) });
  const allowJumps = Math.max(o.band.jumpsPer10.p90, 0) * (n / 10) + 0.5;
  if (p.jumps.length > allowJumps) issues.push({ kind: "time_skip", detail: `the story skips time without a bridge ${p.jumps.length} time(s): ${p.jumps.slice(0, 4).map((j) => `${j.from}→${j.to}${j.inside ? " inside one sentence" : ""}`).join(", ")}. Real films of the channel do this at most ${o.band.jumpsPer10.p90.toFixed(1)} times per 10 lines. What happened in those years is often the story: bridge it ("for the next three years…") or tell it as a moment.`, lines: p.jumps.map((j) => j.line) });
  if (o.band.opensOnMoment >= 0.5 && !p.opensOnMoment) issues.push({ kind: "opening_no_moment", detail: `the opening does not put the viewer in a moment; ${pc(o.band.opensOnMoment)} of the channel's real films open on one within their first ${Math.round(Math.min(20, o.durationS / 4))} s. Open on a person in a place at a time, doing something, from the fact sheet's scenes.`, lines: [0] });
  const restatesShare = o.band.endings.restatement ?? 0;
  if (o.ending?.kind === "restatement" && restatesShare < 0.25) issues.push({ kind: "ending_restates", detail: `the ending restates the opening (${o.ending.why}); only ${pc(restatesShare)} of the channel's films end that way. Land a consequence: what the story led to, what it cost, what it means now.`, lines: [n - 1] });
  if (o.dossierMoments?.length) {
    const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 4));
    const text = words(o.lines.join(" "));
    const used = o.dossierMoments.filter((m) => {
      const w = [...words(`${m.what} ${m.where}`)];
      return w.length && w.filter((x) => text.has(x)).length / w.length >= 0.34;
    });
    const need = Math.min(o.dossierMoments.length, o.durationS >= 120 ? 2 : 1);
    if (used.length < need) issues.push({ kind: "dossier_unused", detail: `the research found ${o.dossierMoments.length} moment(s) for this film and the script tells ${used.length}: ${o.dossierMoments.slice(0, 4).map((m) => `${m.when}, ${m.where}: ${m.what}`).join(" | ")}. Build the film from them.`, lines: [] });
  }
  return { profile: p, issues };
}
