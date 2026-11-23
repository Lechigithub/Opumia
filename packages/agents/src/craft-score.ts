/**
 * Build list 5, item 4: a craft score per agent against the reference, measured at the film's OWN length.
 *
 * Each craft (story, picture, edit, voice, sound, look, packaging) is scored two ways:
 *  1. **Its own measures against real stretches of the same length.** `referenceStretches` cuts a fixed set of real
 *     windows of exactly the film's length out of the channel's films (the opening, the middle and the run-in to the
 *     ending of each film long enough), deterministically, so the set never changes between runs. The craft's measure
 *     function runs on each real stretch and on ours; the band is the real stretches' p10–p90. The score is the share
 *     of measures inside the band, with partial credit by distance outside it.
 *  2. **A blind pairwise judge for that craft alone** (`judgeCraftPair`): ours beside one real stretch, A/B in a
 *     seeded order, the judge names the imitation. Realness = 1 − P(ours picked).
 *
 * The agents' own measure functions are registered here (`CRAFT_MEASURES`), so the score, the agent's tools and the
 * gate all read the same numbers. A change to an agent is kept only if its craft score improves (`craftHistory`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelId } from "@opumia/contracts";
import type { ReferenceShot } from "@opumia/ingest";
import * as z from "zod/v4";
import { flat, measure, type Band } from "./channel-profile.js";
import { MODELS, plain, structured } from "./llm.js";
import { loadReferenceIndex } from "./reference-index.js";

export const CRAFTS = ["story", "picture", "edit", "voice", "sound", "look", "packaging"] as const;
export type Craft = (typeof CRAFTS)[number];
/** Which agent owns each craft. */
export const CRAFT_OWNER: Record<Craft, string> = { story: "writer", picture: "scene designer", edit: "editor", voice: "voice director", sound: "sound designer", look: "colourist", packaging: "packaging" };

/** One stretch of a film: its shots (reference-index rows), its strong hits and the words spoken in it. */
export interface Stretch { film: string; fromS: number; toS: number; position: "opening" | "middle" | "ending"; shots: ReferenceShot[]; hits: Array<{ t: number; cls?: string }>; words: string }

export type CraftMeasureFn = (s: Stretch) => Record<string, number> | Promise<Record<string, number>>;

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]! : NaN;
};
export const bandOfValues = (xs: number[]): Band => ({ p10: r3(pct(xs, 0.1)), median: r3(pct(xs, 0.5)), p90: r3(pct(xs, 0.9)) });

/** Length buckets: stretches are cut at the nearest bucket so bands can be cached and shared between films. */
export const LENGTH_BUCKETS = [20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800];
export const lengthBucket = (s: number) => LENGTH_BUCKETS.reduce((b, x) => (Math.abs(x - s) < Math.abs(b - s) ? x : b), LENGTH_BUCKETS[0]!);

/** Shot-only measures every craft can use: the same `measure()` the channel profile uses, at the stretch's length. */
export function shotMeasures(s: Stretch): Record<string, number> {
  return flat(measure(s.shots, s.hits, Math.max(1, s.toS - s.fromS)));
}

