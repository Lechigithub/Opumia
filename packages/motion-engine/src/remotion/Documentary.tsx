import React from "react";
import { AbsoluteFill, Sequence, staticFile, Img } from "remotion";
import { Captions } from "./scenes/Captions";
import { AnimatedChart } from "./scenes/Chart";
import { DocumentScene } from "./scenes/Document";
import { BigWord, MoneyFigure, NameLabel, QuoteCard, Timeline, Versus } from "./scenes/Kinetic";
import { MapRoute, type MapProps } from "./scenes/MapRoute";
import { MediaLayer, OverlayLayer } from "./scenes/Media";
import type { CaptionGroup, DocProps, Layer } from "./types";

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
      return <MoneyFigure {...(p as object)} accent={accent} />;
    case "versus":
      return <Versus {...(p as object)} accent={accent} />;
    case "timeline":
      return <Timeline {...(p as object)} accent={accent} />;
    case "quote_card":
      return <QuoteCard {...(p as object)} accent={accent} />;
    case "name_label":
      return <NameLabel {...(p as object)} accent={accent} />;
    case "captions":
      return <Captions groups={(p.groups ?? []) as CaptionGroup[]} accent={accent} />;
    default:
      return null;
  }
};

/** Grade + texture applied over the whole frame (channel look). */
const Grade: React.FC<{ vignette: number; grain: number }> = ({ vignette, grain }) => (
  <>
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,${vignette}) 100%)`, pointerEvents: "none" }} />
    {grain > 0 ? <AbsoluteFill style={{ opacity: grain, mixBlendMode: "overlay", backgroundImage: "repeating-radial-gradient(circle at 17% 32%, rgba(255,255,255,0.08) 0 1px, transparent 1px 3px)", pointerEvents: "none" }} /> : null}
  </>
);

const FULL_FRAME = new Set(["captions", "name_label", "map"]);

export const Documentary: React.FC<DocProps> = ({ manifest, look }) => {
  const portrait = manifest.height > manifest.width;
  const layers = [...manifest.video].sort((a, b) => a.zIndex - b.zIndex || a.startFrame - b.startFrame);
  const below = layers.filter((l) => l.zIndex < 50);
  const above = layers.filter((l) => l.zIndex >= 50);
  const render = (l: Layer) => (
    <Sequence key={l.id} from={l.startFrame} durationInFrames={l.endFrame - l.startFrame} layout="absolute-fill">
      {l.sourceKind === "designed" ? (
        portrait && !FULL_FRAME.has(l.ref) ? (
          // 9:16: graphics live in the top two-thirds; the lower third belongs to captions and platform UI.
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: "66%" }}>
            <Designed layer={l} accent={look.accent} />
          </div>
        ) : (
          <Designed layer={l} accent={look.accent} />
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
      <AbsoluteFill style={{ filter: `saturate(${look.saturate}) contrast(${look.contrast})` }}>{below.map(render)}</AbsoluteFill>
      <Grade vignette={look.vignette} grain={look.grain} />
      {above.map(render)}
    </AbsoluteFill>
  );
};

/** Thumbnail still: background image + headline set by the channel's thumbnail rules. */
export const Thumbnail: React.FC<{ bg: string; headline: string; accentWord?: string; accent: string; placement: "top" | "middle" | "bottom"; w: number; h: number }> = ({ bg, headline, accentWord, accent, placement }) => {
  const words = headline.toUpperCase().split(/\s+/);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Img src={staticFile(bg)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <AbsoluteFill style={{ background: "linear-gradient(transparent 40%, rgba(0,0,0,0.75))" }} />
      <AbsoluteFill style={{ justifyContent: placement === "top" ? "flex-start" : placement === "middle" ? "center" : "flex-end", alignItems: "center", padding: "8% 6%" }}>
        <div style={{ textAlign: "center", lineHeight: 0.95 }}>
          {words.map((w, i) => (
            <span key={i} style={{ fontFamily: `"Arial Black", Helvetica, sans-serif`, fontSize: 150, color: accentWord && w.includes(accentWord.toUpperCase()) ? accent : "#fff", WebkitTextStroke: "6px #000", paintOrder: "stroke fill", textShadow: "0 10px 30px #000", margin: "0 14px", display: "inline-block" }}>
              {w}
            </span>
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
