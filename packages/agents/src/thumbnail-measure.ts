/**
 * Thumbnail measurement: what a thumbnail is made of, labelled the same way for the reference channel's real
 * thumbnails and for ours. The channel's thumbnails become a band (how big the hero is, how many words, what sits
 * behind it, how colourful it is, how many could be made from real pictures alone) and a thumbnail of ours either
 * sits inside it or it does not.
 *
 * `makeable` answers the owner's question directly: a thumbnail that needs an invented scene, an altered face or an
 * illustration cannot be matched without generated imagery — the band says how many of the channel's do.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

export const THUMB_HEROES = ["person", "product", "logo", "object", "building", "place", "text", "none"] as const;
export const THUMB_BACKGROUNDS = ["colour_field", "gradient", "photo_scene", "split_colour", "pattern", "texture"] as const;
export const THUMB_MAKEABLE = ["real_pictures", "needs_retouch", "needs_invention", "illustration"] as const;
export const THUMB_MARKS = ["arrow", "circle", "cross", "strike", "box", "burst", "money", "fire", "glow", "outline"] as const;
export const THUMB_TEXT_STYLES = ["none", "label_box", "outlined", "plain", "gradient", "glow"] as const;

const SYSTEM = `You label YouTube thumbnails, one label set per numbered image. Judge only what is visible; be literal.
hero: the one thing that fills the frame — person, product, logo, object, building, place (a scene or landscape), text (words are the main event), none.
heroShare: the fraction of the frame's AREA the hero covers (0.05 = small, 0.5 = half the frame).
heroCutout: true if the hero is lifted off its original background (a cut-out on a new background), false if it is a photo in its own setting.
faces: how many human faces are visible. expression: the strongest face's expression — none (no face), neutral (a calm portrait), strong (shock, anger, laughter, a shout, tears).
background: colour_field (flat or near-flat colour), gradient, photo_scene (a real photo or footage behind), split_colour (two colours split by a line or diagonal), pattern (repeated objects or logos), texture.
elements: how many separate focal elements there are (hero, second subject, logo, big text, arrow… — not background detail).
words: how many words of text are on it (0 if none; ignore channel watermarks). textHeight: the cap height of the biggest text as a fraction of the frame height (0 if no text).
textStyle: how the main text is drawn — none, label_box (letters on a solid coloured box or bar), outlined (letters with a thick outline or stroke), plain (solid letters, at most a soft shadow), gradient (letters filled with a gradient or texture), glow (letters glowing). textLook: in a few words, the letters' colour, typeface kind (heavy sans-serif, serif, condensed, handwritten) and the box colour if any.
marks: graphic devices used — arrow, circle, cross, strike (something struck through), box (a text box or frame), burst (radiating light rays), money (cash, coins, dollar signs), fire (flames, explosion), glow (a coloured glow or rim light around a subject), outline (a white sticker outline around a cut-out).
makeable: could a designer make this exact thumbnail from real photographs alone, by cutting out, placing, colouring and adding type and shapes?
- real_pictures: yes — every picture in it is (or could be) a real photo, logo or object, composed.
- needs_retouch: real pictures, but a face or object is visibly altered (exaggerated expression, distorted, relit beyond grading, merged into a scene so seamlessly it reads as one photo).
- needs_invention: it shows a scene that no photograph could have captured (a person in a place they never were, a building on fire that never burned, an impossible object) rendered photo-realistically.
- illustration: drawn, painted, cartoon or 3D-rendered artwork rather than photos.
why: one short sentence on what decided makeable.`;

const Labels = z.object({
  thumbs: z.array(
    z.object({
      i: z.number(),
      hero: z.enum(THUMB_HEROES),
      heroShare: z.number(),
      heroCutout: z.boolean(),
      faces: z.number(),
      expression: z.enum(["none", "neutral", "strong"]),
      background: z.enum(THUMB_BACKGROUNDS),
      elements: z.number(),
      words: z.number(),
      textHeight: z.number(),
      textStyle: z.enum(THUMB_TEXT_STYLES),
      textLook: z.string(),
      marks: z.array(z.enum(THUMB_MARKS)),
      makeable: z.enum(THUMB_MAKEABLE),
      why: z.string(),
    }),
  ),
});
export type ThumbLabel = Omit<z.infer<typeof Labels>["thumbs"][number], "i">;

const b64 = (f: string) => readFile(f).then((b) => b.toString("base64"), () => null);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

/** Sonnet vision, six thumbnails a call (thumbnails are dense; the cheaper labeller missed marks and makeability). */
export async function labelThumbnails(files: string[]): Promise<Array<ThumbLabel | null>> {
  const out = new Array<ThumbLabel | null>(files.length).fill(null);
  const parts: Array<{ from: number; items: string[] }> = [];
  for (let i = 0; i < files.length; i += 6) parts.push({ from: i, items: files.slice(i, i + 6) });
  await Promise.all(
    parts.map(async (part) => {
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const [k, f] of part.items.entries()) {
        const data = await b64(f);
        if (data) blocks.push({ type: "text", text: `[${k}]` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
      }
      if (!blocks.length) return;
      const res = await structured({ stage: "thumb.label", model: MODELS.sonnet, system: [plain(SYSTEM)], user: blocks, schema: Labels, effort: "low", maxTokens: 3000 }).catch(() => null);
      for (const l of res?.data.thumbs ?? []) {
        if (l.i < 0 || l.i >= part.items.length) continue;
        const { i: _i, ...rest } = l;
        out[part.from + l.i] = { ...rest, heroShare: clamp(rest.heroShare, 0, 1), textHeight: clamp(rest.textHeight, 0, 1), words: Math.max(0, Math.round(rest.words)), elements: Math.max(0, Math.round(rest.elements)), faces: Math.max(0, Math.round(rest.faces)) };
      }
    }),
  );
  return out;
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]! : 0;
};
const share = <T extends string>(ls: ThumbLabel[], key: (l: ThumbLabel) => T | T[], keys: readonly T[]) => Object.fromEntries(keys.map((k) => [k, Math.round((ls.filter((l) => ([] as T[]).concat(key(l)).includes(k)).length / Math.max(1, ls.length)) * 1000) / 1000])) as Record<T, number>;