/** Built-in measures for the crafts read from shot rows; agents add their own (story labels, voice, look…). */
export const CRAFT_MEASURES: Partial<Record<Craft, CraftMeasureFn>> = {
  edit: (s) => {
    const m = shotMeasures(s);
    const len = s.shots.map((x) => x.t1 - x.t0).sort((a, b) => a - b);
    const still = s.shots.filter((x) => x.motion < 2 && x.t1 - x.t0 > 2.5).length / Math.max(1, s.shots.length);
    return { cutsPerMin: m.cutsPerMin!, shotMedianS: m.shotMedianS!, shotCv: m.shotCv!, shotP90S: r3(pct(len, 0.9)), cutInPause: m.cutInPause!, cutToWordMedianS: m.cutToWordMedianS!, softTransitions: m.softTransitions!, stillHolds: r3(still) };
  },
  sound: (s) => {
    const m = shotMeasures(s);
    const minutes = Math.max(1e-6, (s.toS - s.fromS) / 60);
    const drops = s.shots.filter((x) => x.musicDrop).length / minutes;
    const cues = s.shots.filter((x) => x.cueChange).length / minutes;
    return { hitsPerMin: m.hitsPerMin!, hitOnCutShare: m.hitOnCutShare!, musicDropsPerMin: r3(drops), cueChangesPerMin: r3(cues) };
  },
  look: (s) => {
    const m = shotMeasures(s);
    return { sat: m.sat!, luma: m.luma!, contrast: m.contrast! };
  },
  picture: (s) => {
    const m = shotMeasures(s);
    const txt = s.shots.filter((x) => x.overlay === "text_slam");
    return {
      designed: m["picture.designed"] ?? 0, stockActor: m["picture.stock_actor"] ?? 0, stockBroll: m["picture.stock_broll"] ?? 0,
      realFootage: (m["picture.real_footage"] ?? 0) + (m["picture.real_photo"] ?? 0), textSlam: m.textSlam!,
      textAreaWhenText: r3(pct(txt.map((x) => x.textArea), 0.5) || 0),
    };
  },
};

/**
 * A fixed set of real stretches of `lengthS` from the channel's films: per film long enough, the opening, the middle
 * and the stretch that ends 5 % before its end — at most `n`, chosen deterministically (by a hash of the film id).
 */
export async function referenceStretches(o: { data: string; channel: ChannelId; lengthS: number; n?: number }): Promise<Stretch[]> {
  const ix = await loadReferenceIndex(o.data);
  if (!ix) return [];
  const L = o.lengthS;
  const audio = await readFile(path.join(o.data, "reference-index", "audio.jsonl"), "utf8").then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { film: string; hits: Array<{ t: number; cls: string; peak: number }> }), () => []);
  const strong = (cls: string) => /thud|boom|impact|hit|riser/.test(cls);
  const films = ix.manifest.films.filter((f) => f.channel === o.channel && f.durS >= L * 1.2).sort((a, b) => createHash("sha1").update(a.id).digest("hex").localeCompare(createHash("sha1").update(b.id).digest("hex")));
  const byFilm = new Map<string, ReferenceShot[]>();
  for (const s of ix.shots) if (s.channel === o.channel) (byFilm.get(s.film) ?? byFilm.set(s.film, []).get(s.film)!).push(s);
  const out: Stretch[] = [];
  const n = o.n ?? 12;
  for (const pos of ["opening", "middle", "ending"] as const)
    for (const f of films) {
      if (out.length >= n * 3) break;
      const shots = byFilm.get(f.id) ?? [];
      if (shots.length < 4) continue;
      const fromS = pos === "opening" ? 0 : pos === "middle" ? Math.max(0, f.durS / 2 - L / 2) : Math.max(0, f.durS * 0.95 - L);
      const toS = fromS + L;
      const inS = shots.filter((s) => s.t0 >= fromS - 0.01 && s.t0 < toS).map((s) => ({ ...s, t0: s.t0 - fromS, t1: Math.min(s.t1, toS) - fromS }));
      const hits = (audio.find((a) => a.film === f.id)?.hits ?? []).filter((h) => h.t >= fromS && h.t < toS && strong(h.cls)).map((h) => ({ t: h.t - fromS, cls: h.cls }));
      out.push({ film: f.id, fromS, toS, position: pos, shots: inS, hits, words: inS.map((s) => s.line).join(" ") });
    }
  // interleave positions, cap at n
  const pick: Stretch[] = [];
  for (let i = 0; pick.length < n && i < out.length; i++) {
    const p = ["opening", "middle", "ending"][i % 3]!;
    const next = out.find((s) => s.position === p && !pick.includes(s));
    if (next) pick.push(next);
    else if (!out.some((s) => !pick.includes(s))) break;
  }
  return pick;
}

export interface CraftBandFile { craft: Craft; channel: string; lengthS: number; stretches: number; films: string[]; bands: Record<string, Band>; builtAt: string }

