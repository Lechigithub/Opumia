import type { AssetRecord, Storyboard, StoryboardShot, StyleProfile, TimedScript } from "@opumia/contracts";
import { lengthPlan } from "./film-length.js";

/**
 * Music moods and the channel's hit budget, used by the director (one bed per chapter on a mood arc) and the sound
 * timeline. The sound itself is designed on what the viewer sees (sound-timeline.ts, sound-agent.ts).
 */
export type Mood = "intrigue" | "rise" | "tension" | "collapse" | "resolve";

/** Mood of a library music bed from its title (curated keyword table over Library/music). */
const TITLE_MOODS: Array<[RegExp, Mood]> = [
  [/dark times|wounded|sad trio|lightless|heartbreak|vanishing|despair|nightfall|long note|undertow/i, "collapse"],
  [/interloper|night vigil|hiding your reality|volatile|static|signal to noise|industrial|impact prelude|run amok|mountain king|chasm|catalyst|danse macabre/i, "tension"],
  [/rise above|rising|heroic|titan|race the sun|shoulders of giants|inspired|ascending|emergent|five armies|adventure|americana|polonaise/i, "rise"],
  [/a kind of hope|wildflowers|nocturne|ballade|valse|fantasie/i, "resolve"],
  [/mesmeri|illusionist|discovery|thinking|incredulity|resonance|floating|dreamer|legend/i, "intrigue"],
];
export const moodOfTitle = (t: string): Mood => TITLE_MOODS.find(([re]) => re.test(t))?.[1] ?? "intrigue";

const COLLAPSE_WORDS = /\b(fall|falls|fell|collapse|crash|burn|burning|fire|death|dies|end|ruin|lost|loses|decline|bankrupt|sold|scraps|platform)\b/i;
const RISE_WORDS = /\b(rise|rising|boom|empire|king|dominat\w*|growth|gold|giant|conquer\w*|top)\b/i;

/** Chapter spans with a mood on the arc. Shorts are one span. */
export function chapterMoods(script: TimedScript): Array<{ chapter: string; startS: number; endS: number; mood: Mood }> {
  const spans: Array<{ chapter: string; startS: number; endS: number; roles: string[]; text: string }> = [];
  for (const sg of script.segments) {
    const ch = sg.chapter ?? "main";
    const last = spans[spans.length - 1];
    if (last && last.chapter === ch) {
      last.endS = sg.endS;
      last.roles.push(sg.role);
      last.text += ` ${sg.text}`;
    } else spans.push({ chapter: ch, startS: spans.length ? sg.startS : 0, endS: sg.endS, roles: [sg.role], text: sg.text });
  }
  if (spans.length) spans[spans.length - 1]!.endS = script.durationS;
  return spans.map((s, i) => {
    const late = i >= Math.max(1, spans.length - 2);
    let mood: Mood;
    if (i === 0) mood = "tension"; // in-media-res cold open
    else if (COLLAPSE_WORDS.test(s.chapter) || s.roles.some((r) => r === "fall" || r === "climax")) mood = "collapse";
    else if (i === spans.length - 1 && s.roles.includes("resolution") && !COLLAPSE_WORDS.test(s.chapter)) mood = "resolve";
    else if (s.roles.includes("twist")) mood = "tension";
    else if (RISE_WORDS.test(s.chapter) || s.roles.includes("rise")) mood = "rise";
    else mood = late ? "collapse" : "intrigue";
    return { chapter: s.chapter, startS: s.startS, endS: s.endS, mood };
  });
}

interface MusicItem {
  id: string;
  title: string;
  durationS: number;
}

/** One bed per chapter: the mood's beds in a stable order, never the same bed twice in a row. */
export function pickMusicByMood(music: MusicItem[], spans: ReturnType<typeof chapterMoods>): Storyboard["music"] {
  const used = new Set<string>();
  const out: Storyboard["music"] = [];
  // One bed per act: consecutive chapters with the same mood share a bed (≈ the channel's cue-change rate).
  const merged: typeof spans = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && last.mood === sp.mood) last.endS = sp.endS;
    else merged.push({ ...sp });
  }
  // Within a mood span the bed evolves every ~45 s (reference cue gap p50 46 s, p25 31, p75 75): next bed of the
  // same mood, crossfaded by the mixer. Cue boundaries are snapped to sentence starts by the caller (sentenceStarts).
  for (const sp of merged) {
    const pool = music.filter((m) => moodOfTitle(m.title) === sp.mood).sort((a, b) => a.title.localeCompare(b.title));
    const n = Math.max(1, Math.round((sp.endS - sp.startS) / 45));
    for (let k = 0; k < n; k++) {
      const a = sp.startS + ((sp.endS - sp.startS) * k) / n;
      const b = sp.startS + ((sp.endS - sp.startS) * (k + 1)) / n;
      const pick = pool.find((m) => !used.has(m.id)) ?? pool[k % Math.max(1, pool.length)] ?? music.find((m) => !used.has(m.id)) ?? music[0];
      if (!pick) continue;
      used.add(pick.id);
      const last = out[out.length - 1];
      if (last && last.assetId === pick.id) last.endS = b;
      else out.push({ assetId: pick.id, startS: Math.round(a * 1000) / 1000, endS: Math.round(b * 1000) / 1000, gainDb: -18, mood: sp.mood, drops: [] });
    }
  }
  return out;
}

