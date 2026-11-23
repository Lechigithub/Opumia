/**
 * The escalation ladders of the planned film (build list 3, items 12–16): for every check the preflight gate runs,
 * the owner's fixes from the cheapest to the strongest. A rung queues work on the Act (produce.ts implements it); the
 * gate then runs the queued work once (one scene-designer pass for every scene sent back, one sound pass…), measures
 * again, and the problems still failing climb to their next rung. Nothing is ever reduced to a weaker look.
 */
import type { LadderTable, Problem, Rung } from "@opumia/agents";

export interface Act {
  /** Take the offending pictures out of these problems' shots (repeats, cooldown, fair use, period, softness, fit). Returns the shots touched. */
  dropOffending(p: Problem): Promise<string[]>;
  /** New footage through the picture tools (searched, rated by eye, dated against the line); `want` overrides what to ask for. Returns the shots that got some. */
  refill(ids: string[], want?: (id: string) => string): Promise<string[]>;
  /** The director re-plans these shots around what the sources hold (one model call): the new thing to show, or "design". */
  replan(ids: string[]): Promise<Map<string, { action: "search" | "spare" | "design"; must: string }>>;
  /** Remove a shot's footage so it is designed on the kit's stage. */
  stripFootage(ids: string[]): void;
  /** Send a shot back to the scene designer with a note (run once per round for all of them). */
  scene(id: string, note: string): void;
  /** Redesign every scene (after the kit changed). */
  allScenes(note: string): void;
  /** Undo an editor's split (the half goes back into the shot before it). */
  mergeSplit(ids: string[]): string[];
  /** Bridge a cut with the film's own transition. */
  bridge(ids: string[]): string[];
  colour(brief: string): void;
  sound(brief: string, fresh: boolean): void;
  editor(brief: string): void;
  /** The art director changes its kit (or starts a new concept). Runs now; returns its note. */
  kit(request: string, fresh: boolean): Promise<string>;
  /** Ask the writer for a rewrite of these lines (once per film; false when it is no longer allowed). */
  rewrite(brief: string): boolean;
  /** Mark shots to be rendered again as they are (a render fault). */
  touch(ids: string[]): void;
  line(id: string): string;
  defects(id: string): string[];
}

// Build list 4: estimates are what each owner's rung costs with Sonnet for creative work and Haiku for the measured
// agents (bl4b-theranos), not the Opus-era figures that made the gate skip every scene rung.
const rung = (name: string, owner: string, maxUsd: number, run: Rung<Act>["run"]): Rung<Act> => ({ name, owner, maxUsd, run });
const shotsOf = (ps: Problem[]) => [...new Set(ps.flatMap((p) => p.shots))];
const said = (p: Problem) => `${p.what} (measured ${p.measured}, target ${p.band})`;