export interface ThumbBand {
  channel: string;
  count: number;
  hero: Record<(typeof THUMB_HEROES)[number], number>;
  background: Record<(typeof THUMB_BACKGROUNDS)[number], number>;
  makeable: Record<(typeof THUMB_MAKEABLE)[number], number>;
  marks: Record<(typeof THUMB_MARKS)[number], number>;
  heroShare: { p10: number; median: number; p90: number };
  cutoutShare: number;
  faceShare: number;
  strongExpressionShare: number;
  words: { median: number; p90: number; max: number; noTextShare: number };
  textHeight: { p10: number; median: number };
  textStyle: Record<(typeof THUMB_TEXT_STYLES)[number], number>;
  /** How the channel's text looks, from the thumbnails that carry text. */
  textLooks: string[];
  elements: { median: number; max: number };
  colourfulness: { p25: number; median: number; p90: number };
  luma: { p10: number; p90: number };
  /** Per reference thumbnail, so the agent can be shown real examples of a kind. */
  items: Array<{ file: string; title: string; views: number | null; label: ThumbLabel; colourfulness: number; luma: number }>;
  generatedAt: string;
}

export function thumbBand(channel: string, items: ThumbBand["items"]): ThumbBand {
  const ls = items.map((x) => x.label);
  const withText = ls.filter((l) => l.words > 0);
  return {
    channel,
    count: ls.length,
    hero: share(ls, (l) => l.hero, THUMB_HEROES),
    background: share(ls, (l) => l.background, THUMB_BACKGROUNDS),
    makeable: share(ls, (l) => l.makeable, THUMB_MAKEABLE),
    marks: share(ls, (l) => l.marks, THUMB_MARKS),
    heroShare: { p10: q(ls.map((l) => l.heroShare), 0.1), median: q(ls.map((l) => l.heroShare), 0.5), p90: q(ls.map((l) => l.heroShare), 0.9) },
    cutoutShare: ls.filter((l) => l.heroCutout).length / Math.max(1, ls.length),
    faceShare: ls.filter((l) => l.faces > 0).length / Math.max(1, ls.length),
    strongExpressionShare: ls.filter((l) => l.expression === "strong").length / Math.max(1, ls.filter((l) => l.faces > 0).length),
    words: { median: q(ls.map((l) => l.words), 0.5), p90: q(ls.map((l) => l.words), 0.9), max: Math.max(0, ...ls.map((l) => l.words)), noTextShare: ls.filter((l) => l.words === 0).length / Math.max(1, ls.length) },
    textHeight: { p10: q(withText.map((l) => l.textHeight), 0.1), median: q(withText.map((l) => l.textHeight), 0.5) },
    textStyle: share(withText, (l) => l.textStyle, THUMB_TEXT_STYLES),
    textLooks: withText.map((l) => l.textLook).slice(0, 24),
    elements: { median: q(ls.map((l) => l.elements), 0.5), max: Math.max(0, ...ls.map((l) => l.elements)) },
    colourfulness: { p25: q(items.map((x) => x.colourfulness), 0.25), median: q(items.map((x) => x.colourfulness), 0.5), p90: q(items.map((x) => x.colourfulness), 0.9) },
    luma: { p10: q(items.map((x) => x.luma), 0.1), p90: q(items.map((x) => x.luma), 0.9) },
    items,
    generatedAt: new Date().toISOString(),
  };
}

