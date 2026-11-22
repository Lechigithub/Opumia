/**
 * The sound designer as an agent (build list B5). It starts from the rule-based timeline (sound-timeline.ts — the
 * same kit of visual events, measured files, levels and beds), measures it against the channel's own sound (the
 * unified channel profile: hits a minute overall and by position, hits on cuts, hits on text, the mix of hit kinds,
 * music cue changes and drop-outs), studies how the channel scored passages like ours, listens to stretches of the
 * mix, and changes hits and music itself.
 *
 *  skill    packages/agents/skills/sound.md
 *  tools    read_sound, study_real_sound, add_hit, move_hit, remove_hit, change_hit, music_options, change_bed,
 *           add_drop, remove_drop, snap_cue_changes, land_ending (the music editor's tools, B6), listen, submit_sound,
 *           note_lesson
 *  memory   <memoryDir>/<channel>.md, owner-notes.md (data/agents/sound/)
 *  output   storyboard shots with sfx and music cues (the same shape the timeline returns)
 */
import { PLATFORM_FPS } from "@opumia/contracts";
import { readMemory } from "./lessons.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelId, ResolutionReport, ScenePlan, Storyboard, StoryboardShot } from "@opumia/contracts";
import * as z from "zod/v4";
import { loadChannelProfile, type ChannelProfile, type Segment } from "./channel-profile.js";
import { ourShotsFrom, structureOf, type FilmGap } from "./film-score.js";
import { agentLoop, cached, MODELS, plain, type AgentTool } from "./llm.js";
import { edl, findPassages } from "./reference-library.js";
import { chapterMoods, type Mood } from "./sound-design.js";
import { arcDistance, bedArc, endingGap, landEnding, offBar, snapCueChanges } from "./music-edit.js";
import { designSoundTimeline, soundKit, SOUND_FAMILIES, STRONG_FAMILIES, visualEvents, type SoundFamily, type SoundTimelineOptions } from "./sound-timeline.js";

export const SOUND_KEYS = ["hitsPerMin", "hitOnCutShare"];

interface Hit { id: string; family: SoundFamily; assetId: string; momentS: number; why: string }
type Cue = Storyboard["music"][number];
export interface SoundMeasure { key: string; what: string; ours: number; band: { p10: number; median: number; p90: number }; outside: number }
export interface SoundAgentReport { pass: boolean; before: { score: number; rows: SoundMeasure[] }; after: { score: number; rows: SoundMeasure[] }; ops: string[]; note: string; agent: { turns: number; calls: Record<string, number>; usd: number } }

