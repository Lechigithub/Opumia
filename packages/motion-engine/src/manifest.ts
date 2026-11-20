import { ASPECT_DIMENSIONS, RenderManifest, type ResolutionReport, type ResolvedMedia, type Storyboard, type TimedScript } from "@opumia/contracts";
import { captionGroups } from "./captions.js";
import { cameraAt } from "./motion.js";
import { projectMap, type MapPoint } from "./map.js";

type VideoLayer = RenderManifest["video"][number];
type AudioLayer = RenderManifest["audio"][number];

export interface BuildManifestOptions {
  storyboard: Storyboard;
  script: TimedScript;
  resolution: ResolutionReport;
  libraryRoot: string;
  outputPath: string;
  narrationPath: string;
  fps?: 30;
  tailS?: number;
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
  const shots = [...o.storyboard.shots].sort((a, b) => a.startS - b.startS);
  const allWords = o.script.segments.flatMap((sg) => sg.words);
  // Two consecutive capitalised words mid-sentence (e.g. "Ken Lay") → the line names a person or organisation.
  const namesPerson = (sh: (typeof shots)[number]) => /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(allWords.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" "));

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!;
    const start = F(s.startS);
    const end = i === shots.length - 1 ? durationFrames : Math.max(start + 1, F(s.endS));
    const len = end - start;
    const media = byShot.get(s.id) ?? [];
    const primary = media.find((m) => m.role === "primary");
    const designed = s.source.kind === "designed" ? s.source : null;
    const paper = designed?.designed === "document" ? media.find((m) => m.role === "overlay" && m.kind === "image") : undefined;

    if (primary) {
      const cam = s.camera;
      const mode = cam.type === "parallax" || (primary.kind === "image" && primary.origin !== "stock" && !designed) ? "parallax_card" : "cover";
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
        props: { kind: primary.kind, mode, focus: s.focus ?? [0.5, 0.5], transitionIn: s.transitionIn, period: primary.origin === "archival", ...(designed && designed.designed !== "name_label" ? { dim: 0.55 } : {}) },
      };
      video.push(layer);
    } else if (!designed && !namesPerson(s) && (() => {
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
      // Last resort: show the spoken key phrase as kinetic type — always on-topic, never misleading.
      const spoken = o.script.segments.flatMap((sg) => sg.words).filter((w) => w.startS >= s.startS - 0.05 && w.startS < s.endS).map((w) => w.word.replace(/[^\p{L}\p{N}$%'-]/gu, "")).filter(Boolean);
      const caps = spoken.filter((w) => /^[A-Z$0-9]/.test(w));
      const text = (caps.length >= 2 ? caps : spoken).slice(-3).join(" ") || s.intent.split(/\s+/).slice(0, 3).join(" ");
      video.push({ id: `${s.id}_kt`, shotId: s.id, sourceKind: "designed", ref: "big_word", startFrame: start, endFrame: end, trimStartFrame: 0, zIndex: 2, blend: "normal", keyframes: [], props: { text } });
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

  // Word-synced captions on top.
  const groups = captionGroups(o.script);
  video.push({
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
    props: { groups: groups.map((g) => ({ startFrame: F(g.startS), endFrame: F(g.endS), words: g.words.map((w) => ({ text: w.text, startFrame: F(w.startS), endFrame: F(w.endS) })) })) },
  });

  audio.push({ id: "narration", role: "narration", ref: o.script.id, src: o.narrationPath, startFrame: 0, endFrame: Math.min(durationFrames, F(o.script.durationS) + 1), trimStartFrame: 0, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 });
  for (const m of o.storyboard.music) {
    const r = o.resolution.media.find((x) => x.role === "music" && x.ref === m.assetId);
    if (r) audio.push({ id: `music_${m.assetId}`, role: "music", ref: m.assetId, src: r.localPath, startFrame: 0, endFrame: durationFrames, trimStartFrame: 0, gainDb: m.gainDb, duckUnderNarrationDb: -10, fadeInFrames: F(0.4), fadeOutFrames: F(1.2) });
  }

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
    captions: groups.map((g) => ({ startFrame: F(g.startS), endFrame: F(g.endS), text: g.words.map((w) => w.text).join(" ") })),
    loudnessTargetLufs: -14,
    output: { path: o.outputPath, codec: "h264", crf: 18 },
    credits,
    generatedAt: new Date().toISOString(),
  });
}
