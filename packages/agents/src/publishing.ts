import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import type { FactSheet, FilmDesignSystem, SceneElement, SceneSpec, TimedScript } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";
import { fitLayout } from "./scene-designer.js";

/**
 * Publishing studio: the package a film is published with — thumbnail, title, description, tags, hashtags and a
 * pinned comment — learned from how the reference channel packages its own films, and checked against the film
 * (nothing promised that the film does not deliver, no fact the research did not verify).
 *
 * Thumbnails are composed from REAL pictures (cut-out portraits, logos, products, library objects) on the film's
 * colour world by the same scene engine as the film. No generated imagery.
 */
const img = async (p: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(p)).toString("base64") } });

// ---------------------------------------------------------------------------------------------------------
// What the channel's thumbnails do (learned once per channel from the reference thumbnails).

const GrammarSchema = z.object({
  thumbs: z.array(
    z.object({
      index: z.number(),
      hero: z.string().describe("the one thing that fills the frame"),
      heroKind: z.enum(["person", "product", "logo", "object", "building", "scene", "text"]),
      twist: z.string().describe("what makes it a story and not a product shot (damage, contrast, a prop, an expression)"),
      background: z.string(),
      palette: z.string().describe("2–3 dominant colours in words"),
      words: z.number().describe("how many words of text are on it (0 if none)"),
      textPlacement: z.enum(["none", "top", "middle", "bottom", "left", "right", "on_subject"]),
    }),
  ),
  rules: z.array(z.string()).describe("8–12 rules that hold across these thumbnails, each concrete and checkable"),
});
export type ThumbnailGrammar = z.infer<typeof GrammarSchema> & { titles: string[] };

export async function learnThumbnailGrammar(o: { channel: string; thumbs: Array<{ path: string; title: string; views: number | null }> }): Promise<{ grammar: ThumbnailGrammar; usd: number }> {
  const list = [...o.thumbs].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 30);
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [i, t] of list.entries()) blocks.push({ type: "text", text: `[${i}] "${t.title}" — ${t.views ?? "?"} views` }, await img(t.path));
  const { data, usage } = await structured({
    stage: "publish.grammar",
    model: MODELS.sonnet,
    system: [plain(`You are a YouTube thumbnail designer studying the channel ${o.channel}. Describe each thumbnail precisely, then state the rules that hold across them — what fills the frame, how the subject is made into a story, how colour is used (note that each film has its own palette), how much text there is and where. Be literal: describe what is there, not what is usual on YouTube.`)],
    user: blocks,
    schema: GrammarSchema,
    effort: "medium",
    maxTokens: 12000,
  });
  return { grammar: { ...data, titles: list.map((t) => t.title) }, usd: usage.usd };
}

// ---------------------------------------------------------------------------------------------------------
// Thumbnail design: one composed scene from real cutouts.

const COLORS = ["primary", "primarySoft", "accent", "accentDeep", "surface", "surfaceAlt", "paper", "marker", "text", "textMuted", "black", "white"] as const;
const ThumbEl = z.object({
  type: z.enum(["cutout", "photo", "text", "shape", "texture"]),
  slot: z.number().describe("picture slot index for cutout/photo, else -1"),
  text: z.string(),
  role: z.enum(["display", "headline", "label", "stamp"]),
  shape: z.enum(["none", "underline", "circle", "arrow", "bar", "rect", "cross"]),
  texture: z.enum(["none", "paper", "halftone", "grid", "scanlines", "noise", "stripes"]),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  x2: z.number(),
  y2: z.number(),
  rot: z.number(),
  size: z.number().describe("text cap height as a fraction of frame height (thumbnail text is BIG: 0.14–0.28)"),
  align: z.enum(["left", "center", "right"]),
  color: z.enum(COLORS),
  word: z.string().describe("one word in the accent colour, or empty"),
  outline: z.boolean(),
});
const ThumbSchema = z.object({
  concept: z.string().describe("one sentence: the hero and the twist that makes a viewer need to know more"),
  palette: z.object({ primary: z.string(), accent: z.string(), surface: z.string() }).describe("#RRGGBB — this thumbnail's own vivid palette, from the subject's real colours"),
  world: z.enum(["nebula", "blueprint", "paper", "halftone", "smoke", "stripes", "spotlight"]),
  headlineStyle: z.enum(["neon_glow", "solid_stroke", "boxed", "gradient", "paper_cut"]),
  elements: z.array(ThumbEl),
});