// ---- Pictures (item 12)
const replacePicture = rung("replace the picture", "picture researcher", 0.15, async (ps, a) => {
  const touched = new Set<string>();
  for (const p of ps) for (const id of await a.dropOffending(p)) touched.add(id);
  const ids = [...new Set([...touched, ...shotsOf(ps)])];
  const got = new Set(await a.refill(ids));
  for (const id of ids) a.scene(id, got.has(id) ? `this shot has new footage (the old picture broke a rule: ${ps[0]!.what}): design the scene for it — let it play clean if it carries the line` : `the picture was taken out of this shot (${ps[0]!.what}) and no footage was found: get a picture with find_picture and build the shot around it`);
  return `${ids.length} shot(s): ${got.size} given new footage`;
});
const timelessCloseUp = rung("a timeless close-up that tells the line", "picture researcher", 0.15, async (ps, a) => {
  const ids = shotsOf(ps);
  for (const p of ps) await a.dropOffending(p);
  const got = new Set(await a.refill(ids, (id) => `${a.line(id).split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(" ")} close up hands objects`));
  for (const id of ids) a.scene(id, got.has(id) ? "new footage: a timeless close-up chosen because nothing period-true was found — design the scene for it" : "no honest footage exists for this line: build it on the kit's stage around a real picture (find_picture) or the kit's number or label");
  return `${got.size}/${ids.length} given a timeless close-up`;
});
const directorReplans = rung("the director re-plans the shot", "director", 0.1, async (ps, a) => {
  const ids = shotsOf(ps);
  for (const p of ps) await a.dropOffending(p);
  const plans = await a.replan(ids);
  const search = [...plans].filter(([, v]) => v.action !== "design");
  const got = new Set(await a.refill(search.map(([k]) => k), (id) => plans.get(id)!.must));
  for (const id of ids) {
    const pl = plans.get(id);
    a.scene(id, pl && got.has(id) ? `re-planned: now shows ${pl.must} — design the scene for it` : `re-planned as a designed shot: build it on the kit's stage around a real picture or the kit's components (${pl?.must ?? "what the line says"})`);
    if (!got.has(id)) a.stripFootage([id]);
  }
  return `${ids.length} shot(s) re-planned: ${got.size} new footage, ${ids.length - got.size} designed`;
});
const designedFromKit = rung("a designed shot from the kit", "scene designer", 0.3, async (ps, a) => {
  const ids = shotsOf(ps);
  for (const p of ps) await a.dropOffending(p);
  a.stripFootage(ids);
  for (const id of ids) a.scene(id, `no picture could carry this line honestly (${ps[0]!.what}): design it on the kit's stage — a real picture slot (find_picture, a library object), the kit's number, label or quote`);
  return `${ids.length} shot(s) designed from the kit`;
});
const writerRewords = rung("the writer rewords the line so it can be shown", "writer", 0.6, async (ps, a) => {
  const ids = shotsOf(ps);
  const ok = a.rewrite(`These lines found no honest picture after three tries; reword them so they can be shown (concrete, filmable, same facts): ${ids.map((id) => `"${a.line(id)}"`).join("; ")}`);
  return ok ? `rewrite requested for ${ids.length} line(s)` : null;
});
const PICTURE = [replacePicture, timelessCloseUp, directorReplans, designedFromKit];
const FIT = [replacePicture, directorReplans, writerRewords];
const NO_PICTURE = [
  rung("find footage for the shot", "picture researcher", 0.15, async (ps, a) => {
    const ids = shotsOf(ps);
    const got = new Set(await a.refill(ids));
    for (const id of got) a.scene(id, "this shot now has real footage: design the scene for it — let it play clean if it carries the line");
    for (const id of ids.filter((x) => !got.has(x))) a.scene(id, "this stage shot has no picture: get one with find_picture (as a slot) and build the shot around it");
    return `${got.size}/${ids.length} given footage`;
  }),
  directorReplans,
];

// ---- Scenes (item 13)
const sceneNote = (prefix: string) => (ps: Problem[], a: Act) => {
  for (const p of ps) for (const id of p.shots) a.scene(id, `${prefix} ${said(p)}${a.defects(id).length ? ` — the critic saw: ${a.defects(id).join("; ")}` : ""}`);
  return Promise.resolve(`${shotsOf(ps).length} scene(s) sent back`);
};
const SCENE = [
  rung("the scene designer fixes the named defect", "scene designer", 0.3, async (ps, a) => {
    const halves = shotsOf(ps).filter((id) => /_\d+$/.test(id) && ps.some((p) => p.check === "dead_frames"));
    const merged = halves.length ? a.mergeSplit(halves) : [];
    await sceneNote("fix this:")(ps.map((p) => ({ ...p, shots: p.shots.filter((s) => !halves.includes(s)) })), a);
    return `${merged.length ? `split undone: ${merged.join(", ")}; ` : ""}${shotsOf(ps).length - halves.length} scene(s) sent back`;
  }),
  rung("variants: genuinely different designs, the best kept", "scene designer", 0.3, sceneNote("use try_variants: two or three genuinely different designs of this shot (another composition, another picture), keep the closest to the channel —")),
  rung("a different kind of shot", "scene designer", 0.3, sceneNote("change the KIND of shot (clean footage, a picture composition, the kit's number, a quote, a label over footage — not the kind it is now):")),
  rung("the art director adds a component the film was missing", "art director", 0.6, async (ps, a) => {
    const need = ps.map((p) => `${p.what} on ${p.shots.join(", ")} (lines: ${p.shots.slice(0, 3).map((id) => `"${a.line(id).slice(0, 80)}"`).join("; ")})`).join("; ");
    const note = await a.kit(`the scene designer could not make these shots good enough with the kit as it is — add the component this film is missing for them (keep every existing component): ${need}`, false);
    for (const id of shotsOf(ps)) a.scene(id, `the art director added a component for this shot (${note.slice(0, 160)}): redesign it with the kit's new component`);
    return note;
  }),
];

