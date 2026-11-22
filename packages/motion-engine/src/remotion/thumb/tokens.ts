/**
 * The thumbnail's lettering and background style (the packaging agent chooses them per thumbnail). Thumbnail-only:
 * films have no menu styles; their look is their own kit.
 */
export type TextStyleName = "neon_glow" | "solid_stroke" | "boxed" | "gradient" | "paper_cut" | "outline_only";
export interface Treatment {
  headline: TextStyleName;
  phrase: TextStyleName;
  label: "tag" | "underline" | "pill" | "bracket" | "plain";
  photo: "print" | "torn" | "polaroid" | "none" | "tv" | "circle";
  world: "nebula" | "blueprint" | "paper" | "halftone" | "smoke" | "stripes" | "spotlight";
  particles: "none" | "dust" | "embers" | "snow" | "bokeh";
  glow: number;
}
export const TREATMENT: Treatment = { headline: "solid_stroke", phrase: "boxed", label: "tag", photo: "none", world: "smoke", particles: "none", glow: 0.6 };
export const TYPO = { casing: "upper" as "upper" | "title", tracking: 1 };
export interface ThumbStyle { headline?: TextStyleName; world?: Treatment["world"]; glow?: number }
export function applyThumbStyle(s?: ThumbStyle) {
  if (!s) return;
  if (s.headline) TREATMENT.headline = s.headline;
  if (s.world) TREATMENT.world = s.world;
  if (typeof s.glow === "number") TREATMENT.glow = Math.max(0, Math.min(1, s.glow));
}
