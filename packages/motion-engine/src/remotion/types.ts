import type { RenderManifest } from "@opumia/contracts";

export type Manifest = RenderManifest;
export type Layer = RenderManifest["video"][number];

export interface DocProps {
  manifest: Manifest;
  /** Channel look: accent colour and grade. */
  look: { accent: string; saturate: number; contrast: number; vignette: number; grain: number };
  [key: string]: unknown;
}

export interface CaptionWord {
  text: string;
  startFrame: number;
  endFrame: number;
}
export interface CaptionGroup {
  startFrame: number;
  endFrame: number;
  words: CaptionWord[];
}

export const FONT = `"Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif`;
export const FONT_BODY = `"Helvetica Neue", Helvetica, Arial, sans-serif`;
export const FONT_SERIF = `Georgia, "Times New Roman", Times, serif`;
