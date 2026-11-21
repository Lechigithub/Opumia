/**
 * The scene designer agent: it designs every shot, renders its own previews, looks at them, measures the film
 * against the channel's real shots, and revises — until the film passes or it runs out of turns.
 *
 *  skill    packages/agents/skills/scenes.md
 *  tools    view_reference_shots (real frames of the channel), design_scenes (checked by the same guards as
 *           before), render_previews (its own shots at three moments — its eyes), measure_film (the visual
 *           band), submit_scenes, note_lesson
 *  memory   <memoryDir>/<channel>.md — its own lessons and a log of every film
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { ScenePlan, type FilmDesignSystem, type ResolutionReport, type Storyboard, type StoryboardShot, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { agentLoop, MODELS, plain, type AgentTool } from "./llm.js";
import { designScenes, SceneDraftSchema, type SceneDraftScene } from "./scene-designer.js";
import { labelShots, SHOT_KINDS, visualIssues, visualProfile, type VisualBand, type VisualProfile } from "./visual-measure.js";

export interface ReferenceShot { kind: string; layout: string; motion: string; line: string; frame: string }
export interface SceneReport {
  pass: boolean;
  rounds: Array<{ issues: string[]; profile: VisualProfile }>;
  remaining: Array<{ kind: string; detail: string }>;
  agent: { turns: number; calls: Record<string, number>; usd: number; rendered: number };
}
export interface SceneAgentOptions {
  storyboard: Storyboard;
  script: TimedScript;
  resolution: ResolutionReport;
  design: FilmDesignSystem | null;
  channel: string;
  visualBand: VisualBand;
  referenceShots: ReferenceShot[];
  /** Renders the given shots of a plan at three moments: the sheet (all three) and the middle frame. */
  render: (plan: ScenePlan, shotIds: string[]) => Promise<Array<{ shotId: string; sheet: string; mid: string }>>;
  memoryDir?: string;
  people?: string[];
  avoidLayouts?: string;
  onReport?: (r: SceneReport) => void;
  log?: (s: string) => void;
}

const isScene = (s: StoryboardShot) => s.source.kind === "designed" && s.source.designed === "scene";
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(file)).toString("base64") } });

