import { createHash } from "node:crypto";
import { Storyboard, type CameraMove, type FactSheet, type LibraryIndex, type StoryboardShot, type TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { buildMenu, isUsable, pickFrom } from "./library-menu.js";
import { cached, MODELS, plain, structured } from "./llm.js";
import { bindFactProps, formatFactTable, numericFacts } from "./numeric-facts.js";
import type { StylePack } from "./style-pack.js";
import { chapterMoods, designSound, pickMusicByMood, sfxCap } from "./sound-design.js";

const DESIGNED = ["scene", "chart", "map", "document", "big_word", "money_figure", "name_label", "hero_face", "timeline", "versus", "quote_card", "cutout_collage", "screen"] as const;
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

const PROPS_SPEC = `designedProps JSON per kind. NUMBERS COME ONLY FROM THE NUMERIC FACT TABLE, referenced by id — never type a number yourself:
- money_figure: {"fact":"n03","label":str} — a gold counter laid over the shot's sharp footage (choose a strong query for that footage). ONLY a figure the narrator says during this very shot. At most one per ~50 s.
- chart: {"type":"line" for a trajectory (growth then crash) | "bar" for a comparison,"title":str (2–4 words, one key word),"labels":[str,...],"facts":["n01","n04",...] (one fact id per label),"highlight":int}
- versus: head-to-head rivalry or peak-vs-now contrast {"title":str,"left":{"label":str,"fact":"n05"},"right":{"label":str,"fact":"n06"}}
- map: {"title":str,"points":[{"name":str,"lon":num,"lat":num}],"route":bool}
- document: {"style":"web"|"newspaper"|"filing"|"letter","masthead":str,"date":str,"headline":str,"body":str (2–4 sentences),"highlight":str (exact substring of headline or body — ideally words the narrator says during the shot, so the marker sweeps in sync),"tone":"yellow"|"red" (red for a damning line)} — only facts from the sheet
- big_word: {"text":str,"sub":str} — a 1–2 word text slam laid over the shot's sharp footage (choose a strong query), held ~3 s: a date, a stat, or a 1–2 word stamp ("THE FALL"). Never repeat the same slam.
- name_label: {"name":str,"title":str} (lower third over footage of the named entity's place/building/document)
- hero_face: {"name":str,"title":str} — split panel introducing a key person: crimson block with the name + their black-and-white archival portrait (set entities to the person so the archive is searched; typographic fallback when none exists)
- cutout_collage: {"title":str (1–3 words),"tone":"crimson"|"gold"|"teal"} — subject cut out over a duotone textured backdrop with torn-paper edges (query = the subject photo/footage)
- screen: {"title":str,"lines":[str,...] (2–5 short UI lines, facts only),"device":"monitor"|"phone"} — tilted dark monitor/UI mock for tech/app beats
- timeline: {"items":[{"year":str,"label":str}]} (years must appear in the facts)
- quote_card: {"quote":str (verbatim from facts),"by":str}
- scene: {"brief":str (one sentence: the exact composition — what is shown, how it is laid out, what moves; e.g. "the real company logo stamps onto the frame over its headquarters footage, the word FRAUD slides in under it in the accent colour"),"layers":[{"name":str,"type":"person"|"company"|"product"|"place"}] (0–3 real entities whose photo or logo appears in the scene),"words":[str] (0–3 short on-screen words the narrator says during this shot — no numbers unless spoken exactly)} — a CUSTOM composed scene designed for this one line (logo reveal, photo-print collage, cutout over footage, kinetic words over footage, a person's photo with a label, callout arrows, a step flow). This is the channel's main designed shot: most designed shots should be scenes, each different.`;

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

/** big_word is a date, a stat, or a 1–2 word stamp. */
export const validBigWord = (t: string) => {
  const words = t.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && (words.length <= 2 || /\d/.test(t)) && words.length <= 4;
};

export interface DirectOptions {
  pack: StylePack;
  script: TimedScript;
  facts: FactSheet;
  index: LibraryIndex;
  /** ProductionMemory: query phrasings that produced mismatches in earlier films. */
  avoidQueries?: string[];
  log?: (s: string) => void;
}

type Word = TimedScript["segments"][number]["words"][number] & { seg: string; chapter?: string };

export async function directStoryboard(o: DirectOptions): Promise<Storyboard> {
  const log = o.log ?? (() => {});
  const words: Word[] = o.script.segments.flatMap((s) => s.words.map((w) => ({ ...w, seg: s.id, ...(s.chapter ? { chapter: s.chapter } : {}) })));
  const menu = buildMenu(o.index);
  const nf = numericFacts(o.facts);
  const short = o.script.durationS <= 90;
  const p = o.pack.profile.pacing;
  // Shorts cut faster than the channel's long-form; long-form follows the channel's median cut rate.
  // 16:9 mini-documentaries keep the channel's long-form cutting; only vertical shorts cut faster.
  const medShot = short && o.script.aspect === "9:16" ? Math.min(2.6, Math.max(1.6, p.shotMedianS?.p50 ?? 2)) : Math.min(4.5, Math.max(2.2, 60 / (p.cutsPerMin?.p50 ?? 17)));

  // Chunk long scripts at segment boundaries (~90 s each) so each plan fits one response.
  const chunks: Array<{ from: number; to: number; chapter?: string }> = [];
  let from = 0;
  for (let i = 0; i < o.script.segments.length; i++) {
    const seg = o.script.segments[i]!;
    const firstWord = words.findIndex((w) => w.seg === seg.id);
    const chunkStartS = words[from]?.startS ?? 0;
    if (firstWord > from && seg.startS - chunkStartS > 90) {
      chunks.push({ from, to: firstWord });
      from = firstWord;
    }
  }
  chunks.push({ from, to: words.length });

  const task = `You are the director/editor for the channel in the style pack. Turn the timed narration into a shot list.

Constraints:
- Aspect ${o.script.aspect}${o.script.aspect === "9:16" ? " (vertical: keep subjects centred, text in the upper two-thirds; captions own the band above the bottom 24%)" : " (landscape: lower thirds sit at 16% from the bottom, captions below them)"}.
- Median shot ≈ ${medShot.toFixed(1)} s (never under 0.8 s, never over ${short ? 5 : 7} s). Each shot starts on a word index (startWord); startWord strictly increasing; the first shot of this chunk starts at its first word index. Cut on emphasis words and sentence starts.
- VISUAL MIX (measured on the channel): ~70% sharp footage (reenactment, archival, b-roll) and 25–30% DESIGNED shots — roughly one designed shot in every 3–4. Hit that share. Designed elements sit over sharp, dark-graded footage, so every designed shot still needs a strong footage query. ABOUT HALF OF ALL DESIGNED SHOTS ARE "scene" (a custom composed layout for that exact line — the channel's logo reveals, photo-print collages, kinetic words over footage, callouts, step flows); the fixed kinds below cover the rest. Reach for: scene for any line that names a company, product or person at a turning point, a process, or a title moment; hero_face the first time each key person appears; versus or chart for every contrast anchor (us vs a rival); document for memos, filings and quotes; map for places and expansions; screen for software/app beats; cutout_collage for a key product or person at a turning point; big_word text slams (1–2 words) on chapter turns, dates and verdicts; money_figure only for a decisive spoken figure.
- SHOW THE REAL THING (style pack section 8): when the line names a specific person, company, product, building or event, set entities (name, type, year) — the resolver then fetches real press footage (news, interviews, keynotes) and real photos/logos of it. Real material of the actual entity always beats generic stock. Generic stock and reenactment are for mood and process lines only.
- FOLLOW THE VISUAL GRAMMAR (section 8): number lines are designed (counter, chart, scene with the spoken figure); comparison lines are versus/chart; process lines are step-flow scenes; literal lines that name a brand or person get the real footage/photo or a composed scene with their logo/photo; mood lines get footage.
- NO AI-generated imagery ever. Visuals are real footage, real photos or designed graphics.
- REENACTMENT FIRST: the channel's #1 picture type is staged stock reenactment with anonymous actors (about a third of all cuts). When the line describes power, secrecy, engineers, founders, boardroom tension, deals, panic or consumers, use visual "reenactment" with a cinematic, filmable query: "suited executives dark boardroom tension", "engineer working late computer monitors dark office", "hand signing contract fountain pen close up", "person looking worried at smartphone at night", "ceo staring out office window city night". Pair with archival queries for the named entities. Never request a recognisable celebrity or politician as someone else, and never put a name_label over an actor.
- Period props must match the story era (no typewriters, dip pens or rotary phones after 1990; no smartphones before 2007).
- Every shot is a layered composition: designed graphics sit over sharp footage (set query to the footage that should sit behind the graphic).
- Avoid shots that fade to black, show darkness, or are mostly blank/white.
- query: concrete, searchable English with era when relevant.
- sfx: classes from the SFX menu, placed on the words they accent (atWord = global index), at the channel's density (audio.strongHitsPerMin${short ? ", scaled up for a short" : ""}).
- overlay: optional texture from the overlay menu for period footage or transitions.
- musicId: the music bed for THIS chunk from the MUSIC menu (long-form changes cues between chapters).
${PROPS_SPEC}`;

  const menuText = `SFX MENU: ${menu.sfxClasses.map((s) => `${s.cls} (${s.use})`).join("; ")}
OVERLAY MENU: ${menu.overlayGroups.map((g) => g.group).join(", ")}
MUSIC MENU: ${menu.music.map((m) => `${m.id} "${m.title}" ${m.durationS}s`).join("; ")}
LOCAL LIBRARY SUBJECTS: ${menu.cinematicSubjects.join(", ")}; eras ${menu.eras.join(", ")}; object cutouts: ${menu.objects.join(", ")}

${o.avoidQueries?.length ? `QUERIES THAT FAILED IN EARLIER FILMS (do not reuse these phrasings): ${o.avoidQueries.join("; ")}\n\n` : ""}NUMERIC FACT TABLE (verified):
${formatFactTable(nf) || "(none — do not use money_figure, chart or versus)"}`;

  type PlanShot = z.infer<typeof PlanSchema>["shots"][number];
  const planned: PlanShot[] = [];
  const musicCues: Array<{ id: string; fromWord: number }> = [];
  for (const [ci, ch] of chunks.entries()) {
    const segIds = new Set(words.slice(ch.from, ch.to).map((w) => w.seg));
    const wordList = words.slice(ch.from, ch.to).map((w, k) => `${ch.from + k}:${w.word}@${w.startS.toFixed(2)}`).join(" ");
    const chunkDur = (words[ch.to - 1]?.endS ?? o.script.durationS) - (words[ch.from]?.startS ?? 0);
    log(`  director: chunk ${ci + 1}/${chunks.length} — ~${Math.round(chunkDur / medShot)} shots (${MODELS.sonnet}, style pack cached)…`);
    const { data, usage } = await structured({
      stage: "director.plan",
      model: MODELS.sonnet,
      system: [cached(o.pack.text), cached(task)],
      user: `${menuText}\n\nNARRATION SEGMENTS (this chunk):\n${o.script.segments.filter((s) => segIds.has(s.id)).map((s) => `[${s.id} ${s.role}${s.chapter ? ` | chapter "${s.chapter}"` : ""}] ${s.text}`).join("\n")}\n\nWORDS (index:word@seconds), indices ${ch.from}–${ch.to - 1}:\n${wordList}`,
      schema: PlanSchema,
      effort: "high",
      maxTokens: 32000,
    });
    log(`    cache read ${usage.cacheRead} tokens`);
    const inRange = data.shots.filter((s) => s.startWord >= ch.from && s.startWord < ch.to).sort((a, b) => a.startWord - b.startWord);
    if (inRange.length) inRange[0]!.startWord = ch.from;
    else inRange.push({ startWord: ch.from, intent: "continue", lineLink: "mood", visual: "broll", query: o.facts.topic, era: "", entities: [], designedKind: "none", designedProps: "{}", camera: "drift", overlay: "", transitionIn: "cut", sfx: [], focusX: 0.5 });
    log(`    ${inRange.filter((x) => x.visual === "designed" && x.designedKind === "scene").length} composed scene(s), ${inRange.filter((x) => x.entities.length).length} entity shot(s) in this chunk`);
    planned.push(...inRange);
    musicCues.push({ id: data.musicId, fromWord: ch.from });
  }

  const dedup = planned.filter((s, i) => i === 0 || s.startWord > planned[i - 1]!.startWord);
  dedup[0]!.startWord = 0;

  const usable = o.index.assets.filter(isUsable);
  const sfxByClass = new Map<string, typeof usable>();
  for (const a of usable) if (a.category === "sfx" && typeof a.facets.class === "string") (sfxByClass.get(a.facets.class) ?? sfxByClass.set(a.facets.class, []).get(a.facets.class)!).push(a);
  const overlayByGroup = new Map<string, typeof usable>();
  for (const a of usable) if (a.category === "overlays" && a.kind === "video" && typeof a.facets.group === "string") (overlayByGroup.get(a.facets.group) ?? overlayByGroup.set(a.facets.group, []).get(a.facets.group)!).push(a);
  const usedSfx = new Set<string>();
  const usedOverlay = new Set<string>();
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
        // Graphics must bind every number to a verified fact; big_word must be a date/stat/stamp.
        const bound = bindFactProps(s.designedKind, props, nf);
        const bigOk = s.designedKind !== "big_word" || validBigWord(String(props.text ?? ""));
        if (bound && bigOk) {
          source = { kind: "designed", designed: s.designedKind, props: { ...bound.props, background: bg }, assetIds: [] };
          factIds = bound.factIds;
        } else demoted++;
      }
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
      const entities = s.entities.filter((e) => e.name.trim()).map((e) => ({ name: e.name.trim(), type: e.type, ...(e.year > 1000 ? { year: Math.round(e.year) } : {}) }));
      return {
        schemaVersion: 1,
        id: `sh${String(i + 1).padStart(3, "0")}`,
        scriptSegmentId: w0.seg,
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
        ...(entities.length ? { entities } : {}),
        ...(factIds.length ? { factIds } : {}),
        ...(w0.chapter ? { chapter: w0.chapter } : {}),
      } satisfies StoryboardShot;
    })
    .filter((s) => s.endS - s.startS > 0.05);
  if (demoted) log(`  director: ${demoted} graphic(s) demoted to footage (unbound numbers or non-stamp big_word)`);

  // Signature introductions: the first footage shot that names a dossier character becomes a HeroFaceSplit
  // (archive-searched portrait, typographic fallback), so key people are introduced like the reference NameTag.
  for (const ch of o.facts.story?.characters ?? []) {
    const last = ch.name.split(/\s+/).at(-1)!.replace(/[^\p{L}]/gu, "");
    if (last.length < 3 || shots.some((x) => x.source.kind === "designed" && x.source.designed === "hero_face" && String(x.source.props.name ?? "").includes(last))) continue;
    const sh = shots.find((x) => x.source.kind === "query" && x.endS - x.startS >= 1.6 && words.some((w) => w.startS >= x.startS && w.startS < x.endS && w.word.replace(/[^\p{L}]/gu, "") === last));
    if (!sh) continue;
    const q = sh.source.kind === "query" ? sh.source.query : "";
    sh.source = { kind: "designed", designed: "hero_face", props: { name: ch.name, title: ch.role.slice(0, 40), background: { query: q } }, assetIds: [] };
    sh.entities = [{ name: ch.name, type: "person" }];
  }

  // Variety caps (reference: ~29 % designed; counters are rare; text slams never repeat).
  const KEEP_ORDER = ["scene", "chart", "map", "document", "versus", "hero_face", "cutout_collage", "screen", "timeline", "name_label", "money_figure", "big_word", "quote_card"];
  const toFootage = (sh: StoryboardShot) => {
    const bg = (sh.source.kind === "designed" ? (sh.source.props.background as { query?: string; era?: string } | undefined) : undefined) ?? {};
    sh.source = { kind: "query", query: bg.query && bg.query.length >= 3 ? bg.query : `${sh.intent} cinematic reenactment`, mustBe: "video", ...(bg.era ? { era: bg.era } : {}) };
    delete sh.factIds;
  };
  const dz = (k: string) => shots.filter((x) => x.source.kind === "designed" && x.source.designed === k);
  const maxCounters = Math.max(1, Math.round((3 * o.script.durationS) / 150));
  const seenFacts = new Set<string>();
  let lastCounter = -Infinity;
  let capped = 0;
  for (const sh of dz("money_figure")) {
    const f = sh.factIds?.[0] ?? "";
    if (dz("money_figure").indexOf(sh) >= 0 && (seenFacts.has(f) || sh.startS - lastCounter < 20 || [...seenFacts].length >= maxCounters)) (toFootage(sh), capped++);
    else (seenFacts.add(f), (lastCounter = sh.startS));
  }
  const seenSlams = new Set<string>();
  for (const sh of dz("big_word")) {
    const t = String((sh.source as { props: Record<string, unknown> }).props.text ?? "").toLowerCase().trim();
    if (seenSlams.has(t)) (toFootage(sh), capped++);
    else seenSlams.add(t);
  }
  const maxDesigned = Math.floor(shots.length * 0.3);
  const designedNow = () => shots.filter((x) => x.source.kind === "designed" && x.source.designed !== "name_label");
  while (designedNow().length > maxDesigned) {
    const worst = [...designedNow()].sort((a, b) => KEEP_ORDER.indexOf((b.source as { designed: string }).designed) - KEEP_ORDER.indexOf((a.source as { designed: string }).designed) || b.startS - a.startS)[0]!;
    toFootage(worst);
    capped++;
  }
  {
    const share = shots.filter((x) => x.source.kind === "designed").length / Math.max(1, shots.length);
    log(`  director: designed share ${(share * 100).toFixed(0)} % (reference 24–36 %)${share < 0.2 ? " — below the channel band" : ""}`);
  }
  // EVERY SHOT IS DESIGNED (measured on the reference: nearly every shot carries designed treatment). Data graphics
  // keep their dedicated components; every other shot — footage, introductions, slams, quotes — becomes a composed
  // scene that the scene designer lays out for that exact line, with the shot's entities as picture layers.
  {
    const DATA = new Set(["chart", "map", "document", "versus", "money_figure", "timeline"]);
    let scenes = 0;
    for (const sh of shots) {
      const src = sh.source;
      if (src.kind === "designed" && (DATA.has(src.designed) || src.designed === "scene")) {
        if (src.designed === "scene") scenes++;
        continue;
      }
      const p = src.kind === "designed" ? src.props : {};
      const bg = (src.kind === "designed" ? (p.background as { query?: string; era?: string } | undefined) : { query: src.kind === "query" ? src.query : sh.intent, era: src.kind === "query" ? src.era : undefined }) ?? {};
      const was = src.kind === "designed" ? src.designed : "footage";
      const hint =
        was === "hero_face" ? `introduce ${String(p.name ?? "")} (${String(p.title ?? "")}) with their real photo and name`
        : was === "name_label" ? `label who or what is on screen: ${String(p.name ?? "")} — ${String(p.title ?? "")}`
        : was === "big_word" ? `a text slam: "${String(p.text ?? "")}"${p.sub ? ` / ${String(p.sub)}` : ""}`
        : was === "quote_card" ? `the quote "${String(p.quote ?? "")}" — ${String(p.by ?? "")}`
        : was === "cutout_collage" ? `cutout collage titled "${String(p.title ?? "")}"`
        : was === "screen" ? `a screen/UI moment: ${String(p.title ?? "")}`
        : "";
      const ents = [...(sh.entities ?? [])];
      if (was === "hero_face" && p.name && !ents.some((e) => e.name === p.name)) ents.unshift({ name: String(p.name), type: "person" });
      const layers = ents.filter((e) => ["company", "product", "person", "place", "landmark"].includes(e.type)).slice(0, 2).map((e) => ({ name: e.name, type: e.type }));
      sh.source = { kind: "designed", designed: "scene", props: { brief: [sh.intent, hint].filter(Boolean).join(" — "), layers, words: [], background: { query: bg.query && bg.query.length >= 3 ? bg.query : `${sh.intent} cinematic footage`, mustBe: "video", ...(bg.era ? { era: bg.era } : {}) } }, assetIds: [] };
      if (ents.length) sh.entities = ents;
      delete sh.factIds;
      scenes++;
    }
    log(`  director: every shot designed — ${scenes} composed scene(s), ${shots.length - scenes} data graphic(s)`);
  }
  if (capped) log(`  director: variety caps — ${capped} graphic(s) returned to footage (≤ ${maxCounters} counters, unique slams, ≤ 30 % designed)`);

  // Music: one bed per chapter on the mood arc (long-form); shorts keep the director's pick for their single span.
  let music: Storyboard["music"] = [];
  if (!short) music = pickMusicByMood(menu.music, chapterMoods(o.script));
  else {
    const c = musicCues[0];
    const pick = menu.music.find((m) => m.id === c?.id) ?? menu.music.find((m) => !m.generated) ?? menu.music[0];
    if (pick) music = [{ assetId: pick.id, startS: 0, endS: o.script.durationS, gainDb: -16, drops: [] }];
  }

  // Sound design: drops on cliffhangers, risers/booms on chapter pivots, SFX on ~50 % of reveals. The director's
  // own SFX stay unless they crowd a designed hit (< 1.2 s).
  const sd = designSound({ script: o.script, shots, music, sfxAssets: usable.filter((a) => a.category === "sfx"), profile: o.pack.profile });
  music = sd.music;
  const auto = [...sd.sfx.values()].flat().map((x) => x.atS);
  // Designed hits first; the director's own cues fill what is left of the channel's density budget.
  const budget = sfxCap(o.pack.profile, o.script.durationS) - auto.length;
  const own = shots.flatMap((sh) => sh.sfx.filter((x) => !auto.some((t) => Math.abs(t - x.atS) < 1.2)).map((x) => ({ id: sh.id, x })));
  const keepOwn = new Set(own.filter((_, k) => budget > 0 && k % Math.max(1, Math.ceil(own.length / budget)) === 0).slice(0, Math.max(0, budget)).map((e) => e.x));
  for (const sh of shots) {
    sh.sfx = [...sh.sfx.filter((x) => keepOwn.has(x)), ...(sd.sfx.get(sh.id) ?? [])].sort((a, b) => a.atS - b.atS);
  }
  log(`  director: music ${music.map((m) => `${m.mood ?? "bed"}@${m.startS.toFixed(0)}s`).join(" → ")}; ${music.reduce((n, m) => n + m.drops.length, 0)} drop-out(s); ${shots.reduce((n, s) => n + s.sfx.length, 0)} sfx`);

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
