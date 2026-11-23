import { createHash } from "node:crypto";
import type { AssetRecord, ScenePlan, Storyboard, StoryboardShot, StyleProfile, TimedScript } from "@opumia/contracts";
import { buildCutTimeline, type CutTimeline } from "./cut-timeline.js";
import { moodOfTitle, sfxCap, storyMusicPlan, type Mood, type MusicRates } from "./sound-design.js";

/**
 * Timeline sound designer (no model call): sound is placed on what the viewer SEES, after the scenes are final.
 *
 *  - Events come from the finished timeline: a stamp landing, a headline popping, 3D type arriving, a data
 *    graphic opening, a story turn. Each event asks for a sound FAMILY (measured character, not a file).
 *  - Budget and mix follow the reference channel: ~3 strong hits a minute, mostly low thuds and booms, a few
 *    clicks and risers, no whooshes; never two strong hits within 1.2 s.
 *  - Files are chosen from the measured character of every library effect, shuffled by the film (so two films
 *    never get the same hits in the same order), never repeated inside a film, and never one a recent film used.
 *  - The peak of the sound lands on the visual moment (start = moment − measured attack).
 *  - Music is chosen per span by mood AND measured tempo/pulse, off cooldown, entering after its quiet intro,
 *    with its beat grid aligned to the first strong hit.
 */
export interface SoundCharacterLike { seconds: number; peakDb: number; centroidHz: number; lowShare: number; attackS: number; energyCentre: number; family: string }
export interface MusicProfileLike { seconds: number; bpm: number; pulse: number; energyDb: number[]; beat: { offsetS: number; periodS: number }; brightnessHz: number }

export type SoundFamily = "sub_boom" | "thud" | "impact" | "click" | "riser" | "paper" | "typing" | "cash";
export interface VisualEvent { atS: number; family: SoundFamily; prio: number; strong: boolean; why: string }

const seeded = (seed: string) => (id: string) => parseInt(createHash("sha1").update(`${seed}|${id}`).digest("hex").slice(0, 8), 16);
/** Library class names that mean a specific real-world sound (used only when the picture asks for exactly that). */
const CLASS_FAMILY: Array<[RegExp, SoundFamily]> = [
  [/^(paper|page_turn|newspaper_page|paper_slide)$/, "paper"],
  [/^(typing_burst|typewriter|pencil_writing|pencil_scribble|pen_signing)$/, "typing"],
  [/^(cash_register|coins_handling)$/, "cash"],
];
/**
 * Only designed hit sounds may be accent hits: unlabelled pool sounds and the hit classes. A literal object
 * noise (a tool dropping, a lock, a dish) is foley for a picture of that object, never a hit.
 */
const HIT_CLASS = /^(|boom\w*|impact\w*|bass_hit\w*|drum_\w+|stamp_thud|sub_drop|whoosh_hit|whoosh_deep_impact|click_pop|glass_hit_suspense|riser\w*|reverse_swell|swell_suspense)$/;
/** Ambiences, loops and literal noises are never accent hits. */
const NOT_A_HIT = /ambience|room_tone|crowd|rain|wind|train|war_|fire|frying|kettle|hum|projector|radio|restaurant|army|popcorn|toaster|microwave|oven|egg|dish|gas_stove|heartbeat|clock|machine|mechanical|electric/;

export interface SoundTimelineOptions {
  storyboard: Storyboard;
  script: TimedScript;
  scenes: ScenePlan;
  sfxAssets: AssetRecord[];
  musicAssets: AssetRecord[];
  sfxProfile: Record<string, SoundCharacterLike>;
  musicProfile: Record<string, MusicProfileLike>;
  profile: StyleProfile;
  /** Sounds and beds recent films used. */
  cooldown: { sfx: Set<string>; music: Set<string> };
  /** Film identity: makes this film's choices its own. */
  seed: string;
  /** The film kit's components by role (component name → role), for how hard each lands. */
  kitRoles?: Record<string, string>;
  /** Music drop-outs already designed for the cues (kept). */
  drops?: Array<{ startS: number; endS: number }>;
  /** Build list 5, item 22: the shared timeline of cuts, stressed words and story turns (built here when absent). */
  timeline?: CutTimeline;
  /** Build list 5, item 26: the channel's music-to-story rates at this film's length (craft band medians). */
  musicRates?: MusicRates;
  log?: (s: string) => void;
}

