import type { AssetRecord, Storyboard, StoryboardShot, StyleProfile, TimedScript } from "@opumia/contracts";

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