// ---- Look (item 14) and colour
const LOOK = [
  rung("the kit is redesigned against what made it close", "art director", 0.6, async (ps, a) => {
    const note = await a.kit(`the film looks too close to an earlier film of ours: ${ps.map(said).join("; ")}. Change what made it close (palette, typefaces, card shapes, transition) and keep the components' names and props`, false);
    a.allScenes("the kit was redesigned so the film no longer looks like an earlier one: check every scene with the new kit");
    return note;
  }),
  rung("a new visual concept", "art director", 1.2, async (ps, a) => {
    const note = await a.kit(`the film still looks too close to an earlier film after the kit was changed: ${ps.map(said).join("; ")}. Make a different visual idea`, true);
    a.allScenes("the film has a new kit (a new visual concept): design every scene again from it");
    return note;
  }),
];
const COLOUR = [
  rung("the colourist, told what was measured", "colourist", 0.05, async (ps, a) => {
    a.colour(ps.map(said).join("; "));
    return "colourist sent back";
  }),
  rung("the art director retunes the palette, then the colourist", "art director", 0.6, async (ps, a) => {
    const note = await a.kit(`the colour measures stay outside the channel after grading: ${ps.map(said).join("; ")}. Retune the palette and act grades (set_tokens) and any component colours that cause it`, false);
    a.colour(`the art director retuned the palette: ${ps.map(said).join("; ")}`);
    a.allScenes("the palette changed: check every scene");
    return note;
  }),
];
const ONE_COLOUR = [NO_PICTURE[0]!, ...COLOUR];

// ---- Sound and edit (item 16)
const SOUND = [
  rung("the sound designer, told what was measured", "sound designer", 0.08, async (ps, a) => (a.sound(ps.map(said).join("; "), false), "sound designer sent back")),
  rung("the sound designer from a fresh selection", "sound designer", 0.08, async (ps, a) => (a.sound(`a fresh selection — the first pass still failed: ${ps.map(said).join("; ")}`, true), "fresh sound selection")),
];
const SPLIT = [
  rung("bridge it with the film's transition", "editor", 0, async (ps, a) => { const b = a.bridge(shotsOf(ps)); return b.length ? `bridged ${b.join(", ")}` : null; }),
  rung("undo the split", "editor", 0, async (ps, a) => { const m = a.mergeSplit(shotsOf(ps)); return m.length ? `split undone: ${m.join(", ")}` : null; }),
];
const EDIT = [
  rung("the editor, told what was measured", "editor", 0.08, async (ps, a) => (a.editor(ps.map(said).join("; ")), "editor sent back")),
  rung("the editor again, re-cutting the stretch", "editor", 0.08, async (ps, a) => (a.editor(`re-cut the stretch: split, join and move cuts until it is inside the channel — ${ps.map(said).join("; ")}`), "editor re-cut")),
];
// build list 5, item 21: a stutter needs a new framing AND a transition — the editor reframes; failing that, the split is undone
const STUTTER = [
  rung("the editor reframes and bridges the cut", "editor", 0.08, async (ps, a) => (a.editor(`stutter cuts — the same picture on both sides of a cut: reframe the second shot (reframe: punch-in or another moment of the clip) AND set a transition (whip, light_leak, film): ${ps.map(said).join("; ")}`), "editor sent back")),
  rung("undo the split", "editor", 0, async (ps, a) => { const m = a.mergeSplit(shotsOf(ps)); return m.length ? `split undone: ${m.join(", ")}` : null; }),
];
const WRITER_ONLY = [rung("the writer rewords the lines", "writer", 0.6, async (ps, a) => (a.rewrite(`The narration failed after its retakes: ${ps.map(said).join("; ")}. Reword the lines that cannot be said cleanly.`) ? "rewrite requested" : null))];

