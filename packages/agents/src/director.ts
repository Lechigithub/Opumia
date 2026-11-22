import { createHash } from "node:crypto";
import { Storyboard, type CameraMove, type FactSheet, type LibraryIndex, type StoryboardShot, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { buildMenu } from "./library-menu.js";
import { bindFactProps, numericFacts } from "./numeric-facts.js";
import type { StylePack } from "./style-pack.js";
import { chapterMoods, pickMusicByMood } from "./sound-design.js";

/** Data graphics (drawn by the film's kit from verified data) and composed scenes. No preset cards (build list 3, L4). */
const DESIGNED = ["scene", "chart", "map", "document"] as const;
const CAMERAS = ["static", "push_in", "pull_out", "pan_left", "pan_right", "parallax", "drift", "shake"] as const;

const PlanSchema = z.object({
  musicId: z.string(),
  shots: z.array(
    z.object({
      startWord: z.number().describe("global index of the first word this shot covers"),
      intent: z.string(),
      lineLink: z.enum(["literal", "mood", "data", "metaphor", "transition"]),
      visual: z.enum(["reenactment", "broll", "photo", "designed"]).describe("reenactment = staged stock footage with anonymous actors playing the scene"),
      query: z.string().describe("search query for the footage/photo (also the background for designed shots)"),
      era: z.string().describe("decade like 1950s, or 'modern', or empty"),
      entities: z.array(z.object({ name: z.string(), type: z.enum(["person", "company", "place", "landmark", "event", "product"]), year: z.number() })).describe("specific real people/companies/places/landmarks this shot should literally show (year 0 if unknown); empty for generic B-roll"),
      designedKind: z.enum([...DESIGNED, "none"]),
      designedProps: z.string().describe("JSON object string with the props for the designed kind, or {}"),
      camera: z.enum(CAMERAS),
      overlay: z.string().describe("overlay group name from the menu, or empty"),
      transitionIn: z.enum(["cut", "fade", "whip", "dip_black", "light_leak", "match"]),
      sfx: z.array(z.object({ cls: z.string(), atWord: z.number() })),
      focusX: z.number().describe("0..1 horizontal focus of the subject, used for 9:16 reframing"),
    }),
  ),
});

/** The director agent's tool input: the same plan a model returns, turned into a storyboard by the same code. */
export const DirectorPlanSchema = PlanSchema;
export type DirectorPlan = z.infer<typeof PlanSchema>;

export const PROPS_SPEC = `designedProps JSON per data graphic. The film's kit draws it; the engine feeds it verified data. NUMBERS COME ONLY FROM THE NUMERIC FACT TABLE, referenced by id — never type a number yourself:
- chart: {"type":"line" for a trajectory (growth then crash) | "bar" for a comparison (two bars for a head-to-head),"title":str (2–4 words),"labels":[str,...],"facts":["n01","n04",...] (one fact id per label),"highlight":int}
- map: {"title":str,"points":[{"name":str,"lon":num,"lat":num}],"route":bool}
- document: {"style":"web"|"newspaper"|"filing"|"letter","masthead":str,"date":str,"headline":str,"body":str (2–4 sentences),"highlight":str (exact substring of headline or body — ideally words the narrator says during the shot),"tone":"yellow"|"red"} — only facts from the sheet
Every other shot is footage; the scene designer composes each one from the film's kit (or leaves moving footage clean).`;

const cameraMove = (c: (typeof CAMERAS)[number], i: number): CameraMove => {
  switch (c) {
    case "static":
      return { type: "static" };
    case "push_in":
      return { type: "ken_burns", fromScale: 1.04, toScale: 1.18, from: [0.5, 0.5], to: [0.5, 0.46], easing: "ease_in_out" };
    case "pull_out":
      return { type: "ken_burns", fromScale: 1.2, toScale: 1.04, from: [0.5, 0.45], to: [0.5, 0.5], easing: "ease_out" };
    case "pan_left":
      return { type: "pan", direction: "left", amount: 0.12 };
    case "pan_right":
      return { type: "pan", direction: "right", amount: 0.12 };
    case "parallax":
      return { type: "parallax", layers: 3, depth: 0.6 };
    case "drift":
      return { type: "ken_burns", fromScale: 1.06, toScale: 1.12, from: [i % 2 ? 0.47 : 0.53, 0.5], to: [i % 2 ? 0.53 : 0.47, 0.5], easing: "linear" };
    case "shake":
      return { type: "shake", intensity: 0.4 };
  }
};

export interface DirectOptions {
  pack: StylePack;
  script: TimedScript;
  facts: FactSheet;
  index: LibraryIndex;
  /** The plan drawn up by the director agent (director-agent.ts): this module only converts it and applies its guards. */
  raw: DirectorPlan;
  log?: (s: string) => void;
}

type Word = TimedScript["segments"][number]["words"][number] & { seg: string; chapter?: string };

/** The director agent's plan → a storyboard (build list 3, L18: the single-prompt director was removed). */
export async function directStoryboard(o: DirectOptions): Promise<Storyboard> {
  const log = o.log ?? (() => {});
  const words: Word[] = o.script.segments.flatMap((s) => s.words.map((w) => ({ ...w, seg: s.id, ...(s.chapter ? { chapter: s.chapter } : {}) })));
  const menu = buildMenu(o.index);
  const nf = numericFacts(o.facts);
  const short = o.script.durationS <= 90;
  const planned = [...o.raw.shots].filter((s) => s.startWord >= 0 && s.startWord < words.length).sort((a, b) => a.startWord - b.startWord);
  if (!planned.length) throw new Error("director: the plan has no shot inside the narration");
  const dedup = planned.filter((s, i) => i === 0 || s.startWord > planned[i - 1]!.startWord);
  dedup[0]!.startWord = 0;

  let demoted = 0;

  const shots: StoryboardShot[] = dedup
    .map((s, i) => {
      const startS = i === 0 ? 0 : words[s.startWord]!.startS;
      const next = dedup[i + 1];
      const endS = next ? words[next.startWord]!.startS : o.script.durationS;
      const w0 = words[s.startWord]!;
      let props: Record<string, unknown> = {};
      try {
        props = JSON.parse(s.designedProps || "{}") as Record<string, unknown>;
      } catch {
        props = {};
      }
      const bg = { query: s.query, mustBe: s.visual === "photo" ? "image" : "any", ...(s.era ? { era: s.era } : {}) };
      let source: StoryboardShot["source"] = { kind: "query", query: s.query.length >= 3 ? s.query : `${s.intent} documentary footage`, mustBe: s.visual === "photo" ? "image" : s.visual === "broll" || s.visual === "reenactment" ? "video" : "any", ...(s.era ? { era: s.era } : {}) };
      let factIds: string[] = [];
      if (s.visual === "designed" && s.designedKind !== "none") {
        // Data graphics must bind every number to a verified fact.
        const bound = bindFactProps(s.designedKind, props, nf);
        if (bound) {
          source = { kind: "designed", designed: s.designedKind, props: { ...bound.props, background: bg }, assetIds: [] };
          factIds = bound.factIds;
        } else demoted++;
      }
      const entities = s.entities.filter((e) => e.name.trim()).map((e) => ({ name: e.name.trim(), type: e.type, ...(e.year > 1000 ? { year: Math.round(e.year) } : {}) }));
      return {
        schemaVersion: 2,
        id: `sh${String(i + 1).padStart(3, "0")}`,
        scriptSegmentId: w0.seg,
        index: i,
        startS: Math.round(startS * 1000) / 1000,
        endS: Math.round(endS * 1000) / 1000,
        intent: s.intent,
        lineLink: s.lineLink,
        source,
        camera: cameraMove(s.camera, i),
        overlays: [],
        sfx: [],
        transitionIn: i === 0 ? "cut" : s.transitionIn,
        focus: [Math.min(1, Math.max(0, s.focusX)), 0.5],
        ...(entities.length ? { entities } : {}),
        ...(factIds.length ? { factIds } : {}),
        ...(w0.chapter ? { chapter: w0.chapter } : {}),
      } satisfies StoryboardShot;
    })
    .filter((s) => s.endS - s.startS > 0.05);
  if (demoted) log(`  director: ${demoted} graphic(s) returned to footage (numbers not bound to verified facts)`);

  // Every non-data shot becomes a scene the scene designer composes from the film's kit for that exact line
  // (or leaves clean, when its footage is moving video that shows the line), with the shot's entities as picture layers.
  {
    const DATA = new Set<string>(["chart", "map", "document"]);
    let scenes = 0;
    for (const sh of shots) {
      const src = sh.source;
      if (src.kind === "designed" && DATA.has(src.designed)) continue;
      if (src.kind === "designed" && src.designed === "scene") { scenes++; continue; }
      const bg = src.kind === "query" ? { query: src.query, era: src.era } : { query: sh.intent, era: undefined };
      const ents = [...(sh.entities ?? [])];
      const layers = ents.filter((e) => ["company", "product", "person", "place", "landmark"].includes(e.type)).slice(0, 2).map((e) => ({ name: e.name, type: e.type }));
      sh.source = { kind: "designed", designed: "scene", props: { brief: sh.intent, layers, words: [], background: { query: bg.query && bg.query.length >= 3 ? bg.query : `${sh.intent} cinematic footage`, mustBe: src.kind === "query" ? src.mustBe : "video", ...(bg.era ? { era: bg.era } : {}) } }, assetIds: [] };
      if (ents.length) sh.entities = ents;
      delete sh.factIds;
      scenes++;
    }
    log(`  director: ${scenes} scene(s) for the scene designer, ${shots.length - scenes} data graphic(s)`);
  }

  // Music: one bed per chapter on the mood arc (long-form); shorts keep the director's pick for their single span.
  let music: Storyboard["music"] = [];
  if (!short) music = pickMusicByMood(menu.music, chapterMoods(o.script));
  else {
    const pick = menu.music.find((m) => m.id === o.raw.musicId) ?? menu.music.find((m) => !m.generated) ?? menu.music[0];
    if (pick) music = [{ assetId: pick.id, startS: 0, endS: o.script.durationS, gainDb: -16, drops: [] }];
  }

  // Sound is designed later on what the viewer sees (sound-timeline.ts, the sound designer agent).
  log(`  director: music ${music.map((m) => `${m.mood ?? "bed"}@${m.startS.toFixed(0)}s`).join(" → ")}`);

  return Storyboard.parse({
    schemaVersion: 1,
    id: `sb_${createHash("sha1").update(o.script.id).digest("hex").slice(0, 10)}`,
    scriptId: o.script.id,
    styleProfileId: o.script.styleProfileId,
    aspect: o.script.aspect,
    durationS: o.script.durationS,
    shots,
    music,
    generatedAt: new Date().toISOString(),
  });
}
