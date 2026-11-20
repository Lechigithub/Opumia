import { createHash } from "node:crypto";
import { FilmDesignSystem, type FactSheet } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";
import type { StylePack } from "./style-pack.js";

const Hex = z.string().describe("#RRGGBB");
const DesignSchema = z.object({
  concept: z.string(),
  palette: z.object({ primary: Hex, primarySoft: Hex, accent: Hex, accentDeep: Hex, surface: Hex, surfaceAlt: Hex, paper: Hex, marker: Hex, text: Hex, textMuted: Hex }),
  typography: z.object({ display: z.enum(["condensed_sans", "editorial_serif", "geometric_sans", "slab"]), body: z.enum(["grotesk", "humanist", "serif"]), casing: z.enum(["upper", "title"]), tracking: z.number() }),
  texture: z.object({ grain: z.number(), vignette: z.number(), halftone: z.boolean(), lightLeaks: z.boolean() }),
  acts: z.array(z.object({ name: z.string(), tint: Hex, tintStrength: z.number(), saturation: z.number(), contrast: z.number() })),
  sceneGrammar: z.object({ favour: z.array(z.string()), avoid: z.array(z.string()) }),
});

const KINDS = "chart, map, document, versus, hero_face, cutout_collage, screen, timeline, big_word, money_figure, quote_card, name_label";