/** Label the channel's reference thumbnails once (data/thumbnail-profile/<channel>.json); relabel when the set changes. */
export async function ensureThumbBand(o: { data: string; channel: string; thumbs: Array<{ file: string; title: string; views: number | null; colourfulness: number; luma: number }>; log?: (s: string) => void }): Promise<ThumbBand | null> {
  const file = path.join(o.data, "thumbnail-profile", `${o.channel}.json`);
  const prev = await readFile(file, "utf8").then((t) => JSON.parse(t) as ThumbBand, () => null);
  // Matched by file name: the same set reached through a relative or an absolute data path is the same set.
  if (prev && prev.count > 0 && prev.textStyle && prev.items.length === o.thumbs.length && o.thumbs.every((t) => prev.items.some((x) => path.basename(x.file) === path.basename(t.file)))) {
    const byName = new Map(o.thumbs.map((t) => [path.basename(t.file), t.file]));
    return { ...prev, items: prev.items.map((x) => ({ ...x, file: byName.get(path.basename(x.file)) ?? x.file })) };
  }
  if (!o.thumbs.length) return null;
  o.log?.(`  thumbnail band: labelling ${o.thumbs.length} reference thumbnails…`);
  const labels = await labelThumbnails(o.thumbs.map((t) => t.file));
  const items = o.thumbs.flatMap((t, k) => (labels[k] ? [{ file: t.file, title: t.title, views: t.views, label: labels[k]!, colourfulness: Math.round(t.colourfulness * 10) / 10, luma: Math.round(t.luma * 1000) / 1000 }] : []));
  if (!items.length) return null;
  const band = thumbBand(o.channel, items);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(band, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  return band;
}

export interface ThumbIssue { kind: string; detail: string }

/** Where a thumbnail of ours sits outside the channel's band. */
export function thumbIssues(l: ThumbLabel, look: { colourfulness: number; luma: number }, band: ThumbBand): ThumbIssue[] {
  const out: ThumbIssue[] = [];
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  if (l.makeable !== "real_pictures") out.push({ kind: "not_real_pictures", detail: `it reads as ${l.makeable.replace("_", " ")} (${l.why}). Thumbnails here are composed from real pictures only.` });
  if (l.hero !== "text" && l.heroShare < band.heroShare.p10) out.push({ kind: "hero_too_small", detail: `the hero covers ${pct(l.heroShare)} of the frame; the channel's heroes cover ${pct(band.heroShare.p10)}–${pct(band.heroShare.p90)} (median ${pct(band.heroShare.median)}). Make it bigger — crop it with the frame edge if needed.` });
  if (l.words > Math.max(band.words.p90, 1)) out.push({ kind: "too_many_words", detail: `${l.words} words; the channel uses at most ${band.words.p90} on nine thumbnails in ten (median ${band.words.median}, ${pct(band.words.noTextShare)} have none).` });
  if (l.words > 0 && l.textHeight < band.textHeight.p10 * 0.9) out.push({ kind: "text_too_small", detail: `the text is ${pct(l.textHeight)} of the frame height; the channel's biggest text is ${pct(band.textHeight.p10)}+ (median ${pct(band.textHeight.median)}). Fewer words, bigger.` });
  if (l.elements > band.elements.max) out.push({ kind: "too_busy", detail: `${l.elements} focal elements; the channel never uses more than ${band.elements.max} (median ${band.elements.median}).` });
  if ((band.background[l.background] ?? 0) < 0.04) out.push({ kind: "background_unusual", detail: `a ${l.background.replace("_", " ")} background; the channel uses ${Object.entries(band.background).filter(([, v]) => v >= 0.1).map(([k, v]) => `${k.replace("_", " ")} ${pct(v)}`).join(", ")}.` });
  if (look.colourfulness < band.colourfulness.p25) out.push({ kind: "too_dull", detail: `colourfulness ${Math.round(look.colourfulness)}; the channel's thumbnails sit at ${Math.round(band.colourfulness.p25)}–${Math.round(band.colourfulness.p90)} (median ${Math.round(band.colourfulness.median)}). Push the background colour and the subject's own colour, not grey.` });
  if (look.luma < band.luma.p10 * 0.85) out.push({ kind: "too_dark", detail: `brightness ${look.luma.toFixed(2)}; the channel's darkest thumbnails are ${band.luma.p10.toFixed(2)}. Light the hero.` });
  if (l.words > 0 && l.textStyle !== "none" && (band.textStyle[l.textStyle] ?? 0) < 0.15) out.push({ kind: "text_style_unusual", detail: `the text is drawn ${l.textStyle.replace("_", " ")} (${l.textLook}); the channel draws it ${Object.entries(band.textStyle).filter(([k, v]) => k !== "none" && v >= 0.15).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace("_", " ")} ${pct(v)}`).join(", ")} — e.g. ${band.textLooks.slice(0, 4).join("; ")}.` });
  if (l.faces > 0 && l.expression === "neutral" && band.strongExpressionShare >= 0.3) out.push({ kind: "flat_face", detail: `the face is neutral; ${pct(band.strongExpressionShare)} of the channel's faces show a strong expression. Look for a real frame or photo of this person reacting (film footage, press clips) — never alter a face.` });
  return out;
}
