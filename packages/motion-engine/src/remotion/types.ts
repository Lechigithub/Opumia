import type { RenderManifest } from "@opumia/contracts";

export type Manifest = RenderManifest;
export type Layer = RenderManifest["video"][number];

export interface DocProps {
  manifest: Manifest;
  /** Channel look: accent colour and grade. */
  look: { accent: string; saturate: number; contrast: number; vignette: number; grain: number };
  /** Per-film FilmDesignSystem tokens (palette, typography, texture, act grades). */
  design?: DesignTokens;
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

// Live ES-module bindings: applyDesign() reassigns these per film, every importer sees the new value.
export let FONT = `"Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif`;
export let FONT_BODY = `"Helvetica Neue", Helvetica, Arial, sans-serif`;
export let FONT_SERIF = `Georgia, "Times New Roman", Times, serif`;

/**
 * Safe-zone layout. Lower thirds sit above the caption band; captions sit in the band below them.
 * 9:16: lower-third bottom edge at 24 % of height, captions start at 13 %.
 * 16:9: lower-third bottom edge at 16 %, captions start at 5.5 %.
 */
export const SAFE = { lowerThird916: 0.24, lowerThird169: 0.16, captionBottom916: 0.13, captionBottom169: 0.055 } as const;

/** MagnatesMedia-grade accent palette: crimson for loss/danger/highlight, gold for wealth/peak, ink for depth. */
/**
 * Film palette. Role names are historical: crimson = the film's tension/crisis ACCENT, gold = its PRIMARY subject
 * colour, ink/steel = surfaces. Values are neutral defaults; applyDesign() sets them from the FilmDesignSystem.
 */
export const PALETTE: Record<"crimson" | "crimsonDeep" | "gold" | "goldSoft" | "ink" | "steel" | "paper" | "marker" | "text" | "textMuted", string> = { crimson: "#C0392B", crimsonDeep: "#5B1A14", gold: "#D9D4C7", goldSoft: "#EEEAE0", ink: "#08090C", steel: "#1B1F27", paper: "#F1ECE1", marker: "#F2D16B", text: "#FFFFFF", textMuted: "#B8BCC6" };
export const TEXTURE = { grain: 0.2, vignette: 0.7, halftone: false, lightLeaks: false };
export const TYPO = { casing: "upper" as "upper" | "title", tracking: 1 };

export type TextStyleName = "neon_glow" | "solid_stroke" | "boxed" | "gradient" | "paper_cut" | "outline_only";
export interface Treatment {
  headline: TextStyleName;
  phrase: TextStyleName;
  label: "tag" | "underline" | "pill" | "bracket" | "plain";
  photo: "print" | "torn" | "polaroid" | "none" | "tv" | "circle";
  world: "nebula" | "blueprint" | "paper" | "halftone" | "smoke" | "stripes" | "spotlight";
  particles: "none" | "dust" | "embers" | "snow" | "bokeh";
  wash: "none" | "tint" | "duotone";
  washStrength: number;
  glow: number;
  motif: string;
}
/** The film's motion-design language (live binding, set by applyDesign). */
export const TREATMENT: Treatment = { headline: "solid_stroke", phrase: "neon_glow", label: "tag", photo: "print", world: "smoke", particles: "dust", wash: "tint", washStrength: 0.3, glow: 0.6, motif: "" };

export interface DesignTokens {
  palette: { primary: string; primarySoft: string; accent: string; accentDeep: string; surface: string; surfaceAlt: string; paper: string; marker: string; text: string; textMuted: string };
  typography: { display: "condensed_sans" | "editorial_serif" | "geometric_sans" | "slab"; body: "grotesk" | "humanist" | "serif"; casing: "upper" | "title"; tracking: number };
  texture: { grain: number; vignette: number; halftone: boolean; lightLeaks: boolean };
  acts: Array<{ name: string; tint: string; tintStrength: number; saturation: number; contrast: number }>;
  treatment?: Treatment;
}

const DISPLAY: Record<DesignTokens["typography"]["display"], string> = {
  condensed_sans: `"Impact", "Haettenschweiler", "Arial Narrow Bold", "Arial Black", sans-serif`,
  editorial_serif: `"Didot", "Bodoni 72", "Playfair Display", "Times New Roman", Georgia, serif`,
  geometric_sans: `"Futura", "Avenir Next Heavy", "Avenir Next", "Century Gothic", "Arial Black", sans-serif`,
  slab: `"Rockwell", "Roboto Slab", "Courier New", Georgia, serif`,
};
const BODY: Record<DesignTokens["typography"]["body"], string> = {
  grotesk: `"Helvetica Neue", Helvetica, Arial, sans-serif`,
  humanist: `"Gill Sans", "Optima", "Segoe UI", Helvetica, sans-serif`,
  serif: `"Iowan Old Style", Georgia, "Times New Roman", serif`,
};

/** Install one film's design system (call at the top of a composition, before children render). */
export function applyDesign(d?: DesignTokens) {
  if (!d) return;
  const p = d.palette;
  Object.assign(PALETTE, { crimson: p.accent, crimsonDeep: p.accentDeep, gold: p.primary, goldSoft: p.primarySoft, ink: p.surface, steel: p.surfaceAlt, paper: p.paper, marker: p.marker, text: p.text, textMuted: p.textMuted });
  Object.assign(TEXTURE, d.texture);
  Object.assign(TYPO, { casing: d.typography.casing, tracking: d.typography.tracking });
  if (d.treatment) Object.assign(TREATMENT, d.treatment);
  FONT = DISPLAY[d.typography.display];
  FONT_BODY = BODY[d.typography.body];
  FONT_SERIF = d.typography.display === "editorial_serif" ? DISPLAY.editorial_serif : `Georgia, "Times New Roman", Times, serif`;
}