export interface ThumbSlot { slot: number; depicts: string; kind: "cutout" | "photo"; aspect: number }
export interface ThumbnailDesign { concept: string; spec: SceneSpec; design: FilmDesignSystem; usd: number }

const validHex = (h: string) => /^#[0-9a-fA-F]{6}$/.test(h);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

export async function designThumbnail(o: { channel: string; grammar: ThumbnailGrammar; exemplars: string[]; title: string; facts: FactSheet; design: FilmDesignSystem; slots: ThumbSlot[]; avoid?: string[]; issues?: string[]; previous?: string }): Promise<ThumbnailDesign> {
  const ex: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [i, p] of o.exemplars.slice(0, 6).entries()) ex.push({ type: "text", text: `REAL ${o.channel} THUMBNAIL ${i + 1}:` }, await img(p));
  const { data, usage } = await structured({
    stage: o.issues ? "publish.thumbnail.revise" : "publish.thumbnail",
    model: MODELS.sonnet,
    system: [
      plain(`You design YouTube thumbnails for the channel ${o.channel}. The real thumbnails above set the standard. What they do, measured on the channel:
${o.grammar.rules.map((r) => `- ${r}`).join("\n")}

Design ONE thumbnail as a layered layout for a renderer that draws real pictures. It must be built from the picture slots listed — real cut-out people, logos, products and objects — never an illustration. The frame is 1280×720; coordinates are fractions (x,y = top-left, w = width); keep everything inside 0.03–0.97.

HOW:
- ONE hero that fills the frame: a cutout at w 0.4–0.75 (a face or product should be huge, cropped by the frame edge if it helps). outline=true gives the white sticker outline the channel uses.
- A TWIST that makes it a story: a second cutout that contradicts or threatens the hero, a struck-through logo, a cross, an arrow, a stamp — something the title does not already say.
- The background is a vivid colour world in THIS thumbnail's own palette (take it from the subject's real colours; primary and accent strongly saturated, surface a deep coloured dark). Never a neutral grey, never the same red-and-yellow flames for every film.
- TEXT: 0–3 words, huge, and never the title repeated — the title sits under the thumbnail on YouTube. If the picture tells it, use no text.
- Readable at phone size: nothing small, no more than 4 focal elements, strong contrast between subject and background. A logo must sit fully inside the frame on a part of the background it contrasts with (a dark logo needs a light or bright patch behind it — put a "bar" or "rect" shape in a light colour under it, or use the logo large on the bright side). No element may be half-hidden behind a text box.
- Fill the background: the real thumbnails are dense. Repeat a library object or a logo as a pattern (several small cutouts scattered behind the hero), add a texture (halftone, stripes, grid) and one big shape, so no area is an empty gradient.
- Elements are drawn in order (later on top): textures first, then the hero, then the twist, then text and shapes.${o.avoid?.length ? `\n- Recent thumbnails already used these concepts — do something different: ${o.avoid.join(" | ")}` : ""}`),
    ],
    user: [
      ...ex,
      { type: "text", text: `FILM TITLE: ${o.title}\nSTORY: ${o.facts.summary}\nPEOPLE: ${(o.facts.story?.characters ?? []).map((c) => `${c.name} (${c.role})`).join("; ")}\nFILM COLOUR WORLD: primary ${o.design.palette.primary}, accent ${o.design.palette.accent}\n\nPICTURE SLOTS (real pictures, already cut out where marked):\n${o.slots.map((s) => `[${s.slot}] ${s.depicts} — ${s.kind}, ${s.aspect.toFixed(2)}:1`).join("\n") || "none — typography and shapes only"}${o.issues?.length ? `\n\nYOUR PREVIOUS THUMBNAIL (${o.previous ?? ""}) WAS PICKED OUT AS THE FAKE NEXT TO REAL ONES. What gave it away: ${o.issues.join("; ")}. Fix exactly that.` : ""}` },
    ],
    schema: ThumbSchema,
    effort: "medium",
    maxTokens: 6000,
  });
  const slots = new Set(o.slots.map((s) => s.slot));
  const els: SceneElement[] = [];
  for (const e of data.elements) {
    const box = { x: clamp(e.x, 0.01, 0.95), y: clamp(e.y, 0.01, 0.95), w: clamp(e.w, 0.05, 0.96), rot: clamp(e.rot, -14, 14), z: 0.5, at: 0, enter: "fade" as const };
    if ((e.type === "cutout" || e.type === "photo") && !slots.has(e.slot)) continue;
    if (e.type === "cutout") els.push({ type: "cutout", slot: e.slot, ...box, shadow: true, outline: e.outline });
    else if (e.type === "photo") els.push({ type: "photo", slot: e.slot, ...box, frame: "none", grade: "natural" });
    else if (e.type === "text") {
      const t = e.text.trim();
      if (!t || t.split(/\s+/).length > 4 || t.length > 28) continue;
      els.push({ type: "text", text: t, role: e.role === "label" ? "label" : e.role === "stamp" ? "stamp" : "display", ...box, size: clamp(e.size, 0.08, 0.3), align: e.align, color: e.color, ...(e.word.trim() ? { highlightWord: e.word.trim() } : {}) });
    } else if (e.type === "shape" && e.shape !== "none") els.push({ type: "shape", shape: e.shape, ...box, h: 0.014, color: e.color, ...(e.shape === "arrow" ? { x2: clamp(e.x2, 0.02, 0.98), y2: clamp(e.y2, 0.02, 0.98) } : {}) });
    else if (e.type === "texture" && e.texture !== "none") els.push({ type: "texture", texture: e.texture, opacity: 0.3, at: 0 });
  }
  // Text must stay clear of other text; cutouts may overlap each other and the frame (that is the look).
  const texts = els.filter((e) => e.type === "text");
  fitLayout(texts, false);
  const p = o.design.palette;
  const design: FilmDesignSystem = {
    ...o.design,
    palette: { ...p, primary: validHex(data.palette.primary) ? data.palette.primary : p.primary, accent: validHex(data.palette.accent) ? data.palette.accent : p.accent, surface: validHex(data.palette.surface) ? data.palette.surface : p.surface },
    treatment: { ...(o.design.treatment ?? { phrase: "boxed", label: "tag", photo: "none", particles: "none", wash: "none", washStrength: 0.3, glow: 0.7, motif: "", transition: "whip" as const }), headline: data.headlineStyle, world: data.world, particles: "none", phrase: o.design.treatment?.phrase ?? "boxed", label: o.design.treatment?.label ?? "tag", photo: "none", wash: "none", washStrength: 0.3, glow: Math.max(0.6, o.design.treatment?.glow ?? 0.6), motif: o.design.treatment?.motif ?? "", transition: o.design.treatment?.transition ?? "whip" },
  };
  const spec: SceneSpec = { shotId: "thumbnail", idea: data.concept.slice(0, 200), backdrop: "world", dim: 0.3, camera: { fromScale: 1, toScale: 1, fromX: 0.5, toX: 0.5, fromY: 0.5, toY: 0.5 }, elements: els.length ? els : [{ type: "text", text: o.title.split(/\s+/).slice(0, 3).join(" "), role: "display", x: 0.08, y: 0.3, w: 0.84, rot: 0, z: 0.5, at: 0, enter: "fade", size: 0.2, align: "center", color: "text" }] };
  return { concept: data.concept, spec, design, usd: usage.usd };
}

