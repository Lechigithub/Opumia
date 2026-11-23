import { FilmDesignSystem, type ChannelId } from "@opumia/contracts";

/**
 * The film's kit owns its look (build list 3, L1/L3/L5). The art director (film-designer-agent.ts) writes the kit's
 * components and sets its design tokens; this module holds the role contract every kit must meet and turns the art
 * director's tokens into design.json (contrast-guarded so text stays legible).
 */

/** Every kit supplies one component per role; the engine and the scene designer address them by role. */
export const KIT_ROLES = ["headline", "phrase", "label", "number", "quote", "chapter", "stage", "chart", "map", "document"] as const;
export type KitRole = (typeof KIT_ROLES)[number];

/** The props the engine passes to each role (besides `slots`, `boxW`, `boxH`, which every component receives). */
export const ROLE_CONTRACT: Record<KitRole, string> = {
  headline: "text, variant?, mark?, lead? — craft inventory: the kit MUST draw every variant in the film's own style: \"banner\" (words on a banner, strip or tape — the channel's 5.6/min), \"caps\" (a bold centred all-caps title, 4.8/min), \"marker\" (the `mark` substring in a colour marker highlight, 4/min), \"glow\" (glowing / neon type), \"ghost\" (giant ghosted type behind the subject), with an optional small `lead` caption above the title. The one line that lands a turn (words the narrator says); BIG, set into the picture: the channel's words cover a median 9 % of the frame and up to 30 % (measured with OCR on its real frames, build list 5 item 12) — size the type to fill its box, not to sit small in a tag",
  phrase: "text, words: [{ text, from }] — narration words synced to the voice: `from` is the frame (relative to the element's start) on which each word is spoken; draw each word as it is said; large display type integrated with the picture (about half the channel's shots with words), never a small boxed label",
  label: "text, sub?, variant? (\"intro\": a person introduction card — name and role beside their picture; \"arrow\": a hand-drawn arrow or circle that draws on toward the subject, with the text; \"script\": a handwritten callout) — who or what is on screen (a name tag, a place, a date); the only small boxed type of the kit (the channel boxes at most half of its words)",
  number: "value (the figure exactly as spoken, e.g. \"$7.2 billion\"), label?",
  quote: "text (a verbatim quotation), by",
  chapter: "title, index? — a chapter or title card",
  stage: "variant? — a FULL-FRAME ground behind data graphics only (chart, map, document; boxW/boxH are the frame); designed scenes are built in the engine's worlds of real pictures (duotone, black and white with an accent, collage, paper, burst, flat field, terminal), never on this stage — so keep it quiet, never a dark grid with glows or particles",
  chart: "type (\"line\" | \"bar\"), title, labels: string[], values: number[] (verified), display: string[] (each value as the narrator says it — show these strings), unit, highlight (index) — draw it in the film's own way; every value is given, never invent one",
  map: "title, route (bool), canvas { w, h }, paths: [{ d (SVG path in canvas units), focus (bool: a country the story is in) }], points: [{ name, x, y }] (canvas units), from / to: [x, y, w, h] view boxes (fly from the wide view to the close one) — draw the land, the points and the route in the film's own way",
  document: "style (\"web\" | \"newspaper\" | \"filing\" | \"letter\"), masthead, date, headline, body, highlight (an exact substring of headline or body), tone (\"yellow\" | \"red\"), highlightFrom / highlightTo (frames: sweep the highlight while those words are spoken), paperSrc? (a real paper texture)",
};

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
const lum = (h: string) => {
  const [r, g, b] = rgb(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two hex colours. */
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const hex = (c: [number, number, number]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const mix = (h: string, to: string, t: number) => hex(rgb(h).map((v, i) => v + (rgb(to)[i]! - v) * t) as [number, number, number]);
/** Push `fg` toward white or black until it reaches `min` contrast against `bg`. */
const ensure = (fg: string, bg: string, min: number) => {
  let c = fg;
  const target = lum(bg) < 0.4 ? "#ffffff" : "#000000";
  for (let i = 0; i < 20 && contrast(c, bg) < min; i++) c = mix(c, target, 0.12);
  return c;
};

export interface KitTokens {
  palette: FilmDesignSystem["palette"];
  texture: FilmDesignSystem["texture"];
  acts: FilmDesignSystem["acts"];
}

/** The art director's tokens → design.json (v2). Text colours are pushed to legible contrast; nothing else is changed. */
export function designFromKit(o: { job: string; channel: ChannelId; topic: string; concept: string; fonts: { display: string; body: string }; tokens: KitTokens }): { design: FilmDesignSystem; adjusted: string[] } {
  const p = { ...o.tokens.palette };
  const adjusted: string[] = [];
  const fix = (k: "text" | "textMuted", bg: string, min: number) => {
    const v = ensure(p[k], bg, min);
    if (v !== p[k]) (adjusted.push(`${k} ${p[k]} → ${v} (contrast ${contrast(p[k], bg).toFixed(1)}:1 on ${bg})`), (p[k] = v));
  };
  fix("text", p.surface, 7);
  fix("textMuted", p.surface, 4.5);
  const design = FilmDesignSystem.parse({ schemaVersion: 2, id: o.job, channelId: o.channel, topic: o.topic, concept: o.concept, palette: p, fonts: o.fonts, texture: o.tokens.texture, acts: o.tokens.acts, generatedAt: new Date().toISOString() });
  return { design, adjusted };
}
