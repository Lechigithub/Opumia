import type { RenderManifest } from "@opumia/contracts";

export type Manifest = RenderManifest;
export type Layer = RenderManifest["video"][number];

export interface DocProps {
  manifest: Manifest;
  /** Channel look: accent colour and grade. */
  look: { accent: string; saturate: number; contrast: number; vignette: number; grain: number };
  /** Per-film FilmDesignSystem tokens (palette, fonts, texture, act grades). */
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

// Live ES-module bindings: applyDesign() / setFilmFonts() reassign these per film; every importer sees the new value.
/** The film kit's typefaces (FILM.fonts), used by the captions and the 3D card labels. */
export let FONT = `"Helvetica Neue", Helvetica, Arial, sans-serif`;
export let FONT_BODY = `"Helvetica Neue", Helvetica, Arial, sans-serif`;
export function setFilmFonts(f: { display: string; body: string } | undefined) {
  if (!f) return;
  FONT = f.display;
  FONT_BODY = f.body;
}

/**
 * Safe-zone layout. Lower thirds sit above the caption band; captions sit in the band below them.
 * 9:16: lower-third bottom edge at 24 % of height, captions start at 13 %.
 * 16:9: lower-third bottom edge at 16 %, captions start at 5.5 %.
 */
export const SAFE = { lowerThird916: 0.24, lowerThird169: 0.16, captionBottom916: 0.13, captionBottom169: 0.055 } as const;

type PaletteKey = "primary" | "primarySoft" | "accent" | "accentDeep" | "surface" | "surfaceAlt" | "paper" | "marker" | "text" | "textMuted";
/** The film's palette (design.json, set by its art director with the kit). Neutral values until applyDesign() runs. */
export const PALETTE: Record<PaletteKey, string> = { primary: "#D9D4C7", primarySoft: "#EEEAE0", accent: "#C0392B", accentDeep: "#5B1A14", surface: "#08090C", surfaceAlt: "#1B1F27", paper: "#F1ECE1", marker: "#F2D16B", text: "#FFFFFF", textMuted: "#B8BCC6" };
export const TEXTURE = { grain: 0.2, vignette: 0.7 };

/** design.json (FilmDesignSystem v2) as the renderer reads it. */
export interface DesignTokens {
  palette: Record<PaletteKey, string>;
  fonts?: { display: string; body: string };
  texture: { grain: number; vignette: number };
  acts: Array<{ name: string; tint: string; tintStrength: number; saturation: number; contrast: number; /** build list 5, item 28: the colourist's exposure (1 = as shot) */ brightness?: number }>;
}

/** Install one film's design tokens (call at the top of a composition, before children render). */
/**
 * Owner, 2026-11-23: no template look. Every engine-drawn style (bursts, grids, filmstrips, frames, wipes, particle
 * density…) takes its own variant per film from this seed, set from the film's own design (its palette and typefaces,
 * which the art director must make different from every earlier film), so two films never draw them the same way.
 */
export const STYLE = { seed: 0 };
const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
/** A per-film value in [lo, hi] for a named style parameter. */
export const vary = (key: string, lo: number, hi: number) => lo + ((hashStr(`${STYLE.seed}|${key}`) % 10007) / 10006) * (hi - lo);
/** A per-film choice among options. */
export const pick = <T,>(key: string, opts: readonly T[]): T => opts[hashStr(`${STYLE.seed}|${key}`) % opts.length]!;

export function applyDesign(d?: DesignTokens) {
  if (!d) return;
  STYLE.seed = hashStr(JSON.stringify([d.palette, d.fonts]));
  Object.assign(PALETTE, d.palette);
  Object.assign(TEXTURE, { grain: d.texture.grain, vignette: d.texture.vignette });
  setFilmFonts(d.fonts);
}
