/**
 * Visual measurement: what kind of shot each frame is, labelled the same way for the reference channel's real
 * shots and for previews of ours. A film is then a mix of shot kinds, and that mix either sits inside the
 * channel's range or it does not (one toolkit on every shot is measurable: few kinds, one kind dominating).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

export const SHOT_KINDS = ["plain_footage", "words_over_footage", "caption_on_footage", "title_card", "picture_composition", "logo", "number_stat", "chart", "document_or_screen", "map", "comparison", "infographic", "quote_card"] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

const SYSTEM = `You label frames of documentary videos, one label set per numbered image. Judge only what is visible.
kind:
- plain_footage: filmed or archive footage (or a photo filling the frame) with no designed text or graphics on it.
- words_over_footage: footage with large words of the narration set over it (kinetic type), the words being the main event.
- caption_on_footage: footage with a small label, name tag or caption (who or what this is); the footage is the main event.
- title_card: big type on a designed or plain background, no footage and no main picture.
- picture_composition: photos or cut-out pictures arranged on a designed background (collage, framed print, cut-out person or product).
- logo: a company or product logo as the main subject.
- number_stat: a big figure, counter or statistic as the main subject.
- chart: a line, bar or pie chart, or a timeline.
- document_or_screen: a document, newspaper headline, web page, article, phone or computer screen.
- map: a map or route.
- comparison: two things set side by side or against each other.
- infographic: icons, diagrams, step flows or an illustration explaining something.
- quote_card: a quotation as text, usually with who said it.
words: how many words of text are readable in the frame (0 if none; ignore tiny watermarks).
pictures: how many distinct photographs or cut-out pictures are composed in the frame (footage filling the frame counts as 0).
layered: true if elements clearly sit at different depths (a cut-out over a background, a card over footage).`;

const Labels = z.object({ frames: z.array(z.object({ i: z.number(), kind: z.enum(SHOT_KINDS), words: z.number(), pictures: z.number(), layered: z.boolean() })) });
export interface ShotLabel { kind: ShotKind; words: number; pictures: number; layered: boolean }

/** Haiku vision, ten frames a call. A frame that cannot be labelled comes back as null. */
export async function labelShots(files: string[]): Promise<Array<ShotLabel | null>> {
  const out = new Array<ShotLabel | null>(files.length).fill(null);
  const parts: Array<{ from: number; items: string[] }> = [];
  for (let i = 0; i < files.length; i += 10) parts.push({ from: i, items: files.slice(i, i + 10) });
  for (let p = 0; p < parts.length; p += 6) {
    await Promise.all(
      parts.slice(p, p + 6).map(async (part) => {
        const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
        for (const [k, f] of part.items.entries()) {
          const data = await readFile(f).then((b) => b.toString("base64"), () => null);
          if (!data) continue;
          blocks.push({ type: "text", text: `[${k}]` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
        }
        if (!blocks.length) return;
        const res = await structured({ stage: "visual.label", model: MODELS.haiku, system: [plain(SYSTEM)], user: blocks, schema: Labels, effort: "low", maxTokens: 1500 }).catch(() => null);
        for (const l of res?.data.frames ?? []) if (l.i >= 0 && l.i < part.items.length) out[part.from + l.i] = { kind: l.kind, words: l.words, pictures: l.pictures, layered: l.layered };
      }),
    );
  }
  return out;
}

export interface VisualProfile {
  shots: number;
  share: Record<ShotKind, number>;
  /** How many different kinds of shot the film uses. */
  distinctKinds: number;
  /** Share of the single most used kind. */
  topShare: number;
  topKind: ShotKind;
  /** Share of shots with any readable text. */
  textShare: number;
  /** Median words on screen among shots that carry text. */
  wordsMedian: number;
  /** Share of shots that compose at least one separate picture. */
  pictureShare: number;
}

export function visualProfile(labels: Array<ShotLabel | null>): VisualProfile {
  const ls = labels.filter((l): l is ShotLabel => l !== null);
  const n = Math.max(1, ls.length);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const share = Object.fromEntries(SHOT_KINDS.map((k) => [k, r(ls.filter((l) => l.kind === k).length / n)])) as Record<ShotKind, number>;
  const top = [...SHOT_KINDS].sort((a, b) => share[b] - share[a])[0]!;
  const words = ls.filter((l) => l.words > 0).map((l) => l.words).sort((a, b) => a - b);
  return { shots: ls.length, share, distinctKinds: SHOT_KINDS.filter((k) => share[k] > 0).length, topShare: share[top], topKind: top, textShare: r(ls.filter((l) => l.words > 0).length / n), wordsMedian: words[Math.floor(words.length / 2)] ?? 0, pictureShare: r(ls.filter((l) => l.pictures > 0).length / n) };
}

type Range = { p10: number; p50: number; p90: number };
export interface VisualBand {
  schemaVersion: 1;
  channel: string;
  films: number;
  shots: number;
  /** The channel's overall mix of shot kinds (all labelled shots together). */
  mix: Record<ShotKind, number>;
  /** Per film (films with at least 12 labelled shots). */
  distinctKinds: Range;
  topShare: Range;
  textShare: Range;
  pictureShare: Range;
  wordsMedian: Range;
  plainFootage: Range;
  wordsOverFootage: Range;
  titleCard: Range;
}
const rangeOf = (xs: number[]): Range => {
  const v = [...xs].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0;
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
};

/** Built once from the exemplar library (data/exemplars/<channel>/index.json) into data/visual-profile/<channel>.json. */
export async function ensureVisualBand(o: { data: string; channelId: string; log?: (s: string) => void }): Promise<VisualBand | null> {
  const file = path.join(o.data, "visual-profile", `${o.channelId}.json`);
  const hit = await readFile(file, "utf8").then((t) => JSON.parse(t) as VisualBand, () => null);
  if (hit) return hit;
  const dir = path.join(o.data, "exemplars", o.channelId);
  const idx = await readFile(path.join(dir, "index.json"), "utf8").then((t) => JSON.parse(t) as { shots: Array<{ film: string; frames: string[] }> }, () => null);
  const shots = (idx?.shots ?? []).filter((s) => s.frames.length);
  if (shots.length < 40) return null;
  o.log?.(`  visual band: labelling ${shots.length} real shots of the channel (once)…`);
  const labels = await labelShots(shots.map((s) => path.join(dir, s.frames.at(-1)!)));
  const byFilm = new Map<string, Array<ShotLabel | null>>();
  shots.forEach((s, i) => byFilm.set(s.film, [...(byFilm.get(s.film) ?? []), labels[i]!]));
  const films = [...byFilm.values()].filter((l) => l.filter(Boolean).length >= 12).map(visualProfile);
  if (films.length < 4) return null;
  const all = visualProfile(labels);
  const band: VisualBand = { schemaVersion: 1, channel: o.channelId, films: films.length, shots: all.shots, mix: all.share, distinctKinds: rangeOf(films.map((f) => f.distinctKinds)), topShare: rangeOf(films.map((f) => f.topShare)), textShare: rangeOf(films.map((f) => f.textShare)), pictureShare: rangeOf(films.map((f) => f.pictureShare)), wordsMedian: rangeOf(films.map((f) => f.wordsMedian)), plainFootage: rangeOf(films.map((f) => f.share.plain_footage)), wordsOverFootage: rangeOf(films.map((f) => f.share.words_over_footage)), titleCard: rangeOf(films.map((f) => f.share.title_card)) };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(band, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
  return band;
}

export interface VisualIssue { kind: "few_kinds" | "one_kind_dominates" | "too_many_words_over_footage" | "too_many_title_cards" | "too_much_text" | "too_wordy" | "too_few_pictures"; detail: string }

/** What a film's shot mix misses against the channel's band (tolerance of one shot). */
export function visualIssues(p: VisualProfile, band: VisualBand): VisualIssue[] {
  const tol = Math.max(0.04, 1 / Math.max(1, p.shots));
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const out: VisualIssue[] = [];
  // Films are compared at similar length: the reference films were sampled at about 12–25 shots each.
  if (p.distinctKinds < band.distinctKinds.p10) out.push({ kind: "few_kinds", detail: `the film uses ${p.distinctKinds} kinds of shot; the channel's films use ${band.distinctKinds.p10}–${band.distinctKinds.p90}. Kinds it uses and ours does not: ${SHOT_KINDS.filter((k) => band.mix[k] >= 0.02 && p.share[k] === 0).map((k) => `${k} (${pc(band.mix[k])} of the channel's shots)`).join(", ") || "—"}.` });
  if (p.topShare > band.topShare.p90 + tol && p.topKind !== "plain_footage") out.push({ kind: "one_kind_dominates", detail: `${pc(p.topShare)} of the shots are "${p.topKind}"; in the channel's films the most used designed kind stays under ${pc(band.topShare.p90)}.` });
  if (p.share.words_over_footage > band.wordsOverFootage.p90 + tol) out.push({ kind: "too_many_words_over_footage", detail: `${pc(p.share.words_over_footage)} of the shots are narration words over footage; the channel: up to ${pc(band.wordsOverFootage.p90)}. Let more footage play clean, or carry the line with a picture, a figure or a document instead.` });
  if (p.share.title_card > band.titleCard.p90 + tol) out.push({ kind: "too_many_title_cards", detail: `${pc(p.share.title_card)} of the shots are type on a plain background; the channel: up to ${pc(band.titleCard.p90)}.` });
  if (p.textShare > band.textShare.p90 + tol) out.push({ kind: "too_much_text", detail: `${pc(p.textShare)} of the shots carry on-screen text; the channel: ${pc(band.textShare.p10)}–${pc(band.textShare.p90)}. The channel lets ${pc(band.plainFootage.p50)} of its shots play as clean footage.` });
  if (p.wordsMedian > band.wordsMedian.p90 + 2) out.push({ kind: "too_wordy", detail: `shots with text carry ${p.wordsMedian} words (median); the channel: ${band.wordsMedian.p10}–${band.wordsMedian.p90}.` });
  if (p.pictureShare < band.pictureShare.p10 - tol) out.push({ kind: "too_few_pictures", detail: `${pc(p.pictureShare)} of the shots compose a separate picture (a photo, a cut-out, a card); the channel: ${pc(band.pictureShare.p10)}–${pc(band.pictureShare.p90)}.` });
  return out;
}
