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
import type { FilmKitMeta } from "./scene-designer.js";
import { readMemory } from "./lessons.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { ScenePlan, type FilmDesignSystem, type ResolutionReport, type Storyboard, type StoryboardShot, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { agentLoop, plain, type AgentTool, ROLE_MODEL } from "./llm.js";
import { designScenes, SceneDraftSchema, type SceneDraftScene } from "./scene-designer.js";
import { colourCover, measureLegibility, textBoxesOf } from "@opumia/senses";
import { nearestByMeaning } from "./retrieve.js";
import { labelShots, SHOT_KINDS, visualIssues, visualProfile, type VisualBand, type VisualProfile } from "./visual-measure.js";

export type PictureResult = { ok: true; shotId: string; as: "footage" | "slot"; slot?: number; kind: "video" | "image"; depicts: string; fit?: number; preview: string } | { ok: false; why: string };
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
  /** Renders one shot at seven moments as a strip, so the designer can see it move. */
  play?: (plan: ScenePlan, shotId: string) => Promise<string | null>;
  /** Step 4: trained taste of rendered frames (0–10, the same heads as the film score), and the channel's real band. */
  taste?: { score: (files: string[]) => Promise<Array<number | null>>; realP10: number; realMedian: number };
  /** Build list 3, item 20: likeness of frames to our earlier films (max cosine) and the limit above which a frame looks like one. */
  likeness?: { near: (files: string[]) => Promise<number[]>; limit: number };
  /** This film's own kit (design/film/meta.json): every word on screen and the stage come from it (build list 3, L3). */
  kit: FilmKitMeta;
  /** Step 2: watch a stretch at real speed with sound, with the measured detector report (jumps, legibility, seams, taste). */
  watch?: (plan: ScenePlan, fromS: number, toS: number) => Promise<{ strip: string; text: string }>;
  /** Sourcing tools (resolver/scene-tools.ts): they add pictures to `resolution` in place. */
  pictures?: {
    findPicture: (i: { shotId: string; want: string; as: "footage" | "slot"; kind: "video" | "image" }) => Promise<PictureResult>;
    searchObjects: (i: { query: string }) => Array<{ id: string; type: "object" | "icon"; name: string; tags: string[] }>;
    addObject: (i: { shotId: string; assetId: string }) => Promise<PictureResult>;
    cutOut: (i: { shotId: string; slot: number }) => Promise<PictureResult>;
  };
  memoryDir?: string;
  people?: string[];
  avoidLayouts?: string;
  onReport?: (r: SceneReport) => void;
  /** Revision (sent back by the showrunner or the gate): start from this plan and redesign only these shots. */
  previous?: ScenePlan;
  revise?: Array<{ shotId: string; note: string }>;
  log?: (s: string) => void;
}

const isScene = (s: StoryboardShot) => s.source.kind === "designed" && s.source.designed === "scene";
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");
const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });

