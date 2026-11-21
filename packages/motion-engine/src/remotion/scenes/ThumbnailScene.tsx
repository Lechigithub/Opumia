import React from "react";
import { AbsoluteFill } from "remotion";
import { applyDesign, type DesignTokens } from "../types";
import { ComposedScene, type ComposedProps } from "./Composed";

/**
 * Thumbnail = one composed scene, frozen after its entrances: real cutouts, the film's colour world, 0–4 words.
 * Drawn by the same engine as the film's scenes, so a thumbnail belongs to its film; colour is pushed harder
 * because thumbnails are measured about 2.5× as colourful as film frames on the reference channel.
 */
export const ThumbnailScene: React.FC<{ spec: ComposedProps["spec"]; slots: Record<string, string>; design?: DesignTokens; w: number; h: number }> = ({ spec, slots, design }) => {
  applyDesign(design);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", filter: "saturate(1.35) contrast(1.08)" }}>
      <ComposedScene spec={spec} slots={slots} />
    </AbsoluteFill>
  );
};
