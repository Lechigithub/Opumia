/**
 * The editor agent (build list B4): sets the film's rhythm after the scenes are designed and before sound is laid —
 * where each cut falls against the voice, how long each shot holds, where a shot is split (punch-in) or two are
 * joined, how a shot is entered. It studies how the channel cut passages like ours (reference-library.ts), measures
 * every change with the channel's own function (film-score.ts:structureOf) and can watch a stretch with sound.
 *
 *  skill    packages/agents/skills/editor.md
 *  tools    read_cut, study_real_cut, move_cut, split_shot, merge_with_next, set_transition, watch, submit_cut,
 *           note_lesson
 *  memory   <memoryDir>/<channel>.md (lessons + a log of every film), owner-notes.md
 *  output   the edited storyboard, scenes and resolution (a split shot's second half gets its own scene and media,
 *           starting later inside the same clip via StoryboardShot.trimInS)
 */
import { readMemory } from "./lessons.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelId, ResolutionReport, ScenePlan, Storyboard, TimedScript } from "@opumia/contracts";
import { probeDuration, rgbFrames } from "@opumia/senses";
import * as z from "zod/v4";
import { loadChannelProfile, type Segment } from "./channel-profile.js";
import { ourShotsFrom, stretchOfPlan, structureOf, type FilmGap } from "./film-score.js";
import { CRAFT_MEASURES, craftBand, scoreAgainst } from "./craft-score.js";
import { buildCutTimeline } from "./cut-timeline.js";
import { agentLoop, cached, plain, type AgentTool, ROLE_MODEL } from "./llm.js";
import { edl, findPassages } from "./reference-library.js";

/** Measures the editor owns (sound and picture kinds belong to other agents). */
export const EDITOR_KEYS = ["cutsPerMin", "shotMedianS", "shotCv", "cutInPause", "cutToWordMedianS", "wordsPerShot"];
/** Build list 5, item 20: the at-length rhythm measures the editor is held to (CRAFT_MEASURES.edit on real stretches of the film's length). */
export const RHYTHM_KEYS = ["shotMedianS", "shotCv", "shotP90S", "cutToWordMedianS", "cutInPause", "stillHolds"];
const BRIDGE_TRANSITIONS = new Set(["film", "whip", "light_leak", "fade", "dip_black", "match", "flash", "zoom_punch", "zoom_through"]);

/**
 * Build list 5, item 21: a cut to the same picture (the same source on both sides) needs a different framing AND a
 * transition (punch-in on action, whip, flash). Returns the shots entering such a cut without both.
 */