type Sfx = StoryboardShot["sfx"][number];

/** Total SFX allowed in a film: the channel's strong hits/min (p75) + 1. */
export const sfxCap = (profile: StyleProfile, durS: number) => Math.round((((profile.audio as { strongHitsPerMin?: { p50?: number } | null }).strongHitsPerMin?.p50 ?? 3.0) * durS) / 60);

/**
 * Build list 5, item 26: the channel's music-to-story rates at the film's length — the medians of the sound craft band
 * (craft-score.ts: real stretches of the same length, measured with the same function as ours).
 */
export interface MusicRates { cueChangesPerMin: number; musicDropsPerMin: number; hitOnCutShare: number; hitsPerMin?: number }

/** Mood of a stretch of the story from the roles the writer marked in it (and its words). */
function moodOfStory(roles: string[], text: string, first: boolean, last: boolean): Mood {
  if (first) return "tension";
  if (roles.some((r) => r === "climax" || r === "fall")) return COLLAPSE_WORDS.test(text) ? "collapse" : "tension";
  if (roles.includes("twist") || roles.includes("rehook")) return "tension";
  if (last && roles.includes("resolution")) return COLLAPSE_WORDS.test(text) ? "collapse" : "resolve";
  if (roles.includes("rise") || RISE_WORDS.test(text)) return "rise";
  return "intrigue";
}

/**
 * Music that follows the story: cue changes at the strongest writer-marked turns (as many as lengthPlan.musicCues and
 * the channel's measured cue rate at this length allow), never closer than a fair share of the film apart; drop-outs
 * (silence as punctuation) just before the biggest turns, as many as the channel's drop rate at this length; the moods
 * from what each stretch of the story does. Pure; the sound timeline and the sound agent both use it.
 */
export function storyMusicPlan(script: TimedScript, tl: { turns: Array<{ atS: number; segId: string; role: string; strength: number }>; pauses: Array<{ startS: number; endS: number }> }, rates?: MusicRates): { spans: Array<{ startS: number; endS: number; mood: Mood; turn: string | null }>; drops: Array<{ startS: number; endS: number }>; climaxS: number | null } {
  const dur = script.durationS;
  const minutes = dur / 60;
  const lp = lengthPlan(dur);
  const strong = tl.turns.filter((t) => t.strength >= 0.5 && t.atS > 6 && t.atS < dur - 6);
  let cues = lp.musicCues(strong.length);
  if (rates) cues = Math.max(1, Math.min(cues, Math.round(rates.cueChangesPerMin * minutes) + 1));
  const gap = Math.max(8, dur / (cues * 2));
  const picked: typeof strong = [];
  for (const t of [...strong].sort((a, b) => b.strength - a.strength || a.atS - b.atS)) {
    if (picked.length >= cues - 1) break;
    if (picked.every((p) => Math.abs(p.atS - t.atS) >= gap)) picked.push(t);
  }
  picked.sort((a, b) => a.atS - b.atS);
  const bounds = [0, ...picked.map((t) => t.atS), dur];
  const spans = bounds.slice(0, -1).map((a, i) => {
    const b = bounds[i + 1]!;
    const segs = script.segments.filter((sg) => sg.startS < b - 0.5 && sg.endS > a + 0.5);
    return { startS: Math.round(a * 1000) / 1000, endS: Math.round(b * 1000) / 1000, mood: moodOfStory(segs.map((sg) => sg.role), segs.map((sg) => sg.text).join(" "), i === 0, i === bounds.length - 2), turn: i ? picked[i - 1]!.role : null };
  });
  // two neighbouring spans of one mood still change bed; the mood says what the bed is for
  // drop-outs: before the strongest turns, in the breath before the line (1.2–1.6 s), never in the first 4 s
  const nDrops = rates ? Math.round(rates.musicDropsPerMin * minutes) : Math.max(1, Math.round(minutes * 0.7));
  const drops: Array<{ startS: number; endS: number }> = [];
  for (const t of [...tl.turns].filter((x) => x.atS > 5).sort((a, b) => b.strength - a.strength || a.atS - b.atS)) {
    if (drops.length >= Math.max(dur >= 30 ? 1 : 0, nDrops)) break;
    const p = tl.pauses.find((x) => x.endS >= t.atS - 0.15 && x.endS <= t.atS + 0.15);
    const endS = Math.round((p ? p.endS : t.atS) * 100) / 100;
    const startS = Math.round(Math.max(endS - 1.5, (p?.startS ?? endS - 1.3) - 0.6) * 100) / 100;
    if (endS - startS < 0.8 || drops.some((d) => Math.abs(d.endS - endS) < 10)) continue;
    // a drop sits inside one cue: end it just before the cue change at this turn
    const cueAt = spans.find((sp) => Math.abs(sp.startS - endS) < 0.3);
    drops.push(cueAt ? { startS: Math.round((startS - 0.05) * 100) / 100, endS: Math.round((cueAt.startS - 0.05) * 100) / 100 } : { startS, endS });
  }
  drops.sort((a, b) => a.startS - b.startS);
  const climax = [...tl.turns].sort((a, b) => b.strength - a.strength || a.atS - b.atS)[0];
  return { spans, drops, climaxS: climax ? climax.atS : null };
}