type Family = SoundFamily;
type Event = VisualEvent;
export const SOUND_FAMILIES: SoundFamily[] = ["sub_boom", "thud", "impact", "click", "riser", "paper", "typing", "cash"];
export const STRONG_FAMILIES = new Set<SoundFamily>(["sub_boom", "thud", "impact"]);

/** Step 1: the moments the viewer sees that may carry a sound (element entrances, data graphics, story turns). */
export function visualEvents(o: Pick<SoundTimelineOptions, "storyboard" | "script" | "scenes" | "kitRoles">): VisualEvent[] {
  const specOf = new Map(o.scenes.scenes.map((s) => [s.shotId, s]));
  const events: Event[] = [];
  for (const sh of o.storyboard.shots) {
    const src = sh.source;
    if (src.kind === "designed" && src.designed !== "scene") {
      const k = src.designed;
      if (k === "document") events.push({ atS: sh.startS + 0.1, family: "paper", prio: 2.5, strong: false, why: "document opens" });
      else events.push({ atS: sh.startS + 0.15, family: "thud", prio: 3, strong: true, why: `${k} opens` });
      continue;
    }
    const spec = specOf.get(sh.id);
    if (!spec) continue;
    for (const el of spec.elements) {
      const at = sh.startS + (el.at ?? 0);
      if (at > sh.endS - 0.25) continue;
      if (el.type === "card3d") events.push({ atS: at + 0.2, family: "thud", prio: 3.2, strong: true, why: "3D card" });
      else if (el.type === "cutout" || el.type === "photo") events.push({ atS: at + 0.12, family: "thud", prio: 2.2, strong: true, why: `${el.type} lands` });
      // a kit component lands: the kit's role sets the weight (a headline or number lands harder than a label)
      else if (el.type === "component") {
        const role = o.kitRoles?.[el.name] ?? "";
        const big = role === "headline" || role === "number" || role === "chapter";
        events.push({ atS: at + 0.12, family: role === "chapter" ? "sub_boom" : "thud", prio: big ? 4 : 2.8, strong: true, why: `${role || el.name} lands` });
      }
    }
  }
  // Story turns: the line after a twist or re-hook lands on a boom.
  for (const sg of o.script.segments) if ((sg.role === "twist" || sg.role === "rehook" || sg.role === "climax" || sg.role === "fall") && sg.startS > 2) events.push({ atS: sg.startS + 0.05, family: "sub_boom", prio: sg.role === "climax" ? 4.8 : 4.5, strong: true, why: `${sg.role} line` });
  return events.sort((a, b) => a.atS - b.atS);
}

const TARGET_PEAK: Record<Family, number> = { sub_boom: -7, thud: -8, impact: -8, click: -15, riser: -12, paper: -14, typing: -16, cash: -12 };
const WANT: Record<Mood, { bpm: [number, number]; pulse: number }> = { intrigue: { bpm: [70, 115], pulse: 0.15 }, rise: { bpm: [100, 140], pulse: 0.3 }, tension: { bpm: [85, 135], pulse: 0.25 }, collapse: { bpm: [60, 105], pulse: 0.1 }, resolve: { bpm: [70, 115], pulse: 0.15 } };