/** The band of a craft's measures over the real stretches at this length, cached in data/craft-bands/. */
export async function craftBand(o: { data: string; channel: ChannelId; craft: Craft; lengthS: number; measure?: CraftMeasureFn; version?: string; n?: number; fresh?: boolean }): Promise<CraftBandFile | null> {
  const L = lengthBucket(o.lengthS);
  const f = path.join(o.data, "craft-bands", o.channel, `${o.craft}${o.version ? `-${o.version}` : ""}-${L}s.json`);
  if (!o.fresh && existsSync(f)) return JSON.parse(await readFile(f, "utf8")) as CraftBandFile;
  const fn = o.measure ?? CRAFT_MEASURES[o.craft];
  if (!fn) return null;
  const st = await referenceStretches({ data: o.data, channel: o.channel, lengthS: L, ...(o.n ? { n: o.n } : {}) });
  if (st.length < 4) return null;
  const rows: Array<Record<string, number>> = [];
  for (const s of st) rows.push(await fn(s));
  const keys = [...new Set(rows.flatMap((x) => Object.keys(x)))];
  const bands = Object.fromEntries(keys.map((k) => [k, bandOfValues(rows.map((x) => x[k]!).filter((v) => v !== undefined))]));
  const out: CraftBandFile = { craft: o.craft, channel: o.channel, lengthS: L, stretches: st.length, films: [...new Set(st.map((s) => s.film))], bands, builtAt: new Date().toISOString() };
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify(out, null, 1) + "\n");
  await rename(f + ".tmp", f);
  return out;
}

export interface CraftScore { craft: Craft; owner: string; lengthS: number; score: number; inBand: number; measures: number; outside: Array<{ key: string; ours: number; band: Band; off: number }>; judge?: { realness: number; tells: string[] } }

/**
 * Score ours against a band: each measure inside p10–p90 counts 1, outside it loses credit by how far it is out in
 * units of the band's width (0 at one full width away). Score 0–100.
 */
export function scoreAgainst(craft: Craft, ours: Record<string, number>, band: CraftBandFile): CraftScore {
  const outside: CraftScore["outside"] = [];
  let credit = 0;
  let n = 0;
  for (const [k, b] of Object.entries(band.bands)) {
    const v = ours[k];
    if (v === undefined || !Number.isFinite(v) || !Number.isFinite(b.p10)) continue;
    n++;
    const w = Math.max(1e-6, b.p90 - b.p10, Math.abs(b.median) * 0.1);
    const off = v < b.p10 ? (b.p10 - v) / w : v > b.p90 ? (v - b.p90) / w : 0;
    credit += Math.max(0, 1 - off);
    if (off > 0) outside.push({ key: k, ours: r3(v), band: b, off: r3(off) });
  }
  outside.sort((a, b) => b.off - a.off);
  return { craft, owner: CRAFT_OWNER[craft], lengthS: band.lengthS, score: n ? Math.round((credit / n) * 100) : 0, inBand: n - outside.length, measures: n, outside };
}

/** Whether a craft score is "in the channel's band": the share of real stretches that score at least this high. */
export async function realScoreFloor(o: { data: string; channel: ChannelId; craft: Craft; lengthS: number; measure?: CraftMeasureFn }): Promise<number | null> {
  const band = await craftBand(o);
  if (!band) return null;
  const fn = o.measure ?? CRAFT_MEASURES[o.craft];
  if (!fn) return null;
  const st = await referenceStretches({ data: o.data, channel: o.channel, lengthS: band.lengthS });
  const scores: number[] = [];
  for (const s of st) scores.push(scoreAgainst(o.craft, await fn(s), band).score);
  // the lowest tenth of the channel's own stretches is the floor ours must reach
  return pct(scores, 0.1);
}

// ---- blind pairwise judge, one craft at a time

