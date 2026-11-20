import { readFile } from "node:fs/promises";
import path from "node:path";
import { ThumbnailStyle, type ChannelId, type ScriptDraft } from "@opumia/contracts";
import { CHANNELS, discoverVideos, readJsonSafe, writeStableJson } from "@opumia/ingest";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";

const StyleSchema = z.object({
  rules: z.array(z.string()),
  palette: z.array(z.string()),
  textRules: z.object({ maxWords: z.number(), casing: z.string(), placement: z.enum(["top", "middle", "bottom"]), font: z.string() }),
  composition: z.string(),
  subject: z.string(),
  promptTemplate: z.string(),
});

/** Extract a channel's thumbnail rules from its top-viewed reference thumbnails (cached in data/thumbnail-styles). */
export async function thumbnailStyle(channelId: ChannelId, roots: { reference: string; data: string }, log: (s: string) => void = () => {}): Promise<ThumbnailStyle> {
  const out = path.join(roots.data, "thumbnail-styles", `${channelId}.json`);
  const prev = await readJsonSafe(out, 0);
  if (prev.ok) {
    const p = ThumbnailStyle.safeParse(prev.value);
    if (p.success) return p.data;
  }
  const ch = CHANNELS.find((c) => c.id === channelId)!;
  const vids = (await discoverVideos(roots.reference, ch)).sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 6);
  const imgs: Array<{ title: string; data: string; rel: string }> = [];
  for (const v of vids) {
    const candidates = [path.join(v.dir, "thumbnail.jpg"), v.infoPath?.replace(/\.info\.json$/, ".jpg")].filter((x): x is string => Boolean(x));
    for (const c of candidates) {
      try {
        imgs.push({ title: v.title, data: (await readFile(c)).toString("base64"), rel: path.relative(roots.reference, c) });
        break;
      } catch {
        /* try next */
      }
    }
  }
  if (!imgs.length) throw new Error(`no reference thumbnails found for ${channelId}`);
  log(`  thumbnail-style: analysing ${imgs.length} reference thumbnails (${MODELS.sonnet})…`);
  const { data } = await structured({
    stage: "thumbnail.style",
    model: MODELS.sonnet,
    system: [plain("You are a YouTube packaging designer. Derive reusable, specific thumbnail rules from a channel's best-performing thumbnails: composition, subject treatment, colour palette (hex), headline text (max words, casing, placement, weight), contrast, emotional cue. Then write a promptTemplate for an image model that produces ONLY the background/subject plate with NO text, NO logos, and NO identifiable real people (use objects, symbols, places, silhouettes or anonymous figures). Use {topic} and {subject} placeholders.")],
    user: [
      ...imgs.flatMap((im) => [
        { type: "text" as const, text: `Thumbnail for "${im.title}":` },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: im.data } },
      ]),
      { type: "text" as const, text: "Extract the channel's thumbnail style rules." },
    ],
    schema: StyleSchema,
    effort: "medium",
  });
  const style = ThumbnailStyle.parse({ schemaVersion: 1, channelId, ...data, textRules: { ...data.textRules, maxWords: Math.max(1, Math.round(data.textRules.maxWords)) }, references: imgs.map((i) => i.rel), generatedAt: new Date().toISOString() });
  await writeStableJson(out, ThumbnailStyle, style, [roots.reference]);
  return style;
}

const BriefSchema = z.object({
  imagePrompt: z.string(),
  headline: z.string(),
  accentWord: z.string(),
  subject: z.string(),
});
export type ThumbnailBrief = z.infer<typeof BriefSchema>;

/** Turn the style rules + script into an image prompt (no text, no real faces) and a headline to composite. */
export async function thumbnailBrief(style: ThumbnailStyle, draft: ScriptDraft, aspect: string): Promise<ThumbnailBrief> {
  const { data } = await structured({
    stage: "thumbnail.brief",
    model: MODELS.haiku,
    system: [plain(`Write a thumbnail brief following these channel rules:\n${JSON.stringify(style)}\nThe image model draws only the plate: no text, no logos, no watermarks, no identifiable real people. The headline (max ${style.textRules.maxWords} words, ${style.textRules.casing}) is composited later; accentWord is one word of the headline to colour.`)],
    user: `Video title: ${draft.title}\nHook: ${draft.segments[0]?.text}\nAspect: ${aspect}`,
    schema: BriefSchema,
    effort: "low",
  });
  return data;
}