/** Steps 3–4 as tools: pick a file for a family, set its level and placement, rank beds for a span, enter a bed on the beat. */
export function soundKit(o: SoundTimelineOptions) {
  const rnd = seeded(o.seed);
  const cls = (a: AssetRecord) => String(a.facets.class ?? "");
  const all = o.sfxAssets.filter((a) => o.sfxProfile[a.id]);
  const pool = (fam: Family): AssetRecord[] => {
    let list: AssetRecord[];
    const specific = CLASS_FAMILY.filter(([, f]) => f === fam);
    if (specific.length) list = all.filter((a) => specific.some(([re]) => re.test(cls(a))));
    else
      list = all.filter((a) => {
        const p = o.sfxProfile[a.id]!;
        if (!HIT_CLASS.test(cls(a)) || NOT_A_HIT.test(cls(a)) || CLASS_FAMILY.some(([re]) => re.test(cls(a)))) return false;
        if (fam === "impact" && cls(a) === "stamp_thud") return true;
        if (fam === "riser") return p.family === "riser" && p.seconds <= 7;
        if (fam === "click") return p.family === "click" || (p.seconds < 0.6 && p.centroidHz > 1500 && p.attackS < 0.15);
        if (p.seconds > 6 || p.attackS > 0.3) return false;
        if (fam === "sub_boom") return p.family === "sub_boom" || (p.lowShare > 0.45 && p.centroidHz < 400);
        if (fam === "thud") return p.family === "thud" || (p.family === "impact" && p.centroidHz < 1200);
        return p.family === "impact" || p.family === "thud";
      });
    return list.sort((a, b) => (fam === "impact" ? Number(cls(b) === "stamp_thud") - Number(cls(a) === "stamp_thud") : 0) || rnd(a.id) - rnd(b.id));
  };
  // Build list 5, item 27: fresh effects only. A file used in this film or by a recent film is never picked; when a
  // family runs dry, a neighbouring strong family is tried (thud ↔ impact ↔ sub_boom), and failing that the hit is not
  // placed — never a repeat (the Nokia film shared 67 % of its effects with a recent film through this fallback).
  const NEIGHBOURS: Partial<Record<Family, Family[]>> = { thud: ["impact", "sub_boom"], impact: ["thud", "sub_boom"], sub_boom: ["thud", "impact"], click: [], riser: [] };
  const pick = (fam: Family, used: Set<string>, skip = 0): AssetRecord | undefined => {
    const fresh = (f: Family) => pool(f).filter((a) => !used.has(a.id) && !o.cooldown.sfx.has(a.id));
    const own = fresh(fam);
    if (own[skip]) return own[skip];
    if (own.length) return own[own.length - 1];
    for (const f of NEIGHBOURS[fam] ?? []) {
      const n = fresh(f);
      if (n.length) return n[0];
    }
    // proof films: the short risers ran dry under the cooldown and the climax lost its riser — a longer riser (its tail
    // is what is heard: the lead into the moment is cut to 3.2 s) or a swell is fresh material too
    if (fam === "riser") {
      const longer = all.filter((a) => !used.has(a.id) && !o.cooldown.sfx.has(a.id) && (o.sfxProfile[a.id]!.family === "riser" || /reverse_swell|swell_suspense/.test(cls(a))));
      if (longer.length) return longer.sort((a, b) => rnd(a.id) - rnd(b.id))[0];
    }
    return undefined;
  };
  /** How many fresh files a family still has (for the agent's read-out). */
  const freshLeft = (fam: Family, used: Set<string>) => pool(fam).filter((a) => !used.has(a.id) && !o.cooldown.sfx.has(a.id)).length;
  const profileOf = (id: string) => o.sfxProfile[id];
  /** Start time so the peak lands on the moment, and the gain that brings it to the family's level. */
  const placement = (fam: Family, id: string, momentS: number) => {
    const p = o.sfxProfile[id]!;
    const lead = fam === "riser" ? Math.min(p.seconds, 3.2) : Math.min(p.attackS, 0.25);
    return { atS: Math.max(0, Math.round((momentS - lead) * 1000) / 1000), gainDb: Math.max(-20, Math.min(0, TARGET_PEAK[fam] - p.peakDb)) };
  };
  const beds = o.musicAssets.filter((a) => o.musicProfile[a.id]);
  const bedOptions = (mood: Mood, spanS: number, usedBeds: Set<string>) => {
    const w = WANT[mood];
    const score = (a: AssetRecord) => {
      const p = o.musicProfile[a.id]!;
      const bpmFit = p.bpm >= w.bpm[0] && p.bpm <= w.bpm[1] ? 1 : Math.max(0, 1 - Math.min(Math.abs(p.bpm - w.bpm[0]), Math.abs(p.bpm - w.bpm[1])) / 40);
      return (moodOfTitle(a.title ?? "") === mood ? 2 : 0) + bpmFit + (1 - Math.min(1, Math.abs(p.pulse - w.pulse) * 3)) + (p.seconds >= spanS ? 0.5 : 0) + (rnd(a.id) % 1000) / 2500 - (o.cooldown.music.has(a.id) ? 3 : 0) - (usedBeds.has(a.id) ? 5 : 0);
    };
    return [...beds].map((a) => ({ a, score: score(a), p: o.musicProfile[a.id]! })).sort((x, y) => y.score - x.score);
  };
  /** Enter after the quiet intro, beat on the first strong hit of the span. */
  const entry = (bedId: string, sp: { startS: number; endS: number }, firstHit: number) => {
    const p = o.musicProfile[bedId]!;
    const k = p.energyDb.findIndex((v) => v > -9);
    let inS = Math.max(0, (k > 0 ? k * 5 : 0) - 1);
    if (p.beat.periodS > 0.2 && sp.startS <= firstHit && firstHit < sp.endS) {
      const phase = (((firstHit - sp.startS + inS - p.beat.offsetS) % p.beat.periodS) + p.beat.periodS) % p.beat.periodS;
      inS = Math.max(0, inS + (phase < p.beat.periodS / 2 ? phase : phase - p.beat.periodS));
    }
    if (inS + (sp.endS - sp.startS) > p.seconds - 2) inS = Math.max(0, p.seconds - (sp.endS - sp.startS) - 2);
    return Math.round(inS * 100) / 100;
  };
  return { pool, pick, freshLeft, profileOf, placement, bedOptions, entry, musicProfile: (id: string) => o.musicProfile[id], title: (id: string) => o.musicAssets.find((a) => a.id === id)?.title ?? o.sfxAssets.find((a) => a.id === id)?.title ?? id, classOf: (id: string) => { const a = o.sfxAssets.find((x) => x.id === id); return a ? cls(a) : ""; } };
}