// --- WCAG contrast guard so any palette the model returns stays legible.
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
const lum = (h: string) => {
  const [r, g, b] = rgb(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const hex = (c: [number, number, number]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const mix = (h: string, to: string, t: number) => hex(rgb(h).map((v, i) => v + (rgb(to)[i]! - v) * t) as [number, number, number]);
const valid = (h: string) => /^#[0-9a-fA-F]{6}$/.test(h);
/** Push `fg` toward white/black until it reaches `min` contrast against `bg`. */
const ensure = (fg: string, bg: string, min: number) => {
  let c = fg;
  const target = lum(bg) < 0.4 ? "#ffffff" : "#000000";
  for (let i = 0; i < 20 && contrast(c, bg) < min; i++) c = mix(c, target, 0.12);
  return c;
};

/**
 * ArtDirectorAgent: a unique FilmDesignSystem per film from the topic, its era and mood, and the channel's
 * measured look (saturation, luma, grey share). Palette is contrast-checked; acts get their own grade.
 */
export async function artDirect(o: { facts: FactSheet; pack: StylePack; acts: number; log?: (s: string) => void }): Promise<FilmDesignSystem> {
  const log = o.log ?? (() => {});
  const look = o.pack.profile.look as Record<string, { p50?: number } | null>;
  const years = o.facts.claims.flatMap((c) => [...c.text.matchAll(/\b(1[6-9]\d\d|20[0-4]\d)\b/g)].map((m) => Number(m[1]))).sort((a, b) => a - b);
  const era = years.length ? `${years[Math.floor(years.length * 0.2)]}–${years[Math.floor(years.length * 0.9)]}` : "unknown";
  log(`  art director: designing the film (${MODELS.sonnet})…`);
  const { data } = await structured({
    stage: "art.direct",
    model: MODELS.sonnet,
    system: [
      plain(`You are the art director of a premium documentary studio. Design ONE film's visual identity: it must feel specific to THIS story — its industry, country, era and moral arc — never a generic template. Think in references: a Nordic telecom giant reads in cold steel blue with a crimson crisis accent; a banking scandal in emerald and brass; an industrial empire in amber and charcoal; a crypto fraud in electric violet and toxic green; an airline/aerospace story in titanium grey and safety orange. Constraints: the surface tones are dark (documentary grade, luma around ${(look.luma?.p50 ?? 0.28).toFixed(2)}); overall saturation near ${(look.saturation?.p50 ?? 0.44).toFixed(2)}; text must be readable on the surface; the accent must pop against both surface and primary. Typography: pick the pairing that fits the era and tone (editorial_serif for old money / history, condensed_sans for aggressive business drama, geometric_sans for tech, slab for industry). Texture: grain 0–0.4 (older eras and darker stories more), vignette 0.3–0.9. Acts: exactly ${o.acts} acts in story order, each with its own grade (tint, tint strength 0–0.4, saturation 0.6–1.2, contrast 1.0–1.25) that follows the arc (e.g. warm optimism → cold tension → desaturated collapse). Scene grammar: choose 3–6 designed kinds this story should favour and any to avoid, from: ${KINDS}.`),
    ],
    user: `CHANNEL: ${o.pack.channelId}\nTOPIC: ${o.facts.topic}\nERA (from facts): ${era}\nANGLE: ${o.facts.angle}\nSUMMARY: ${o.facts.summary}\nCHARACTERS: ${(o.facts.story?.characters ?? []).map((c) => `${c.name} (${c.role})`).join("; ")}\nSCENES: ${(o.facts.story?.scenes ?? []).map((s) => `${s.kind}: ${s.what}`).join(" | ").slice(0, 1200)}`,
    schema: DesignSchema,
    effort: "medium",
  });
  const p = { ...data.palette };
  for (const k of Object.keys(p) as Array<keyof typeof p>) if (!valid(p[k])) p[k] = k.startsWith("surface") ? "#0c0f14" : k === "paper" ? "#f1ece1" : "#c0392b";
  // Legibility guard: surfaces dark, text ≥ 7:1, accent and primary ≥ 3:1 on the surface, marker dark-text readable.
  if (lum(p.surface) > 0.08) p.surface = mix(p.surface, "#000000", 0.6);
  if (lum(p.surfaceAlt) > 0.12) p.surfaceAlt = mix(p.surfaceAlt, "#000000", 0.5);
  p.text = ensure(p.text, p.surface, 7);
  p.textMuted = ensure(p.textMuted, p.surface, 4.5);
  p.accent = ensure(p.accent, p.surface, 3);
  p.primary = ensure(p.primary, p.surface, 3);
  p.primarySoft = ensure(p.primarySoft, p.surface, 4.5);
  if (contrast("#16130e", p.marker) < 4.5) p.marker = mix(p.marker, "#ffffff", 0.4);
  if (contrast("#16130e", p.paper) < 9) p.paper = mix(p.paper, "#ffffff", 0.5);
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const acts = Array.from({ length: o.acts }, (_, i) => data.acts[Math.min(i, data.acts.length - 1)] ?? { name: `Act ${i + 1}`, tint: p.primary, tintStrength: 0.15, saturation: 0.9, contrast: 1.1 }).map((a) => ({
    name: a.name,
    tint: valid(a.tint) ? a.tint : p.primary,
    tintStrength: clamp(a.tintStrength, 0, 0.45),
    saturation: clamp(a.saturation, 0.5, 1.2),
    contrast: clamp(a.contrast, 0.95, 1.25),
  }));
  const ds = FilmDesignSystem.parse({
    schemaVersion: 1,
    id: `ds_${createHash("sha1").update(o.facts.id + o.pack.channelId).digest("hex").slice(0, 10)}`,
    channelId: o.pack.channelId,
    topic: o.facts.topic,
    concept: data.concept,
    palette: p,
    typography: { ...data.typography, tracking: clamp(data.typography.tracking, -1, 4) },
    texture: { grain: clamp(data.texture.grain, 0.08, 0.4), vignette: clamp(data.texture.vignette, 0.3, 0.9), halftone: data.texture.halftone, lightLeaks: data.texture.lightLeaks },
    acts,
    sceneGrammar: { favour: data.sceneGrammar.favour, avoid: data.sceneGrammar.avoid, minRepeatGapS: 45 },
    generatedAt: new Date().toISOString(),
  });
  log(`  art director: "${ds.concept}" — primary ${p.primary}, accent ${p.accent}, ${ds.typography.display}/${ds.typography.body}, ${acts.length} act grades`);
  return ds;
}