export async function designScenesAgent(o: SceneAgentOptions): Promise<ScenePlan> {
  const log = o.log ?? (() => {});
  const shots = o.storyboard.shots.filter(isScene);
  const empty = () => ScenePlan.parse({ schemaVersion: 2, storyboardId: o.storyboard.id, scenes: [], generatedAt: new Date().toISOString() });
  if (!shots.length) return empty();
  const skill = await readFile(new URL("../skills/scenes.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: path.dirname(path.dirname(o.memoryDir)) }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const words = o.script.segments.flatMap((s) => s.words);
  const lineOf = (sh: StoryboardShot) => words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ");
  const band = o.visualBand;
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const ds = o.design;

  const revising = !!(o.previous && o.revise?.length);
  let plan: ScenePlan = revising ? structuredClone(o.previous!) : empty();
  const dirty = new Set<string>(revising ? o.revise!.map((r) => r.shotId) : []); // designed or changed since the last render
  const unseen = new Set<string>(revising ? o.revise!.map((r) => r.shotId) : []); // designed or changed since the designer last LOOKED at it
  let referenceViews = revising ? 2 : 0;
  const triedPicture = new Map<string, number>(); // shots the designer asked a picture for and got none
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

  // Step 4: taste per scene (trained heads on the middle frame), kept current as scenes are rendered.
  const tasteOf = new Map<string, number>();
  const triedVariants = new Set<string>();
  const scoreTasteFor = async (ids: string[]) => {
    if (!o.taste) return;
    const want = ids.filter((id) => frames.has(id));
    const sc = await o.taste.score(want.map((id) => frames.get(id)!.mid)).catch(() => [] as Array<number | null>);
    want.forEach((id, k) => { const v = sc[k]; if (typeof v === "number") tasteOf.set(id, v); });
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
    const staged = plan.scenes.filter((sc) => sc.backdrop !== "footage");
    const roleOf = (name: string) => o.kit.components[name]?.role ?? "";
    // a picture, or a kit component that draws something (data, a number) rather than words alone
    const hasPicture = (sc: (typeof staged)[number]) => sc.elements.some((e) => e.type === "photo" || e.type === "cutout" || e.type === "card3d" || (e.type === "component" && ["number", "chart", "map", "document"].includes(roleOf(e.name))));
    // G25: what a footage-less shot could be built around, read from its own line.
    const said = (id: string) => { const sh = o.storyboard.shots.find((x) => x.id === id); return sh ? o.script.segments.flatMap((sg) => sg.words).filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ") : ""; };
    const suggest = (id: string) => {
      const l = said(id).toLowerCase();
      if (/\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|hundred|thousand|million|billion|half|percent)\b/.test(l)) return `the kit's number (${o.kit.roles?.number ?? "number role"}) with the spoken figure`;
      if (/\b(reported|announced|headline|news|filed|court|ruled|sued|declared|bankrupt|press)\b/.test(l)) return "a real article screenshot or a press photo (find_picture)";
      if (/\b(website|app|online|internet|email|post|tweet|instagram|facebook|google|screen|search)\b/.test(l)) return "a real page screenshot (find_picture)";
      return "a picture (find_picture) or a library object";
    };
    const unused = staged.filter((sc) => !hasPicture(sc) && slotsOf(sc.shotId).length > 0);
    if (unused.length) issues.push({ kind: "unused_picture", detail: `these shots have real pictures available and show none: ${unused.map((sc) => `${sc.shotId} (${slotsOf(sc.shotId).map((m) => `[${m.slot}] ${(m.depicts ?? m.query).slice(0, 40)}`).join("; ")})`).join(", ")}. Build the scene around the picture.` });
    // A shot with no footage must be built around a picture, unless the designer really tried to get one
    // (two different requests that found nothing). With the picture tools there is no excuse for a bare stage.
    if (o.pictures) {
      const bareStage = staged.filter((sc) => !hasPicture(sc) && (triedPicture.get(sc.shotId) ?? 0) < 2);
      if (bareStage.length) issues.push({ kind: "stage_without_picture", detail: `these shots have no footage and show no picture: ${bareStage.map((sc) => `${sc.shotId} (try ${suggest(sc.shotId)})`).join(", ")}. For each, get one: find_picture as footage (moving video of what the line is about) or as a slot to compose, or a library object or icon that makes the idea visible — then redesign the shot around it. Only after two different requests found nothing may a shot stay without a picture.` });
    }
    const wordsOn = (sc: (typeof staged)[number]) => sc.elements.reduce((n, e) => n + (e.type === "component" ? Object.values(e.props).filter((v): v is string => typeof v === "string").join(" ").trim().split(/\s+/).filter(Boolean).length : 0), 0);
    const bare = staged.filter((sc) => !hasPicture(sc) && wordsOn(sc) <= 3);
    const allow = Math.max(1, Math.floor(plan.scenes.length * 0.08));
    if (bare.length > allow) issues.push({ kind: "bare_word_cards", detail: `${bare.length} shots are a word or two on a plain stage (${bare.map((sc) => sc.shotId).join(", ")}); at most ${allow} in a film this long. A lone word on colour is a slide: build it around a picture or the kit's number, chart or document when the line allows (${bare.map((sc) => `${sc.shotId}: ${suggest(sc.shotId)}`).join("; ")}), or carry the line with more of the narration's words in the kit's phrase.` });
    // Readability: text that cannot be read at a glance (labelled on the rendered frame, like everything else).
    const hard = ids.filter((id, k) => labels[k] && labels[k]!.words > 0 && !labels[k]!.readable);
    if (hard.length) issues.push({ kind: "hard_to_read", detail: `text is hard to read at a glance in ${hard.join(", ")} (too small, low contrast against what is behind it, across a busy area, cut off, or overlapping). Make it larger, move it to a calm part of the frame, or dim the footage under it — then look again.` });
    // Colour: footage tinted so heavily that the frame reads as one colour.
    const washed: string[] = [];
    for (const sc of plan.scenes) {
      if (!sc.wash || !frames.has(sc.shotId)) continue;
      const cover = await colourCover(frames.get(sc.shotId)!.mid).catch(() => null);
      if (cover !== null && cover >= 0.5) washed.push(sc.shotId);
    }
    // One colour carrying the film: frames that are a colour stage or a tint, whatever is on them. The channel's
    // typical film has 5–11 % such shots and its most extreme 38 %.
    const carried: string[] = [];
    for (const id of ids) {
      const cover = await colourCover(frames.get(id)!.mid).catch(() => null);
      if (cover !== null && cover >= 0.5) carried.push(id);
    }
    if (carried.length / Math.max(1, ids.length) > 0.3) issues.push({ kind: "too_many_colour_frames", detail: `${carried.length} of ${ids.length} shots are a frame of one colour (${carried.join(", ")}) — a colour stage or tinted footage; the channel's films typically have about one in ten. Put these lines on real footage (find_picture as footage), on paper, or let existing footage play in its natural colour.` });
    // The same picture placed again and again reads as a template.
    const placed = new Map<string, string[]>();
    for (const sc of plan.scenes)
      for (const e of sc.elements) {
        if (e.type !== "photo" && e.type !== "cutout" && e.type !== "card3d") continue;
        const ref = o.resolution.media.find((m) => m.shotId === sc.shotId && m.role === "layer" && m.slot === e.slot)?.ref;
        // an editor split's halves ("sh008_2") are one shot
        if (ref) placed.set(ref, [...new Set([...(placed.get(ref) ?? []), sc.shotId.replace(/(_\d+)+$/, "")])]);
      }
    const overused = [...placed.entries()].filter(([, v]) => v.length > 2);
    // Step 4: taste is the objective — every scene against the channel's real shots (trained heads).
    if (o.taste) {
      await scoreTasteFor(ids.filter((id) => !tasteOf.has(id) || dirty.has(id)));
      const low = ids.filter((id) => (tasteOf.get(id) ?? 10) < o.taste!.realP10);
      const untried = low.filter((id) => !triedVariants.has(id));
      if (untried.length) issues.push({ kind: "below_channel_taste", detail: `these scenes score below the channel's lowest tenth on taste (${o.taste.realP10}; its median ${o.taste.realMedian}): ${untried.map((id) => `${id} ${tasteOf.get(id)}`).join(", ")}. For each, try_variants with two or three genuinely different designs (another picture, another composition, another kind of shot) — the one closest to the channel is kept.` });
    }
    if (overused.length) issues.push({ kind: "same_picture_repeated", detail: `the same picture is placed in more than two shots: ${overused.map(([, v]) => v.join(", ")).join(" | ")}. Show it at most twice; give the other shots a different picture or let their footage play.` });
    const washAllow = Math.floor(plan.scenes.length * 0.1);
    if (washed.length > washAllow) issues.push({ kind: "washed_footage", detail: `${washed.length} footage shot(s) are tinted so heavily that the whole frame reads as one colour (${washed.join(", ")}); the channel's footage keeps its natural colour. Set wash to false on these (at most ${washAllow} may stay washed, for a deliberate mood moment).` });
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
      name: "similar_real_shots",
      description: "The channel's real shots whose spoken line is nearest in meaning and role to one of your shots (the same kind of story moment), with what was on screen — how the channel actually shows a line like this. Up to 4 frames.",
      schema: z.object({ shotId: z.string() }),
      run: (async (i: { shotId: string }) => {
        const sh = shots.find((s) => s.id === i.shotId);
        if (!sh) return `no shot ${i.shotId}`;
        referenceViews++;
        const idx = await nearestByMeaning(`a documentary narration line: "${lineOf(sh)}" (shot intent: ${sh.intent.slice(0, 120)})`, o.referenceShots.map((s) => `"${s.line}" → shown as ${s.kind === "none" ? "clean footage" : s.kind}: ${s.layout}`), 4, "real narration line and how it was shown");
        const out: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const k of idx) {
          const s = o.referenceShots[k]!;
          const im = await img(s.frame).catch(() => null);
          if (im) out.push({ type: "text", text: `REAL — "${s.line.slice(0, 110)}" → ${s.kind === "none" ? "clean footage, nothing designed" : s.kind}: ${s.layout}; motion: ${s.motion}` }, im);
        }
        return out.length ? out : "no similar real shot could be read";
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
        plan = await designScenes({ storyboard: o.storyboard, script: o.script, resolution: o.resolution, channel: o.channel, ...(o.people ? { people: o.people } : {}), kit: o.kit, raw, previous: plan, log: (s) => said.push(s.trim()) });
        for (const s of raw) (dirty.add(s.shotId), unseen.add(s.shotId));
        const lines = raw.map((r) => {
          const got = plan.scenes.find((x) => x.shotId === r.shotId);
          if (!got) return `${r.shotId}: REJECTED (nothing usable was left)`;
          const lost = r.clean && got.elements.length ? " — could not be clean (no moving footage): its elements were kept" : !r.clean && got.elements.length < r.elements.length ? ` — ${r.elements.length - got.elements.length} element(s) removed by the checks` : "";
          const moved = r.backdrop !== got.backdrop ? ` — backdrop changed to ${got.backdrop}` : "";
          return `${r.shotId}: ${got.elements.length ? got.elements.map((e) => (e.type === "component" ? e.name : e.type)).join("+") : "clean footage"} on ${got.backdrop}${lost}${moved}`;
        });
        return `${plan.scenes.length}/${shots.length} shots have a scene.\n${lines.join("\n")}${said.length ? `\nchecks: ${said.join(" ").slice(0, 500)}` : ""}`;
      }) as AgentTool["run"],
    },
    ...(o.taste
      ? [
          {
            name: "try_variants",
            description: "Taste as the objective: give two or three genuinely different designs of ONE shot (another composition, another picture, another kind of shot — not a nudge). Each is rendered and scored by the trained taste against the channel's real shots; the closest to the channel is kept and you see all of them side by side with their scores.",
            schema: z.object({ shotId: z.string(), designs: SceneDraftSchema.shape.scenes.min(2).max(3) }),
            run: (async (i: { shotId: string; designs: SceneDraftScene[] }) => {
              if (!shots.some((s) => s.id === i.shotId)) return `no shot ${i.shotId}`;
              const base = plan;
              const tried: Array<{ plan: ScenePlan; mid: string; sheet: string; score: number }> = [];
              const keepFrame = frames.get(i.shotId);
              const cand = [...(base.scenes.some((x) => x.shotId === i.shotId) && keepFrame ? [{ plan: base, mid: keepFrame.mid, sheet: keepFrame.sheet }] : [])];
              for (const d of i.designs) {
                const p2 = await designScenes({ storyboard: o.storyboard, script: o.script, resolution: o.resolution, channel: o.channel, ...(o.people ? { people: o.people } : {}), kit: o.kit, raw: [{ ...d, shotId: i.shotId }], previous: base, log: () => {} });
                if (!p2.scenes.some((x) => x.shotId === i.shotId)) continue;
                const r = (await o.render(p2, [i.shotId]))[0];
                if (!r) continue;
                // the renderer writes one file per shot: keep a copy of each variant's frames
                const { copyFile } = await import("node:fs/promises");
                const k = cand.length;
                const mid = r.mid.replace(/(\.[a-z]+)$/, `_v${k}$1`), sheet = r.sheet.replace(/(\.[a-z]+)$/, `_v${k}$1`);
                await copyFile(r.mid, mid);
                await copyFile(r.sheet, sheet);
                cand.push({ plan: p2, mid, sheet });
              }
              if (!cand.length) return "no variant could be designed";
              const sc = await o.taste!.score(cand.map((c) => c.mid));
              cand.forEach((c, k) => tried.push({ ...c, score: sc[k] ?? 0 }));
              const best = tried.reduce((a, b) => (b.score > a.score ? b : a));
              plan = best.plan;
              frames.set(i.shotId, { mid: best.mid, sheet: best.sheet });
              tasteOf.set(i.shotId, best.score);
              dirty.delete(i.shotId);
              triedVariants.add(i.shotId);
              unseen.delete(i.shotId);
              const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [{ type: "text", text: `${i.shotId}: ${tried.map((t, k) => `${k === 0 && cand[0]!.plan === base ? "current" : `variant ${k}`} ${t.score}`).join(", ")} — kept the ${best.score} (the channel's median ${o.taste!.realMedian}, lowest tenth ${o.taste!.realP10}).` }];
              for (const [k, t] of tried.entries()) blocks.push({ type: "text", text: `${k === 0 && cand[0]!.plan === base ? "current" : `variant ${k}`} — taste ${t.score}:` }, await img(t.sheet));
              return blocks;
            }) as AgentTool["run"],
          } satisfies AgentTool,
        ]
      : []),
    {
      name: "render_previews",
      description: "Render your scenes and look at them: three moments of each shot (early, middle, end). Up to 9 shots per call. Look for anything cut off, overlapping, unreadable, covering a face or the subject, an empty or dull frame, and shots that look alike.",
      schema: z.object({ shotIds: z.array(z.string()).min(1).max(9) }),
      run: (async (i: { shotIds: string[] }) => {
        const out = await renderShots(i.shotIds);
        if (!out.length) return "nothing to render: design those shots first";
        const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        // item 20: the gate's own measures on every render — legibility on a phone, trained taste, likeness to our earlier films
        const tastes = o.taste ? await o.taste.score(out.map((r) => r.mid)).catch(() => out.map(() => null)) : out.map(() => null);
        const near = o.likeness ? await o.likeness.near(out.map((r) => r.mid)).catch(() => out.map(() => 0)) : out.map(() => 0);
        for (const [k, r] of out.entries()) {
          const sh = shots.find((s) => s.id === r.shotId)!;
          const sc = plan.scenes.find((x) => x.shotId === r.shotId);
          const leg = sc ? await measureLegibility(r.mid, textBoxesOf(sc as never)).catch(() => []) : [];
          const bad = leg.filter((l) => l.issues.length);
          const t = tastes[k];
          const m = [
            leg.length ? (bad.length ? `UNREADABLE: ${bad.map((l) => `"${l.label}" ${l.issues.join("; ")}`).join(" | ")}` : `text readable (${leg.map((l) => `${l.contrast}:1`).join(", ")})`) : "no text",
            t !== null && t !== undefined && o.taste ? `taste ${t}/10${t < o.taste.realP10 ? ` — BELOW the channel's lowest tenth (${o.taste.realP10})` : ""}` : "",
            o.likeness && near[k]! > o.likeness.limit ? `LOOKS LIKE AN EARLIER FILM (${near[k]})` : "",
          ].filter(Boolean).join("; ");
          blocks.push({ type: "text", text: `${r.shotId} — "${lineOf(sh).slice(0, 120)}" (early, middle, end) — measured: ${m}` }, await img(r.sheet));
          unseen.delete(r.shotId);
        }
        return blocks;
      }) as AgentTool["run"],
    },
    ...(o.play
      ? [
          {
            name: "play_shot",
            description: "See one shot move: seven moments from start to end as a strip. Use it on shots where timing matters — elements arriving on a word, a camera move, anything that might collide while entering.",
            schema: z.object({ shotId: z.string() }),
            run: (async (i: { shotId: string }) => {
              if (!plan.scenes.some((s) => s.shotId === i.shotId)) return "design that shot first";
              const strip = await o.play!(plan, i.shotId);
              if (!strip) return "that shot could not be rendered";
              return [{ type: "text" as const, text: `${i.shotId} from start to end:` }, await img(strip)];
            }) as AgentTool["run"],
          } satisfies AgentTool,
        ]
      : []),
    ...(o.watch
      ? [
          {
            name: "watch_stretch",
            description: "Watch a stretch of the film (up to 15 s) as it plays, with its sound: frames across it and a measured report — unbridged jumps between your shots, text that cannot be read on a phone, voice seams, and the trained taste against the channel. Watch across the cuts between your scenes, not only single shots.",
            schema: z.object({ fromS: z.number(), toS: z.number() }),
            run: (async (i: { fromS: number; toS: number }) => {
              const w = await o.watch!(plan, Math.max(0, i.fromS), Math.min(i.toS, i.fromS + 15)).catch((e: Error) => ({ strip: "", text: `could not render: ${e.message.slice(0, 160)}` }));
              return w.strip ? [{ type: "text" as const, text: w.text }, await img(w.strip)] : w.text;
            }) as AgentTool["run"],
          } satisfies AgentTool,
        ]
      : []),
    ...(o.pictures
      ? ([
          {
            name: "find_picture",
            description: "Get a different or an additional picture for one shot. Every stock and archive source is searched for what you describe, the candidates are checked by eye against the line, and the best fitting one is fetched. as=\"footage\" replaces the shot's footage (kind video or image); as=\"slot\" adds a photo as a new picture slot you can place, frame or cut out. Describe it the way a stock library would title it: concrete and visual, a few words, no names of people.",
            schema: z.object({ shotId: z.string(), want: z.string(), as: z.enum(["footage", "slot"]), kind: z.enum(["video", "image"]) }),
            run: (async (i: { shotId: string; want: string; as: "footage" | "slot"; kind: "video" | "image" }) => {
              const r = await o.pictures!.findPicture(i);
              if (!r.ok) {
                triedPicture.set(i.shotId, (triedPicture.get(i.shotId) ?? 0) + 1);
                return `NOT FOUND — ${r.why}`;
              }
              dirty.add(i.shotId);
              unseen.add(i.shotId);
              const text = r.as === "footage" ? `${i.shotId} now has ${r.kind === "video" ? "moving video" : "a still"} as footage: ${r.depicts} (fit ${r.fit}/10). Redesign the shot for it.` : `${i.shotId} has a new picture slot [${r.slot}]: ${r.depicts} (fit ${r.fit}/10). Place it with a photo, cutout or card3d element.`;
              const im = r.preview ? await img(r.preview).catch(() => null) : null;
              return im ? [{ type: "text" as const, text }, im] : text;
            }) as AgentTool["run"],
          },
          {
            name: "search_library_objects",
            description: "Search the licensed library for cut-out objects (photographs on transparency: a briefcase, a calculator, a stack of cash) and line icons, by keyword. Returns ids to use with add_library_object.",
            schema: z.object({ query: z.string() }),
            run: (async (i: { query: string }) => {
              const r = o.pictures!.searchObjects(i);
              return r.length ? r.map((x) => `${x.id} | ${x.type} | ${x.name} | ${x.tags.join(", ")}`).join("\n") : `nothing in the library for "${i.query}" — try a simpler everyday word`;
            }) as AgentTool["run"],
          },
          {
            name: "add_library_object",
            description: "Add a library cut-out object or icon to a shot as a new picture slot (transparent — place it with a cutout element).",
            schema: z.object({ shotId: z.string(), assetId: z.string() }),
            run: (async (i: { shotId: string; assetId: string }) => {
              const r = await o.pictures!.addObject(i);
              if (!r.ok) return `NOT ADDED — ${r.why}`;
              const text = `${i.shotId} has a new picture slot [${r.slot}]: ${r.depicts}. Place it with a cutout element.`;
              const im = r.preview ? await img(r.preview).catch(() => null) : null;
              return im ? [{ type: "text" as const, text }, im] : text;
            }) as AgentTool["run"],
          },
          {
            name: "cut_out_subject",
            description: "Lift the subject of a photo slot (a person, a product, a building) off its background. The cut-out becomes a new transparent slot of the same shot, to place with a cutout element over a stage or over footage.",
            schema: z.object({ shotId: z.string(), slot: z.number() }),
            run: (async (i: { shotId: string; slot: number }) => {
              const r = await o.pictures!.cutOut(i);
              if (!r.ok) return `NOT CUT OUT — ${r.why}`;
              const text = `${i.shotId} has a new picture slot [${r.slot}]: ${r.depicts}.`;
              const im = r.preview ? await img(r.preview).catch(() => null) : null;
              return im ? [{ type: "text" as const, text }, im] : text;
            }) as AgentTool["run"],
          },
        ] satisfies AgentTool[])
      : []),
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
      `${skill}\n\n## This channel, measured on ${band.shots} of its real shots\n- its mix: ${SHOT_KINDS.filter((k) => band.mix[k] > 0).sort((a, b) => band.mix[b] - band.mix[a]).map((k) => `${k} ${pc(band.mix[k])}`).join(", ")}\n- per film: ${band.distinctKinds.p10}–${band.distinctKinds.p90} kinds of shot; clean footage on ${pc(band.plainFootage.p10)}–${pc(band.plainFootage.p90)} of shots; any text on ${pc(band.textShare.p10)}–${pc(band.textShare.p90)}; ${band.wordsMedian.p10}–${band.wordsMedian.p90} words when there is text\n\n## THIS FILM'S OWN KIT (its art director wrote it for this film only — its visual idea: ${o.kit.concept})\nEvery word on screen and every stage come from these components (element type \"component\", component = the name, propsJson = its props as JSON); real pictures go in photo, cutout or card3d elements. There are no other text or decoration elements.\nRoles: ${Object.entries(o.kit.roles ?? {}).map(([r, c]) => `${r} = ${c}`).join(", ")}. The phrase component's words land on the frames they are spoken (the engine syncs them). A shot without footage sits on the kit's stage (${o.kit.roles?.stage ?? "its stage component"}), drawn behind your elements.\n${Object.entries(o.kit.components).map(([n, c]) => `- ${n}${c.role ? ` [${c.role}]` : ""}: ${c.use} — props: ${c.props}`).join("\n")}\n- colours (for washes and choices): primary ${ds?.palette.primary}, accent ${ds?.palette.accent}, surface ${ds?.palette.surface}, paper ${ds?.palette.paper}\nCuts that change the same picture are bridged by the film's own transition (the editor marks them).\n- frame: ${portrait ? "1080×1920 vertical; keep important content in the top two-thirds" : "1920×1080"}${o.avoidLayouts ? `\n- recent films leaned on these placements; this film must not: ${o.avoidLayouts}` : ""}${notes.trim() ? `\n\n## Your own notes from earlier films\n${notes}` : ""}${owner.trim() ? `\n\n## The owner's notes on your work (take these seriously)\n${tail(owner, 30)}` : ""}`,
    ),
  ];
  log(`  scene designer: one designer with eyes — ${shots.length} shots, ${o.referenceShots.length} real shots to look at (${ROLE_MODEL.sceneDesigner})…`);
  const run = await agentLoop({ stage: "scenes.agent", finish: { message: "Your budget for this stage is used up. Call submit_scenes NOW with the work you have — change nothing else first. If it is refused, fix only what the refusal names and call submit_scenes again." }, model: ROLE_MODEL.sceneDesigner, system, user: revising
      ? `Revise this film's scenes. The plan below is the current one; redesign ONLY these shots, for these reasons, and keep every other shot as it is:\n${o.revise!.map((r) => `- ${r.shotId}: ${r.note}`).join("\n")}\n\nCURRENT SCENES OF THOSE SHOTS:\n${o.revise!.map((r) => JSON.stringify(plan.scenes.find((x) => x.shotId === r.shotId) ?? null)).join("\n")}\n\n${briefs}\n\nLook at the nearest real shots for these lines (similar_real_shots), redesign, render and look, then submit.`
      : `Design this film's scenes.\n\n${briefs}\n\nStart by looking at the channel's real shots.`, tools, effort: "medium", maxTurns: revising ? 16 : 28, maxSeconds: revising ? 240 : 480, maxUsd: revising ? 0.3 : 0.7, maxTokens: 32000, done: () => accepted && (noteSaved || grace-- <= 0), nudge: "The scenes are not accepted yet. Measure the film, fix what it shows, and submit.", log });
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
