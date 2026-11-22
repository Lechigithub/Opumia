import React from "react";
import { AbsoluteFill, Sequence, staticFile, Img } from "remotion";
import { Captions } from "./scenes/Captions";
import { AnimatedChart } from "./scenes/Chart";
import { DocumentScene } from "./scenes/Document";
import { BigWord, NameLabel, QuoteCard, Timeline } from "./scenes/Kinetic";
import { Versus } from "./scenes/Versus";
import { ComposedScene, type ComposedProps } from "./scenes/Composed";
import { CutoutCollage, HeroFaceSplit, ScreenMock, SharpOverlayCounter, TitleRollChapter } from "./scenes/Signature";
import { AccentLight, Atmosphere, CameraPush, FilmGrain, Vignette } from "./scenes/Cinema";
import { applyDesign, PALETTE, TEXTURE, type DesignTokens } from "./types";
import { interpolate, useCurrentFrame } from "remotion";
import { MapRoute, type MapProps } from "./scenes/MapRoute";
import { MediaLayer, OverlayLayer } from "./scenes/Media";
import type { CaptionGroup, DocProps, Layer } from "./types";
import { FILM } from "@film";

const Designed: React.FC<{ layer: Layer; accent: string }> = ({ layer, accent }) => {
  const p = (layer.props ?? {}) as Record<string, unknown>;
  switch (layer.ref) {
    case "chart":
      return <AnimatedChart {...(p as object)} accent={accent} />;
    case "map":
      return <MapRoute {...(p as unknown as MapProps)} accent={accent} />;
    case "document":
      return <DocumentScene {...(p as object)} accent={accent} />;
    case "big_word":
      return <BigWord {...(p as object)} accent={accent} />;
    case "money_figure":
      // Reference Counter technique: a gold tally straight over the sharp footage (no card, no blur).
      return <SharpOverlayCounter {...(p as object)} accent={accent} />;
    case "hero_face":
      return <HeroFaceSplit {...(p as object)} accent={accent} />;
    case "cutout_collage":
      return <CutoutCollage {...(p as object)} accent={accent} />;
    case "chapter_card":
      return <TitleRollChapter {...(p as object)} accent={accent} />;
    case "screen":
      return <ScreenMock {...(p as object)} accent={accent} />;
    case "versus":
      return <Versus {...(p as object)} accent={accent} />;
    case "timeline":
      return <Timeline {...(p as object)} accent={accent} />;
    case "quote_card":
      return <QuoteCard {...(p as object)} accent={accent} />;
    case "name_label":
      return <NameLabel {...(p as object)} accent={accent} />;
    case "scene":
      return <ComposedScene {...(p as unknown as ComposedProps)} accent={accent} />;
    case "captions":
      return <Captions groups={(p.groups ?? []) as CaptionGroup[]} accent={accent} />;
    default:
      return null;
  }
};

/** Grade + texture over the whole frame: animated film grain, breathing vignette, faint warm/crimson light. */
/**
 * Grade + texture over the whole frame, from the film's design system: the current act's tint (soft-light) and
 * strengths, animated grain, breathing vignette, faint accent light.
 */
const Grade: React.FC<{ act?: DesignTokens["acts"][number] }> = ({ act }) => (
  <>
    {act && act.tintStrength > 0 ? <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "soft-light", background: act.tint, opacity: Math.min(0.5, act.tintStrength * 1.2) }} /> : null}
    <AccentLight color={PALETTE.crimsonDeep} at={[0.12, 0.85]} intensity={0.12} />
    <Vignette strength={Math.min(0.45, TEXTURE.vignette * 0.6)} />
    <FilmGrain opacity={TEXTURE.grain} />
    {TEXTURE.halftone ? <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.07, backgroundImage: "radial-gradient(rgba(0,0,0,0.9) 1px, transparent 1.2px)", backgroundSize: "6px 6px" }} /> : null}
  </>
);

const TransitionAt: React.FC<{ span: number; T: React.FC<{ progress: number }> }> = ({ span, T }) => {
  const f = useCurrentFrame();
  return <T progress={Math.max(0, Math.min(1, f / Math.max(1, span - 1)))} />;
};

const FULL_FRAME = new Set(["scene", "captions", "name_label", "map", "versus", "atmosphere", "hero_face", "cutout_collage", "chapter_card", "screen", "money_figure"]);

export const Documentary: React.FC<DocProps> = ({ manifest, look, design }) => {
  applyDesign(design);
  const frame = useCurrentFrame();
  // Act boundaries = chapter opener layers (long-form); one act for shorts.
  const actStarts = [0, ...manifest.video.filter((l) => l.ref === "chapter_card").map((l) => l.startFrame).sort((a, b) => a - b)];
  const actIdx = Math.max(0, actStarts.filter((f) => f <= frame).length - 1);
  const acts = design?.acts ?? [];
  const act = acts.length ? acts[Math.min(actIdx, acts.length - 1)] : undefined;
  // Grade crossfades 12 frames into each new act.
  const blend = actIdx > 0 ? interpolate(frame, [actStarts[actIdx]!, actStarts[actIdx]! + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const satRaw = act ? act.saturation * blend + (acts[Math.max(0, Math.min(actIdx - 1, acts.length - 1))]?.saturation ?? act.saturation) * (1 - blend) : look.saturate;
  // Never desaturate below natural: the reference is 1.5-2x more colourful than a neutral grade.
  const sat = Math.max(1.05, satRaw + 0.15);
  const con = act ? act.contrast : Math.max(look.contrast, 1.12);
  const portrait = manifest.height > manifest.width;
  const layers = [...manifest.video].sort((a, b) => a.zIndex - b.zIndex || a.startFrame - b.startFrame);
  const below = layers.filter((l) => l.zIndex < 50);
  const above = layers.filter((l) => l.zIndex >= 50);
  // Designed scenes get a continuous camera push (never a static slide); lower thirds/captions stay locked.
  const designed = (l: Layer) =>
    l.ref === "captions" || l.ref === "name_label" || l.ref === "money_figure" || l.ref === "chapter_card" || l.ref === "scene" ? (
      <Designed layer={l} accent={look.accent} />
    ) : (
      <CameraPush to={l.ref === "map" ? 1.0 : 1.05}>
        <Designed layer={l} accent={look.accent} />
      </CameraPush>
    );
  const render = (l: Layer) => (
    <Sequence key={l.id} from={l.startFrame} durationInFrames={l.endFrame - l.startFrame} layout="absolute-fill">
      {l.sourceKind === "designed" ? (
        l.ref === "atmosphere" ? (
          <Atmosphere />
        ) : portrait && !FULL_FRAME.has(l.ref) ? (
          // 9:16: graphics live in the top two-thirds; the lower third belongs to captions and platform UI.
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: "66%" }}>{designed(l)}</div>
        ) : (
          designed(l)
        )
      ) : l.blend !== "normal" ? (
        <OverlayLayer layer={l} />
      ) : (
        <MediaLayer layer={l} />
      )}
    </Sequence>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* One world: footage pulled toward the reference look (luma ≈ 0.28, saturation ≈ 0.44, contrast up). */}
      <AbsoluteFill style={{ filter: `saturate(${sat.toFixed(3)}) contrast(${Math.min(con, 1.14).toFixed(3)}) brightness(1.0)` }}>{below.map(render)}</AbsoluteFill>
      <Grade {...(act ? { act } : {})} />
      {above.map(render)}
      {/* Step 5: the film's own transition across every cut a shot asks to bridge ("film"), centred on the cut. */}
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