/** Imposter test: our thumbnail among real ones. Can a designer who knows the channel pick it out? */
export async function thumbnailImposter(o: { channel: string; candidate: string; real: string[]; seed: number }): Promise<{ spotted: boolean; confidence: number; tells: string[]; usd: number }> {
  const all = [...o.real.slice(0, 4).map((p) => ({ p, ours: false }))];
  all.splice(o.seed % (all.length + 1), 0, { p: o.candidate, ours: true });
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [i, t] of all.entries()) blocks.push({ type: "text", text: `Thumbnail ${String.fromCharCode(65 + i)}:` }, await img(t.p));
  const { data, usage } = await structured({
    stage: "publish.imposter",
    model: MODELS.sonnet,
    system: [plain(`You are the thumbnail designer of the YouTube channel ${o.channel}. Of these thumbnails, all but one are real thumbnails from the channel; one was made by an imitator. Pick the imitation and say exactly what gives it away (composition, the subject and how it is cut out, colour, text, finish). Do not decide by topic or image resolution, and ignore the channel's own logo, badge or watermark (an imitation is not allowed to carry it, so its absence tells you nothing). If they all look like the channel, say so with low confidence.`)],
    user: blocks,
    schema: z.object({ observations: z.array(z.string()), pick: z.string().describe("the letter of the imitation"), confidence: z.number().describe("0.2 = guess, 1 = certain"), tells: z.array(z.string()) }),
    effort: "medium",
    maxTokens: 3000,
  });
  const idx = data.pick.trim().toUpperCase().charCodeAt(0) - 65;
  return { spotted: all[idx]?.ours === true, confidence: clamp(data.confidence, 0, 1), tells: data.tells.slice(0, 6), usd: usage.usd };
}