/** Check id → its ladder. Checks with no ladder here are measured and reported only. */
export const PREFLIGHT_LADDERS: LadderTable<Act> = {
  repeat_in_film: PICTURE,
  shared_pictures: PICTURE,
  stand_in_face: [replacePicture, directorReplans, designedFromKit],
  fair_use_one_clip: PICTURE,
  fair_use_clip_length: PICTURE,
  fair_use_share: PICTURE,
  period_footage: PICTURE,
  soft_footage: PICTURE,
  weak_fit: FIT,
  picture_coverage: NO_PICTURE,
  bare_backdrop_run: NO_PICTURE,
  picture_less_scenes: NO_PICTURE,
  dead_frames: SCENE,
  scene_defects: SCENE,
  unreadable_text: SCENE,
  film_taste: SCENE,
  designed_share: [rung("the scene designer decides every shot", "scene designer", 0.3, sceneNote("this shot has no decided scene:"))],
  slow_zoom_share: EDIT,
  cut_pace: EDIT,
  unbridged_split: SPLIT,
  // build list 5: the new checks, each with its owner's ladder
  stutter_cut: STUTTER,
  shot_rhythm: EDIT,
  cut_on_word: EDIT,
  tells_edit: EDIT,
  tells_picture: SCENE,
  tells_colour: COLOUR,
  tells_footage: PICTURE,
  idle_stock: PICTURE,
  generic_pictures: PICTURE,
  weak_meaning: FIT,
  // build list 5, items 10–14: the scene designer, told what the design measure found (DESIGN_FIX in the note)
  one_world: SCENE,
  template_stage: SCENE,
  backdrop_back_to_back: SCENE,
  world_variety: SCENE,
  untreated: SCENE,
  raw_stock: SCENE,
  small_text: SCENE,
  boxed_labels: SCENE,
  repeat_card: SCENE,
  data_rate: SCENE,
  chart_slides: SCENE,
  data_hold: SCENE,
  repeat_picture: PICTURE,
  figure_parity: SCENE,
  preview_luma: COLOUR,
  preview_colourfulness: COLOUR,
  preview_hue_spread: COLOUR,
  one_colour_film: ONE_COLOUR,
  unique_look: LOOK,
  unique_plan: LOOK,
  unique_plan_sound: SOUND,
  shared_sfx: SOUND,
  shared_music: SOUND,
  sfx_variety: SOUND,
  voice_unresolved: WRITER_ONLY,
  voice_wer: WRITER_ONLY,
};

/** The finished film (item 17): QA's picture faults, the viewer's notes by owner and the final-cut judge's tells. */
const RERENDER = [rung("render the stretch again", "render", 0.0, async (ps, a) => (a.touch(shotsOf(ps)), `${shotsOf(ps).length} shot(s) marked to render again`)), ...SCENE.slice(0, 2)];
export const FINISHED_LADDERS: LadderTable<Act> = {
  qa_picture: [replacePicture, directorReplans, designedFromKit],
  viewer_sourcing: [replacePicture, directorReplans, designedFromKit],
  "viewer_scene_designer": SCENE,
  viewer_editor: EDIT,
  "viewer_sound_designer": SOUND,
  viewer_colourist: COLOUR,
  viewer_voice: WRITER_ONLY,
  viewer_writer: WRITER_ONLY,
  viewer_render: RERENDER,
  final_cut: SCENE,
};
