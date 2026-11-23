import React from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { FILM } from "@film";
import { Captions } from "./scenes/Captions";
import { CameraPush, FilmGrain, Vignette } from "./scenes/Cinema";
import { ComposedScene, KitStage, roleComponent, type ComposedProps } from "./scenes/Composed";
import { MediaLayer, OverlayLayer } from "./scenes/Media";
import { applyDesign, setFilmFonts, TEXTURE, type CaptionGroup, type DesignTokens, type DocProps, type Layer } from "./types";

/**
 * One film's timeline. Footage and real pictures come from the manifest; everything designed is drawn by the film's own
 * kit (build list 3): scenes through its components, the stage behind shots without footage, chapter cards, and the
 * chart, map and document data graphics (the engine passes them verified data, the kit draws them).
 */
const KitRole: React.FC<{ role: string; props: Record<string, unknown> }> = ({ role, props }) => {
  const { width, height } = useVideoConfig();
  const C = roleComponent(role);
  return C ? <C {...props} slots={{}} boxW={width} boxH={height} /> : null;
};

const Designed: React.FC<{ layer: Layer; accent: string }> = ({ layer, accent }) => {
  const p = (layer.props ?? {}) as Record<string, unknown>;
  switch (layer.ref) {
    case "scene":
      return <ComposedScene {...(p as unknown as ComposedProps)} accent={accent} />;
    case "stage":
      return <KitStage />;
    case "chart":
    case "map":
    case "document":
    case "chapter":
      return <KitRole role={layer.ref} props={p} />;
    case "captions":
      return <Captions groups={(p.groups ?? []) as CaptionGroup[]} accent={accent} />;
    default:
      return null;
  }
};

/** Grade + texture over the whole frame from the film's design tokens: the current act's tint, grain, vignette. */
const Grade: React.FC<{ act?: DesignTokens["acts"][number] }> = ({ act }) => (
  <>
    {act && act.tintStrength > 0 ? <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "soft-light", background: act.tint, opacity: Math.min(0.5, act.tintStrength * 1.2) }} /> : null}
    <Vignette strength={Math.min(0.45, TEXTURE.vignette * 0.6)} />
    <FilmGrain opacity={TEXTURE.grain} />
  </>
);

const TransitionAt: React.FC<{ span: number; T: React.FC<{ progress: number }> }> = ({ span, T }) => {
  const f = useCurrentFrame();
  return <T progress={Math.max(0, Math.min(1, f / Math.max(1, span - 1)))} />;
};

/** Layers that are not pushed by the engine's camera (they move themselves or are the frame). */
const STILL_CAMERA = new Set(["captions", "chapter", "scene", "stage"]);

export const Documentary: React.FC<DocProps> = ({ manifest, look, design }) => {
  applyDesign(design);
  setFilmFonts(FILM.fonts);
  const frame = useCurrentFrame();
  // Act boundaries = chapter cards (long-form); one act for shorts.
  const actStarts = [0, ...manifest.video.filter((l) => l.ref === "chapter").map((l) => l.startFrame).sort((a, b) => a - b)];
  const actIdx = Math.max(0, actStarts.filter((f) => f <= frame).length - 1);
  const acts = design?.acts ?? [];
  const act = acts.length ? acts[Math.min(actIdx, acts.length - 1)] : undefined;
  // Grade crossfades 12 frames into each new act.
  const blend = actIdx > 0 ? interpolate(frame, [actStarts[actIdx]!, actStarts[actIdx]! + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const satRaw = act ? act.saturation * blend + (acts[Math.max(0, Math.min(actIdx - 1, acts.length - 1))]?.saturation ?? act.saturation) * (1 - blend) : look.saturate;
  // Never desaturate below natural: the reference is 1.5-2x more colourful than a neutral grade.
  const sat = Math.max(1.05, satRaw + 0.15);
  const con = act ? act.contrast : Math.max(look.contrast, 1.12);
  // build list 5, item 28: the act's exposure (the colourist's), crossfaded between acts like saturation
  const brOf = (x?: { brightness?: number }) => Math.max(0.7, Math.min(1.4, x?.brightness ?? 1));
  const bri = act ? brOf(act) * blend + brOf(acts[Math.max(0, Math.min(actIdx - 1, acts.length - 1))] ?? act) * (1 - blend) : 1;
  const layers = [...manifest.video].sort((a, b) => a.zIndex - b.zIndex || a.startFrame - b.startFrame);
  const below = layers.filter((l) => l.zIndex < 50);
  const above = layers.filter((l) => l.zIndex >= 50);
  const designed = (l: Layer) =>
    STILL_CAMERA.has(l.ref) ? (
      <Designed layer={l} accent={look.accent} />
    ) : (
      <CameraPush to={l.ref === "map" ? 1.0 : 1.04}>
        <Designed layer={l} accent={look.accent} />
      </CameraPush>
    );
  const render = (l: Layer) => (
    <Sequence key={l.id} from={l.startFrame} durationInFrames={l.endFrame - l.startFrame} layout="absolute-fill">
      {l.sourceKind === "designed" ? designed(l) : l.blend !== "normal" ? <OverlayLayer layer={l} /> : <MediaLayer layer={l} />}
    </Sequence>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <AbsoluteFill style={{ filter: `saturate(${sat.toFixed(3)}) contrast(${Math.min(con, 1.14).toFixed(3)}) brightness(${bri.toFixed(3)})` }}>{below.map(render)}</AbsoluteFill>
      <Grade {...(act ? { act } : {})} />
      {above.map(render)}
      {/* The film's own transition across every cut a shot asks to bridge ("film"), centred on the cut. */}
      {(() => {
        const T = FILM.transitions[FILM.transition ?? ""];
        if (!T) return null;
        const span = FILM.transitionFrames ?? 10;
        const cuts = [...new Set(manifest.video.filter((l) => (l.props as { transitionIn?: string } | undefined)?.transitionIn === "film" && l.startFrame > 0).map((l) => l.startFrame))];
        return cuts.map((c) => (
          <Sequence key={`tr${c}`} from={Math.max(0, c - Math.floor(span / 2))} durationInFrames={span} layout="absolute-fill">
            <TransitionAt span={span} T={T} />
          </Sequence>
        ));
      })()}
    </AbsoluteFill>
  );
};
