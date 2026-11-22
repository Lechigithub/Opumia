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
import { probeDuration } from "@opumia/senses";
import * as z from "zod/v4";
import { loadChannelProfile, type Segment } from "./channel-profile.js";
import { ourShotsFrom, structureOf, type FilmGap } from "./film-score.js";
import { agentLoop, cached, MODELS, plain, type AgentTool } from "./llm.js";
import { edl, findPassages } from "./reference-library.js";

/** Measures the editor owns (sound and picture kinds belong to other agents). */
export const EDITOR_KEYS = ["cutsPerMin", "shotMedianS", "shotCv", "cutInPause", "cutToWordMedianS", "wordsPerShot"];

export interface EditorReport { pass: boolean; before: { structure: number; gaps: FilmGap[] }; after: { structure: number; gaps: FilmGap[] }; ops: string[]; note: string; agent: { turns: number; calls: Record<string, number>; usd: number } }

export interface EditorAgentOptions {
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

  let studied = 0;
  let watched = 0;
  let accepted: { note: string } | null = null;
  let noteSaved = false;
  const tools: AgentTool[] = [
    {
      name: "read_cut",
      description: "Our current cut as an edit decision list (every shot: start, length, picture kind, text, cut against the voice, words said) and every gap to the channel's band on the editor's measures, whole film and by position.",
      schema: z.object({}),
      run: (async () => cutText()) as AgentTool["run"],
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
        board.shots.splice(k, 1, { ...s, endS: at }, { ...s, id: id2, startS: at, trimInS: r3(trim2), camera: cam2, transitionIn: "cut", sfx: [] });
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
      description: "How a shot is entered: cut (default), film (the film's OWN transition from its kit — use it to bridge every change of the same picture and on turns; the channel bridges 4–11 same-picture changes a minute, mostly with light flashes), whip, fade, dip_black, light_leak, match. A same-picture change with no bridge reads as a jump.",
      schema: z.object({ shotId: z.string(), kind: z.enum(["cut", "film", "fade", "whip", "dip_black", "light_leak", "match"]) }),
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
        const BRIDGES = new Set(["film", "whip", "light_leak", "fade", "dip_black"]);
        const unbridged = board.shots.filter((x) => /_\d+$/.test(x.id) && !BRIDGES.has(x.transitionIn ?? "cut")).map((x) => x.id);
        if (unbridged.length) return `refused: these halves change the same picture with nothing bridging them — a jump: ${unbridged.join(", ")}. set_transition each to ${o.filmTransition ? "film (the film's own transition)" : "whip or light_leak"}, or merge_with_next to undo the split.`;
        if (o.watch && !watched) return "refused: watch at least one stretch you changed (with its sound) before submitting — numbers alone do not show a jump cut or a cut that lands on the wrong picture";
        const now = measureNow();
        if (now.structure < before.structure) return `refused: the cut measures further from the channel than it started (${now.structure} < ${before.structure}). Read the cut and fix it.`;
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
  const system = [
    cached(`${skill}\n\n## The channel's measured cutting (profile v${prof.version})\n${prof.directives.slice(0, 5).map((d) => `- ${d}`).join("\n")}`),
    plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes on your work (take these seriously)\n${tail(owner, 20)}\n\n` : ""}Times are in seconds on the narration's clock. Words with times are given so you can place cuts inside phrases.`),
  ];
  const user = `Edit this film (${o.script.title}, ${o.script.aspect}, ${o.script.durationS.toFixed(1)} s).\n\nNARRATION WORDS (word@start):\n${words.map((w) => `${w.word}@${w.startS.toFixed(2)}`).join(" ")}\n\nSHOT INTENTS:\n${board.shots.map((s) => `${s.id} ${s.startS.toFixed(2)}–${s.endS.toFixed(2)} [${s.lineLink}] ${s.intent.slice(0, 90)} · said: "${lineOf(s).slice(0, 80)}"`).join("\n")}${o.brief ? `\n\nTHE SHOWRUNNER SENT THIS CUT BACK:\n${o.brief}` : ""}\n\nStart with read_cut.`;
  log(`  editor: ${board.shots.length} shots, structure on the editor's measures ${before.structure}/100 (${MODELS.sonnet})…`);
  let grace = 2;
  const run = await agentLoop({ stage: "editor.agent", model: MODELS.sonnet, system, user, tools, effort: "medium", maxTurns: 40, maxTokens: 24000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "The cut is not submitted yet. Read it, study the channel, edit, and submit.", log });
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
