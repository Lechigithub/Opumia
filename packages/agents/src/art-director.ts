import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FilmDesignSystem, type FactSheet } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";
import type { StylePack } from "./style-pack.js";

const TEXT_STYLES = ["neon_glow", "solid_stroke", "boxed", "gradient", "paper_cut", "outline_only"] as const;
const WORLDS = ["nebula", "blueprint", "paper", "halftone", "smoke", "stripes", "spotlight"] as const;
const Hex = z.string().describe("#RRGGBB");
const DesignSchema = z.object({
  concept: z.string(),
  palette: z.object({ primary: Hex, primarySoft: Hex, accent: Hex, accentDeep: Hex, surface: Hex, surfaceAlt: Hex, paper: Hex, marker: Hex, text: Hex, textMuted: Hex }),
  typography: z.object({ display: z.enum(["condensed_sans", "editorial_serif", "geometric_sans", "slab"]), body: z.enum(["grotesk", "humanist", "serif"]), casing: z.enum(["upper", "title"]), tracking: z.number() }),
  texture: z.object({ grain: z.number(), vignette: z.number(), halftone: z.boolean(), lightLeaks: z.boolean() }),
  acts: z.array(z.object({ name: z.string(), tint: Hex, tintStrength: z.number(), saturation: z.number(), contrast: z.number() })),
  sceneGrammar: z.object({ favour: z.array(z.string()), avoid: z.array(z.string()) }),
  treatment: z.object({
    headline: z.enum(TEXT_STYLES),
    phrase: z.enum(TEXT_STYLES),
    label: z.enum(["tag", "underline", "pill", "bracket", "plain"]),
    photo: z.enum(["print", "torn", "polaroid", "none", "tv", "circle"]),
    world: z.enum(WORLDS),
    particles: z.enum(["none", "dust", "embers", "snow", "bokeh"]),
    wash: z.enum(["none", "tint", "duotone"]),
    washStrength: z.number(),
    glow: z.number(),
    transition: z.enum(["whip", "dip_black", "light_leak", "fade"]).describe("the film's signature transition between thoughts"),
    motif: z.string().describe("one recurring visual device unique to this film, drawn from its subject (e.g. film sprocket strips for a camera maker)"),
  }),
});

