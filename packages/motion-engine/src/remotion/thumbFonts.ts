/**
 * Thumbnail typefaces: open-licensed (SIL OFL) Google fonts, loaded only when a thumbnail renders, so the lettering
 * is the same on a Mac and in the Linux render container (which has none of the Mac's system fonts).
 */
import { loadFont as anton } from "@remotion/google-fonts/Anton";
import { loadFont as archivoBlack } from "@remotion/google-fonts/ArchivoBlack";
import { loadFont as bebas } from "@remotion/google-fonts/BebasNeue";
import { loadFont as montserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as oswald } from "@remotion/google-fonts/Oswald";
import { loadFont as playfair } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as robotoSlab } from "@remotion/google-fonts/RobotoSlab";

export type ThumbFont = "heavy_sans" | "wide_heavy" | "condensed" | "tall_condensed" | "narrow" | "slab" | "serif";
export const THUMB_FONT_FALLBACK: Record<ThumbFont, string> = {
  heavy_sans: `"Arial Black", Helvetica, sans-serif`,
  wide_heavy: `"Arial Black", Helvetica, sans-serif`,
  condensed: `Impact, "Arial Narrow", sans-serif`,
  tall_condensed: `Impact, "Arial Narrow", sans-serif`,
  narrow: `"Arial Narrow", Helvetica, sans-serif`,
  slab: `Rockwell, Georgia, serif`,
  serif: `Georgia, serif`,
};

let loaded: Record<ThumbFont, string> | null = null;
/** Call from a thumbnail composition body; every font is fetched once per bundle. */
export function thumbFonts(): Record<ThumbFont, string> {
  if (loaded) return loaded;
  const fam = (f: () => { fontFamily: string }, k: ThumbFont) => {
    try {
      return `"${f().fontFamily}", ${THUMB_FONT_FALLBACK[k]}`;
    } catch {
      return THUMB_FONT_FALLBACK[k];
    }
  };
  loaded = {
    heavy_sans: fam(() => montserrat("normal", { weights: ["900"], subsets: ["latin"] }), "heavy_sans"),
    wide_heavy: fam(() => archivoBlack("normal", { weights: ["400"], subsets: ["latin"] }), "wide_heavy"),
    condensed: fam(() => anton("normal", { weights: ["400"], subsets: ["latin"] }), "condensed"),
    tall_condensed: fam(() => bebas("normal", { weights: ["400"], subsets: ["latin"] }), "tall_condensed"),
    narrow: fam(() => oswald("normal", { weights: ["700"], subsets: ["latin"] }), "narrow"),
    slab: fam(() => robotoSlab("normal", { weights: ["900"], subsets: ["latin"] }), "slab"),
    serif: fam(() => playfair("normal", { weights: ["900"], subsets: ["latin"] }), "serif"),
  };
  return loaded;
}
