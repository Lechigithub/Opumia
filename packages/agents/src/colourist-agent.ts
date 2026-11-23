/**
 * The colourist (build list B9). The art director chose a grade per act and the scene designer chose a wash and a
 * dimming per shot; nobody looked at the film's colour as a whole. The colourist does: it measures every final
 * scene preview (brightness, colourfulness, how much of the frame one colour carries — senses:measureLook,
 * colourCover) against the channel's real frames measured the same way (data/exemplars: per-film looks, and the
 * share of real shots carried by one colour), finds tinted shots and acts that sit outside the channel, changes the
 * act grades and the per-shot wash/dim, re-renders what it changed and measures again.
 *
 *  skill    packages/agents/skills/colourist.md
 *  tools    read_grade, look, set_act_grade, set_shot, render_changes, submit_grade, note_lesson
 *  memory   <memoryDir>/<channel>.md, owner-notes.md (data/agents/colourist/)
 *  output   the design (act grades) and scene plan (wash, dim) — nothing else changes.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { FilmDesignSystem, ScenePlan } from "@opumia/contracts";
import { colourCover, contactSheet, measureLook } from "@opumia/senses";
import * as z from "zod/v4";
import { readMemory } from "./lessons.js";
import { agentLoop, BudgetError, cached, plain, type AgentTool, ROLE_MODEL } from "./llm.js";

interface ShotColour { luma: number; colourfulness: number; cover: number }
export interface ColourBand { luma: { p25: number; p75: number }; colourfulness: { p25: number; p75: number }; tintedShare: { median: number; max: number } }
export interface ColouristReport { pass: boolean; before: ColourSummary; after: ColourSummary; ops: string[]; note: string; agent: { turns: number; calls: Record<string, number>; usd: number } }
export interface ColourSummary { luma: number; colourfulness: number; tinted: number; tintedShare: number; outside: string[] }

export interface ColouristOptions {
  channel: string;
  title: string;
  data: string;
  design: FilmDesignSystem;
  scenes: ScenePlan;
  /** Shot id → act index (the chapter the shot sits in). */
  actOf: (shotId: string) => number;
  /** The narration line of a shot (for judging what the colour should feel like). */
  lineOf: (shotId: string) => string;
  /** Render the mid preview of these shots with this design and plan; returns shotId → frame file. */
  render: (design: FilmDesignSystem, plan: ScenePlan, shotIds: string[]) => Promise<Map<string, string>>;
  /** The current mid preview of every shot (already rendered by the scene designer). */
  frames: Map<string, string>;
  /** Step 2: watch a stretch with this design and plan, with the measured report. */
  watch?: (design: FilmDesignSystem, plan: ScenePlan, fromS: number, toS: number) => Promise<{ strip: string; text: string }>;
  /** Sent back by the preflight gate: what is wrong with the colour, in measured terms. */
  brief?: string;
  memoryDir?: string;
  log?: (s: string) => void;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
/** A frame counts as carried by one colour when half of all its pixels are saturated pixels of one colour family. */
const TINTED = 0.5;

async function measureFrame(file: string): Promise<ShotColour> {
  const look = await measureLook(file, { fps: 1 }).catch(() => null);
  const cover = await colourCover(file).catch(() => null);
  return { luma: r2(look?.luma ?? 0), colourfulness: r2(look?.colourfulness ?? 0), cover: r2(cover ?? 0) };
}

/** The channel's colour band from its real frames (exemplars), measured with the same functions; cached. */
export async function colourBand(data: string, channel: string): Promise<ColourBand | null> {
  const cache = path.join(data, ".cache", `colour-band-${channel}.json`);
  const hit = await readFile(cache, "utf8").then((t) => JSON.parse(t) as ColourBand, () => null);
  if (hit) return hit;
  const dir = path.join(data, "exemplars", channel);
  const idx = await readFile(path.join(dir, "index.json"), "utf8").then((t) => JSON.parse(t) as { looks?: { band?: { luma: { p25: number; p75: number }; colourfulness: { p25: number; p75: number } } }; shots: Array<{ film: string; frames: string[] }> }, () => null);
  if (!idx?.looks?.band) return null;
  const byFilm = new Map<string, number[]>();
  for (const s of idx.shots) {
    const f = s.frames[1] ?? s.frames[0];
    if (!f) continue;
    const c = await colourCover(path.join(dir, f)).catch(() => null);
    if (c !== null) (byFilm.get(s.film) ?? byFilm.set(s.film, []).get(s.film)!).push(c);
  }
  const shares = [...byFilm.values()].filter((xs) => xs.length >= 5).map((xs) => xs.filter((c) => c >= TINTED).length / xs.length);
  const band: ColourBand = { luma: idx.looks.band.luma, colourfulness: idx.looks.band.colourfulness, tintedShare: { median: r2(med(shares)), max: r2(Math.max(0, ...shares)) } };
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(`${cache}.tmp`, JSON.stringify(band) + "\n");
  await rename(`${cache}.tmp`, cache);
  return band;
}

