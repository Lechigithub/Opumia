/**
 * Thumbnail craft: what makes the channel's thumbnails work, and judges that hold ours to it. The reference channel's
 * own thumbnails are the ground truth (owner, 2026-11-22) — nothing here is calibrated on anyone's personal taste.
 *
 *  deconstructions  every reachable reference thumbnail broken down by a designer's eye: the one idea, how the
 *                   subject and the twist are fused into it, the layer stack, what fills each edge, the lettering,
 *                   and how to rebuild it with our tools (data/thumbnail-profile/<channel>-craft.json, made once)
 *  concept critic   scores written concepts against those deconstructions before anything is rendered
 *  critique         a render next to the three nearest real thumbnails: fused idea or collage, empty areas, and what
 *                   each real one does that ours does not
 *  emptyShare       share of the frame that is flat, dim or blurred (measured the same way on the reference)
 *
 * Deconstruction, concept critique and render critique run on Sonnet 5.5 (no Opus, build list 4); was: OPUMIA_CRAFT_MODEL=opus ran them on Opus 5.5
 * (to be compared once the Sonnet result is known — owner decision 2026-11-22).
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { plain, ROLE_MODEL, structured } from "./llm.js";
import { nearestByMeaning } from "./retrieve.js";
import type { ThumbBand } from "./thumbnail-measure.js";

/** Sonnet (build list 4, item 17: no Opus — the role table in llm.ts). */
const craftModel = () => ROLE_MODEL.thumbnailCraft;
const b64img = async (f: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(f) ? "image/png" : "image/jpeg", data: (await readFile(f)).toString("base64") } });

// ---------------------------------------------------------------------------------------------------------
// Empty frame: flat, dim or blurred areas (the channel fills its thumbnails edge to edge).