/** Treatments of recent films (data/treatments.json): a new film may not repeat a recent headline+world pair. */
export interface TreatmentRecord { job: string; channel: string; headline: string; phrase: string; world: string; particles: string; photo: string; label: string; display: string; primary: string; accent: string; transition?: string }
const treatmentsFile = (dataDir: string) => path.join(dataDir, "treatments.json");
export async function recentTreatments(dataDir: string, n = 8): Promise<TreatmentRecord[]> {
  try {
    return (JSON.parse(await readFile(treatmentsFile(dataDir), "utf8")) as TreatmentRecord[]).slice(-n);
  } catch {
    return [];
  }
}
export async function recordTreatment(dataDir: string, r: TreatmentRecord): Promise<void> {
  let all: TreatmentRecord[] = [];
  try {
    all = JSON.parse(await readFile(treatmentsFile(dataDir), "utf8")) as TreatmentRecord[];
  } catch {
    /* first film */
  }
  all = [...all.filter((x) => x.job !== r.job), r].slice(-60);
  await mkdir(dataDir, { recursive: true });
  await writeFile(`${treatmentsFile(dataDir)}.tmp`, JSON.stringify(all, null, 1) + "\n");
  await rename(`${treatmentsFile(dataDir)}.tmp`, treatmentsFile(dataDir));
}

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
/** HSV saturation/value of a hex colour, and a version pushed to at least `minS` saturation and `minV` value. */
const vivid = (h: string, minS: number, minV: number) => {
  const [r, g, b] = rgb(h);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let hue = 0;
  if (d > 0) hue = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const s = Math.max(mx ? d / mx : 0, minS);
  const v = Math.max(mx, minV);
  const c = v * s;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = v - c;
  const [r1, g1, b1] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return hex([r1! + m, g1! + m, b1! + m]);
};
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
export async function artDirect(o: { facts: FactSheet; pack: StylePack; acts: number; recent?: TreatmentRecord[]; log?: (s: string) => void }): Promise<FilmDesignSystem> {
  const log = o.log ?? (() => {});
  const look = o.pack.profile.look as Record<string, { p50?: number } | null>;
  const years = o.facts.claims.flatMap((c) => [...c.text.matchAll(/\b(1[6-9]\d\d|20[0-4]\d)\b/g)].map((m) => Number(m[1]))).sort((a, b) => a - b);
  const era = years.length ? `${years[Math.floor(years.length * 0.2)]}–${years[Math.floor(years.length * 0.9)]}` : "unknown";
  log(`  art director: designing the film (${MODELS.sonnet})…`);
  const { data } = await structured({
    stage: "art.direct",
    model: MODELS.sonnet,
    system: [
      plain(`You are the art director of a premium documentary studio. Design ONE film's visual identity: it must feel specific to THIS story — its industry, country, era and moral arc — never a generic template. Think in references: a Nordic telecom giant reads in cold steel blue with a crimson crisis accent; a banking scandal in emerald and brass; an industrial empire in amber and charcoal; a crypto fraud in electric violet and toxic green; an airline/aerospace story in titanium grey and safety orange. COLOUR WORLD: the reference channel's films are vivid and each lives in its own colour world (measured: Coca-Cola film = reds, Silk Road film = green and purple, Uber film = blues, FedEx film = purple and orange). Start from the SUBJECT'S OWN COLOURS — its real brand colours, its product, its era's print and packaging — and build the palette from them. primary and accent must be strongly saturated, clearly different hues, and must not be a generic "documentary" grey, teal-and-orange or crimson-and-gold unless the subject itself is those colours. The surface is a deep, COLOURED dark (a dark version of a palette hue, never neutral grey or black). Text must be readable on the surface; the accent must pop against both surface and primary. (Reference median picture saturation ${(look.saturation?.p50 ?? 0.44).toFixed(2)}.)

TREATMENT: choose this film's motion-design language — one coherent system that fits the subject and era: headline type style and a DIFFERENT style for the kinetic narration phrases (neon_glow = glowing coloured type; solid_stroke = fat type with a dark outline; boxed = type in solid colour bars; gradient = metallic gradient type; paper_cut = dark type on paper strips; outline_only = hollow outlined type), label style, photo style, the procedural backdrop world (nebula, blueprint, paper, halftone, smoke, stripes, spotlight), particles, how footage is washed into the palette (duotone or tint, strength 0.2–0.6), glow 0–1, and ONE recurring motif drawn from the subject.${(o.recent ?? []).length ? ` RECENT FILMS ALREADY USED (do not repeat their headline style + world, their photo style, their display type, their transition, or a primary hue close to theirs — unless the subject's own brand colour leaves no choice, and then make the accent and the world clearly different): ${(o.recent ?? []).map((r) => `${r.headline}+${r.world}/${r.photo}/${r.display}/${r.transition ?? "?"}/${r.primary}`).join("; ")}.` : ""} Typography: pick the pairing that fits the era and tone (editorial_serif for old money / history, condensed_sans for aggressive business drama, geometric_sans for tech, slab for industry). Texture: grain 0–0.4 (older eras and darker stories more), vignette 0.3–0.9. Acts: exactly ${o.acts} acts in story order, each with its own grade (tint, tint strength 0–0.3, saturation 1.0–1.3, contrast 1.0–1.15) that follows the arc (e.g. warm optimism → cold tension → desaturated collapse). Scene grammar: choose 3–6 designed kinds this story should favour and any to avoid, from: ${KINDS}.`),
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
  // Vivid guard: the film's two key colours are saturated and bright; the surface keeps a hue of its own.
  p.primary = ensure(vivid(p.primary, 0.62, 0.72), p.surface, 3);
  p.accent = ensure(vivid(p.accent, 0.7, 0.8), p.surface, 3);
  if (lum(p.surface) < 0.012) p.surface = mix(p.surface, p.primary, 0.14);
  p.surfaceAlt = mix(p.surfaceAlt, p.primary, 0.18);
  if (contrast("#16130e", p.marker) < 4.5) p.marker = mix(p.marker, "#ffffff", 0.4);
  if (contrast("#16130e", p.paper) < 9) p.paper = mix(p.paper, "#ffffff", 0.5);
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const acts = Array.from({ length: o.acts }, (_, i) => data.acts[Math.min(i, data.acts.length - 1)] ?? { name: `Act ${i + 1}`, tint: p.primary, tintStrength: 0.15, saturation: 0.9, contrast: 1.1 }).map((a) => ({
    name: a.name,
    tint: valid(a.tint) ? a.tint : p.primary,
    tintStrength: clamp(a.tintStrength, 0, 0.45),
    saturation: clamp(a.saturation, 1.0, 1.3),
    contrast: clamp(a.contrast, 1.0, 1.15),
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
    treatment: (() => {
      const t = { ...data.treatment, washStrength: clamp(data.treatment.washStrength, 0.2, 0.6), glow: clamp(data.treatment.glow, 0, 1), motif: data.treatment.motif.slice(0, 120) };
      const recent = o.recent ?? [];
      // Uniqueness guard: never the same headline style + world as a recent film; never the same photo style twice running.
      if (recent.some((r) => r.headline === t.headline && r.world === t.world)) t.world = WORLDS.find((w) => !recent.some((r) => r.world === w)) ?? WORLDS[(WORLDS.indexOf(t.world) + 3) % WORLDS.length]!;
      if (recent.at(-1)?.headline === t.headline) t.headline = TEXT_STYLES.find((s) => s !== t.phrase && !recent.slice(-3).some((r) => r.headline === s)) ?? t.headline;
      if (t.phrase === t.headline) t.phrase = TEXT_STYLES.find((s) => s !== t.headline && s !== recent.at(-1)?.phrase) ?? "solid_stroke";
      if (recent.at(-1)?.transition === t.transition) t.transition = (["whip", "dip_black", "light_leak", "fade"] as const).find((x) => !recent.slice(-2).some((r) => r.transition === x)) ?? t.transition;
      if (recent.at(-1)?.photo === t.photo) t.photo = (["print", "torn", "polaroid", "none", "tv", "circle"] as const).find((x) => !recent.slice(-3).some((r) => r.photo === x)) ?? t.photo;
      return t;
    })(),
    sceneGrammar: { favour: data.sceneGrammar.favour, avoid: data.sceneGrammar.avoid, minRepeatGapS: 45 },
    generatedAt: new Date().toISOString(),
  });
  log(`  art director: "${ds.concept}" — primary ${p.primary}, accent ${p.accent}, ${ds.typography.display}/${ds.typography.body}, ${acts.length} act grades`);
  log(`  treatment: transition ${ds.treatment?.transition}, headline ${ds.treatment?.headline}, phrases ${ds.treatment?.phrase}, labels ${ds.treatment?.label}, photos ${ds.treatment?.photo}, world ${ds.treatment?.world}, ${ds.treatment?.particles} particles, ${ds.treatment?.wash} wash — motif: ${ds.treatment?.motif}`);
  return ds;
}