export async function colouristAgent(o: ColouristOptions): Promise<{ design: FilmDesignSystem; scenes: ScenePlan; report: ColouristReport }> {
  const log = o.log ?? (() => {});
  const band = await colourBand(o.data, o.channel);
  let design: FilmDesignSystem = JSON.parse(JSON.stringify(o.design));
  let plan: ScenePlan = JSON.parse(JSON.stringify(o.scenes));
  const frames = new Map(o.frames);
  const measured = new Map<string, ShotColour>();
  for (const [id, f] of frames) if (existsSync(f)) measured.set(id, await measureFrame(f));
  const dirty = new Set<string>();
  const ops: string[] = [];
  let looked = 0, accepted: string | null = null, noteSaved = false;
  const summary = (): ColourSummary => {
    const ms = [...measured.values()];
    const luma = r2(med(ms.map((m) => m.luma))), colourfulness = r2(med(ms.map((m) => m.colourfulness)));
    const tinted = ms.filter((m) => m.cover >= TINTED).length;
    const share = r2(tinted / Math.max(1, ms.length));
    const outside: string[] = [];
    if (band) {
      if (luma < band.luma.p25 * 0.95) outside.push(`too dark (${luma}; channel ${band.luma.p25}–${band.luma.p75})`);
      if (luma > band.luma.p75 * 1.1) outside.push(`too bright (${luma})`);
      if (colourfulness < band.colourfulness.p25 * 0.95) outside.push(`too dull (${colourfulness}; channel ${band.colourfulness.p25}–${band.colourfulness.p75})`);
      if (colourfulness > band.colourfulness.p75 * 1.25) outside.push(`over-saturated (${colourfulness})`);
      const lim = Math.max(band.tintedShare.median * 1.5, 0.12); // build list 4, item 15: tighter (film 3 shipped red and blue washed footage at 17 %)
      if (share > lim) outside.push(`${Math.round(share * 100)} % of shots carried by one colour (the channel's typical film ${Math.round(band.tintedShare.median * 100)} %, most ${Math.round(band.tintedShare.max * 100)} %)`);
    }
    return { luma, colourfulness, tinted, tintedShare: share, outside };
  };
  const before = summary();
  // ---- build list 5, item 28: the colourist ALWAYS grades the film, before any model turn. A model-free first grade
  // pulls the film's brightness and colourfulness to the channel's median (one exposure and saturation per act) and
  // pulls stock that sits far brighter than the film into its grade; it is checked on the re-rendered previews and kept
  // only if the film moved closer to the channel. The agent then refines it. With no budget, this grade stands.
  if (band && measured.size) {
    const s0 = summary();
    const lumaT = (band.luma.p25 + band.luma.p75) / 2;
    const colT = (band.colourfulness.p25 + band.colourfulness.p75) / 2;
    const bright = Math.max(0.85, Math.min(1.35, s0.luma > 0 ? Math.sqrt(lumaT / s0.luma) * (s0.luma < band.luma.p25 ? 1.04 : 1) : 1));
    const satF = Math.max(0.75, Math.min(1.25, s0.colourfulness > 0 ? colT / s0.colourfulness : 1));
    const design0 = design, plan0 = plan;
    const auto: string[] = [];
    if (Math.abs(bright - 1) > 0.03 || Math.abs(satF - 1) > 0.05) {
      design = { ...design, acts: design.acts.map((a) => ({ ...a, brightness: Math.round(Math.max(0.7, Math.min(1.4, (a.brightness ?? 1) * bright)) * 100) / 100, saturation: Math.round(Math.max(0.4, Math.min(1.3, a.saturation * satF)) * 100) / 100 })) };
      auto.push(`every act: exposure ×${bright.toFixed(2)}, saturation ×${satF.toFixed(2)}`);
      for (const sc of plan.scenes) dirty.add(sc.shotId);
    }
    // stock far brighter than the film (a white office against a dark film) is dimmed toward the film's level
    const med = s0.luma;
    for (const [id, m] of measured) {
      const sc = plan.scenes.find((x) => x.shotId === id);
      if (!sc || sc.backdrop !== "footage" || m.luma < med * 1.45) continue;
      const dim = Math.round(Math.min(0.5, 1 - (med * 1.2) / m.luma) * 100) / 100;
      if (dim <= 0.05) continue;
      plan = { ...plan, scenes: plan.scenes.map((x) => (x.shotId === id ? ({ ...x, dim: Math.max((x as { dim?: number }).dim ?? 0, dim) } as typeof x) : x)) };
      dirty.add(id);
      auto.push(`${id} dimmed ${dim} (it sat at ${m.luma.toFixed(2)} against the film's ${med.toFixed(2)})`);
    }
    if (dirty.size) {
      const ids = [...dirty];
      const got = await o.render(design, plan, ids).catch(() => new Map<string, string>());
      const saved = new Map(measured);
      for (const [id, f] of got) { frames.set(id, f); measured.set(id, await measureFrame(f)); }
      dirty.clear();
      const s1 = summary();
      const off = (x: ColourSummary) => Math.abs(x.luma - lumaT) / Math.max(1e-6, lumaT) + Math.abs(x.colourfulness - colT) / Math.max(1e-6, colT);
      if (got.size && (s1.outside.length < s0.outside.length || (s1.outside.length === s0.outside.length && off(s1) < off(s0)))) {
        ops.push(...auto.map((a) => `auto: ${a}`));
        log(`  colourist: first grade — ${auto.join("; ")} → brightness ${s0.luma} → ${s1.luma}, colourfulness ${s0.colourfulness} → ${s1.colourfulness}`);
      } else {
        design = design0; plan = plan0;
        for (const [id, m] of saved) measured.set(id, m);
        log(`  colourist: the first grade did not bring the film closer to the channel — kept as it was`);
      }
    }
  }
  const sumText = (s: ColourSummary) => `Film: brightness ${s.luma}, colourfulness ${s.colourfulness}, ${s.tinted} shot(s) carried by one colour (${Math.round(s.tintedShare * 100)} %).${band ? ` Channel: brightness ${band.luma.p25}–${band.luma.p75}, colourfulness ${band.colourfulness.p25}–${band.colourfulness.p75}, one-colour shots ${Math.round(band.tintedShare.median * 100)} % typical.` : ""}${s.outside.length ? `\nOUTSIDE THE CHANNEL: ${s.outside.join("; ")}` : "\nInside the channel's colour band."}${dirty.size ? `\n(${dirty.size} shot(s) changed and not yet rendered — call render_changes)` : ""}`;
  const sceneOf = (id: string) => plan.scenes.find((s) => s.shotId === id);

  const tools: AgentTool[] = [
    {
      name: "read_grade",
      description: "The film's colour: each act's grade (tint, strength, saturation, contrast) and the measured shots in it — brightness, colourfulness, how much of the frame one colour carries, the shot's backdrop, wash and dimming — against the channel's real frames.",
      schema: z.object({}),
      run: (async () => {
        const acts = design.acts.map((a, k) => {
          const ids = plan.scenes.map((s) => s.shotId).filter((id) => o.actOf(id) === k);
          const rows = ids.map((id) => { const m = measured.get(id); const sc = sceneOf(id)!; return `   ${id} ${sc.backdrop}${sc.wash ? ` wash ${sc.wash.color}/${sc.wash.strength}/${sc.wash.mode}` : ""} dim ${sc.dim}${m ? ` → brightness ${m.luma}, colourful ${m.colourfulness}, one colour ${Math.round(m.cover * 100)} %${m.cover >= TINTED ? " ← TINTED" : ""}` : " (not rendered)"}${dirty.has(id) ? " (changed)" : ""} · "${o.lineOf(id).slice(0, 60)}"`; });
          return `act ${k} "${a.name}": tint ${a.tint} strength ${a.tintStrength}, saturation ${a.saturation}, contrast ${a.contrast}\n${rows.join("\n")}`;
        });
        return `${acts.join("\n\n")}\n\n${sumText(summary())}`;
      }) as AgentTool["run"],
    },
    {
      name: "look",
      description: "See up to 12 shots' mid frames side by side (in film order) — judge the colour as a viewer would: one tone everywhere? a shot that jumps out? footage tinted into a monochrome?",
      schema: z.object({ shotIds: z.array(z.string()).min(1).max(12) }),
      run: (async (i: { shotIds: string[] }) => {
        const fs = i.shotIds.map((id) => frames.get(id)).filter((f): f is string => !!f && existsSync(f));
        if (!fs.length) return "none of those shots has a rendered frame";
        looked++;
        const sheet = await contactSheet(fs, path.join(path.dirname(fs[0]!), `_colour_${looked}.jpg`), { cols: Math.min(4, fs.length), cellW: 320 });
        return [{ type: "text" as const, text: `Left to right, top to bottom: ${i.shotIds.filter((id) => frames.has(id)).join(", ")}` }, await img(sheet)];
      }) as AgentTool["run"],
    },
    ...(o.watch
      ? [
          {
            name: "watch_stretch",
            description: "Watch a stretch (up to 15 s) as it plays, with the current grade: how the colour moves from shot to shot, and the measured report (jumps, legibility, taste).",
            schema: z.object({ fromS: z.number(), toS: z.number() }),
            run: (async (i: { fromS: number; toS: number }) => {
              looked++;
              const w = await o.watch!(design, plan, Math.max(0, i.fromS), Math.min(i.toS, i.fromS + 15)).catch((e: Error) => ({ strip: "", text: `could not render: ${e.message.slice(0, 160)}` }));
              return w.strip ? [{ type: "text" as const, text: w.text }, await img(w.strip)] : w.text;
            }) as AgentTool["run"],
          } satisfies AgentTool,
        ]
      : []),
    {
      name: "set_act_grade",
      description: "Change an act's grade: tint colour (hex), tint strength (0–0.6; over ~0.12 tints all footage), saturation (0.4–1.3), contrast (0.9–1.3). Every shot of the act must be re-rendered.",
      schema: z.object({ act: z.number().int().min(0), tint: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), tintStrength: z.number().min(0).max(0.6).optional(), saturation: z.number().min(0.4).max(1.3).optional(), contrast: z.number().min(0.9).max(1.3).optional() }),
      run: (async (i: { act: number; tint?: string; tintStrength?: number; saturation?: number; contrast?: number }) => {
        const a = design.acts[i.act];
        if (!a) return `no act ${i.act}`;
        design = { ...design, acts: design.acts.map((x, k) => (k === i.act ? { ...x, ...(i.tint ? { tint: i.tint } : {}), ...(i.tintStrength !== undefined ? { tintStrength: i.tintStrength } : {}), ...(i.saturation !== undefined ? { saturation: i.saturation } : {}), ...(i.contrast !== undefined ? { contrast: i.contrast } : {}) } : x)) };
        for (const s of plan.scenes) if (o.actOf(s.shotId) === i.act) dirty.add(s.shotId);
        ops.push(`act ${i.act} grade ${JSON.stringify({ tint: i.tint, tintStrength: i.tintStrength, saturation: i.saturation, contrast: i.contrast })}`);
        return `act ${i.act} changed; ${dirty.size} shot(s) to render`;
      }) as AgentTool["run"],
    },
    {
      name: "set_shot",
      description: "Change one shot's colour: its wash (remove it, or set its strength 0–0.85) and its dimming of the footage behind elements (0–0.85).",
      schema: z.object({ shotId: z.string(), removeWash: z.boolean().default(false), washStrength: z.number().min(0).max(0.85).optional(), dim: z.number().min(0).max(0.85).optional() }),
      run: (async (i: { shotId: string; removeWash: boolean; washStrength?: number; dim?: number }) => {
        const sc = sceneOf(i.shotId);
        if (!sc) return `no scene ${i.shotId}`;
        plan = { ...plan, scenes: plan.scenes.map((s) => {
          if (s.shotId !== i.shotId) return s;
          const { wash, ...rest } = s;
          const nw = i.removeWash ? undefined : wash && i.washStrength !== undefined ? { ...wash, strength: i.washStrength } : wash;
          return { ...rest, ...(nw ? { wash: nw } : {}), ...(i.dim !== undefined ? { dim: i.dim } : {}) } as typeof s;
        }) };
        dirty.add(i.shotId);
        ops.push(`shot ${i.shotId} ${i.removeWash ? "no wash" : i.washStrength !== undefined ? `wash ${i.washStrength}` : ""}${i.dim !== undefined ? ` dim ${i.dim}` : ""}`);
        return `changed; ${dirty.size} shot(s) to render`;
      }) as AgentTool["run"],
    },
    {
      name: "render_changes",
      description: "Render every changed shot again and measure it.",
      schema: z.object({}),
      run: (async () => {
        if (!dirty.size) return "nothing changed";
        const ids = [...dirty];
        const got = await o.render(design, plan, ids);
        for (const [id, f] of got) { frames.set(id, f); measured.set(id, await measureFrame(f)); }
        dirty.clear();
        return `${got.size} shot(s) rendered.\n${sumText(summary())}`;
      }) as AgentTool["run"],
    },
    {
      name: "submit_grade",
      description: "Hand over the grade. Refused while changes are not rendered, before you have looked at the film, or if the film moved further outside the channel than it started.",
      schema: z.object({ note: z.string() }),
      run: (async (i: { note: string }) => {
        if (dirty.size) return "refused: render_changes first";
        if (!looked) return "refused: look at the film first";
        const now = summary();
        if (now.outside.length > before.outside.length) return `refused: more outside the channel than at the start (${now.outside.join("; ")})`;
        accepted = i.note;
        return "Accepted. If this film taught you something about colour, call note_lesson once; then stop.";
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's colourist.",
      schema: z.object({ lesson: z.string() }),
      run: (async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LESSON (${o.title.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      }) as AgentTool["run"],
    },
  ];
  const skill = await readFile(new URL("../skills/colourist.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const system = [cached(skill), plain(`${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}The film's colour world (art director): primary ${design.palette.primary}, accent ${design.palette.accent}.`)];
  log(`  colourist: ${sumText(before).split("\n")[0]}${before.outside.length ? ` — outside: ${before.outside.join("; ")}` : ""} (${ROLE_MODEL.colourist})`);
  let grace = 1;
  // the first grade above stands if the film has no money left for model turns
  const run = await agentLoop({ stage: "colourist.agent", model: ROLE_MODEL.colourist, system, user: `Grade "${o.title}".${o.brief ? ` The preflight gate sent the colour back: ${o.brief}` : ""} Start with read_grade.`, tools, effort: "medium", maxTurns: 12, maxSeconds: 180, maxTokens: 16000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "Not submitted yet. Read the grade, look, change what is outside the channel, render and submit.", log }).catch((e: unknown) => { if (e instanceof BudgetError) return { turns: 0, calls: {}, stopped: "max_usd" as const, usd: 0 }; throw e; });
  const after = summary();
  const keep = accepted !== null || after.outside.length < before.outside.length || ops.some((x) => x.startsWith("auto:"));
  const report: ColouristReport = { pass: accepted !== null, before, after: keep ? after : before, ops, note: accepted ?? (keep ? "not submitted; kept its rendered state" : "not submitted: the original grade was kept"), agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.title.slice(0, 60)}": tinted ${before.tinted} → ${report.after.tinted}, outside ${before.outside.length} → ${report.after.outside.length}; ${ops.length} change(s); ${(accepted ?? "").slice(0, 200).replace(/\s+/g, " ")}\n`);
  }
  log(`  colourist: tinted shots ${before.tinted} → ${report.after.tinted}, outside ${before.outside.length} → ${report.after.outside.length}, ${ops.length} change(s), ${run.turns} turns, $${report.agent.usd}`);
  return keep ? { design, scenes: plan, report } : { design: o.design, scenes: o.scenes, report };
}
