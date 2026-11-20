import { ASPECT_DIMENSIONS, RenderManifest, type ResolutionReport, type ResolvedMedia, type Storyboard, type TimedScript } from "@opumia/contracts";
import { captionGroups } from "./captions.js";
import { cameraAt } from "./motion.js";
import { projectMap, type MapPoint } from "./map.js";
import { compactOf, displayOf, parseShown, spokenMatch, spokenNumbers } from "./parity.js";
import { composeScenes } from "./compose.js";

type VideoLayer = RenderManifest["video"][number];

/** Full-screen text cards: burned-in captions are suppressed while one is visible. */
export const FULLSCREEN_TEXT = new Set(["big_word", "quote_card", "chapter_card"]);
/** Designed layouts with their own text in the lower frame: burned-in captions are hidden under them too. */
export const CAPTION_HIDE = new Set(["hero_face", "cutout_collage", "versus"]);
/** Full-screen kinetic cards are held at most this long; the shot continues on its plate. */
export const CARD_MAX_S = 3.2;
/** Chapter title roll length (long-form chapter openers). */
export const CHAPTER_CARD_S = 2.4;
type AudioLayer = Omit<RenderManifest["audio"][number], "dips"> & Partial<Pick<RenderManifest["audio"][number], "dips">>;

export interface BuildManifestOptions {
  storyboard: Storyboard;
  script: TimedScript;
  resolution: ResolutionReport;
  libraryRoot: string;
  outputPath: string;
  narrationPath: string;
  fps?: 30;
  tailS?: number;
  log?: (s: string) => void;
  /** Scene grammar: minimum seconds before a designed layout may repeat (FilmDesignSystem.sceneGrammar). */
  minRepeatGapS?: number;
  /** Burn word captions into the picture (style pack caption policy; shorts always). The SRT keeps every word either way. */
  burnCaptions?: boolean;
  /** Composed scene specs from the scene designer (designed kind "scene"). */
  scenes?: Map<string, unknown>;
}

