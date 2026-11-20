import type { AssetRecord, Storyboard, StoryboardShot, StyleProfile, TimedScript } from "@opumia/contracts";

/**
 * Cinema sound design, driven by the reference channel's measured audio (Reference/<channel>/*\/sound.json →
 * StyleProfile.audio): one music bed per chapter on a mood arc (tension → rise → collapse → resolve), short
 * music drop-outs on cliffhangers that slam back on the reveal, and tactile SFX on chapter pivots and on about
 * half of the visual reveals, at the channel's hit density.
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

/**
 * Drop-outs + SFX. Mutates nothing; returns the music with drops and the extra SFX per shot id.
 *  - drops: on cliffhanger (rehook/twist) segment ends, ≈ the channel's musicDropsPer10Min, never in the first 8 s;
 *  - pivots: riser ending exactly on each chapter start + a sub drop/boom on the downbeat;
 *  - reveals: whoosh on designed graphics, paper on documents, camera shutter on archival photos — every other one (~50 %);
 *  - density capped at the channel's strong hits/min (p75) + 1, min 1.2 s apart; pivots and drops win.
 */
/** Total SFX allowed in a film: the channel's strong hits/min (p75) + 1. */
export const sfxCap = (profile: StyleProfile, durS: number) => Math.round((((profile.audio as { strongHitsPerMin?: { p50?: number } | null }).strongHitsPerMin?.p50 ?? 3.0) * durS) / 60);

export function designSound(o: { script: TimedScript; shots: StoryboardShot[]; music: Storyboard["music"]; sfxAssets: AssetRecord[]; profile: StyleProfile }): { music: Storyboard["music"]; sfx: Map<string, Sfx[]> } {
  const dur = o.script.durationS;
  const byClass = new Map<string, AssetRecord[]>();
  for (const a of o.sfxAssets) if (typeof a.facets.class === "string") (byClass.get(a.facets.class) ?? byClass.set(a.facets.class, []).get(a.facets.class)!).push(a);
  for (const list of byClass.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  const rot = new Map<string, number>();
  const pick = (cls: string) => {
    const list = byClass.get(cls) ?? [];
    if (!list.length) return undefined;
    const k = rot.get(cls) ?? 0;
    rot.set(cls, k + 1);
    return list[k % list.length]!;
  };
  const events: Array<{ atS: number; cls: string; gainDb: number; prio: number; alignEnd?: boolean }> = [];

  // Breathing drop-outs ≈ once per minute (reference 9.4 / 10 min, 1.1–2.0 s, p50 1.4 s): the bed falls away at a
  // sentence end and returns as the next sentence lands. Only loop-opening beats (rehook/twist) get a hit after it
  // (reference: 29 % of drops are followed by a hit).
  const a = o.profile.audio as { musicDropsPer10Min?: { p50?: number } | null; strongHitsPerMin?: { p50?: number; p75?: number } | null };
  const dropEvery = 600 / Math.max(1, a.musicDropsPer10Min?.p50 ?? 9.4);
  const drops: Array<{ startS: number; endS: number }> = [];
  const segs = o.script.segments;
  const words = segs.flatMap((sg) => sg.words.map((w) => ({ ...w, role: sg.role })));
  let nextDrop = 20;
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!;
    if (w.endS < nextDrop || !/[.?!]["”']?$/.test(w.word)) continue;
    const nxt = words[i + 1]!;
    const start = Math.max(w.startS, w.endS - 0.35);
    const end = Math.min(start + 1.6, Math.max(start + 1.2, nxt.startS + 0.25));
    drops.push({ startS: Math.round(start * 1000) / 1000, endS: Math.round(end * 1000) / 1000 });
    if (w.role === "rehook" || w.role === "twist") events.push({ atS: end, cls: "sub_drop", gainDb: -3, prio: 2 });
    nextDrop = end + dropEvery * 0.85;
  }
  const music = o.music.map((m) => ({ ...m, drops: drops.filter((d) => d.startS >= m.startS && d.endS <= m.endS) }));

  // Chapter pivots.
  const chapterStarts: number[] = [];
  for (let i = 1; i < segs.length; i++) if (segs[i]!.chapter && segs[i]!.chapter !== segs[i - 1]!.chapter) chapterStarts.push(segs[i]!.words[0]?.startS ?? segs[i]!.startS);
  for (const t of chapterStarts) {
    events.push({ atS: t, cls: "riser", gainDb: -10, prio: 3, alignEnd: true });
    events.push({ atS: t, cls: byClass.has("boom_long") ? "boom_long" : "sub_drop", gainDb: -4, prio: 3 });
  }

  // Visual reveals (~50 %).
  let reveal = 0;
  for (const s of o.shots) {
    const kind = s.source.kind === "designed" ? s.source.designed : s.entities?.length && s.source.kind === "query" && s.source.mustBe === "image" ? "photo" : null;
    if (!kind || kind === "name_label") continue;
    if (reveal++ % 2) continue;
    // Reference hit mix: 78 % low thuds/booms, whooshes ~0 %. Reveals alternate a low thud and a boom;
    // archival photos keep a camera click (click/pop ≈ 6 % of reference hits).
    const THUDS = ["stamp_thud", "drum_impact_deep", "bass_hit_short"].filter((c) => byClass.has(c));
    const cls = kind === "photo" && byClass.has("camera_shutter") ? "camera_shutter" : reveal % 4 === 1 && byClass.has("boom_long") ? "boom_long" : THUDS[reveal % Math.max(1, THUDS.length)] ?? "sub_drop";
    events.push({ atS: s.startS, cls, gainDb: cls === "boom_long" ? -6 : cls === "camera_shutter" ? -8 : -5, prio: 1 });
  }

  // Density cap and spacing.
  const cap = Math.round(((a.strongHitsPerMin?.p50 ?? 3.0) * dur) / 60);
  const chosen: typeof events = [];
  for (const e of [...events].sort((x, y) => y.prio - x.prio || x.atS - y.atS)) {
    if (chosen.length >= cap) break;
    if (chosen.some((c) => !c.alignEnd && !e.alignEnd && Math.abs(c.atS - e.atS) < 1.2 && c.cls !== e.cls)) continue;
    if (chosen.some((c) => c.cls === e.cls && Math.abs(c.atS - e.atS) < 1.2)) continue;
    chosen.push(e);
  }
  const sfx = new Map<string, Sfx[]>();
  for (const e of chosen) {
    const asset = pick(e.cls);
    if (!asset) continue;
    const len = asset.probe?.durationS ?? 2;
    const atS = e.alignEnd ? Math.max(0, e.atS - Math.min(len, 4)) : e.atS;
    const shot = [...o.shots].reverse().find((s) => s.startS <= atS + 1e-6) ?? o.shots[0]!;
    (sfx.get(shot.id) ?? sfx.set(shot.id, []).get(shot.id)!).push({ assetId: asset.id, atS: Math.round(atS * 1000) / 1000, gainDb: e.gainDb });
  }
  return { music, sfx };
}