/** What the judge sees for one side: text (story, or a described timeline) and/or images (frames, contact sheets). */
export interface CraftSide { text?: string; images?: string[] }
const JudgeOut = z.object({ imitation: z.enum(["A", "B"]), confidence: z.number().describe("0–1"), tells: z.array(z.string()).describe("concrete things in the imitation's craft that gave it away") });
const CRAFT_BRIEF: Record<Craft, string> = {
  story: "the storytelling: whether it puts you in a moment with a person who wants something, keeps time, and earns its ending — not the topic",
  picture: "the picture design: backdrops, treatment of pictures, type scale and integration, what is chosen to be seen",
  edit: "the cutting: shot lengths and their variety, where cuts land against the words, holds, transitions",
  voice: "whether the narration sounds like a human telling a story (stress, melody, pauses, tone shifts) — never its speed",
  sound: "the sound design: where hits land, music changes, drop-outs, silence",
  look: "the colour and light: grade, brightness, saturation, how stock is pulled into one look",
  packaging: "the title and thumbnail idea: whether it promises a person or a turn and reads at phone size",
};

async function image(f: string): Promise<Anthropic.Beta.BetaImageBlockParam> {
  const ext = path.extname(f).toLowerCase();
  return { type: "image", source: { type: "base64", media_type: ext === ".png" ? "image/png" : "image/jpeg", data: (await readFile(f)).toString("base64") } };
}

/** One blind A/B: ours beside one real stretch of the same length. Realness 0–1 (0.5 = the judge could not tell). */
export async function judgeCraftPair(o: { channel: string; craft: Craft; ours: CraftSide; real: CraftSide; seed: string }): Promise<{ realness: number; picked: boolean; tells: string[]; usd: number }> {
  const oursFirst = parseInt(createHash("sha1").update(o.seed).digest("hex").slice(0, 2), 16) % 2 === 0;
  const [A, B] = oursFirst ? [o.ours, o.real] : [o.real, o.ours];
  const user: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [label, side] of [["A", A], ["B", B]] as const) {
    user.push({ type: "text", text: `${label}:${side.text ? `\n${side.text}` : ""}` });
    for (const f of side.images ?? []) if (existsSync(f)) user.push(await image(f));
  }
  user.push({ type: "text", text: `One of these is from a real film of the channel, the other is an imitation made by another studio. Judge ONLY ${CRAFT_BRIEF[o.craft]}. Which is the imitation?` });
  const model = o.craft === "story" || o.craft === "picture" || o.craft === "packaging" ? MODELS.sonnet : MODELS.haiku;
  const r = await structured({ stage: `craft.judge.${o.craft}`, model, system: [plain(`You have worked for years on the YouTube documentary channel ${o.channel} and know its craft closely.`)], user, schema: JudgeOut, effort: "low", maxTokens: 1200 });
  const pickedOurs = (r.data.imitation === "A") === oursFirst;
  const c = Math.max(0.5, Math.min(1, r.data.confidence));
  const pOurs = pickedOurs ? c : 1 - c;
  return { realness: r3(1 - pOurs), picked: pickedOurs, tells: pickedOurs ? r.data.tells : [], usd: r.usage.usd };
}

/** A craft's score history: a change to an agent is kept only if its craft score at this length improves. */
export async function craftHistory(o: { data: string; channel: string; job: string; scores: CraftScore[]; platform?: string }): Promise<void> {
  const f = path.join(o.data, "craft-scores", `${o.channel}.jsonl`);
  await mkdir(path.dirname(f), { recursive: true });
  await appendFile(f, JSON.stringify({ at: new Date().toISOString(), job: o.job, platform: o.platform ?? null, scores: o.scores.map((s) => ({ craft: s.craft, lengthS: s.lengthS, score: s.score, realness: s.judge?.realness ?? null })) }) + "\n");
}

/** The best earlier score for a craft at a length (what a change has to beat). */
export async function bestCraftScore(data: string, channel: string, craft: Craft, lengthS: number): Promise<number | null> {
  const f = path.join(data, "craft-scores", `${channel}.jsonl`);
  const t = await readFile(f, "utf8").catch(() => "");
  let best: number | null = null;
  for (const l of t.split("\n").filter(Boolean)) {
    const row = JSON.parse(l) as { scores: Array<{ craft: string; lengthS: number; score: number }> };
    for (const s of row.scores) if (s.craft === craft && lengthBucket(s.lengthS) === lengthBucket(lengthS)) best = Math.max(best ?? 0, s.score);
  }
  return best;
}