export async function designScenesAgent(o: SceneAgentOptions): Promise<ScenePlan> {
  const log = o.log ?? (() => {});
  const shots = o.storyboard.shots.filter(isScene);
  const empty = () => ScenePlan.parse({ schemaVersion: 1, storyboardId: o.storyboard.id, scenes: [], generatedAt: new Date().toISOString() });
  if (!shots.length) return empty();
  const skill = await readFile(new URL("../skills/scenes.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readFile(path.join(o.memoryDir, `${o.channel}.md`), "utf8").catch(() => "") : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const words = o.script.segments.flatMap((s) => s.words);
  const lineOf = (sh: StoryboardShot) => words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
  const band = o.visualBand;
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const ds = o.design;
  const tr = ds?.treatment;

  let plan: ScenePlan = empty();
  const dirty = new Set<string>(); // designed or changed since the last render
  const unseen = new Set<string>(); // designed or changed since the designer last LOOKED at it
  let referenceViews = 0;
  const frames = new Map<string, { sheet: string; mid: string }>();
  const rounds: SceneReport["rounds"] = [];
  let lastIssues: Array<{ kind: string; detail: string }> = [{ kind: "not_designed", detail: "no scenes were designed" }];
  let accepted = false;
  let noteSaved = false;
  let grace = 1;
  let rendered = 0;

  const renderShots = async (ids: string[]) => {
    const want = ids.filter((id) => plan.scenes.some((s) => s.shotId === id));
    if (!want.length) return [];
    const out = await o.render(plan, want);
    for (const r of out) {
      frames.set(r.shotId, { sheet: r.sheet, mid: r.mid });
      dirty.delete(r.shotId);
    }
    rendered += out.length;
    return out;
  };

  const measure = async (submitting = false) => {
    const missing = shots.map((s) => s.id).filter((id) => !plan.scenes.some((x) => x.shotId === id));
    const stale = plan.scenes.map((s) => s.shotId).filter((id) => dirty.has(id) || !frames.has(id));
    for (let i = 0; i < stale.length; i += 12) await renderShots(stale.slice(i, i + 12));
    const ids = plan.scenes.map((s) => s.shotId).filter((id) => frames.has(id));
    const labels = await labelShots(ids.map((id) => frames.get(id)!.mid));
    const profile = visualProfile(labels);
    const issues: Array<{ kind: string; detail: string }> = visualIssues(profile, band).map((x) => ({ kind: x.kind, detail: x.detail }));
    if (missing.length) issues.push({ kind: "shots_missing", detail: `no scene for ${missing.join(", ")} — every shot needs one (a clean shot is a scene too).` });
    // Clean shots must be worth watching: enough of them, never a run of dead frames.
    const kinds = ids.map((id, k) => ({ id, kind: labels[k]?.kind ?? "plain_footage" }));
    let run = 0;
    for (const [k, x] of kinds.entries()) {
      run = k > 0 && kinds[k - 1]!.kind === x.kind && x.kind !== "plain_footage" ? run + 1 : 1;
      if (run >= 4) {
        issues.push({ kind: "same_kind_in_a_row", detail: `four shots in a row are "${x.kind}" (ending at ${x.id}) — change what the viewer sees.` });
        break;
      }
    }
    // Picture-less scenes: a word or two on a plain stage is a slide, and a stage that ignores its pictures is a waste.
    const slotsOf = (id: string) => o.resolution.media.filter((m) => m.shotId === id && m.role === "layer");
    const staged = plan.scenes.filter((sc) => sc.backdrop !== "footage" && sc.backdrop !== "split");
    const hasPicture = (sc: (typeof staged)[number]) => sc.elements.some((e) => e.type === "photo" || e.type === "cutout" || e.type === "card3d");
    const unused = staged.filter((sc) => !hasPicture(sc) && slotsOf(sc.shotId).length > 0);
    if (unused.length) issues.push({ kind: "unused_picture", detail: `these shots have real pictures available and show none: ${unused.map((sc) => `${sc.shotId} (${slotsOf(sc.shotId).map((m) => `[${m.slot}] ${(m.depicts ?? m.query).slice(0, 40)}`).join("; ")})`).join(", ")}. Build the scene around the picture.` });
    const wordsOn = (sc: (typeof staged)[number]) => sc.elements.filter((e) => e.type === "text" || e.type === "phrase" || e.type === "text3d").reduce((n, e) => n + ("text" in e ? e.text.trim().split(/\s+/).length : 0), 0);
    const bare = staged.filter((sc) => !hasPicture(sc) && wordsOn(sc) <= 3 && !sc.elements.some((e) => e.type === "text3d"));
    const allow = Math.max(1, Math.floor(plan.scenes.length * 0.08));
    if (bare.length > allow) issues.push({ kind: "bare_word_cards", detail: `${bare.length} shots are a word or two on a plain stage (${bare.map((sc) => sc.shotId).join(", ")}); at most ${allow} in a film this long. A lone word on colour is a slide: carry the line with more of the narration's words set with intent, a drawn shape that means something, the film's motif, or 3D type for the one biggest moment.` });
    if (submitting) {
      if (unseen.size) issues.push({ kind: "not_looked_at", detail: `you have not looked at these shots since designing or changing them: ${[...unseen].sort().join(", ")}. Render them with render_previews and look before you submit.` });
      if (referenceViews < 3) issues.push({ kind: "reference_not_studied", detail: `you have looked at the channel's real shots ${referenceViews} time(s). Look at least at clean footage ("none"), words over footage and one composed kind before you submit.` });
    }
    rounds.push({ issues: issues.map((x) => x.kind), profile });
    lastIssues = issues;
    const mix = SHOT_KINDS.filter((k) => profile.share[k] > 0).sort((a, b) => profile.share[b] - profile.share[a]).map((k) => `${k} ${pc(profile.share[k])}`).join(", ");
    const ref = SHOT_KINDS.filter((k) => band.mix[k] > 0).sort((a, b) => band.mix[b] - band.mix[a]).map((k) => `${k} ${pc(band.mix[k])}`).join(", ");
    const header = `YOUR FILM (${profile.shots} shots), labelled like the channel's real shots:\n- mix: ${mix}\n- ${profile.distinctKinds} kinds of shot (channel's films: ${band.distinctKinds.p10}–${band.distinctKinds.p90}); most used: ${profile.topKind} ${pc(profile.topShare)}\n- shots with any text: ${pc(profile.textShare)} (channel: ${pc(band.textShare.p10)}–${pc(band.textShare.p90)}); words when there is text: ${profile.wordsMedian} (channel ${band.wordsMedian.p10}–${band.wordsMedian.p90})\n- shots composing a separate picture: ${pc(profile.pictureShare)} (channel ${pc(band.pictureShare.p10)}–${pc(band.pictureShare.p90)})\nTHE CHANNEL'S MIX: ${ref}\nPer shot: ${kinds.map((x) => `${x.id}=${x.kind}`).join(", ")}`;
    return { ok: issues.length === 0, report: issues.length ? `${header}\n\nNOT YET — ${issues.length} thing(s) to fix:\n${issues.map((x, i) => `${i + 1}. [${x.kind}] ${x.detail}`).join("\n")}` : `${header}\n\nPASSES.` };
  };

  const tools: AgentTool[] = [
    {
      name: "view_reference_shots",
      description: `See real shots of the channel (frames with what was on screen and the line spoken). kind is one of the channel's own labels or part of one, e.g. "none" (clean footage), "text_over_footage", "title_card", "cutout", "logo", "document", "number", "chart", "kinetic", "quote", "collage" — or "any" for a spread. Up to 6 frames per call.`,
      schema: z.object({ kind: z.string() }),
      run: (async (i: { kind: string }) => {
        referenceViews++;
        const q = i.kind.toLowerCase().trim();
        const pool = q === "any" || !q ? o.referenceShots.filter((_, k) => k % Math.max(1, Math.floor(o.referenceShots.length / 6)) === 0) : o.referenceShots.filter((s) => s.kind.toLowerCase().includes(q) || s.layout.toLowerCase().includes(q));
        if (!pool.length) return `no reference shot labelled "${i.kind}". Labels in use: ${[...new Set(o.referenceShots.map((s) => s.kind))].slice(0, 40).join(", ")}`;
        const step = Math.max(1, Math.floor(pool.length / 6));
        const pick = pool.filter((_, k) => k % step === 0).slice(0, 6);
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const s of pick) {
          const im = await img(s.frame).catch(() => null);
          if (!im) continue;
          out.push({ type: "text", text: `REAL SHOT — ${s.kind === "none" ? "clean footage, nothing designed" : s.kind}: ${s.layout}; motion: ${s.motion}; over the line "${s.line.slice(0, 110)}"` }, im);
        }
        return out.length ? out : "those frames could not be read";
      }) as AgentTool["run"],
    },
    {
      name: "design_scenes",
      description: "Design (or redesign) scenes. Send every shot the first time; afterwards send only the shots you are changing. Each design is checked: elements that break a rule are removed and you are told. Mark a shot clean to let its footage play with nothing on it.",
      schema: SceneDraftSchema,
      run: (async (i: { scenes: SceneDraftScene[] }) => {
        const said: string[] = [];
        const known = new Set(shots.map((s) => s.id));
        const raw = i.scenes.filter((s) => known.has(s.shotId));
        if (!raw.length) throw new Error("none of those shot ids exist");
        plan = await designScenes({ storyboard: o.storyboard, script: o.script, resolution: o.resolution, design: o.design, channel: o.channel, ...(o.people ? { people: o.people } : {}), raw, previous: plan, log: (s) => said.push(s.trim()) });
        for (const s of raw) (dirty.add(s.shotId), unseen.add(s.shotId));
        const lines = raw.map((r) => {
          const got = plan.scenes.find((x) => x.shotId === r.shotId);
          if (!got) return `${r.shotId}: REJECTED (nothing usable was left)`;
          const lost = r.clean && got.elements.length ? " — could not be clean (no moving footage): a phrase was kept" : !r.clean && got.elements.filter((e) => e.type !== "texture").length < r.elements.filter((e) => e.type !== "texture").length ? ` — ${r.elements.length - got.elements.length} element(s) removed by the checks` : "";
          const moved = r.backdrop !== got.backdrop ? ` — backdrop changed to ${got.backdrop}` : "";
          return `${r.shotId}: ${got.elements.length ? got.elements.map((e) => e.type).join("+") : "clean footage"} on ${got.backdrop}${lost}${moved}`;
        });
        return `${plan.scenes.length}/${shots.length} shots have a scene.\n${lines.join("\n")}${said.length ? `\nchecks: ${said.join(" ").slice(0, 500)}` : ""}`;
      }) as AgentTool["run"],
    },
    {
      name: "render_previews",
      description: "Render your scenes and look at them: three moments of each shot (early, middle, end). Up to 9 shots per call. Look for anything cut off, overlapping, unreadable, covering a face or the subject, an empty or dull frame, and shots that look alike.",
      schema: z.object({ shotIds: z.array(z.string()).min(1).max(9) }),
      run: (async (i: { shotIds: string[] }) => {
        const out = await renderShots(i.shotIds);
        if (!out.length) return "nothing to render: design those shots first";
        const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const r of out) {
          const sh = shots.find((s) => s.id === r.shotId)!;
          blocks.push({ type: "text", text: `${r.shotId} — "${lineOf(sh).slice(0, 120)}" (early, middle, end):` }, await img(r.sheet));
          unseen.delete(r.shotId);
        }
        return blocks;
      }) as AgentTool["run"],
    },
    {
      name: "measure_film",
      description: "Measure the whole film: every shot's middle frame is labelled the way the channel's real shots were, and the film's mix of shot kinds, how much text it carries and how many pictures it composes are compared with the channel's range.",
      schema: z.object({}),
      run: async () => (await measure()).report,
    },
    {
      name: "submit_scenes",
      description: "Submit the film's scenes. They are measured once more; accepted when the film passes, otherwise you get back what is still wrong.",
      schema: z.object({}),
      run: async () => {
        const r = await measure(true);
        if (r.ok) accepted = true;
        return r.ok ? `ACCEPTED.\n${r.report}\nIf this film taught you something, call note_lesson once; then stop.` : r.report;
      },
    },
    {
      name: "note_lesson",
      description: "Save one short lesson for your future self. It is shown to you before your next film.",
      schema: z.object({ lesson: z.string().max(400) }),
      run: (async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LESSON (${o.script.title.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      }) as AgentTool["run"],
    },
  ];

  const mediaOf = (id: string) => o.resolution.media.filter((m) => m.shotId === id);
  const briefs = shots
    .map((s) => {
      const media = mediaOf(s.id);
      const primary = media.find((m) => m.role === "primary");
      const slots = media.filter((m) => m.role === "layer").sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
      return `SHOT ${s.id} (${(s.endS - s.startS).toFixed(1)} s)\n  narration: "${lineOf(s)}"\n  intent: ${String((s.source as { props: Record<string, unknown> }).props.brief ?? s.intent).slice(0, 160)}\n  footage: ${primary ? `${primary.kind === "video" ? "moving video" : "a STILL picture"} of ${primary.depicts ?? primary.query} (${primary.origin}${primary.seen?.fit ? `, fit ${primary.seen.fit}/10` : ""})` : "NONE"}\n  picture slots: ${slots.length ? slots.map((m) => `[${m.slot}] ${m.depicts ?? m.query}${m.width && m.height ? ` (${(m.width / m.height).toFixed(2)}:1)` : ""}`).join("; ") : "none"}`;
    })
    .join("\n");
  const portrait = o.storyboard.aspect === "9:16";
  const system = [
    plain(
      `${skill}\n\n## This channel, measured on ${band.shots} of its real shots\n- its mix: ${SHOT_KINDS.filter((k) => band.mix[k] > 0).sort((a, b) => band.mix[b] - band.mix[a]).map((k) => `${k} ${pc(band.mix[k])}`).join(", ")}\n- per film: ${band.distinctKinds.p10}–${band.distinctKinds.p90} kinds of shot; clean footage on ${pc(band.plainFootage.p10)}–${pc(band.plainFootage.p90)} of shots; any text on ${pc(band.textShare.p10)}–${pc(band.textShare.p90)}; ${band.wordsMedian.p10}–${band.wordsMedian.p90} words when there is text\n\n## This film's design language (stay inside it so the film is coherent)\n- concept: ${ds?.concept ?? "—"}\n- colours: primary ${ds?.palette.primary}, accent ${ds?.palette.accent}, surface ${ds?.palette.surface}, paper ${ds?.palette.paper}, text ${ds?.palette.text}\n- type: ${ds?.typography.display} display, ${ds?.typography.casing} case; headlines drawn "${tr?.headline ?? "solid_stroke"}", narration phrases "${tr?.phrase ?? "neon_glow"}", labels "${tr?.label ?? "tag"}", photos "${tr?.photo ?? "print"}"\n- stage when a shot has no footage: "${tr?.world ?? "smoke"}" in the film's colours\n- motif: ${tr?.motif ?? "—"}\n- frame: ${portrait ? "1080×1920 vertical; keep important content in the top two-thirds" : "1920×1080"}${o.avoidLayouts ? `\n- recent films leaned on these placements; this film must not: ${o.avoidLayouts}` : ""}${notes.trim() ? `\n\n## Your own notes from earlier films\n${tail(notes, 30)}` : ""}${owner.trim() ? `\n\n## The owner's notes on your work (take these seriously)\n${tail(owner, 30)}` : ""}`,
    ),
  ];
  log(`  scene designer: one designer with eyes — ${shots.length} shots, ${o.referenceShots.length} real shots to look at (${MODELS.sonnet})…`);
  const run = await agentLoop({ stage: "scenes.agent", model: MODELS.sonnet, system, user: `Design this film's scenes.\n\n${briefs}\n\nStart by looking at the channel's real shots.`, tools, effort: "medium", maxTurns: 26, maxTokens: 32000, done: () => accepted && (noteSaved || grace-- <= 0), nudge: "The scenes are not accepted yet. Measure the film, fix what it shows, and submit.", log });
  // Whatever happened, every shot leaves with a rendered, measured scene plan.
  if (!accepted && plan.scenes.length) await measure().catch(() => {});
  const report: SceneReport = { pass: accepted, rounds, remaining: accepted ? [] : lastIssues, agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4, rendered } };
  o.onReport?.(report);
  const p = rounds.at(-1)?.profile;
  log(`  scene designer: ${accepted ? "scenes accepted" : "NOT ACCEPTED"} after ${run.turns} turn(s) — ${plan.scenes.length}/${shots.length} scenes, rendered ${rendered} preview(s), looked at the reference ${run.calls.view_reference_shots ?? 0}×, measured ${(run.calls.measure_film ?? 0) + (run.calls.submit_scenes ?? 0)}×, $${run.usd.toFixed(2)}${p ? ` — ${p.distinctKinds} kinds, clean footage ${pc(p.share.plain_footage)}, text on ${pc(p.textShare)} of shots` : ""}${accepted ? "" : ` — still: ${lastIssues.map((x) => x.kind).join(", ")}`}`);
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.script.title.slice(0, 60)}": ${accepted ? "accepted" : "not accepted"} after ${rounds.length} measurement(s); caught along the way: ${[...new Set(rounds.flatMap((r) => r.issues))].join(", ") || "nothing"}${p ? `; final ${p.distinctKinds} kinds, clean ${pc(p.share.plain_footage)}, text ${pc(p.textShare)}, pictures ${pc(p.pictureShare)}` : ""}\n`);
  }
  return plan;
}