export interface SoundAgentOptions extends SoundTimelineOptions {
  channel: ChannelId;
  data: string;
  resolution: ResolutionReport;
  /** Hear a stretch with this sound: the pipeline lays the sound, mixes it and returns a strip + listening report. */
  listen?: (st: { shots: StoryboardShot[]; music: Storyboard["music"] }, fromS: number, toS: number) => Promise<{ strip: string; text: string }>;
  /** What the showrunner sent back, if anything. */
  brief?: string;
  memoryDir?: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
/** Library hit families → the reference's hit classes (sound.json cls). */
const REF_CLASS: Record<string, SoundFamily[]> = { "thud/hit": ["thud", "impact"], "boom/impact": ["sub_boom"], "click/pop": ["click"] };

export async function soundAgent(o: SoundAgentOptions): Promise<{ shots: StoryboardShot[]; music: Storyboard["music"]; report: SoundAgentReport }> {
  const log = o.log ?? (() => {});
  const prof = await loadChannelProfile(o.data, o.channel);
  const draft = designSoundTimeline({ ...o, log: () => {} });
  const kit = soundKit(o);
  const dur = o.script.durationS;
  const fps = PLATFORM_FPS;
  // Working state: hits by the moment their peak lands, music cues as the timeline made them.
  let n = 0;
  const hits: Hit[] = [];
  for (const sh of draft.shots) for (const f of sh.sfx) {
    const fam = (SOUND_FAMILIES.find((x) => kit.pool(x).some((a) => a.id === f.assetId)) ?? "thud") as SoundFamily;
    const p = kit.profileOf(f.assetId);
    const lead = fam === "riser" ? Math.min(p?.seconds ?? 0, 3.2) : Math.min(p?.attackS ?? 0, 0.25);
    hits.push({ id: `h${++n}`, family: fam, assetId: f.assetId, momentS: r2(f.atS + lead), why: "timeline" });
  }
  let music: Cue[] = draft.music.map((m) => ({ ...m, drops: [...(m.drops ?? [])] }));
  const events = visualEvents(o);
  const ops: string[] = [];
  let studied = 0, heard = 0, accepted: string | null = null, noteSaved = false;

  const materialise = () => {
    const shots = o.storyboard.shots.map((s) => ({ ...s, sfx: [] as StoryboardShot["sfx"] }));
    for (const h of hits) {
      const pl = kit.placement(h.family, h.assetId, h.momentS);
      const sh = [...shots].reverse().find((x) => x.startS <= pl.atS + 0.001) ?? shots[0]!;
      sh.sfx.push({ assetId: h.assetId, atS: pl.atS, gainDb: pl.gainDb });
    }
    for (const sh of shots) sh.sfx.sort((a, b) => a.atS - b.atS);
    return { shots, music: music.map((m) => ({ ...m })) };
  };
  const strongHits = () => hits.filter((h) => STRONG_FAMILIES.has(h.family));
  const measureNow = (): { score: number; rows: SoundMeasure[]; gaps: FilmGap[] } => {
    const st = materialise();
    const audio = [
      ...strongHits().map((h) => ({ role: "sfx", startFrame: Math.round(h.momentS * fps), endFrame: Math.round(h.momentS * fps) + 10 })),
      ...music.map((m) => ({ role: "music", startFrame: Math.round(m.startS * fps), endFrame: Math.round(m.endS * fps), dips: (m.drops ?? []).map((d) => ({ fromFrame: Math.round(d.startS * fps), toFrame: Math.round(d.endS * fps) })) })),
    ];
    const plan = ourShotsFrom({ storyboard: { shots: st.shots, durationS: dur }, scenes: o.scenes.scenes as never, media: o.resolution.media as never, words: o.script.segments.flatMap((s) => s.words) as never, manifest: { fps, audio } });
    const rows: SoundMeasure[] = [];
    const add = (key: string, what: string, ours: number, band: { p10: number; median: number; p90: number }) => {
      const w = Math.max(1e-6, band.p90 - band.p10);
      rows.push({ key, what, ours: r2(ours), band, outside: r2(ours < band.p10 ? (band.p10 - ours) / w : ours > band.p90 ? (ours - band.p90) / w : 0) });
    };
    let gaps: FilmGap[] = [];
    if (prof) {
      const s = structureOf(prof, plan.shots, plan.hits, dur, SOUND_KEYS);
      gaps = s.gaps;
      add("hitsPerMin", "strong hits a minute", s.measures.hitsPerMin, prof.band.hitsPerMin!);
      add("hitOnCutShare", "share of strong hits on a cut", s.measures.hitOnCutShare, prof.band.hitOnCutShare!);
      for (const seg of ["cold_open", "ending"] as Segment[]) {
        const m = s.byPosition[seg];
        const b = prof.byPosition[seg]?.pooled.hitsPerMin;
        if (m && b !== undefined) add(`${seg}.hitsPerMin`, `strong hits a minute in the ${seg.replace("_", " ")}`, m.hitsPerMin, { p10: r2(b * 0.6), median: b, p90: r2(b * 1.5) });
      }
      const strong = strongHits();
      const classes = prof.relations.hitOnScreen.classes;
      for (const [cls, fams] of Object.entries(REF_CLASS)) {
        const share = classes[cls] ?? 0;
        const ours = strong.length ? strong.filter((h) => fams.includes(h.family)).length / strong.length : 0;
        add(`mix.${cls}`, `share of strong hits that are ${cls}`, ours, { p10: r2(Math.max(0, share - 0.15)), median: share, p90: r2(Math.min(1, share + 0.15)) });
      }
      const onText = strong.filter((h) => plan.shots.find((x) => h.momentS >= x.t0 && h.momentS < x.t1)?.overlay === "text_slam").length / Math.max(1, strong.length);
      const t = prof.relations.hitOnScreen.textSlam;
      add("hitOnText", "share of strong hits on a shot with text", onText, { p10: r2(Math.max(0, t - 0.2)), median: t, p90: r2(Math.min(1, t + 0.2)) });
      const mus = prof.relations.music;
      // a cue change = a new bed starting after the first; per 10 minutes, scaled to the film (never below one for a short)
      const cues10 = (Math.max(0, music.length - 1) / dur) * 600;
      if (dur >= 120) add("music.cuesPer10Min", "music cue changes per 10 min", cues10, mus.cuesPer10Min);
      const drops10 = (music.reduce((t2, m) => t2 + (m.drops?.length ?? 0), 0) / dur) * 600;
      add("music.dropsPer10Min", "music drop-outs per 10 min", drops10, mus.dropsPer10Min);
    }
    // B6 music editing: cue changes on a bar line, the ending landing with the film, the energy arc.
    const mp = (id: string) => kit.musicProfile(id);
    if (music.length > 1) {
      const off = music.slice(1).map((c, k) => offBar(music[k]!, mp(music[k]!.assetId)!, c.startS)).filter((x) => Number.isFinite(x));
      add("music.cutOffBar", "worst distance of a cue change from a bar line (s)", Math.max(0, ...off), { p10: 0, median: 0, p90: 0.15 });
    }
    const eg = endingGap(music, mp);
    if (eg !== null) add("music.endingGapS", "seconds between the last bed's own ending and the film's end", Math.min(eg, 30), { p10: 0, median: 0, p90: 2 });
    if (prof) {
      const ad = arcDistance(bedArc(music, mp, dur), prof.relations.music.bedArc);
      if (ad !== null) add("music.arc", "music energy arc against the channel's (mean dB apart, levelled)", ad, { p10: 0, median: 1, p90: 2.5 });
    }
    const spacing = strongHits().map((h) => h.momentS).sort((a, b) => a - b).reduce((mn, t2, i, a) => (i ? Math.min(mn, t2 - a[i - 1]!) : mn), 99);
    if (strongHits().length > 1) add("minGapS", "closest two strong hits (s)", Math.min(spacing, 6), { p10: 1.2, median: 4, p90: 6 });
    const score = Math.round(100 - Math.min(100, (rows.reduce((t2, x) => t2 + Math.min(2, x.outside), 0) / Math.max(1, rows.length)) * 50));
    return { score, rows, gaps };
  };
  const before = measureNow();
  const rowsText = (m: ReturnType<typeof measureNow>) => `Sound score ${m.score}/100 against the channel:\n${m.rows.map((x) => `- ${x.what}: ours ${x.ours} — channel ${x.band.p10}–${x.band.p90} (median ${x.band.median})${x.outside ? `  ← OUTSIDE by ${x.outside} band-widths` : ""}`).join("\n")}`;
  const cutAt = (t: number) => o.storyboard.shots.reduce((b, s) => (Math.abs(s.startS - t) < Math.abs(b - t) ? s.startS : b), 0);
  const lineAt = (t: number) => o.script.segments.find((s) => t >= s.startS && t < s.endS);
  const shotAt = (t: number) => [...o.storyboard.shots].reverse().find((s) => s.startS <= t) ?? o.storyboard.shots[0]!;
  const used = () => new Set(hits.map((h) => h.assetId));

  const tools: AgentTool[] = [
    {
      name: "read_sound",
      description: "The current sound: every hit (id, family, when its peak lands, the shot and nearest cut, the line being spoken, why it is there), the music cues (bed, mood, tempo, span, drop-outs), the visual moments that could carry a hit but have none, and the measures against the channel.",
      schema: z.object({}),
      run: (async () => {
        const hl = [...hits].sort((a, b) => a.momentS - b.momentS).map((h) => { const c = cutAt(h.momentS); return `${h.id} ${h.momentS.toFixed(2)}s ${h.family.padEnd(8)} shot ${shotAt(h.momentS).id}, ${Math.abs(c - h.momentS) <= 0.2 ? "ON the cut" : `${(h.momentS - c).toFixed(2)} s from cut`} · "${(lineAt(h.momentS)?.text ?? "").slice(0, 70)}" · ${h.why} · ${kit.title(h.assetId).slice(0, 40)}`; });
        const free = events.filter((e) => !hits.some((h) => Math.abs(h.momentS - e.atS) < 0.6)).map((e) => `${e.atS.toFixed(2)}s ${e.family} (${e.why})`);
        const ml = music.map((m, i) => { const p = kit.musicProfile(m.assetId); return `cue ${i}: ${m.startS.toFixed(1)}–${m.endS.toFixed(1)} s, ${m.mood}, "${kit.title(m.assetId)}" ${p ? `${Math.round(p.bpm)} bpm, pulse ${p.pulse.toFixed(2)}` : ""}, enters at ${m.inS ?? 0}s of the bed${m.drops?.length ? `, drops ${m.drops.map((d) => `${d.startS.toFixed(1)}–${d.endS.toFixed(1)}`).join(", ")}` : ""}`; });
        const segs = o.script.segments.map((s) => `[${s.id} ${s.role} ${s.startS.toFixed(1)}–${s.endS.toFixed(1)}] ${s.text.slice(0, 90)}`);
        return `HITS (${hits.length}):\n${hl.join("\n")}\n\nVISUAL MOMENTS WITHOUT A HIT:\n${free.slice(0, 30).join("\n") || "none"}\n\nMUSIC:\n${ml.join("\n")}\n\nNARRATION:\n${segs.join("\n")}\n\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "study_real_sound",
      description: "How the channel scored passages nearest in meaning to a stretch of our narration: real edit lists with every hit (on the cut or inside the shot, and its kind), music drop-outs and cue changes. Give our words and optionally the position.",
      schema: z.object({ said: z.string(), segment: z.enum(["cold_open", "chapter_open", "middle", "ending"]).optional() }),
      run: (async (i: { said: string; segment?: Segment }) => {
        studied++;
        const ps = await findPassages({ data: o.data, channel: o.channel, said: i.said, ...(i.segment ? { segment: i.segment } : {}), seconds: 25, k: 2 });
        return ps.length ? ps.map((p) => `REAL — ${edl(p.shots, p.title)}`).join("\n\n") : "no passage found";
      }) as AgentTool["run"],
    },
    {
      name: "add_hit",
      description: "Put a hit whose peak lands at a moment (seconds). Family: sub_boom (deep boom, the biggest moments), thud (the channel's usual hit), impact (stamps), click (small accent), riser (builds INTO the moment; place it on the moment it leads to), paper, typing, cash (only when that object is on screen). A file is chosen by its measured sound, never one used already in this film or by a recent film.",
      schema: z.object({ atS: z.number(), family: z.enum(SOUND_FAMILIES as [SoundFamily, ...SoundFamily[]]), why: z.string() }),
      run: (async (i: { atS: number; family: SoundFamily; why: string }) => {
        if (i.atS < 0 || i.atS > dur) return `outside the film (0–${dur.toFixed(1)} s)`;
        const a = kit.pick(i.family, used());
        if (!a) return `no ${i.family} sound in the library`;
        const h: Hit = { id: `h${++n}`, family: i.family, assetId: a.id, momentS: r2(i.atS), why: i.why.slice(0, 80) };
        hits.push(h);
        ops.push(`add ${h.id} ${i.family} @${h.momentS}`);
        return `added ${h.id} (${kit.title(a.id).slice(0, 40)}) peaking at ${h.momentS} s\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "move_hit",
      description: "Move a hit so its peak lands at a new moment (seconds), e.g. onto the cut or the frame where the element lands.",
      schema: z.object({ id: z.string(), toS: z.number() }),
      run: (async (i: { id: string; toS: number }) => {
        const h = hits.find((x) => x.id === i.id);
        if (!h) return `no hit ${i.id}`;
        ops.push(`move ${h.id} ${h.momentS}→${r2(i.toS)}`);
        h.momentS = r2(Math.max(0, Math.min(dur, i.toS)));
        return `moved\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "remove_hit",
      description: "Take a hit out (a hit on nothing, too close to another, or a moment that should breathe).",
      schema: z.object({ id: z.string(), why: z.string() }),
      run: (async (i: { id: string; why: string }) => {
        const k = hits.findIndex((x) => x.id === i.id);
        if (k < 0) return `no hit ${i.id}`;
        ops.push(`remove ${i.id} (${i.why.slice(0, 50)})`);
        hits.splice(k, 1);
        return `removed\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "change_hit",
      description: "Give a hit another family, or another file of the same family (alternative: 1, 2… picks the next candidate).",
      schema: z.object({ id: z.string(), family: z.enum(SOUND_FAMILIES as [SoundFamily, ...SoundFamily[]]).optional(), alternative: z.number().int().min(0).max(8).default(1) }),
      run: (async (i: { id: string; family?: SoundFamily; alternative: number }) => {
        const h = hits.find((x) => x.id === i.id);
        if (!h) return `no hit ${i.id}`;
        const fam = i.family ?? h.family;
        const u = used();
        u.delete(h.assetId);
        const a = kit.pick(fam, u, i.family ? 0 : i.alternative);
        if (!a) return `no ${fam} sound`;
        ops.push(`change ${h.id} ${h.family}→${fam}`);
        h.family = fam;
        h.assetId = a.id;
        return `now ${fam}: ${kit.title(a.id).slice(0, 40)}\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "music_options",
      description: "The beds that fit a cue's mood and span best (measured tempo, pulse, length; recent films' beds marked down).",
      schema: z.object({ cue: z.number().int().min(0), mood: z.enum(["intrigue", "rise", "tension", "collapse", "resolve"]).optional() }),
      run: (async (i: { cue: number; mood?: Mood }) => {
        const m = music[i.cue];
        if (!m) return `no cue ${i.cue}`;
        const others = new Set(music.filter((_, k) => k !== i.cue).map((x) => x.assetId));
        return kit.bedOptions(i.mood ?? (m.mood as Mood), m.endS - m.startS, others).slice(0, 8).map((x) => `${x.a.id} "${x.a.title ?? ""}" ${Math.round(x.p.bpm)} bpm, pulse ${x.p.pulse.toFixed(2)}, ${Math.round(x.p.seconds)} s long, fit ${x.score.toFixed(2)}`).join("\n");
      }) as AgentTool["run"],
    },
    {
      name: "change_bed",
      description: "Change a cue: another bed (an id from music_options), another mood, or split it in two at a moment (a cue change on a story turn — the channel changes cue near half of its chapter starts).",
      schema: z.object({ cue: z.number().int().min(0), assetId: z.string().optional(), mood: z.enum(["intrigue", "rise", "tension", "collapse", "resolve"]).optional(), splitAtS: z.number().optional() }),
      run: (async (i: { cue: number; assetId?: string; mood?: Mood; splitAtS?: number }) => {
        const m = music[i.cue];
        if (!m) return `no cue ${i.cue}`;
        const firstHit = strongHits().map((h) => h.momentS).sort((a, b) => a - b)[0] ?? 0;
        if (i.splitAtS !== undefined) {
          if (i.splitAtS <= m.startS + 4 || i.splitAtS >= m.endS - 4) return "split must leave at least 4 s on each side";
          const others = new Set(music.map((x) => x.assetId));
          const bed = i.assetId ?? kit.bedOptions(i.mood ?? (m.mood as Mood), m.endS - i.splitAtS, others)[0]?.a.id;
          if (!bed || !kit.musicProfile(bed)) return "no bed for the new cue";
          const second: Cue = { ...m, assetId: bed, startS: i.splitAtS, mood: i.mood ?? m.mood, drops: (m.drops ?? []).filter((d) => d.startS >= i.splitAtS!), inS: kit.entry(bed, { startS: i.splitAtS, endS: m.endS }, firstHit) };
          const first: Cue = { ...m, endS: i.splitAtS, drops: (m.drops ?? []).filter((d) => d.endS <= i.splitAtS!) };
          music = [...music.slice(0, i.cue), first, second, ...music.slice(i.cue + 1)];
          ops.push(`split cue ${i.cue} at ${i.splitAtS}`);
        } else {
          const bed = i.assetId ?? (i.mood ? kit.bedOptions(i.mood, m.endS - m.startS, new Set(music.map((x) => x.assetId)))[0]?.a.id : m.assetId);
          if (!bed || !kit.musicProfile(bed)) return `unknown bed ${i.assetId ?? ""}`;
          music[i.cue] = { ...m, assetId: bed, mood: i.mood ?? m.mood, inS: kit.entry(bed, m, firstHit) };
          ops.push(`cue ${i.cue} → ${kit.title(bed).slice(0, 30)}`);
        }
        return `music now:\n${music.map((x, k) => `cue ${k}: ${x.startS.toFixed(1)}–${x.endS.toFixed(1)} s ${x.mood} "${kit.title(x.assetId)}"`).join("\n")}\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "add_drop",
      description: "Drop the music out for a moment (1–2.5 s) — before a reveal, on a held beat, before a chapter turns (the channel does this before about a third of its chapters).",
      schema: z.object({ startS: z.number(), endS: z.number() }),
      run: (async (i: { startS: number; endS: number }) => {
        const len = i.endS - i.startS;
        if (len < 0.6 || len > 3) return "a drop-out lasts 0.6–3 s";
        const m = music.find((x) => i.startS >= x.startS && i.endS <= x.endS);
        if (!m) return "no single cue covers that stretch";
        m.drops = [...(m.drops ?? []), { startS: r2(i.startS), endS: r2(i.endS) }].sort((a, b) => a.startS - b.startS);
        ops.push(`drop ${i.startS}–${i.endS}`);
        return `added\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "remove_drop",
      description: "Remove the drop-out that starts at a moment.",
      schema: z.object({ startS: z.number() }),
      run: (async (i: { startS: number }) => {
        for (const m of music) { const k = (m.drops ?? []).findIndex((d) => Math.abs(d.startS - i.startS) < 0.3); if (k >= 0) { m.drops!.splice(k, 1); ops.push(`undrop ${i.startS}`); return `removed\n${rowsText(measureNow())}`; } }
        return "no drop-out there";
      }) as AgentTool["run"],
    },
    {
      name: "snap_cue_changes",
      description: "Music editor: move every cue change onto a bar line of the outgoing bed (at most half a bar) and enter each new bed on its own downbeat — so the music changes on a phrase, not mid-bar. Cue changes are kept out of the middle of a word.",
      schema: z.object({}),
      run: (async () => {
        const words = o.script.segments.flatMap((s) => s.words);
        const inWord = (t: number) => words.some((w) => t > w.startS + 0.05 && t < w.endS - 0.05);
        const r = snapCueChanges(music, (id) => kit.musicProfile(id), inWord);
        music = r.cues;
        ops.push(`snap cue changes (${r.moved.length} moved)`);
        return `${r.moved.length ? r.moved.map((m) => `${m.from} → ${m.to} s`).join(", ") : "no change needed"}\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "land_ending",
      description: "Music editor: place the last bed so its own ending arrives with the film's last frame (instead of a fade mid-phrase). Needs a bed at least as long as its span.",
      schema: z.object({}),
      run: (async () => {
        const r = landEnding(music, (id) => kit.musicProfile(id));
        if (r.ok) { music = r.cues; ops.push("land ending"); }
        return `${r.why}\n${rowsText(measureNow())}`;
      }) as AgentTool["run"],
    },
    {
      name: "listen",
      description: "Hear a stretch (up to 15 s) with the sound as it stands: frames and a listening report (loudness, voice over bed, hits heard and whether they sit on cuts, drop-outs, silences).",
      schema: z.object({ fromS: z.number(), toS: z.number() }),
      run: (async (i: { fromS: number; toS: number }) => {
        if (!o.listen) return "listening is not available in this run — judge from the measures";
        const from = Math.max(0, i.fromS), to = Math.min(dur, Math.min(i.toS, from + 15));
        const w = await o.listen(materialise(), from, to).catch((e: Error) => ({ strip: "", text: `could not mix: ${e.message.slice(0, 200)}` }));
        if (w.strip) heard++;
        return w.strip ? [{ type: "text" as const, text: w.text }, await img(w.strip)] : w.text;
      }) as AgentTool["run"],
    },
    {
      name: "submit_sound",
      description: "Hand the sound over. Refused until you have studied at least two real passages, listened to at least one stretch (when listening is available), and the sound score is not below where you started.",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        if (studied < 2) return `refused: study at least two real passages first (${studied} so far)`;
        if (o.listen && heard < 1) return "refused: listen to at least one stretch first (the cold open is a good one)";
        const now = measureNow();
        if (now.score < before.score) return `refused: the sound score fell from ${before.score} to ${now.score} — undo what made it worse, or fix the rows outside the band`;
        accepted = i.note;
        return `Accepted at ${now.score}/100. If this film taught you something about sound, call note_lesson once; then stop.`;
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's sound designer.",
      schema: z.object({ lesson: z.string() }),
      run: (async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LESSON (${o.seed.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      }) as AgentTool["run"],
    },
  ];
  const skill = await readFile(new URL("../skills/sound.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const directives = prof ? directivesSound(prof) : "";
  const system = [cached(skill), plain(`${directives}\n\n${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}The film is ${dur.toFixed(1)} s long; chapters: ${chapterMoods(o.script).map((c) => `${c.chapter} ${c.startS.toFixed(0)}–${c.endS.toFixed(0)} s (${c.mood})`).join("; ")}.`)];
  const user = `Design the sound of this film. The timeline designer made a first pass from the visual moments; it is yours to improve.${o.brief ? `\n\nTHE SHOWRUNNER SENT THIS BACK:\n${o.brief}` : ""}\n\nStart with read_sound.`;
  log(`  sound designer: ${before.score}/100 at the start (${MODELS.sonnet})…`);
  let grace = 1;
  const run = await agentLoop({ stage: "sound.agent", model: MODELS.sonnet, system, user, tools, effort: "medium", maxTurns: 36, maxTokens: 20000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "The sound is not submitted yet. Read it, study the channel, listen, change what is wrong, and submit.", log });
  const after = measureNow();
  const pass = accepted !== null;
  // never hand over sound that measures worse than the timeline's
  const keep = after.score >= before.score;
  const out = keep ? materialise() : { shots: draft.shots, music: draft.music };
  const report: SoundAgentReport = { pass, before: { score: before.score, rows: before.rows }, after: keep ? { score: after.score, rows: after.rows } : { score: before.score, rows: before.rows }, ops, note: accepted ?? (keep ? "not submitted; kept its last state" : "not submitted and worse than the timeline: the timeline's sound was kept"), agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} ${o.seed.slice(0, 40)}: sound ${before.score} → ${report.after.score}; ${ops.length} change(s); ${(accepted ?? report.note).slice(0, 200).replace(/\s+/g, " ")}\n`);
  }
  log(`  sound designer: ${before.score} → ${report.after.score}/100, ${ops.length} change(s), ${run.turns} turns, $${report.agent.usd}${pass ? "" : " (not submitted)"}`);
  return { ...out, report };
}

function directivesSound(p: ChannelProfile): string {
  const b = p.band;
  const pos = (k: Segment) => p.byPosition[k]?.pooled.hitsPerMin;
  return [
    `## The channel's sound (measured on ${p.films.length} films, every shot)`,
    `- ${b.hitsPerMin!.median} strong hits a minute (films ${b.hitsPerMin!.p10}–${b.hitsPerMin!.p90}); ${Math.round(b.hitOnCutShare!.median * 100)} % of them on a cut.`,
    `- By position: cold open ${pos("cold_open")} a minute, chapter openings ${pos("chapter_open")}, middle ${pos("middle")}, ending ${pos("ending")} — denser at the start, sparse at the end.`,
    `- Kinds: ${Object.entries(p.relations.hitOnScreen.classes).slice(0, 5).map(([k, v]) => `${k} ${Math.round(v * 100)} %`).join(", ")}.`,
    `- ${Math.round(p.relations.hitOnScreen.textSlam * 100)} % of hits land on a shot with text; by picture: ${Object.entries(p.relations.hitOnScreen.picture).slice(0, 4).map(([k, v]) => `${k} ${Math.round(v * 100)} %`).join(", ")}.`,
    `- Music: about ${p.relations.music.cuesPer10Min.median} cue changes per 10 min; a cue change near ${Math.round(p.relations.music.cueNearChapterStart * 100)} % of chapter starts; a drop-out just before ${Math.round(p.relations.music.dropBeforeChapter * 100)} % of them.`,
  ].join("\n");
}
