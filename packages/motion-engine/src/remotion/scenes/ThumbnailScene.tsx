import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { applyDesign, type DesignTokens } from "../types";
import { ComposedScene, type ComposedProps } from "./Composed";

/**
 * Thumbnail = one composed scene, frozen after its entrances, plus a finishing layer — everything drawn from real
 * pixels (no generated imagery):
 *  - background: a real photo filling the frame behind the hero (graded, blurred, dimmed, tinted), or a two-colour split;
 *  - rays: a burst of light behind the hero;
 *  - overlays: real fire, smoke, sparks or light frames (filmed on black) blended over or under the composition;
 *  - vignette.
 * Colour is pushed harder than in the film: the reference channel's thumbnails are about 2.5× as colourful as its frames.
 */
export interface ThumbFinish {
  background?: { slot: number; blur?: number; dim?: number; tint?: string; tintStrength?: number; x?: number; y?: number; scale?: number };
  split?: { a: string; b: string; angle?: number; at?: number };
  rays?: { color: string; x: number; y: number; opacity?: number; count?: number };
  overlays?: Array<{ slot: number; blend?: "screen" | "lighten" | "multiply" | "overlay"; opacity?: number; under?: boolean; x?: number; y?: number; w?: number; h?: number }>;
  vignette?: number;
}

const hex = (c: string | undefined, d: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : d);
const clamp = (v: number | undefined, a: number, b: number, d: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? (v as number) : d));

const Overlays: React.FC<{ list: NonNullable<ThumbFinish["overlays"]>; slots: Record<string, string>; under: boolean }> = ({ list, slots, under }) => (
  <>
    {list
      .filter((o) => Boolean(o.under) === under && slots[String(o.slot)])
      .map((o, i) => (
        <Img
          key={i}
          src={staticFile(slots[String(o.slot)]!)}
          style={{ position: "absolute", left: `${clamp(o.x, -0.5, 1, 0) * 100}%`, top: `${clamp(o.y, -0.5, 1, 0) * 100}%`, width: `${clamp(o.w, 0.05, 2, 1) * 100}%`, height: `${clamp(o.h, 0.05, 2, 1) * 100}%`, objectFit: "cover", mixBlendMode: o.blend ?? "screen", opacity: clamp(o.opacity, 0, 1, 0.85) }}
        />
      ))}
  </>
);

export const ThumbnailScene: React.FC<{ spec: ComposedProps["spec"]; slots: Record<string, string>; design?: DesignTokens; finish?: ThumbFinish; w: number; h: number }> = ({ spec, slots, design, finish }) => {
  applyDesign(design);
  const bg = finish?.background && slots[String(finish.background.slot)] ? finish.background : null;
  const split = finish?.split ?? null;
  const ownBackground = Boolean(bg || split);
  const rays = finish?.rays;
  const n = Math.round(clamp(rays?.count, 6, 32, 16));
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", filter: "saturate(1.35) contrast(1.08)", overflow: "hidden" }}>
      {bg ? (
        <AbsoluteFill style={{ overflow: "hidden" }}>
          <Img src={staticFile(slots[String(bg.slot)]!)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: `${clamp(bg.x, 0, 1, 0.5) * 100}% ${clamp(bg.y, 0, 1, 0.5) * 100}%`, transform: `scale(${clamp(bg.scale, 1, 2, 1.04)})`, filter: `blur(${clamp(bg.blur, 0, 24, 0)}px) brightness(${1 - clamp(bg.dim, 0, 0.85, 0.15)}) contrast(1.08) saturate(1.2)` }} />
          {bg.tint ? <AbsoluteFill style={{ background: hex(bg.tint, "#000000"), mixBlendMode: "color", opacity: clamp(bg.tintStrength, 0, 1, 0.5) }} /> : null}
        </AbsoluteFill>
      ) : null}
      {!bg && split ? <AbsoluteFill style={{ background: `linear-gradient(${clamp(split.angle, -180, 180, 100)}deg, ${hex(split.a, "#101010")} 0 ${clamp(split.at, 0.1, 0.9, 0.5) * 100}%, ${hex(split.b, "#f0f0f0")} ${clamp(split.at, 0.1, 0.9, 0.5) * 100}% 100%)` }} /> : null}
      {rays ? (
        <AbsoluteFill style={{ mixBlendMode: "screen", opacity: clamp(rays.opacity, 0, 1, 0.55), background: `repeating-conic-gradient(from 0deg at ${clamp(rays.x, 0, 1, 0.5) * 100}% ${clamp(rays.y, 0, 1, 0.5) * 100}%, ${hex(rays.color, "#ffffff")} 0deg ${180 / n}deg, transparent ${180 / n}deg ${360 / n}deg)`, WebkitMaskImage: `radial-gradient(circle at ${clamp(rays.x, 0, 1, 0.5) * 100}% ${clamp(rays.y, 0, 1, 0.5) * 100}%, #000 0%, rgba(0,0,0,0.6) 35%, transparent 75%)` }} />
      ) : null}
      {finish?.overlays?.length ? <Overlays list={finish.overlays} slots={slots} under /> : null}
      <ComposedScene spec={ownBackground ? { ...spec, backdrop: "footage", wash: undefined } : spec} slots={slots} />
      {finish?.overlays?.length ? <Overlays list={finish.overlays} slots={slots} under={false} /> : null}
      {finish?.vignette ? <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 45%, rgba(0,0,0,${clamp(finish.vignette, 0, 1, 0.5)}) 100%)` }} /> : null}
    </AbsoluteFill>
  );
};
