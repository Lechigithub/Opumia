import { ASPECT_DIMENSIONS, RenderManifest, type ResolutionReport, type ResolvedMedia, type Storyboard, type TimedScript } from "@opumia/contracts";
import { PLATFORM_FPS } from "@opumia/contracts";
import { captionGroups } from "./captions.js";
import { cameraAt } from "./motion.js";
import { projectMap, type MapPoint } from "./map.js";
import { compactOf, displayOf, spokenMatch, spokenNumbers } from "./parity.js";

type VideoLayer = RenderManifest["video"][number];

/** Layers during which burned-in captions are hidden (the kit's chapter card fills the frame with its own words). */
export const FULLSCREEN_TEXT = new Set(["chapter"]);
/** Chapter card length (long-form chapter openers, drawn by the kit's chapter role). */
export const CHAPTER_CARD_S = 2.4;
type AudioLayer = Omit<RenderManifest["audio"][number], "dips"> & Partial<Pick<RenderManifest["audio"][number], "dips">>;

export interface BuildManifestOptions {
  storyboard: Storyboard;
  script: TimedScript;
  resolution: ResolutionReport;
  libraryRoot: string;
  outputPath: string;
  narrationPath: string;
  fps?: 24 | 25 | 30 | 60;
  tailS?: number;
  log?: (s: string) => void;
  /** Burn word captions into the picture (style pack caption policy; shorts always). The SRT keeps every word either way. */
  burnCaptions?: boolean;
  /** Composed scene specs from the scene designer (designed kind "scene"). */
  scenes?: Map<string, unknown>;
}

