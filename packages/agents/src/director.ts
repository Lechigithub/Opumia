import { createHash } from "node:crypto";
import { Storyboard, type CameraMove, type LibraryIndex, type StoryboardShot, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { buildMenu, isUsable, pickFrom } from "./library-menu.js";
import { cached, MODELS, plain, structured } from "./llm.js";
import type { StylePack } from "./style-pack.js";

const DESIGNED = ["chart", "map", "document", "big_word", "money_figure", "name_label", "timeline", "versus", "quote_card"] as const;
const CAMERAS = ["static", "push_in", "pull_out", "pan_left", "pan_right", "parallax", "drift", "shake"] as const;

const PlanSchema = z.object({
  musicId: z.string(),
  shots: z.array(
    z.object({
      startWord: z.number().describe("global index of the first word this shot covers"),
      intent: z.string(),
      lineLink: z.enum(["literal", "mood", "data", "metaphor", "transition"]),
      visual: z.enum(["broll", "photo", "designed"]),
      query: z.string().describe("search query for the footage/photo (also the background for designed shots)"),
      era: z.string().describe("decade like 1950s, or 'modern', or empty"),
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

const PROPS_SPEC = `designedProps JSON per kind (all text short; every number must come from the narration/facts):
- chart: {"type":"bar"|"line","title":str,"unit":str,"labels":[str],"values":[num],"highlight":int}
- map: {"title":str,"points":[{"name":str,"lon":num,"lat":num}],"route":bool}
- document: {"style":"newspaper"|"filing"|"letter","masthead":str,"date":str,"headline":str,"body":str,"highlight":str (exact substring of headline or body)}
- big_word: {"text":str (1-3 words, kinetic typography),"sub":str}
- money_figure: {"value":num,"prefix":str,"suffix":str,"label":str}
- name_label: {"name":str,"title":str} (lower third over the footage)
- timeline: {"items":[{"year":str,"label":str}]}
- versus: {"title":str,"left":{"label":str,"value":str},"right":{"label":str,"value":str}}
- quote_card: {"quote":str,"by":str}`;

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
  index: LibraryIndex;
  log?: (s: string) => void;
}

export async function directStoryboard(o: DirectOptions): Promise<Storyboard> {
  const log = o.log ?? (() => {});
  const words = o.script.segments.flatMap((s) => s.words.map((w) => ({ ...w, seg: s.id })));
  const menu = buildMenu(o.index);
  const short = o.script.durationS <= 90;
  const p = o.pack.profile.pacing;
  const medShot = short ? Math.min(2.6, Math.max(1.6, (p.shotMedianS?.p50 ?? 2) * 1.0)) : (p.shotMedianS?.p50 ?? 2.5);
  const targetShots = Math.round(o.script.durationS / medShot);

  const wordList = words.map((w, i) => `${i}:${w.word}@${w.startS.toFixed(2)}`).join(" ");
  const task = `You are the director/editor for the channel in the style pack. Turn the timed narration into a shot list.

Constraints:
- Aspect ${o.script.aspect}${o.script.aspect === "9:16" ? " (vertical: keep subjects centred, text in the middle 70%, captions occupy the lower third)" : ""}. Duration ${o.script.durationS.toFixed(2)} s.
- About ${targetShots} shots (median shot ≈ ${medShot.toFixed(1)} s, never under 0.8 s, never over 5 s). Each shot starts on a word index (startWord); the first shot must start at word 0; startWord strictly increasing. Cut on emphasis words and sentence starts.
- Match the channel's visual mix (style profile visualMix: stock vs real/archival vs designed) and its signature designed moments (techniques). Use designed graphics for numbers (chart/money_figure), places (map), headlines and filings (document), key words (big_word kinetic typography), people (name_label over footage), comparisons (versus).
- NO AI-generated imagery ever. Visuals are real footage, real photos or designed graphics.
- REAL PEOPLE: when the narration names or refers to a real person (an executive, a whistle-blower), never ask for footage of "a man"/"a woman"/"an executive" — viewers would take that stranger for the real person. Use name_label over a building, office, document or hands shot, a document, or big_word instead. Never request footage of other identifiable public figures or unrelated real events.
- Avoid shots that fade to black or show darkness/lights switching off; end on a strong image.
- query: concrete, searchable English (e.g. "1970s factory assembly line workers", "stock exchange trading floor"), with era when relevant. For people, prefer archival/real footage of the actual place or era, or mood shots — never pretend an actor is the real person.
- sfx: choose classes from the SFX menu; place hits on the words they accent (atWord = global index). Use them like the channel does (hit density in audio.strongHitsPerMin, scaled for a fast short).
- overlay: optional texture from the overlay menu for period footage or transitions.
- Pick one music bed from the MUSIC menu that fits the tone (musicId).
${PROPS_SPEC}`;

  const menuText = `SFX MENU: ${menu.sfxClasses.map((s) => `${s.cls} (${s.use})`).join("; ")}
OVERLAY MENU: ${menu.overlayGroups.map((g) => g.group).join(", ")}
MUSIC MENU: ${menu.music.map((m) => `${m.id} "${m.title}" ${m.durationS}s`).join("; ")}
LOCAL LIBRARY SUBJECTS: ${menu.cinematicSubjects.join(", ")}; eras ${menu.eras.join(", ")}; object cutouts: ${menu.objects.join(", ")}`;

  log(`  director: planning ~${targetShots} shots (${MODELS.sonnet}, style pack cached)…`);
  const { data, usage } = await structured({
    stage: "director.plan",
    model: MODELS.sonnet,
    system: [cached(o.pack.text), plain(task)],
    user: `${menuText}\n\nNARRATION SEGMENTS:\n${o.script.segments.map((s) => `[${s.id} ${s.role}] ${s.text}`).join("\n")}\n\nWORDS (index:word@seconds):\n${wordList}`,
    schema: PlanSchema,
    effort: "high",
  });
  log(`    cache read ${usage.cacheRead} tokens`);

  // Normalise: valid, increasing word indices covering the timeline.
  const plan = data.shots.filter((s) => s.startWord >= 0 && s.startWord < words.length).sort((a, b) => a.startWord - b.startWord);
  const dedup = plan.filter((s, i) => i === 0 || s.startWord > plan[i - 1]!.startWord);
  if (!dedup.length) throw new Error("director returned no usable shots");
  dedup[0]!.startWord = 0;

  const usable = o.index.assets.filter(isUsable);
  const sfxByClass = new Map<string, typeof usable>();
  for (const a of usable) if (a.category === "sfx" && typeof a.facets.class === "string") (sfxByClass.get(a.facets.class) ?? sfxByClass.set(a.facets.class, []).get(a.facets.class)!).push(a);
  const overlayByGroup = new Map<string, typeof usable>();
  for (const a of usable) if (a.category === "overlays" && a.kind === "video" && typeof a.facets.group === "string") (overlayByGroup.get(a.facets.group) ?? overlayByGroup.set(a.facets.group, []).get(a.facets.group)!).push(a);
  const usedSfx = new Set<string>();
  const usedOverlay = new Set<string>();

  const shots: StoryboardShot[] = dedup.map((s, i) => {
    const startS = i === 0 ? 0 : words[s.startWord]!.startS;
    const next = dedup[i + 1];
    const endS = next ? words[next.startWord]!.startS : o.script.durationS;
    const seg = words[s.startWord]!.seg;
    let props: Record<string, unknown> = {};
    try {
      props = JSON.parse(s.designedProps || "{}") as Record<string, unknown>;
    } catch {
      props = {};
    }
    const bg = { query: s.query, mustBe: s.visual === "photo" ? "image" : "any", ...(s.era ? { era: s.era } : {}) };
    const source: StoryboardShot["source"] =
      s.visual === "designed" && s.designedKind !== "none"
        ? { kind: "designed", designed: s.designedKind, props: { ...props, background: bg }, assetIds: [] }
        : { kind: "query", query: s.query.length >= 3 ? s.query : `${s.intent} documentary footage`, mustBe: s.visual === "photo" ? "image" : s.visual === "broll" ? "video" : "any", ...(s.era ? { era: s.era } : {}) };
    const sfx = s.sfx
      .map((x) => {
        const pick = pickFrom(sfxByClass.get(x.cls) ?? [], usedSfx);
        if (!pick || x.atWord < 0 || x.atWord >= words.length) return null;
        usedSfx.add(pick.id);
        return { assetId: pick.id, atS: Math.max(0, words[x.atWord]!.startS - 0.05), gainDb: -4 };
      })
      .filter((x): x is { assetId: string; atS: number; gainDb: number } => x !== null);
    const ov = s.overlay ? pickFrom(overlayByGroup.get(s.overlay) ?? [], usedOverlay) : undefined;
    if (ov) usedOverlay.add(ov.id);
    return {
      schemaVersion: 1,
      id: `sh${String(i + 1).padStart(3, "0")}`,
      scriptSegmentId: seg,
      index: i,
      startS: Math.round(startS * 1000) / 1000,
      endS: Math.round(endS * 1000) / 1000,
      intent: s.intent,
      lineLink: s.lineLink,
      source,
      camera: cameraMove(s.camera, i),
      overlays: ov ? [{ assetId: ov.id, blend: "screen", opacity: 0.55 }] : [],
      sfx,
      transitionIn: i === 0 ? "cut" : s.transitionIn,
      focus: [Math.min(1, Math.max(0, s.focusX)), 0.5],
    } satisfies StoryboardShot;
  }).filter((s) => s.endS - s.startS > 0.05);

  const music = menu.music.find((m) => m.id === data.musicId) ?? menu.music.find((m) => !m.generated) ?? menu.music[0];
  return Storyboard.parse({
    schemaVersion: 1,
    id: `sb_${createHash("sha1").update(o.script.id).digest("hex").slice(0, 10)}`,
    scriptId: o.script.id,
    styleProfileId: o.script.styleProfileId,
    aspect: o.script.aspect,
    durationS: o.script.durationS,
    shots,
    music: music ? [{ assetId: music.id, startS: 0, endS: o.script.durationS, gainDb: -16 }] : [],
    generatedAt: new Date().toISOString(),
  });
}