/** Storyboard + TimedScript + resolved media → frame-exact RenderManifest (validated). */
export async function buildManifest(o: BuildManifestOptions): Promise<RenderManifest> {
  const fps = o.fps ?? 30;
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
  // Asset-aware composition + scene grammar before any layer is built.
  const composed = composeScenes({ shots: [...o.storyboard.shots].sort((a, b) => a.startS - b.startS), byShot, spoken, minRepeatGapS: o.minRepeatGapS ?? 45 });
  if (composed.notes.length) log(`  composer: ${composed.notes.length} layout change(s) — ${composed.notes.slice(0, 6).join("; ")}${composed.notes.length > 6 ? "; …" : ""}`);
  const shots = composed.shots;
  const parityLog: string[] = [];
  // Nearest approved footage plate (video preferred) for shots that have none of their own.
  const plateNear = (i: number) => {
    for (let d = 1; d < shots.length; d++) {
      for (const j of [i - d, i + d]) {
        const sh = shots[j];
        if (!sh) continue;
        const m = (byShot.get(sh.id) ?? []).find((x) => x.role === "primary" && x.kind === "video");
        if (m) return m;
      }
    }
    return undefined;
  };

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!;
    const start = F(s.startS);
    const end = i === shots.length - 1 ? durationFrames : Math.max(start + 1, F(s.endS));
    const len = end - start;
    const media = byShot.get(s.id) ?? [];
    const primary = media.find((m) => m.role === "primary");
    let designed = s.source.kind === "designed" ? s.source : null;
    const sceneSpec = designed?.designed === "scene" ? (o.scenes?.get(s.id) as { dim?: number } | undefined) : undefined;
    // A scene the designer could not compose (nothing focal resolved) plays as its footage.
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
        trimStartFrame: 0,
        zIndex: 0,
        blend: "normal",
        keyframes: kfs,
        props: { kind: primary.kind, mode: citation && !designed ? "parallax_card" : mode, focus: s.focus ?? [0.5, 0.5], transitionIn: s.transitionIn, period: primary.origin === "archival", ...(citation ? { citation } : {}), ...(designed && designed.designed !== "name_label" ? { dim: sceneSpec?.dim ?? 0.55 } : {}) },
      };
      video.push(layer);
    } else if (designed && designed.designed !== "map" && designed.designed !== "versus") {
      // Multi-layer stack: every designed scene sits on an atmospheric base — a borrowed approved plate (blurred,
      // darkened) or, for lines naming a person (no stand-in faces), the procedural atmosphere.
      const plate = plateNear(i);
      if (plate) {
        const c0 = cameraAt({ type: "ken_burns", fromScale: 1.18, toScale: 1.28, from: [0.45, 0.5], to: [0.55, 0.5], easing: "linear" }, 0);
        const c1 = cameraAt({ type: "ken_burns", fromScale: 1.18, toScale: 1.28, from: [0.45, 0.5], to: [0.55, 0.5], easing: "linear" }, 1);
        video.push({ id: `${s.id}_plate`, shotId: s.id, sourceKind: plate.origin, ref: plate.ref, src: plate.publicPath, startFrame: start, endFrame: end, trimStartFrame: Math.round(fps * 1.5), zIndex: 0, blend: "normal", keyframes: [{ frame: 0, scale: c0.scale, x: c0.x, y: c0.y, opacity: 1 }, { frame: Math.max(1, len - 1), scale: c1.scale, x: c1.x, y: c1.y, opacity: 1 }], props: { kind: plate.kind, mode: "cover", focus: [0.5, 0.5], transitionIn: s.transitionIn, ...(designed.designed !== "name_label" ? { dim: 0.6 } : {}) } });
      } else video.push({ id: `${s.id}_atmo`, shotId: s.id, sourceKind: "designed", ref: "atmosphere", startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 0, blend: "normal", keyframes: [], props: {} });
    } else if (!designed && (() => {
      // No footage passed review: first reuse a picture already approved for the same narration segment
      // (different in-point and camera move), so the image stays on-topic. Lines that name a person go
      // straight to kinetic type instead, so no stand-in picture can be read as that person.
      const sib = shots.find((x) => x.id !== s.id && x.scriptSegmentId === s.scriptSegmentId && (byShot.get(x.id) ?? []).some((m) => m.role === "primary" && m.kind === "video") && x.source.kind !== "designed");
      const m = sib ? (byShot.get(sib.id) ?? []).find((x) => x.role === "primary")! : undefined;
      if (!m) return false;
      const c0 = cameraAt({ type: "ken_burns", fromScale: 1.25, toScale: 1.12, from: [0.4, 0.5], to: [0.6, 0.5], easing: "ease_in_out" }, 0);
      const c1 = cameraAt({ type: "ken_burns", fromScale: 1.25, toScale: 1.12, from: [0.4, 0.5], to: [0.6, 0.5], easing: "ease_in_out" }, 1);
      video.push({ id: `${s.id}_v`, shotId: s.id, sourceKind: m.origin, ref: m.ref, src: m.publicPath, startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 0, blend: "normal", keyframes: [{ frame: 0, scale: c0.scale, x: c0.x, y: c0.y, opacity: 1 }, { frame: Math.max(1, len - 1), scale: c1.scale, x: c1.x, y: c1.y, opacity: 1 }], props: { kind: m.kind, mode: "cover", focus: [0.5, 0.5], transitionIn: s.transitionIn } });
      return true;
    })()) {
      /* reused an approved sibling shot */
    } else if (!designed) {
      // Last resort: a kinetic stamp — a year/number, else a 1–2 word name from the line. Captions are
      // suppressed while it is on screen, so the card never repeats the subtitle.
      const spoken = allWords.filter((w) => w.startS >= s.startS - 0.05 && w.startS < s.endS).map((w) => w.word.replace(/[^\p{L}\p{N}$%.,'-]/gu, "").replace(/[.,]$/, "")).filter(Boolean);
      const num = spoken.find((w) => /\d/.test(w));
      const caps = spoken.filter((w, k) => k > 0 && /^[A-Z]/.test(w));
      const text = num ?? (caps.length ? caps.slice(0, 2).join(" ") : (s.chapter ?? s.intent).split(/\s+/).slice(0, 2).join(" "));
      // No approved footage: borrow the nearest approved plate with its own camera move. A kinetic stamp is
      // used only when the film has no footage at all (never a repeated closing stamp).
      const kp = plateNear(i);
      if (kp) video.push({ id: `${s.id}_plate`, shotId: s.id, sourceKind: kp.origin, ref: kp.ref, src: kp.publicPath, startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 0, blend: "normal", keyframes: [{ frame: 0, scale: 1.22, x: -0.02, y: 0, opacity: 1 }, { frame: Math.max(1, len - 1), scale: 1.1, x: 0.02, y: 0, opacity: 1 }], props: { kind: kp.kind, mode: "cover", focus: [0.5, 0.5], transitionIn: s.transitionIn } });
      else {
        video.push({ id: `${s.id}_atmo`, shotId: s.id, sourceKind: "designed", ref: "atmosphere", startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 0, blend: "normal", keyframes: [], props: {} });
        video.push({ id: `${s.id}_kt`, shotId: s.id, sourceKind: "designed", ref: "big_word", startFrame: start, endFrame: Math.min(end, start + F(CARD_MAX_S)), trimStartFrame: 0, zIndex: 2, blend: "normal", keyframes: [], props: { text } });
      }
    }

    for (const ov of media.filter((m) => m.role === "overlay" && m !== paper)) {
      video.push({ id: `${s.id}_ov_${ov.ref}`, shotId: s.id, sourceKind: "library", ref: ov.ref, src: ov.publicPath, startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 1, blend: "screen", keyframes: [], props: { kind: ov.kind, opacity: s.overlays[0]?.opacity ?? 0.5 } });
    }

    if (designed) {
      let props: Record<string, unknown> = { ...designed.props };
      delete props.background;
      if (designed.designed === "map") {
        const pts = (Array.isArray(props.points) ? props.points : []) as MapPoint[];
        props = { title: props.title, route: props.route ?? true, ...(await projectMap(o.libraryRoot, pts)) };
      }
      if (paper) props.paperSrc = paper.publicPath;
      // Signature primitives take the shot's own picture: portrait for HeroFaceSplit, subject for CutoutCollage.
      if (designed.designed === "hero_face" && primary?.kind === "image") props.portraitSrc = primary.publicPath;
      if (designed.designed === "cutout_collage" && primary) props.subjectSrc = primary.publicPath;
      if (designed.designed === "scene") props = { spec: sceneSpec, slots: Object.fromEntries(media.filter((m) => m.role === "layer").map((m) => [String(m.slot ?? 0), m.publicPath])) };
      if (s.factIds?.length) props.factIds = s.factIds;
      const win: [number, number] = [s.startS - 1.5, s.endS + 1.0];
      let keep = true;
      // Number parity: the figure on screen is the figure spoken, at the spoken precision.
      if (designed.designed === "money_figure") {
        const unit = props.prefix ? String(props.prefix) : props.suffix === "%" ? "%" : "";
        const hit = spokenMatch(spoken, Number(props.value), unit, win[0], win[1], s.startS);
        if (hit) props.display = displayOf(hit);
        else {
          keep = false;
          parityLog.push(`${s.id}: money_figure ${compactOf(Number(props.value), unit)} not spoken in its shot → dropped (plate only)`);
        }
      }
      if (designed.designed === "versus") {
        for (const k of ["left", "right"] as const) {
          const side = props[k] as { label?: string; value?: string } | undefined;
          const v = side?.value ? parseShown(side.value) : null;
          if (!side || !v) continue;
          const hit = spokenMatch(spoken, v.value, v.unit, win[0], win[1], s.startS);
          props[k] = { ...side, value: hit ? displayOf(hit) : compactOf(v.value, v.unit), magnitude: v.value };
        }
      }
      if (designed.designed === "chart" && Array.isArray(props.values)) {
        const unit = String(props.unit ?? "");
        props.displays = (props.values as number[]).map((v) => {
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
          props.highlightAt = Math.max(2, F(first.w.startS) - start);
          props.highlightEnd = Math.max(Number(props.highlightAt) + 6, F(allWords[first.k + phrase.length - 1]!.endS) - start);
        }
      }
      // Full-screen kinetic cards are held ≤ 2.0 s; the plate carries the rest of the shot.
      const endD = FULLSCREEN_TEXT.has(designed.designed) ? Math.min(end, start + F(CARD_MAX_S)) : end;
      if (endD < end) for (const l of video) if (l.shotId === s.id && l.zIndex === 0) l.props = { ...l.props, dimUntil: endD - start };
      if (keep) video.push({ id: `${s.id}_d`, shotId: s.id, sourceKind: "designed", ref: designed.designed, startFrame: start, endFrame: endD, trimStartFrame: 0, zIndex: 2, blend: "normal", keyframes: [], props });
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
        video.push({ id: `chapter_${idx}`, shotId: shots.find((x) => F(x.startS) <= at && F(x.endS) > at)?.id ?? "all", sourceKind: "designed", ref: "chapter_card", startFrame: Math.max(0, at - 6), endFrame: Math.min(durationFrames, at - 6 + F(CHAPTER_CARD_S)), trimStartFrame: 0, zIndex: 5, blend: "normal", keyframes: [], props: { title: sg.chapter, index: idx, teaser: `Chapter ${idx}` } });
      }
      prev = sg.chapter;
    }
  }
  if (parityLog.length) log(`  manifest: number parity — ${parityLog.join("; ")}`);

  // Word-synced captions on top — suppressed while a full-screen kinetic card is on screen (no duplicate text).
  // Burned-in captions never overlap designed text: hidden under slams/chapter rolls and under layouts that carry
  // their own lower-frame text (HeroFaceSplit name panel, CutoutCollage title, Versus scale bar).
  const kinetic = video.filter((l) => l.sourceKind === "designed" && (FULLSCREEN_TEXT.has(l.ref) || CAPTION_HIDE.has(l.ref)));
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
    audio.push({ id: `music_${k}_${m.assetId}`, role: "music", ref: m.assetId, src: r.localPath, startFrame, endFrame, trimStartFrame: 0, gainDb: m.gainDb, duckUnderNarrationDb: -8, fadeInFrames: k === 0 ? F(0.4) : F(1.5), fadeOutFrames: k === arr.length - 1 ? F(1.2) : F(1.5), dips: (m.drops ?? []).map((d) => ({ fromFrame: F(d.startS), toFrame: F(d.endS), gainDb: -36 })) });
  });

  const seen = new Set<string>();
  const credits = o.resolution.media
    .filter((m) => (seen.has(m.ref) ? false : (seen.add(m.ref), true)))
    .map((m) => ({ ref: m.ref, text: m.attributionText ?? `${m.provider} ${m.ref}`, license: m.license, ...(m.sourceUrl ? { url: m.sourceUrl } : {}) }));

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