// ---------------------------------------------------------------------------------------------------------
// Title, description, tags, hashtags, pinned comment.

const TextSchema = z.object({
  titles: z.array(z.object({ title: z.string(), pattern: z.string().describe("which reference title pattern it follows") })).describe("6 candidates, each a different pattern"),
  hook: z.string().describe("the first two lines of the description (≤ 200 characters): what the viewer will find out, written to be read in the collapsed preview"),
  summary: z.string().describe("one paragraph, 60–110 words, in the channel's description style: restates the subject in the ways people search for it and tells what the film covers, without spoiling the ending"),
  tags: z.array(z.string()).describe("15–22 search phrases people would type, most specific first, modelled on the reference tags"),
  hashtags: z.array(z.string()).describe("3–5 hashtags without spaces, the first three are shown above the title"),
  pinnedComment: z.string().describe("one comment from the channel to pin: a specific, answerable question about the story that invites viewers to reply; no links, no 'subscribe'"),
});

export interface PublishingText { title: string; titleCandidates: Array<{ title: string; pattern: string }>; hook: string; summary: string; tags: string[]; hashtags: string[]; pinnedComment: string; checks: string[]; usd: number }

export async function writePublishingText(o: { channel: string; references: Array<{ title: string; views: number | null; summary: string; tags: string[] }>; script: TimedScript; facts: FactSheet; /** Chosen and tested by the packaging agent: kept as it is. */ title?: string; /** Problems a first version had (from the package check): fix them. */ fix?: string[] }): Promise<PublishingText> {
  const refs = [...o.references].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const narration = o.script.segments.map((s) => s.text).join(" ");
  const verified = o.facts.claims.map((c) => c.text).join(" ");
  const res = await structured({
    stage: "publish.text",
    model: MODELS.sonnet,
    system: [
      plain(`You package films for the YouTube channel ${o.channel}: the title, the description text, the tags, the hashtags and the pinned comment. Learn from how the channel itself does it.

THE CHANNEL'S TITLES, most viewed first (views in brackets):
${refs.slice(0, 30).map((r) => `- ${r.title} [${r.views ?? "?"}]`).join("\n")}

STORY PARAGRAPHS FROM ITS DESCRIPTIONS:
${refs.filter((r) => r.summary.length > 150).slice(0, 5).map((r) => `- (${r.title}) ${r.summary.slice(0, 500)}`).join("\n")}

ITS TAGS (per film):
${refs.filter((r) => r.tags.length).slice(0, 6).map((r) => `- (${r.title}) ${r.tags.slice(0, 14).join(", ")}`).join("\n")}

RULES:
- Titles: follow the patterns that got the most views above — their length, their punctuation, their kind of promise. At most 60 characters. Each candidate uses a different pattern. Never clickbait the film cannot pay off.
- Only facts from the film. Every number, name and claim must be in the narration or the verified facts given. Hedge what the narration hedges.
- No links, no "subscribe", no channel promotion, no emojis.
- Tags: phrases a person would search, built around the subject's names and the story's angle; no single generic words like "business". Never use the name of ${o.channel} or any other channel as a tag, and never a person, product or term the narration does not mention.`),
    ],
    user: `${o.fix?.length ? `A FIRST VERSION OF THIS PACKAGE HAD THESE PROBLEMS — do not repeat them; mention nothing the narration does not:\n${o.fix.map((x) => `- ${x}`).join("\n")}\n\n` : ""}FILM NARRATION:\n${narration}\n\nVERIFIED FACTS:\n${o.facts.claims.map((c) => `- ${c.text}`).join("\n").slice(0, 6000)}`,
    schema: TextSchema,
    effort: "medium",
    maxTokens: 6000,
  });
  const d = res.data;
  let usd = res.usage.usd;
  const checks: string[] = [];
  // Code checks: figures must come from the film; lengths within YouTube's limits.
  const source = `${narration} ${verified}`.toLowerCase();
  const numsOk = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).every((n) => source.includes(n.replace(/[.,]$/, "").toLowerCase()));
  let candidates = d.titles.map((t) => ({ title: t.title.trim().replace(/\s+/g, " "), pattern: t.pattern })).filter((t) => t.title.length >= 12 && t.title.length <= 70);
  const badNum = candidates.filter((t) => !numsOk(t.title));
  if (badNum.length) checks.push(`${badNum.length} title candidate(s) dropped: a figure not in the film`);
  candidates = candidates.filter((t) => numsOk(t.title));
  if (!candidates.length) candidates = [{ title: o.script.title, pattern: "script title" }];
  if (o.title) candidates = [{ title: o.title, pattern: "chosen by the packaging agent" }];
  // Imposter test on titles: each candidate hidden among real titles; the one least often picked out wins.
  const judged = o.title ? null : await structured({
    stage: "publish.titles",
    model: MODELS.haiku,
    system: [plain(`You know the YouTube channel ${o.channel} well. For each numbered list, all titles but one are real titles from the channel; one is an imitation. Say which line is the imitation and how sure you are. Judge wording, length, punctuation and the kind of promise — not the topic.`)],
    user: candidates.map((c, k) => {
      const real = refs.filter((_, i) => i % candidates.length === k % candidates.length).slice(0, 5).map((r) => r.title);
      const lines = [...real];
      lines.splice((k * 2 + 1) % (lines.length + 1), 0, c.title);
      return `LIST ${k}:\n${lines.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
    }).join("\n\n"),
    schema: z.object({ lists: z.array(z.object({ list: z.number(), imitation: z.string().describe("the full text of the title you think is the imitation"), confidence: z.number() })) }),
    effort: "low",
    maxTokens: 2000,
  }).catch(() => null);
  if (judged) usd += judged.usage.usd;
  const risk = (k: number) => {
    const v = judged?.data.lists.find((x) => x.list === k);
    if (!v) return 0.5;
    return v.imitation.trim().toLowerCase() === candidates[k]!.title.toLowerCase() ? clamp(v.confidence, 0, 1) : 0;
  };
  const ranked = candidates.map((c, k) => ({ c, r: risk(k) })).sort((a, b) => a.r - b.r);
  const title = ranked[0]!.c.title;
  if (!o.title) checks.push(`title chosen by imposter test: "${title}" (spotted-risk ${ranked[0]!.r.toFixed(2)}; ${ranked.filter((x) => x.r === 0).length}/${ranked.length} candidates passed as real)`);
  // Description text: only figures the NARRATION speaks (stricter than the fact sheet — the description must
  // not promise a number the viewer never hears). A sentence with any other figure is removed.
  const spoken = narration.toLowerCase();
  const spokenOk = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).every((n) => spoken.includes(n.replace(/[.,]$/, "").toLowerCase()));
  const keepSpoken = (t: string) => {
    const parts = t.split(/(?<=[.!?])\s+/);
    const kept = parts.filter(spokenOk);
    if (kept.length < parts.length) checks.push(`${parts.length - kept.length} description sentence(s) removed: a figure the narration never says`);
    return kept.join(" ");
  };
  d.hook = keepSpoken(d.hook);
  d.summary = keepSpoken(d.summary);
  // Tags: unique, ≤ 480 characters in total (YouTube's limit is 500).
  const tags: string[] = [];
  let len = 0;
  const brand = o.channel.toLowerCase().replace(/[^a-z]/g, "");
  const GENERIC = /^(the|a|an|of|and|to|in|on|for|by|with|what|how|why|who|did|does|is|was|happened|story|stories|history|documentary|explained|truth|real|inside|rise|fall|scandal|fraud|trial|verdict|prison|case|company|business|startup|founder|ceo|investors?|collapse|downfall|dark|secret|secrets|biggest|scam|lawsuit|investigation|timeline|full)$/;
  let droppedTags = 0;
  for (const t of d.tags.map((x) => x.trim().replace(/^#/, "").replace(/\s+/g, " ")).filter((x) => x.length >= 3 && x.length <= 60)) {
    const low = t.toLowerCase();
    // Not the reference channel's brand, and no name or term the film itself never uses.
    const foreign = low.replace(/[^a-z]/g, "").includes(brand) || low.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.test(w)).some((w) => !source.includes(w));
    if (foreign) {
      droppedTags++;
      continue;
    }
    if (tags.some((y) => y.toLowerCase() === low) || len + t.length + 1 > 480) continue;
    tags.push(t);
    len += t.length + 1;
  }
  if (droppedTags) checks.push(`${droppedTags} tag(s) dropped: the reference channel's name or a term the film never uses`);
  const hashtags = [...new Set(d.hashtags.map((h) => `#${h.replace(/[^\p{L}\p{N}]/gu, "")}`).filter((h) => h.length > 2 && h.length <= 30))].slice(0, 5);
  const noLinks = (t: string) => t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return { title, titleCandidates: ranked.map((x) => x.c), hook: noLinks(d.hook).slice(0, 220), summary: noLinks(d.summary), tags, hashtags, pinnedComment: noLinks(d.pinnedComment).slice(0, 400), checks, usd };
}

/**
 * Title test: each candidate is hidden among real titles of the channel (a different set per candidate) and a judge
 * picks the imitation; a figure the film does not contain or a title over 70 characters fails outright.
 * risk = the judge's confidence when it picked our title out, 0 when it did not.
 */
export async function testTitles(o: { channel: string; references: Array<{ title: string; views: number | null }>; titles: string[]; narration: string; verified: string }): Promise<{ results: Array<{ title: string; risk: number; ok: boolean; why: string }>; usd: number }> {
  const refs = [...o.references].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const source = `${o.narration} ${o.verified}`.toLowerCase();
  const numsOk = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).every((n) => source.includes(n.replace(/[.,]$/, "").toLowerCase()));
  const cands = o.titles.map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 8);
  const pre = cands.map((t) => (t.length > 70 ? "longer than 70 characters" : t.length < 12 ? "too short" : !numsOk(t) ? "a figure the film does not contain" : ""));
  const testable = cands.map((t, k) => ({ t, k })).filter((x) => !pre[x.k]);
  let usd = 0;
  const judged = testable.length
    ? await structured({
        stage: "publish.titles",
        model: MODELS.haiku,
        system: [plain(`You know the YouTube channel ${o.channel} well. For each numbered list, all titles but one are real titles from the channel; one is an imitation. Say which line is the imitation and how sure you are. Judge wording, length, punctuation and the kind of promise — not the topic.`)],
        user: testable.map(({ t }, j) => {
          const lines = refs.filter((_, i) => i % Math.max(1, testable.length) === j % Math.max(1, testable.length)).slice(0, 5).map((r) => r.title);
          lines.splice((j * 2 + 1) % (lines.length + 1), 0, t);
          return `LIST ${j}:\n${lines.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;
        }).join("\n\n"),
        schema: z.object({ lists: z.array(z.object({ list: z.number(), imitation: z.string(), confidence: z.number() })) }),
        effort: "low",
        maxTokens: 2000,
      }).catch(() => null)
    : null;
  if (judged) usd += judged.usage.usd;
  const results = cands.map((t, k) => {
    if (pre[k]) return { title: t, risk: 1, ok: false, why: pre[k]! };
    const j = testable.findIndex((x) => x.k === k);
    const v = judged?.data.lists.find((x) => x.list === j);
    const risk = !v ? 0.5 : v.imitation.trim().toLowerCase() === t.toLowerCase() ? clamp(v.confidence, 0, 1) : 0;
    return { title: t, risk, ok: true, why: risk === 0 ? "passed as a real title" : `picked out as the imitation (confidence ${risk.toFixed(2)})` };
  });
  return { results, usd };
}

/** Does the package promise what the film delivers? (title, thumbnail words, description vs the narration) */
export async function checkPackage(o: { title: string; thumbnailText: string[]; thumbnailConcept: string; hook: string; summary: string; pinnedComment: string; narration: string }): Promise<{ ok: boolean; issues: string[]; usd: number }> {
  const { data, usage } = await structured({
    stage: "publish.check",
    model: MODELS.haiku,
    system: [plain("You are a strict standards editor. Compare a film's publishing package with its narration. Flag only real problems: a promise or claim in the package that the narration does not deliver; a fact, figure or accusation not stated in the narration; the title, thumbnail and description contradicting each other; anything defamatory stated as fact when the narration hedges it. Do not flag style.")],
    user: `TITLE: ${o.title}\nTHUMBNAIL: ${o.thumbnailConcept} — words on it: ${o.thumbnailText.join(" / ") || "none"}\nDESCRIPTION HOOK: ${o.hook}\nDESCRIPTION SUMMARY: ${o.summary}\nPINNED COMMENT: ${o.pinnedComment}\n\nNARRATION:\n${o.narration}`,
    schema: z.object({ ok: z.boolean(), issues: z.array(z.string()) }),
    effort: "low",
    maxTokens: 1500,
  });
  return { ok: data.ok && !data.issues.length, issues: data.issues.slice(0, 6), usd: usage.usd };
}