export function stutterCuts(shots: Array<{ id: string; transitionIn?: string; camera?: { type?: string; [k: string]: unknown }; trimInS?: number }>, media: Array<{ shotId: string; role: string; ref?: string; localPath?: string }>): Array<{ shotId: string; why: string }> {
  const src = (id: string) => {
    const m = media.find((x) => x.shotId === id && x.role === "primary");
    return m ? (m.ref ?? m.localPath ?? "").replace(/#.*$/, "").replace(/\?.*$/, "") : "";
  };
  const out: Array<{ shotId: string; why: string }> = [];
  shots.forEach((x, k) => {
    if (k === 0) return;
    const prev = shots[k - 1]!;
    const a = src(prev.id), b = src(x.id);
    const sameSplit = /_\d+$/.test(x.id) && x.id.replace(/_\d+$/, "") === prev.id.replace(/_\d+$/, "");
    if (!sameSplit && (!a || a !== b)) return;
    const bridged = BRIDGE_TRANSITIONS.has(x.transitionIn ?? "cut");
    const reframed = JSON.stringify(x.camera ?? {}) !== JSON.stringify(prev.camera ?? {}) || Math.abs((x.trimInS ?? 0) - (prev.trimInS ?? 0)) >= 1;
    if (!bridged || !reframed) out.push({ shotId: x.id, why: `${prev.id} → ${x.id} is the same picture ${!bridged ? "with a hard cut" : ""}${!bridged && !reframed ? " and " : ""}${!reframed ? "with the same framing" : ""}` });
  });
  return out;
}

export interface EditorReport { pass: boolean; before: { structure: number; gaps: FilmGap[] }; after: { structure: number; gaps: FilmGap[] }; ops: string[]; note: string; agent: { turns: number; calls: Record<string, number>; usd: number } }

export interface EditorAgentOptions {
  /** Craft inventory: the channel's techniques in this agent's craft, with rates and tools (techniqueBrief). */
  techniques?: string;
  /** Build list 5, item 22: the voice director's stressed words (voice-direction.json), shared with the sound designer. */
  emphasis?: Array<{ emphasis: string }>;
  channel: ChannelId;
  data: string;
  storyboard: Storyboard;
  scenes: ScenePlan;
  resolution: ResolutionReport;
  script: TimedScript;
  /** Watch a stretch of the edited film with its sound (renders a low-resolution clip). Optional. */
  watch?: (st: { storyboard: Storyboard; scenes: ScenePlan; resolution: ResolutionReport }, fromS: number, toS: number) => Promise<{ strip: string; text: string }>;
  /** Step 6: the music's beat times (seconds), so a cut can land on the music. */
  beats?: number[];
  /** Step 6: whether the film has its own transition (a kit) to bridge same-picture changes. */
  filmTransition?: boolean;
  memoryDir?: string;
  /** Sent back by the showrunner: what to change and why. */
  brief?: string;
  onReport?: (r: EditorReport) => void;
  log?: (s: string) => void;
}

const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const MIN_SHOT = 0.35;

export async function editFilmAgent(o: EditorAgentOptions): Promise<{ storyboard: Storyboard; scenes: ScenePlan; resolution: ResolutionReport; report: EditorReport }> {
  const log = o.log ?? (() => {});
  const prof = await loadChannelProfile(o.data, o.channel);
  if (!prof) throw new Error(`editor: no channel profile for ${o.channel}`);
  // working state (deep copies)
  let board: Storyboard = structuredClone(o.storyboard);
  let scenes: ScenePlan = structuredClone(o.scenes);
  let resolution: ResolutionReport = structuredClone(o.resolution);
  const words = o.script.segments.flatMap((s) => s.words);
  const ops: string[] = [];
  // how long each primary clip really is (the shot cannot outgrow it)
  const clipLen = new Map<string, number>();
  for (const m of resolution.media.filter((x) => x.role === "primary" && x.kind === "video")) clipLen.set(m.shotId, await probeDuration(m.localPath).catch(() => m.durationS ?? 0));
  const capacity = (shotId: string, trimIn: number) => {
    const len = clipLen.get(shotId);
    return len === undefined ? Infinity : len - trimIn - 0.05;
  };
  const state = () => ({ storyboard: { shots: board.shots, durationS: board.durationS }, scenes: scenes.scenes, media: resolution.media, words });
  const measureNow = () => {
    const { shots, hits, durS } = ourShotsFrom(state() as never);
    return structureOf(prof, shots, hits, durS, EDITOR_KEYS);
  };
  const before = measureNow();
  // build list 5, item 20: the rhythm of real stretches as long as THIS film (by position: openings, middles, endings)
  const rhythmBand = await craftBand({ data: o.data, channel: o.channel, craft: "edit", lengthS: board.durationS }).catch(() => null);
  const rhythmNow = async () => {
    if (!rhythmBand) return null;
    const m = await CRAFT_MEASURES.edit!(stretchOfPlan(state() as never) as never);
    const band = { ...rhythmBand, bands: Object.fromEntries(Object.entries(rhythmBand.bands).filter(([k]) => RHYTHM_KEYS.includes(k))) };
    return scoreAgainst("edit", m, band);
  };
  let rhythmRefusals = 0;
  const lineOf = (s: { startS: number; endS: number }) => words.filter((w) => (w.startS + w.endS) / 2 >= s.startS && (w.startS + w.endS) / 2 < s.endS).map((w) => w.word).join(" ");
  const renumber = () => { board = { ...board, shots: board.shots.map((s, i) => ({ ...s, index: i })) }; };
  const find = (id: string) => board.shots.findIndex((s) => s.id === id);
  const cutText = () => {
    const { shots } = ourShotsFrom(state() as never);
    const m = measureNow();
    const rows = edl(shots).split("\n").slice(1);
    return [
      `OUR CUT (${board.shots.length} shots, ${board.durationS.toFixed(1)} s) — shot ids in order: ${board.shots.map((s) => s.id).join(" ")}`,
      ...rows.map((r, i) => `${board.shots[i]!.id.padEnd(8)}${r}`),
      `\nEditor measures against the channel (structure ${m.structure}/100 on your measures):`,
      ...(m.gaps.length ? m.gaps.map((g) => `- ${g.segment === "film" ? "whole film" : g.segment}: ${g.what} ours ${g.ours} — channel ${g.band.p10}–${g.band.p90} (median ${g.band.median})`) : ["- inside the channel's band on every editor measure"]),
    ].join("\n");
  };
  // build list 5, item 22: the same timeline the sound designer reads — cuts, stressed words, story turns, pauses
  const timelineText = () => {
    const tl = buildCutTimeline({ storyboard: board, script: o.script, ...(o.emphasis ? { emphasis: o.emphasis } : {}) });
    const near = (t: number) => tl.cuts.some((c) => Math.abs(c.atS - t) <= 0.25);
    return `\nSHARED TIMELINE (the sound designer puts hits on cuts and stressed words from this same list): stressed words ${tl.stressed.map((w) => `"${w.word}"@${w.atS.toFixed(2)}${near(w.atS) ? " [cut]" : ""}`).join(", ") || "none"}; turns ${tl.turns.map((t) => `${t.role}@${t.atS.toFixed(1)}`).join(", ")}. A cut that lands on a stressed word lets the hit land on both.`;
  };
  const rhythmText = async () => {
    const r = await rhythmNow();
    const st = stutterCuts(board.shots as never, resolution.media as never);
    return [
      r ? `\nRhythm against ${rhythmBand!.stretches} real stretches of ${rhythmBand!.lengthS} s (score ${r.score}/100):${r.outside.length ? r.outside.map((x) => `\n- ${x.key}: ours ${x.ours}, channel ${x.band.p10}–${x.band.p90} (median ${x.band.median})`).join("") : " inside the band on every rhythm measure"}\n  (shotP90S = the long shots; stillHolds = share of shots over 2.5 s with nothing moving; cutToWordMedianS = how far cuts sit from a word boundary — the channel cuts slightly off the word, never mechanically on it)` : "",
      st.length ? `\nSTUTTER CUTS (the same picture on both sides of a cut needs a different framing AND a transition): ${st.map((x) => x.why).join("; ")}` : "",
    ].join("");
  };

  let studied = 0;
  let watched = 0;
  let accepted: { note: string } | null = null;
  let noteSaved = false;
  const tools: AgentTool[] = [
    {
      name: "read_cut",
      description: "Our current cut as an edit decision list (every shot: start, length, picture kind, text, cut against the voice, words said) and every gap to the channel's band on the editor's measures, whole film and by position.",
      schema: z.object({}),
      run: (async () => `${cutText()}${await rhythmText()}${timelineText()}`) as AgentTool["run"],
    },
    {
      name: "study_real_cut",
      description: "How the channel itself cut passages nearest in meaning to a stretch of our narration: real edit decision lists (shot lengths, picture kinds, cut against the voice, transitions, hits, music). Give the words of our stretch and optionally its position (cold_open, chapter_open, middle, ending).",
      schema: z.object({ said: z.string(), segment: z.enum(["cold_open", "chapter_open", "middle", "ending"]).optional() }),
      run: (async (i: { said: string; segment?: Segment }) => {
        studied++;
        const ps = await findPassages({ data: o.data, channel: o.channel, said: i.said, ...(i.segment ? { segment: i.segment } : {}), seconds: 20, k: 2 });
        return ps.length ? ps.map((p) => `REAL — ${edl(p.shots, p.title)}`).join("\n\n") : "no passage found";
      }) as AgentTool["run"],
    },
    {
      name: "cut_on_action",
      description: "Build list 3, item 24: where a cut should fall, from the motion in the footage itself. For the cut at the start of a shot: the motion of the outgoing clip over its last second (cut DURING a movement, not after it) and how closely each moment of it matches the first frame of the incoming clip (a match cut). Returns the best times; then move_cut.",
      schema: z.object({ shotId: z.string() }),
      run: (async (i: { shotId: string }) => {
        const k = find(i.shotId);
        if (k <= 0) return "pick a shot after the first";
        const prev = board.shots[k - 1]!, cur = board.shots[k]!;
        const clip = (id: string) => o.resolution.media.find((m) => m.shotId === id && m.role === "primary" && m.kind === "video");
        const a = clip(prev.id), b = clip(cur.id);
        if (!a) return `${prev.id} has no moving footage: nothing to cut on`;
        const FPS = 12, W = 32, H = 18;
        const from = Math.max(prev.startS + MIN_SHOT, cur.startS - 1);
        const to = Math.min(cur.startS + 0.4, prev.startS + capacity(prev.id, prev.trimInS ?? 0) - 0.05);
        const ss = (prev.trimInS ?? 0) + (from - prev.startS);
        const fr = await rgbFrames(a.localPath, { ss, t: to - from + 0.1, fps: FPS, w: W, h: H }).catch(() => []);
        if (fr.length < 3) return "the outgoing clip could not be read there";
        const gray = (f: Uint8Array) => { const g = new Float32Array(W * H); for (let p = 0; p < W * H; p++) g[p] = (f[p * 3]! + f[p * 3 + 1]! + f[p * 3 + 2]!) / 3; return g; };
        const gs = fr.map(gray);
        const motion = gs.map((g, j) => (j ? g.reduce((t, v, p) => t + Math.abs(v - gs[j - 1]![p]!), 0) / (W * H) : 0));
        const first = b ? (await rgbFrames(b.localPath, { ss: cur.trimInS ?? 0, t: 0.2, fps: FPS, w: W, h: H }).catch(() => []))[0] : undefined;
        const fg = first ? gray(first) : null;
        const match = gs.map((g) => (fg ? 1 - g.reduce((t, v, p) => t + Math.abs(v - fg[p]!), 0) / (W * H * 255) : 0));
        const at = (j: number) => r3(from + j / FPS);
        const peak = motion.reduce((best, v, j) => (v > motion[best]! ? j : best), 1);
        const bestMatch = match.reduce((best, v, j) => (v > match[best]! ? j : best), 0);
        const now = Math.round((cur.startS - from) * FPS);
        return `cut now at ${cur.startS.toFixed(2)} s (motion there ${(motion[Math.min(motion.length - 1, Math.max(0, now))] ?? 0).toFixed(1)}).\n- cut on action: the outgoing clip moves most at ${at(peak)} s (motion ${motion[peak]!.toFixed(1)}; the clip's median ${[...motion].sort((x, y) => x - y)[Math.floor(motion.length / 2)]!.toFixed(1)})${b ? `\n- match cut: the outgoing frame most like the incoming first frame is at ${at(bestMatch)} s (likeness ${match[bestMatch]!.toFixed(2)}; above 0.85 reads as a match)` : ""}\nMove the cut only where the voice allows (between words).`;
      }) as AgentTool["run"],
    },
    {
      name: "reframe",
      description: "Build list 5, item 21: give a shot a different framing from the shot before it — a punch-in on a part of the frame (scale 1.15–1.6 centred on a point, x/y 0–1), or start its clip at another moment (trimInS). Use it on the second half of a split or any cut back to the same picture, together with set_transition.",
      schema: z.object({ shotId: z.string(), punchIn: z.object({ scale: z.number().min(1.05).max(2), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(), trimInS: z.number().min(0).optional() }),
      run: (async (i: { shotId: string; punchIn?: { scale: number; x: number; y: number }; trimInS?: number }) => {
        const k = find(i.shotId);
        if (k < 0) return `no shot ${i.shotId}`;
        const sh = board.shots[k]!;
        const next = { ...sh } as typeof sh;
        if (i.punchIn) next.camera = { type: "ken_burns", fromScale: i.punchIn.scale, toScale: i.punchIn.scale * 1.04, from: [i.punchIn.x, i.punchIn.y], to: [i.punchIn.x, i.punchIn.y] } as typeof sh.camera;
        if (i.trimInS !== undefined) {
          if (capacity(sh.id, i.trimInS) < sh.endS - sh.startS) return `the clip does not hold ${(sh.endS - sh.startS).toFixed(2)} s after ${i.trimInS} s`;
          next.trimInS = i.trimInS;
        }
        board = { ...board, shots: board.shots.map((x, j) => (j === k ? next : x)) };
        ops.push(`reframe ${sh.id}`);
        return `${sh.id} reframed${i.punchIn ? ` (punch-in ×${i.punchIn.scale} at ${i.punchIn.x},${i.punchIn.y})` : ""}${i.trimInS !== undefined ? ` (clip from ${i.trimInS} s)` : ""}`;
      }) as AgentTool["run"],
    },
    {
      name: "move_cut",
      description: "Move the cut at the start of a shot to a new time (seconds). The previous shot ends there. A shot cannot become shorter than 0.35 s, and cannot grow past the footage its clip holds.",
      schema: z.object({ shotId: z.string(), toS: z.number() }),
      run: (async (i: { shotId: string; toS: number }) => {
        const k = find(i.shotId);
        if (k <= 0) return k === 0 ? "the first shot starts the film; it cannot move" : `no shot ${i.shotId}`;
        const prev = board.shots[k - 1]!, cur = board.shots[k]!;
        const to = r3(i.toS);
        if (to - prev.startS < MIN_SHOT || cur.endS - to < MIN_SHOT) return `refused: a shot would be shorter than ${MIN_SHOT} s`;
        if (to - prev.startS > capacity(prev.id, prev.trimInS ?? 0)) return `refused: ${prev.id}'s clip holds only ${capacity(prev.id, prev.trimInS ?? 0).toFixed(2)} s from its in-point`;
        // the current shot keeps its end; if it starts earlier it needs more footage
        if (cur.endS - to > capacity(cur.id, cur.trimInS ?? 0)) return `refused: ${cur.id}'s clip holds only ${capacity(cur.id, cur.trimInS ?? 0).toFixed(2)} s`;
        board.shots[k - 1] = { ...prev, endS: to };
        board.shots[k] = { ...cur, startS: to };
        ops.push(`move ${i.shotId} → ${to}`);
        return `ok: ${prev.id} now ${(to - prev.startS).toFixed(2)} s, ${cur.id} now ${(cur.endS - to).toFixed(2)} s, cut ${to.toFixed(2)} s`;
      }) as AgentTool["run"],
    },
    {
      name: "split_shot",
      description: "Split a shot in two at a time inside it. The second part continues the same clip (a punch-in: tighter frame, or a pull-out: wider). Designed elements (text, pictures) stay on the part you choose; the other part plays clean footage. Only shots with footage can be split; a still picture only with elements on both parts.",
      schema: z.object({ shotId: z.string(), atS: z.number(), second: z.enum(["punch_in", "pull_out"]), elementsOn: z.enum(["first", "second", "both"]).default("first") }),
      run: (async (i: { shotId: string; atS: number; second: "punch_in" | "pull_out"; elementsOn: "first" | "second" | "both" }) => {
        const k = find(i.shotId);
        if (k < 0) return `no shot ${i.shotId}`;
        const s = board.shots[k]!;
        const at = r3(i.atS);
        if (at - s.startS < MIN_SHOT || s.endS - at < MIN_SHOT) return `refused: both parts must be at least ${MIN_SHOT} s`;
        const prim = resolution.media.find((m) => m.shotId === s.id && m.role === "primary");
        if (!prim) return "refused: this shot has no footage of its own (a designed stage) — split only shots with footage";
        // A still picture never plays clean: a half without the shot's elements would be a frozen frame (film 1:
        // a cassette-deck photo split with its elements on the first half left a bare still, which the gate refused).
        if (prim.kind === "image") {
          const els = scenes.scenes.find((x) => x.shotId === s.id)?.elements ?? [];
          if (!els.length) return "refused: this shot is a still picture with nothing on it — a split would leave two frozen frames";
          if (i.elementsOn !== "both") return "refused: this shot is a still picture — split it only with elementsOn \"both\" (a half without elements would be a frozen frame)";
        }
        let n = 2;
        while (board.shots.some((x) => x.id === `${s.id}_${n}`)) n++;
        const id2 = `${s.id}_${n}`;
        const trim2 = (s.trimInS ?? 0) + (at - s.startS);
        const cam = s.camera;
        const scale = i.second === "punch_in" ? 1.28 : 0.86;
        const cam2 = cam.type === "ken_burns" ? { ...cam, fromScale: Math.max(1, cam.toScale * scale), toScale: Math.max(1, cam.toScale * scale * 1.03) } : { type: "ken_burns" as const, fromScale: Math.max(1, 1.02 * scale), toScale: Math.max(1, 1.05 * scale), from: [0.5, 0.5] as [number, number], to: [0.5, 0.48] as [number, number], easing: "ease_in_out" as const };
        board.shots.splice(k, 1, { ...s, endS: at }, { ...s, id: id2, startS: at, trimInS: r3(trim2), camera: cam2, transitionIn: o.filmTransition ? "film" : "whip", sfx: [] }); // item 24: a split is bridged as it is made
        const media2 = resolution.media.filter((m) => m.shotId === s.id).map((m) => ({ ...m, shotId: id2 }));
        resolution = { ...resolution, media: [...resolution.media, ...media2] };
        const sc = scenes.scenes.find((x) => x.shotId === s.id);
        if (sc) {
          const clean = { ...sc, shotId: id2, elements: i.elementsOn === "first" ? [] : sc.elements, idea: `${sc.idea} (second half, ${i.second})`, camera: { ...sc.camera, fromScale: Math.min(1.6, Math.max(0.9, sc.camera.toScale * scale)), toScale: Math.min(1.6, Math.max(0.9, sc.camera.toScale * scale * 1.03)) } };
          const first = i.elementsOn === "second" ? { ...sc, elements: [] } : sc;
          scenes = { ...scenes, scenes: [...scenes.scenes.filter((x) => x.shotId !== s.id), first, clean] };
        }
        clipLen.set(id2, clipLen.get(s.id) ?? Infinity);
        renumber();
        ops.push(`split ${s.id} at ${at} (${i.second}, elements on ${i.elementsOn})`);
        return `ok: ${s.id} ${(at - s.startS).toFixed(2)} s + ${id2} ${(s.endS - at).toFixed(2)} s (${i.second})`;
      }) as AgentTool["run"],
    },
    {
      name: "merge_with_next",
      description: "Join a shot with the next one: the shot holds through the next shot's time and the next shot is removed (its scene and pictures are dropped). Refused if this shot's clip does not hold the combined length.",
      schema: z.object({ shotId: z.string() }),
      run: (async (i: { shotId: string }) => {
        const k = find(i.shotId);
        if (k < 0 || k >= board.shots.length - 1) return k < 0 ? `no shot ${i.shotId}` : "the last shot has no next shot";
        const a = board.shots[k]!, b = board.shots[k + 1]!;
        if (b.endS - a.startS > capacity(a.id, a.trimInS ?? 0)) return `refused: ${a.id}'s clip holds only ${capacity(a.id, a.trimInS ?? 0).toFixed(2)} s`;
        board.shots.splice(k, 2, { ...a, endS: b.endS });
        resolution = { ...resolution, media: resolution.media.filter((m) => m.shotId !== b.id || m.role === "music" || m.role === "sfx") };
        scenes = { ...scenes, scenes: scenes.scenes.filter((x) => x.shotId !== b.id) };
        renumber();
        ops.push(`merge ${a.id}+${b.id}`);
        return `ok: ${a.id} now ${(b.endS - a.startS).toFixed(2)} s; ${b.id} removed`;
      }) as AgentTool["run"],
    },
    {
      name: "set_transition",
      description: "How a shot is entered: cut (default), film (the film's OWN transition from its kit — use it to bridge every change of the same picture and on turns; the channel bridges 4–11 same-picture changes a minute, mostly with light flashes), whip, fade, dip_black, light_leak, match, flash (a white flash cut, the channel uses it on hits and turns), zoom_punch (a punch-in on a hit), zoom_through (the next shot revealed through a shape that scales through the frame). A same-picture change with no bridge reads as a jump.",
      schema: z.object({ shotId: z.string(), kind: z.enum(["cut", "film", "fade", "whip", "dip_black", "light_leak", "match", "flash", "zoom_punch", "zoom_through"]) }),
      run: (async (i: { shotId: string; kind: Storyboard["shots"][number]["transitionIn"] }) => {
        const k = find(i.shotId);
        if (k < 0) return `no shot ${i.shotId}`;
        board.shots[k] = { ...board.shots[k]!, transitionIn: i.kind };
        ops.push(`transition ${i.shotId} ${i.kind}`);
        const soft = board.shots.filter((s) => s.transitionIn !== "cut").length;
        return `ok (${soft} of ${board.shots.length} shots now enter softly)`;
      }) as AgentTool["run"],
    },
    {
      name: "watch",
      description: "Watch a stretch of the edited film with its sound: a strip of frames and a listening report (a low-resolution render; use it on the stretches you changed most). Up to 15 s.",
      schema: z.object({ fromS: z.number(), toS: z.number() }),
      run: (async (i: { fromS: number; toS: number }) => {
        if (!o.watch) return "watching is not available in this run";
        const to = Math.min(i.toS, i.fromS + 15);
        watched++;
        const w = await o.watch({ storyboard: board, scenes, resolution }, i.fromS, to).catch((e: Error) => ({ strip: "", text: `could not render: ${e.message.slice(0, 200)}` }));
        return w.strip ? [{ type: "text" as const, text: w.text }, await img(w.strip)] : w.text;
      }) as AgentTool["run"],
    },
    ...(o.beats?.length
      ? [
          {
            name: "cut_on_beat",
            description: "Move the cut at the start of a shot onto the nearest beat of the music (within 0.25 s) — cutting on the music makes the rhythm felt. Only when the beat is near a word boundary; never into the middle of a word that matters.",
            schema: z.object({ shotId: z.string() }),
            run: (async (i: { shotId: string }) => {
              const k = find(i.shotId);
              if (k <= 0) return k === 0 ? "the first shot starts the film" : `no shot ${i.shotId}`;
              const t = board.shots[k]!.startS;
              const b = o.beats!.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity);
              if (!Number.isFinite(b) || Math.abs(b - t) > 0.25) return `no beat within 0.25 s of ${t.toFixed(2)} s`;
              const moveTool = tools.find((x) => x.name === "move_cut")!;
              const r = await (moveTool.run as (x: { shotId: string; toS: number }) => Promise<string>)({ shotId: i.shotId, toS: Math.round(b * 1000) / 1000 });
              return `beat at ${b.toFixed(2)} s: ${r}`;
            }) as AgentTool["run"],
          } satisfies AgentTool,
        ]
      : []),
    {
      name: "submit_cut",
      description: "Submit the cut with a short note of what you changed and why. Refused until you have studied at least two real passages, watched at least one changed stretch, and the cut measures at least as close to the channel as it started.",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        if (studied < 2) return `refused: study at least two real passages first (studied ${studied})`;
        // Step 6: a change of the same picture with nothing bridging it reads as a jump (film 1: 3 unbridged punch-ins;
        // the channel bridges 4–11 such changes a minute, mostly with light flashes).
        const BRIDGES = new Set(["film", "whip", "light_leak", "fade", "dip_black", "flash", "zoom_punch", "zoom_through"]);
        const unbridged = board.shots.filter((x) => /_\d+$/.test(x.id) && !BRIDGES.has(x.transitionIn ?? "cut")).map((x) => x.id);
        if (unbridged.length) return `refused: these halves change the same picture with nothing bridging them — a jump: ${unbridged.join(", ")}. set_transition each to ${o.filmTransition ? "film (the film's own transition)" : "whip or light_leak"}, or merge_with_next to undo the split.`;
        if (o.watch && !watched) return "refused: watch at least one stretch you changed (with its sound) before submitting — numbers alone do not show a jump cut or a cut that lands on the wrong picture";
        const now = measureNow();
        if (now.structure < before.structure) return `refused: the cut measures further from the channel than it started (${now.structure} < ${before.structure}). Read the cut and fix it.`;
        // build list 5, items 20–21: stutter cuts are never accepted; the rhythm at this film's length must be in band —
        // after two refusals what is left goes to the preflight gate as the editor's problem (never a stop)
        const st = stutterCuts(board.shots as never, resolution.media as never);
        if (st.length) return `refused: stutter cuts — ${st.map((x) => x.why).join("; ")}. Give each a different framing (set a camera move or trim to another moment) AND a transition (whip, light_leak, film), or merge it.`;
        const rh = await rhythmNow();
        if (rh && rh.outside.length && rhythmRefusals < 2) {
          rhythmRefusals++;
          return `refused (${rhythmRefusals}/2): the rhythm is outside real ${rhythmBand!.lengthS}-second stretches: ${rh.outside.map((x) => `${x.key} ${x.ours} (channel ${x.band.p10}–${x.band.p90})`).join("; ")}. Split long holds on action, merge slivers, move cuts off the word boundary into the motion.`;
        }
        accepted = { note: i.note };
        return `ACCEPTED (structure on your measures ${before.structure} → ${now.structure}). If this film taught you something, call note_lesson once; then stop.`;
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's editor (what worked, what the channel does that you did not expect).",
      schema: z.object({ lesson: z.string() }),
      run: (async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LESSON (${o.script.title.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      }) as AgentTool["run"],
    },
  ];

  const skill = await readFile(new URL("../skills/editor.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const systemBase = [
    cached(`${skill}\n\n## The channel's measured cutting (profile v${prof.version})\n${prof.directives.slice(0, 5).map((d) => `- ${d}`).join("\n")}`),
    plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes on your work (take these seriously)\n${tail(owner, 20)}\n\n` : ""}Times are in seconds on the narration's clock. Words with times are given so you can place cuts inside phrases.`),
  ];
  const system = o.techniques ? [...systemBase, plain(o.techniques)] : systemBase;
  const user = `Edit this film (${o.script.title}, ${o.script.aspect}, ${o.script.durationS.toFixed(1)} s).\n\nNARRATION WORDS (word@start):\n${words.map((w) => `${w.word}@${w.startS.toFixed(2)}`).join(" ")}\n\nSHOT INTENTS:\n${board.shots.map((s) => `${s.id} ${s.startS.toFixed(2)}–${s.endS.toFixed(2)} [${s.lineLink}] ${s.intent.slice(0, 90)} · said: "${lineOf(s).slice(0, 80)}"`).join("\n")}${o.brief ? `\n\nTHE SHOWRUNNER SENT THIS CUT BACK:\n${o.brief}` : ""}\n\nStart with read_cut.`;
  log(`  editor: ${board.shots.length} shots, structure on the editor's measures ${before.structure}/100 (${ROLE_MODEL.editor})…`);
  let grace = 2;
  const run = await agentLoop({ stage: "editor.agent", model: ROLE_MODEL.editor, system, user, tools, effort: "medium", maxTurns: 16, maxSeconds: 180, maxTokens: 24000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "The cut is not submitted yet. Read it, study the channel, edit, and submit.", log });
  const after = measureNow();
  const pass = accepted !== null;
  if (!pass && after.structure < before.structure) {
    // never hand on a cut that measures worse than the director's
    board = structuredClone(o.storyboard); scenes = structuredClone(o.scenes); resolution = structuredClone(o.resolution);
  }
  const final = pass || after.structure >= before.structure ? after : before;
  const report: EditorReport = { pass, before: { structure: before.structure, gaps: before.gaps }, after: { structure: final.structure, gaps: final.gaps }, ops, note: (accepted as { note: string } | null)?.note ?? "", agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  o.onReport?.(report);
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.script.title.slice(0, 60)}": ${pass ? "accepted" : "not accepted"}; structure ${before.structure} → ${final.structure}; ${ops.length} edits (${ops.filter((x) => x.startsWith("split")).length} splits, ${ops.filter((x) => x.startsWith("move")).length} moves, ${ops.filter((x) => x.startsWith("merge")).length} merges); remaining: ${final.gaps.map((g) => g.key).join(", ") || "none"}\n`);
  }
  log(`  editor: ${pass ? "accepted" : "not accepted"} — structure ${before.structure} → ${final.structure}, ${ops.length} edits, ${run.turns} turns, $${report.agent.usd}`);
  return { storyboard: { ...board, shots: board.shots.map((s, i) => ({ ...s, index: i })) }, scenes: { ...scenes, scenes: board.shots.flatMap((s) => scenes.scenes.filter((x) => x.shotId === s.id)) }, resolution, report };
}