/** Storyboard + TimedScript + resolved media → frame-exact RenderManifest (validated). */
export async function buildManifest(o: BuildManifestOptions): Promise<RenderManifest> {
  const fps = o.fps ?? PLATFORM_FPS;
  const F = (s: number) => Math.max(0, Math.round(s * fps));
  const durationFrames = F(o.script.durationS + (o.tailS ?? 0.6));
  const { width, height } = ASPECT_DIMENSIONS[o.storyboard.aspect];
  const byShot = new Map<string, ResolvedMedia[]>();
  for (const m of o.resolution.media) (byShot.get(m.shotId) ?? byShot.set(m.shotId, []).get(m.shotId)!).push(m);

  const video: VideoLayer[] = [];
  const audio: AudioLayer[] = [];
  const allWords = o.script.segments.flatMap((sg) => sg.words);
  const log = o.log ?? (() => {});
  const spoken = spokenNumbers(allWords);
  const shots = [...o.storyboard.shots].sort((a, b) => a.startS - b.startS);
  const parityLog: string[] = [];
  const unfilled: string[] = [];
  const holes: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!;
    const start = F(s.startS);
    const end = i === shots.length - 1 ? durationFrames : Math.max(start + 1, F(s.endS));
    const len = end - start;
    const media = byShot.get(s.id) ?? [];
    const primary = media.find((m) => m.role === "primary");
    let designed = s.source.kind === "designed" ? s.source : null;
    const sceneSpec = designed?.designed === "scene" ? (o.scenes?.get(s.id) as { dim?: number } | undefined) : undefined;
    // A scene the designer left out plays as its footage (preflight sends a scene with neither back to its owner).
    if (designed?.designed === "scene" && !sceneSpec) designed = null;
    const paper = designed?.designed === "document" ? media.find((m) => m.role === "overlay" && m.kind === "image") : undefined;

    if (primary) {
      const cam = s.camera;
      const mode = cam.type === "parallax" || (primary.kind === "image" && primary.origin !== "stock" && !designed) ? "parallax_card" : "cover";
      // Archival entity photos carry a visible source citation badge on the 2.5D card.
      const citation = primary.origin === "archival" && primary.kind === "image" ? (primary.attributionText ?? `${primary.provider} — ${primary.license}`).slice(0, 140) : undefined;
      const kfs = [0, 0.5, 1].map((t) => {
        const c = cameraAt(cam.type === "parallax" ? { type: "ken_burns", fromScale: 1, toScale: 1.04, from: [0.5, 0.5], to: [0.5, 0.5], easing: "linear" } : cam, t);
        return { frame: Math.round(t * Math.max(0, len - 1)), scale: c.scale, x: Math.round(c.x * 1e4) / 1e4, y: Math.round(c.y * 1e4) / 1e4, opacity: 1 };
      });
      const layer: VideoLayer = {
        id: `${s.id}_v`,
        shotId: s.id,
        sourceKind: primary.origin,
        ref: primary.ref,
        src: primary.publicPath,
        startFrame: start,
        endFrame: end,
        // The editor may start a shot later inside its clip (a split shot's second half, a moved cut).
        trimStartFrame: primary.kind === "video" ? F(s.trimInS ?? 0) : 0,
        zIndex: 0,
        blend: "normal",
        keyframes: kfs,
        props: { kind: primary.kind, mode: citation && !designed ? "parallax_card" : mode, focus: s.focus ?? [0.5, 0.5], transitionIn: s.transitionIn, period: primary.origin === "archival", ...(citation ? { citation } : {}), ...(designed ? { dim: sceneSpec?.dim ?? 0.55 } : {}) },
      };
      video.push(layer);
    } else if (designed) {
      // No footage: the kit's stage carries the shot (a scene on a stage draws it itself; a data graphic sits on it).
      if (designed.designed !== "scene") video.push({ id: `${s.id}_stage`, shotId: s.id, sourceKind: "designed", ref: "stage", startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 0, blend: "normal", keyframes: [], props: { transitionIn: s.transitionIn } });
    } else (unfilled.push(s.id), holes.push({ start, end }));

    for (const ov of media.filter((m) => m.role === "overlay" && m !== paper)) {
      const spec = s.overlays.find((x) => x.assetId === ov.ref) ?? s.overlays[0];
      // a cover transition's overlay lasts only over the cut, on top of everything
      const cover = spec?.durS !== undefined;
      video.push({ id: `${s.id}_ov_${ov.ref}`, shotId: s.id, sourceKind: "library", ref: ov.ref, src: ov.publicPath, startFrame: start, endFrame: cover ? Math.min(end, start + Math.round(spec!.durS! * fps)) : end, trimStartFrame: 0, zIndex: cover ? 60 : 1, blend: "screen", keyframes: [], props: { kind: ov.kind, opacity: spec?.opacity ?? 0.5 } });
    }

    if (designed) {
      let props: Record<string, unknown> = { ...designed.props };
      delete props.background;
      // step 5: a cut the shot asks the film's own transition to bridge
      if (s.transitionIn === "film") props.transitionIn = "film";
      if (designed.designed === "map") {
        const pts = (Array.isArray(props.points) ? props.points : []) as MapPoint[];
        props = { title: props.title, route: props.route ?? true, ...(await projectMap(o.libraryRoot, pts)) };
      }
      if (paper) props.paperSrc = paper.publicPath;
      if (designed.designed === "scene") {
        // The kit's phrase: each word lands on the frame it is spoken (the element's props.sync, set by the scene designer).
        const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}$%€£.]/gu, "").replace(/\.$/, "");
        const pool = allWords.filter((w) => w.startS >= s.startS - 0.1 && w.startS < s.endS + 0.05);
        const spec = sceneSpec as unknown as { elements: Array<Record<string, unknown>> };
        // proof film (Blockbuster sh004): a picture removed after design left a paper world and a photo pointing at empty
        // slots — a blank frame with a small label. A slot with no picture is never drawn; a world without its picture is
        // a flat field (the gate's dangling_slot check sends the shot to be refilled with a real picture).
        const have = new Set(media.filter((m) => m.role === "layer").map((m) => m.slot ?? 0));
        const wd = (spec as { world?: { kind: string; slot?: number; slots?: number[] } }).world;
        const worldFix = wd && wd.slot !== undefined && !have.has(wd.slot) ? { ...wd, kind: wd.kind === "collage" && (wd.slots ?? []).some((x) => have.has(x)) ? "collage" : "flat_field", slot: (wd.slots ?? []).find((x) => have.has(x)), slots: (wd.slots ?? []).filter((x) => have.has(x)) } : null;
        const elements = spec.elements.filter((el) => !("slot" in el) || typeof (el as { slot?: unknown }).slot !== "number" || have.has((el as { slot: number }).slot)).map((el) => {
          const pr = el.props as Record<string, unknown> | undefined;
          if (el.type !== "component" || !pr?.sync) return el;
          const shown = String(pr.text ?? "").split(/\s+/).filter(Boolean);
          const want = shown.map(norm);
          const at = pool.findIndex((_, k) => want.every((wd, j) => norm(pool[k + j]?.word ?? "") === wd));
          const elStart = start + F(Number(el.at ?? 0));
          const words = shown.map((text, j) => ({ text, from: at >= 0 ? Math.max(0, F(pool[at + j]!.startS) - elStart) : Math.round(j * fps * 0.22) }));
          return { ...el, props: { ...pr, words } };
        });
        // never a black frame: a footage scene whose footage is gone falls back to the kit's stage (build list 4)
        const noFootage = ((spec as { backdrop?: string }).backdrop ?? "footage") === "footage" && !media.some((m) => m.role === "primary");
        props = { spec: { ...spec, ...(noFootage ? { backdrop: "stage" } : {}), ...(worldFix ? { world: worldFix } : {}), elements }, slots: Object.fromEntries(media.filter((m) => m.role === "layer").map((m) => [String(m.slot ?? 0), m.publicPath])) };
      }
      if (s.factIds?.length) props.factIds = s.factIds;
      const win: [number, number] = [s.startS - 1.5, s.endS + 1.0];
      let keep = true;
      if (designed.designed === "chart" && Array.isArray(props.values)) {
        const unit = String(props.unit ?? "");
        // Number parity: the figure on screen is the figure spoken, at the spoken precision.
        props.display = (props.values as number[]).map((v) => {
          const hit = spokenMatch(spoken, v, unit, win[0], win[1], s.startS);
          return hit ? displayOf(hit) : compactOf(v, unit);
        });
      }
      // Document: marker sweep synced to the words of the highlighted phrase.
      if (designed.designed === "document" && typeof props.highlight === "string") {
        const phrase = props.highlight.split(/\s+/).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
        const pool = allWords.map((w, k) => ({ w, k })).filter(({ w }) => w.startS >= s.startS - 0.5 && w.startS <= s.endS + 0.5);
        const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        const first = pool.find(({ k }) => phrase.length > 0 && phrase.every((p, j) => norm(allWords[k + j]?.word ?? "") === p));
        if (first) {
          props.highlightFrom = Math.max(2, F(first.w.startS) - start);
          props.highlightTo = Math.max(Number(props.highlightFrom) + 6, F(allWords[first.k + phrase.length - 1]!.endS) - start);
        }
      }
      video.push({ id: `${s.id}_d`, shotId: s.id, sourceKind: "designed", ref: designed.designed, startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 2, blend: "normal", keyframes: [], props });
    }

    for (const fx of s.sfx) {
      const m = media.find((x) => x.role === "sfx" && x.ref === fx.assetId);
      if (!m) continue;
      const at = F(fx.atS);
      const sfxEnd = Math.min(durationFrames, at + F(m.durationS ?? 2));
      if (sfxEnd > at) audio.push({ id: `${s.id}_sfx_${m.ref}_${at}`, role: "sfx", ref: m.ref, src: m.localPath, startFrame: at, endFrame: sfxEnd, trimStartFrame: 0, gainDb: fx.gainDb, fadeInFrames: 0, fadeOutFrames: 2 });
    }
  }

  // Long-form chapter openers (TitleRoll): a 2.4 s serif roll at each chapter start after the first.
  {
    let idx = 1;
    let prev: string | undefined;
    for (const sg of o.script.segments) {
      if (!sg.chapter || sg.chapter === prev) continue;
      if (prev !== undefined && o.script.durationS > 90) {
        idx++;
        const at = F(sg.words[0]?.startS ?? sg.startS);
        video.push({ id: `chapter_${idx}`, shotId: shots.find((x) => F(x.startS) <= at && F(x.endS) > at)?.id ?? "all", sourceKind: "designed", ref: "chapter", startFrame: Math.max(0, at - 6), endFrame: Math.min(durationFrames, at - 6 + F(CHAPTER_CARD_S)), trimStartFrame: 0, zIndex: 5, blend: "normal", keyframes: [], props: { title: sg.chapter, index: idx } });
      }
      prev = sg.chapter;
    }
  }
  if (parityLog.length) log(`  manifest: number parity — ${parityLog.join("; ")}`);
  // proof film (WeWork: five shots with neither footage nor a scene rendered black): a hole is never black — the shot
  // before it holds over it (or the one after it starts early); the gate still sends the shot back to be filled.
  for (const h of holes.sort((a, b) => a.start - b.start)) {
    const prev = video.filter((l) => l.zIndex === 0 && l.endFrame === h.start).at(-1);
    if (prev) prev.endFrame = h.end;
    else {
      const next = video.find((l) => l.zIndex === 0 && l.startFrame === h.end);
      if (next) next.startFrame = h.start;
    }
  }
  if (unfilled.length) log(`  manifest: UNFILLED — ${unfilled.join(", ")} have neither footage nor a scene (preflight sends them back)`);

  // Word-synced captions on top — suppressed while the kit's chapter card is on screen (no duplicate text).
  const kinetic = video.filter((l) => l.sourceKind === "designed" && FULLSCREEN_TEXT.has(l.ref));
  const allGroups = captionGroups(o.script);
  const overlapFrac = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1, a1 - a0);
  // Mostly under a card → hidden; partly under → held back until the card ends (never on screen together).
  type G = (typeof allGroups)[number] & { holdFrom?: number };
  const groups: G[] = [];
  for (const g of allGroups) {
    const hits = kinetic.filter((k) => overlapFrac(F(g.startS), F(g.endS), k.startFrame, k.endFrame) > 0);
    if (hits.some((k) => overlapFrac(F(g.startS), F(g.endS), k.startFrame, k.endFrame) >= 0.34)) continue;
    const holdFrom = hits.length ? Math.max(...hits.map((k) => k.endFrame)) : undefined;
    if (holdFrom !== undefined && holdFrom >= F(g.endS) - 2) continue;
    groups.push(holdFrom !== undefined && holdFrom > F(g.startS) ? { ...g, holdFrom } : g);
  }
  if (o.burnCaptions !== false) video.push({
    id: "captions",
    shotId: "all",
    sourceKind: "designed",
    ref: "captions",
    startFrame: 0,
    endFrame: durationFrames,
    trimStartFrame: 0,
    zIndex: 60,
    blend: "normal",
    keyframes: [],
    props: { groups: groups.map((g) => ({ startFrame: g.holdFrom ?? F(g.startS), endFrame: F(g.endS), words: g.words.map((w) => ({ text: w.text, startFrame: F(w.startS), endFrame: F(w.endS) })) })) },
  });

  audio.push({ id: "narration", role: "narration", ref: o.script.id, src: o.narrationPath, startFrame: 0, endFrame: Math.min(durationFrames, F(o.script.durationS) + 1), trimStartFrame: 0, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 });
  o.storyboard.music.forEach((m, k, arr) => {
    const r = o.resolution.media.find((x) => x.role === "music" && x.ref === m.assetId);
    if (!r) return;
    const startFrame = k === 0 ? 0 : Math.max(0, F(m.startS) - F(0.75)); // 1.5 s crossfade around cue changes
    const endFrame = k === arr.length - 1 ? durationFrames : Math.min(durationFrames, F(m.endS) + F(0.75));
    audio.push({ id: `music_${k}_${m.assetId}`, role: "music", ref: m.assetId, src: r.localPath, startFrame, endFrame, trimStartFrame: F(m.inS ?? 0), gainDb: m.gainDb, duckUnderNarrationDb: -14, fadeInFrames: k === 0 ? F(0.4) : F(1.5), fadeOutFrames: k === arr.length - 1 ? F(1.2) : F(1.5), dips: (m.drops ?? []).map((d) => ({ fromFrame: F(d.startS), toFrame: F(d.endS), gainDb: -36 })) });
  });

  const seen = new Set<string>();
  const credits = o.resolution.media
    .filter((m) => (seen.has(m.ref) ? false : (seen.add(m.ref), true)))
    .map((m) => ({ ref: m.ref, text: m.attributionText ?? `${m.provider} ${m.ref}`, license: m.license, ...(m.sourceUrl ? { url: m.sourceUrl } : {}) }));

  // Step 5: every layer of a shot that asks for the film's own transition carries the mark (scene layers rebuild their
  // props, so the mark is set once the timeline is complete).
  for (const sh of o.storyboard.shots) if (sh.transitionIn === "film") for (const l of video) if (l.shotId === sh.id) l.props = { ...(l.props ?? {}), transitionIn: "film" };
  return RenderManifest.parse({
    schemaVersion: 1,
    id: `rm_${o.storyboard.id.slice(3)}_${o.storyboard.aspect.replace(":", "x")}`,
    scriptId: o.script.id,
    aspect: o.storyboard.aspect,
    width,
    height,
    fps,
    durationFrames,
    video: video.map((l) => ({ ...l, endFrame: Math.min(l.endFrame, durationFrames) })).filter((l) => l.endFrame > l.startFrame),
    audio,
    // The manifest's caption track (→ SRT) keeps every word for accessibility; only the burned-in layer is suppressed.
    captions: allGroups.map((g) => ({ startFrame: F(g.startS), endFrame: F(g.endS), text: g.words.map((w) => w.text).join(" ") })),
    loudnessTargetLufs: -12.5,
    output: { path: o.outputPath, codec: "h264", crf: 18 },
    credits,
    generatedAt: new Date().toISOString(),
  });
}