/** Share of 16×9 cells whose detail is low (luma spread under 9 of 255) and that are dim or unsaturated. */
export async function emptyShare(file: string): Promise<number> {
  const buf = await new Promise<Buffer>((res, rej) => execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=128:72:flags=area", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 20 }, (e, out) => (e ? rej(e) : res(out))));
  let empty = 0;
  for (let cy = 0; cy < 9; cy++)
    for (let cx = 0; cx < 16; cx++) {
      const ls: number[] = [];
      let sat = 0;
      for (let y = cy * 8; y < cy * 8 + 8; y++)
        for (let x = cx * 8; x < cx * 8 + 8; x++) {
          const i = (y * 128 + x) * 3;
          const r = buf[i]!, g = buf[i + 1]!, b = buf[i + 2]!;
          ls.push(0.299 * r + 0.587 * g + 0.114 * b);
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          sat += mx ? (mx - mn) / mx : 0;
        }
      const mean = ls.reduce((t, v) => t + v, 0) / ls.length;
      const sd = Math.sqrt(ls.reduce((t, v) => t + (v - mean) ** 2, 0) / ls.length);
      if (sd < 9 && (mean < 70 || sat / ls.length < 0.25)) empty++;
    }
  return Math.round((empty / 144) * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------------------
// Deconstructions.

const Decon = z.object({
  items: z.array(
    z.object({
      i: z.number(),
      idea: z.string().describe("the ONE idea of the thumbnail as a visual metaphor, in one sentence (e.g. 'the logo itself is on fire')"),
      fusion: z.string().describe("how the subject and the twist are fused into one image rather than placed side by side"),
      layers: z.array(z.string()).describe("the layer stack from back to front, each in a few words"),
      edges: z.string().describe("what fills the frame to each edge — what makes it dense, where (if anywhere) it breathes"),
      background: z.string().describe("what the background is made of and how it relates to the subject (brand pattern, the subject's world, a colour)"),
      lettering: z.string().describe("typeface kind, colour, box or outline, size, placement, how it interacts with the image; 'none' if no text"),
      phoneRead: z.string().describe("what a viewer understands in one second at phone size"),
      recipe: z.string().describe("how to rebuild it from real pictures with: cut-outs, piles of a repeated object, a pattern/wallpaper of a logo, a picture masked inside another (fire inside a logo), real fire/smoke/texture overlays, glow, grade, label boxes"),
    }),
  ),
});
export type ThumbDecon = Omit<z.infer<typeof Decon>["items"][number], "i"> & { file: string; title: string; views: number | null; hero: string; background_kind: string };
export interface ThumbCraft { channel: string; items: ThumbDecon[]; emptyShare: { median: number; p90: number }; generatedAt: string }

export async function ensureThumbCraft(o: { data: string; channel: string; band: ThumbBand; log?: (s: string) => void }): Promise<ThumbCraft | null> {
  const file = path.join(o.data, "thumbnail-profile", `${o.channel}-craft.json`);
  const reach = o.band.items.filter((x) => (x.label.reach ? x.label.reach === "reachable" : true));
  const prev = await readFile(file, "utf8").then((t) => JSON.parse(t) as ThumbCraft, () => null);
  if (prev && prev.items.length === reach.length && reach.every((r) => prev.items.some((x) => path.basename(x.file) === path.basename(r.file)))) {
    const byName = new Map(reach.map((r) => [path.basename(r.file), r.file]));
    return { ...prev, items: prev.items.map((x) => ({ ...x, file: byName.get(path.basename(x.file)) ?? x.file })) };
  }
  if (!reach.length) return null;
  o.log?.(`  thumbnail craft: deconstructing ${reach.length} reference thumbnails…`);
  const out: ThumbDecon[] = [];
  const parts: (typeof reach)[] = [];
  for (let k = 0; k < reach.length; k += 4) parts.push(reach.slice(k, k + 4));
  await Promise.all(
    parts.map(async (part) => {
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const [k, x] of part.entries()) blocks.push({ type: "text", text: `[${k}] "${x.title}"` }, await b64img(x.file));
      const res = await structured({
        stage: "thumb.deconstruct",
        model: craftModel(),
        system: [plain("You are a senior YouTube thumbnail designer taking apart thumbnails of a business-documentary channel so a junior designer can learn to make ones as good. For each numbered thumbnail, write precisely what it does — the single idea, how the elements are fused into it, the layers, how the frame is filled, the lettering — and how it could be rebuilt from real photographs, logos, objects, textures and fire/smoke footage. Be concrete; no generic advice.")],
        user: blocks,
        schema: Decon,
        effort: "medium",
        maxTokens: 8000,
      }).catch(() => null);
      for (const d of res?.data.items ?? []) {
        const x = part[d.i];
        if (!x) continue;
        const { i: _i, ...rest } = d;
        out.push({ ...rest, file: x.file, title: x.title, views: x.views, hero: x.label.hero, background_kind: x.label.background });
      }
    }),
  );
  if (!out.length) return null;
  const empties = await Promise.all(o.band.items.map((x) => emptyShare(x.file).catch(() => 0)));
  const sorted = [...empties].sort((a, b) => a - b);
  const craft: ThumbCraft = { channel: o.channel, items: out.sort((a, b) => (b.views ?? 0) - (a.views ?? 0)), emptyShare: { median: sorted[Math.floor(sorted.length / 2)] ?? 0, p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0.1 }, generatedAt: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(craft, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  return craft;
}

export const deconText = (d: ThumbDecon) => `"${d.title}" — IDEA: ${d.idea} | FUSION: ${d.fusion} | LAYERS: ${d.layers.join(" → ")} | EDGES: ${d.edges} | BACKGROUND: ${d.background} | LETTERING: ${d.lettering} | READS AS: ${d.phoneRead}`;

// ---------------------------------------------------------------------------------------------------------
// Concept critic (before any render).

export interface ThumbConcept { id: string; idea: string; hero: string; twist: string; fusion: string; background: string; fill: string; lettering: string; pictures: string }
const ConceptScores = z.object({
  scores: z.array(
    z.object({
      id: z.string(),
      fused: z.number().describe("0–10: one fused image (10) or elements side by side (0)"),
      instant: z.number().describe("0–10: understood in one second at phone size"),
      surprise: z.number().describe("0–10: a twist that makes you need to know more"),
      story: z.number().describe("0–10: the one image tells THIS film's turn (given below) — 10 = it shows the surprise itself; 3 = it shows only the topic or the company (a logo on fire, the product alone)"),
      channel: z.number().describe("0–10: the kind of idea this channel makes (compare with the deconstructions)"),
      makeable: z.number().describe("0–10: buildable from the pictures listed and real photos/objects/fire/textures, without altering a face or painting"),
      nearest: z.string().describe("the reference thumbnail whose idea it is closest to"),
      note: z.string().describe("the one change that would make it stronger"),
    }),
  ),
  best: z.array(z.string()).describe("the ids of the 2–3 concepts to build, best first"),
});
export type ConceptScore = z.infer<typeof ConceptScores>["scores"][number] & { total: number };

export async function critiqueConcepts(o: { channel: string; craft: ThumbCraft; film: string; /** build list 5, item 29: the lines where the story turns */ turn?: string; pictures: string; concepts: ThumbConcept[] }): Promise<{ scores: ConceptScore[]; best: string[]; usd: number }> {
  const res = await structured({
    stage: "publish.concepts",
    model: craftModel(),
    system: [plain(`You are the creative director of the YouTube channel ${o.channel}. Here is how its own best thumbnails work, taken apart:\n${o.craft.items.slice(0, 20).map((d) => `- ${deconText(d)}`).join("\n")}\n\nJudge a junior designer's thumbnail concepts against that standard. Be hard: a collage of a logo, a photo and a label side by side is not an idea. Reward one fused visual metaphor that fills the frame and reads in one second. The channel's thumbnails sell the story's twist — the contradiction or surprise — never just its subject: a concept that shows only the company, its logo or its product (even on fire) tells the topic, not the turn.`)],
    user: `FILM: ${o.film}\n${o.turn ? `THE STORY'S TURN: ${o.turn}\n` : ""}\nPICTURES AVAILABLE NOW (more can be found): ${o.pictures}\n\nCONCEPTS:\n${o.concepts.map((c) => `[${c.id}] IDEA: ${c.idea} | HERO: ${c.hero} | TWIST: ${c.twist} | FUSION: ${c.fusion} | BACKGROUND: ${c.background} | FILLS THE FRAME WITH: ${c.fill} | LETTERING: ${c.lettering} | PICTURES NEEDED: ${c.pictures}`).join("\n")}`,
    schema: ConceptScores,
    effort: "medium",
    maxTokens: 6000,
  });
  const scores = res.data.scores.map((s) => ({ ...s, total: Math.round(((s.fused * 1.5 + s.instant + s.surprise + s.story * 1.5 + s.channel * 1.5 + s.makeable) * 10) / 7.5) / 10 })).sort((a, b) => b.total - a.total);
  return { scores, best: res.data.best, usd: res.usage.usd };
}

// ---------------------------------------------------------------------------------------------------------
// Render critique: ours next to the three nearest real thumbnails.

const Critique = z.object({
  fused: z.enum(["fused_idea", "partly_fused", "collage"]),
  ideaReads: z.boolean().describe("the idea is understood in one second at phone size"),
  empty: z.string().describe("areas that are empty, flat, dim or blurred, or 'none'"),
  perReference: z.array(z.object({ ref: z.number(), doesThatOursDoesNot: z.string() })),
  craft: z.array(z.string()).describe("visible craft faults: soft or low-resolution subject, pasted-looking cut-out, muddy grade, fire or texture covering what matters, lettering unlike the channel's…"),
  score: z.number().describe("0–10 against these real thumbnails: 7 = it would sit among them unnoticed, 9 = as good as the best of them"),
  fixes: z.array(z.string()).describe("the three changes that would raise the score most, most important first"),
});
export type ThumbCritique = z.infer<typeof Critique>;

/** The real thumbnails whose ideas are nearest in meaning (retrieve.ts); word overlap if that fails. */
export async function nearestRefsByMeaning(craft: ThumbCraft, hint: string, n = 3): Promise<ThumbDecon[]> {
  const idx = await nearestByMeaning(hint, craft.items.map((d) => `${d.idea} — ${d.fusion} — background: ${d.background}`), n, "real thumbnail idea");
  return idx.map((i) => craft.items[i]!).filter(Boolean);
}

export function nearestRefs(craft: ThumbCraft, hint: string, n = 3): ThumbDecon[] {
  const words = new Set(hint.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
  return [...craft.items]
    .map((d, k) => ({ d, k, s: [...new Set(`${d.idea} ${d.fusion} ${d.background} ${d.hero}`.toLowerCase().split(/[^a-z]+/))].filter((w) => words.has(w)).length }))
    .sort((a, b) => b.s - a.s || a.k - b.k)
    .slice(0, n)
    .map((x) => x.d);
}

export async function critiqueThumbnail(o: { channel: string; file: string; concept: string; refs: ThumbDecon[] }): Promise<{ critique: ThumbCritique; usd: number }> {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [k, r] of o.refs.entries()) blocks.push({ type: "text", text: `REAL THUMBNAIL ${k} — ${deconText(r)}` }, await b64img(r.file));
  blocks.push({ type: "text", text: `THE NEW THUMBNAIL (intended idea: ${o.concept}):` }, await b64img(o.file));
  const res = await structured({
    stage: "publish.critique",
    model: craftModel(),
    system: [plain(`You are the creative director of the YouTube channel ${o.channel}. Compare a new thumbnail with real ones from the channel, side by side. Be exact and hard — the real thumbnails are the standard. Ignore the channel's own logo or badge (the new one may not carry it).`)],
    user: blocks,
    schema: Critique,
    effort: "medium",
    maxTokens: 4000,
  });
  return { critique: res.data, usd: res.usage.usd };
}