export interface SoundTimelineReport { events: number; strong: number; light: number; families: Record<string, number>; beds: string[]; onCut: number; onStress: number; skippedNoFreshFile: number; cueChanges: number; drops: number; riserIntoClimax: boolean }

export function designSoundTimeline(o: SoundTimelineOptions): { shots: StoryboardShot[]; music: Storyboard["music"]; report: SoundTimelineReport } {
  const log = o.log ?? (() => {});
  const shots = o.storyboard.shots.map((s) => ({ ...s, sfx: [] as StoryboardShot["sfx"] }));
  const dur = o.script.durationS;
  const kit = soundKit(o);
  const tl = o.timeline ?? buildCutTimeline({ storyboard: o.storyboard, script: o.script });

  // ---- 1. Events from the finished timeline, plus stressed words that fall on a cut (item 22: a hit where the cut
  //         and the word the narrator leans on meet is the channel's strongest accent).
  const events = visualEvents(o);
  for (const w of tl.stressed) {
    const c = tl.cuts.find((x) => Math.abs(x.atS - w.atS) <= 0.35);
    if (c) events.push({ atS: c.atS, family: "thud", prio: 3.6, strong: true, why: `stress "${w.word}" on a cut` });
    // inside a shot the word the narrator leans on can carry the hit (the channel's hits sit inside shots more often
    // than on cuts)
    else events.push({ atS: w.atS, family: "thud", prio: 2.9, strong: true, why: `stress "${w.word}"` });
  }
  // a visual moment that meets a stressed word is worth more (picture, word and hit together)
  for (const e of events) if (e.strong && !e.why.startsWith("stress") && tl.stressed.some((w) => Math.abs(w.atS - e.atS) <= 0.35)) e.prio += 0.5;
  events.sort((a, b) => a.atS - b.atS);

  // ---- 2. Budget and spacing (reference: ~3 strong hits a minute, median gap ~6 s, never crowded).
  const strongBudget = Math.max(2, sfxCap(o.profile, dur));
  const lightBudget = Math.max(1, Math.round((dur / 60) * 2));
  const chosen: Event[] = [];
  const far = (e: Event, gap: number) => chosen.every((c) => Math.abs(c.atS - e.atS) >= gap);
  let strong = 0;
  let light = 0;
  // Item 27: strong hits on cuts in the channel's proportion at this length. Most designed elements arrive at a shot's
  // start, so without a quota nearly every hit would sit on a cut (the channel: about a quarter). The first pass keeps
  // on-cut hits to the quota; the second fills the budget only if the off-cut moments ran out.
  const onCutTarget = o.musicRates?.hitOnCutShare ?? 0.25;
  const isOnCut = (t: number) => tl.cuts.some((c) => Math.abs(c.atS - t) <= 0.2);
  const quota = Math.max(1, Math.round(Math.min(0.5, onCutTarget * 1.4) * strongBudget));
  let onCutN = 0;
  const ranked = [...events].sort((a, b) => b.prio - a.prio || a.atS - b.atS);
  for (const pass of [1, 2])
    for (const e of ranked) {
      if (chosen.some((c) => c.atS === e.atS && c.why === e.why)) continue;
      if (e.strong ? strong >= strongBudget || !far(e, 2.4) : light >= lightBudget || !far(e, 1.0)) continue;
      if (pass === 1 && e.strong && isOnCut(e.atS) && onCutN >= quota && e.prio < 4.5) continue;
      // stressed words carry at most about two in five strong hits; the rest land on what the viewer sees
      if (pass === 1 && e.why.startsWith("stress") && chosen.filter((c) => c.why.startsWith("stress")).length >= Math.max(1, Math.round(strongBudget * 0.4))) continue;
      chosen.push({ ...e });
      if (e.strong) (strong++, isOnCut(e.atS) && onCutN++);
      else light++;
    }
  chosen.sort((a, b) => a.atS - b.atS);
  // Mix toward the reference (≈ 2 thuds for every boom): demote the lowest-priority extra booms to thuds.
  const booms = chosen.filter((e) => e.family === "sub_boom");
  const maxBooms = Math.max(1, Math.round(strong * 0.3));
  for (const e of [...booms].sort((a, b) => a.prio - b.prio).slice(0, Math.max(0, booms.length - maxBooms))) e.family = "thud";
  // Hits on cuts in the channel's proportion (item 27): strong hits within 0.45 s of a cut are moved onto it until the
  // share reaches the channel's median at this length; a hit near a stressed word lands on the word.
  const strongChosen = () => chosen.filter((e) => e.strong);
  for (const e of [...strongChosen()].sort((a, b) => a.prio - b.prio)) {
    if (strongChosen().filter((x) => isOnCut(x.atS)).length / Math.max(1, strongChosen().length) >= onCutTarget) break;
    if (isOnCut(e.atS)) continue;
    const c = tl.cuts.find((x) => Math.abs(x.atS - e.atS) <= 0.45 && chosen.every((y) => y === e || Math.abs(y.atS - x.atS) >= 1.2));
    if (c) e.atS = c.atS + 0.02;
  }
  for (const e of chosen) {
    if (!e.strong || isOnCut(e.atS)) continue;
    const w = tl.stressed.find((x) => Math.abs(x.atS - e.atS) <= 0.3);
    if (w) e.atS = w.atS;
  }
  chosen.sort((a, b) => a.atS - b.atS);

  // ---- 3. Files by measured character, the film's own shuffle, no repeats, off cooldown.
  const used = new Set<string>();
  const families: Record<string, number> = {};
  const place = (assetId: string, startS: number, gainDb: number) => {
    const t = Math.max(0, startS);
    const sh = [...shots].reverse().find((x) => x.startS <= t + 0.001) ?? shots[0]!;
    sh.sfx.push({ assetId, atS: Math.round(t * 1000) / 1000, gainDb });
  };
  let risers = 0;
  let skipped = 0;
  let riserIntoClimax = false;
  // item 26: a riser into the climax — the strongest turn the writer marked
  const climax = [...tl.turns].sort((a, b) => b.strength - a.strength || a.atS - b.atS)[0];
  for (const e of chosen) {
    const a = kit.pick(e.family, used);
    if (!a) skipped++;
    else {
      used.add(a.id);
      const pl = kit.placement(e.family, a.id, e.atS);
      place(a.id, pl.atS, pl.gainDb);
      families[e.family] = (families[e.family] ?? 0) + 1;
    }
    // A riser into the biggest moments (at most one per 40 s) — even when the hit itself had no fresh file (proof films:
    // the thuds ran dry under the cooldown and took the climax's riser with them).
    const intoClimax = !!climax && Math.abs(e.atS - climax.atS) < 0.6;
    if ((intoClimax || e.prio >= 4.5) && risers < Math.max(1, Math.floor(dur / 40)) && e.atS > 4) {
      const r = kit.pick("riser", used);
      if (r) {
        used.add(r.id);
        const rp = kit.placement("riser", r.id, e.atS);
        place(r.id, rp.atS, rp.gainDb);
        families.riser = (families.riser ?? 0) + 1;
        risers++;
        if (intoClimax) riserIntoClimax = true;
      }
    }
  }

  // ---- 4. Music follows the story (item 26): a cue change at the strongest turns the writer marked, as many as the
  //         channel changes cue at this length; a drop-out (silence as punctuation) just before the biggest turns; the
  //         riser above leads into the climax. Each bed by mood + measured tempo/pulse, off cooldown, entering after its
  //         quiet intro with the beat on the first strong hit.
  const usedBeds = new Set<string>();
  const music: Storyboard["music"] = [];
  const story = storyMusicPlan(o.script, tl, o.musicRates);
  const firstHit = chosen.find((e) => e.strong)?.atS ?? 0;
  const keptDrops = o.drops ?? [];
  for (const sp of story.spans) {
    const bed = kit.bedOptions(sp.mood, sp.endS - sp.startS, usedBeds)[0]?.a;
    if (!bed) continue;
    usedBeds.add(bed.id);
    const inSpan = (d: { startS: number; endS: number }) => d.startS >= sp.startS && d.endS <= sp.endS;
    const drops = [...story.drops.filter(inSpan), ...keptDrops.filter(inSpan).filter((d) => !story.drops.some((x) => x.startS < d.endS && d.startS < x.endS))].sort((a, b) => a.startS - b.startS);
    music.push({ assetId: bed.id, startS: sp.startS, endS: sp.endS, gainDb: -18, mood: sp.mood, drops, inS: kit.entry(bed.id, sp, firstHit) });
  }
  for (const sh of shots) sh.sfx.sort((a, b) => a.atS - b.atS);
  log(`  sound: ${events.length} visual event(s) → ${strong} strong hit(s) + ${light} accent(s) (${Object.entries(families).map(([k, n]) => `${n} ${k}`).join(", ")}); music ${music.map((m) => `${m.mood} "${kit.title(m.assetId)}" from ${m.inS ?? 0}s`).join(" → ")}`);
  const strongMoments = chosen.filter((e) => e.strong).map((e) => e.atS);
  const onCut = strongMoments.filter((t) => isOnCut(t)).length / Math.max(1, strongMoments.length);
  const onStress = strongMoments.filter((t) => tl.stressed.some((w) => Math.abs(w.atS - t) <= 0.25)).length / Math.max(1, strongMoments.length);
  if (skipped) log(`  sound: ${skipped} hit(s) left out — no fresh file in their family (never a repeat or a recent film's effect)`);
  return { shots, music, report: { events: events.length, strong, light, families, beds: music.map((m) => m.assetId), onCut: Math.round(onCut * 100) / 100, onStress: Math.round(onStress * 100) / 100, skippedNoFreshFile: skipped, cueChanges: Math.max(0, music.length - 1), drops: music.reduce((n, m) => n + (m.drops?.length ?? 0), 0), riserIntoClimax } };
}
