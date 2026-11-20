import { readdir } from "node:fs/promises";
import path from "node:path";
import { StyleProfile, type ChannelId } from "@opumia/contracts";
import { CHANNELS, discoverVideos, readJsonSafe } from "@opumia/ingest";

/**
 * A deterministic, cacheable text bundle describing how a reference channel writes.
 * Byte-stable across runs (sorted inputs, no timestamps) so the prompt-cache prefix holds.
 */
export interface StylePack {
  channelId: ChannelId;
  profile: StyleProfile;
  text: string;
  sources: string[];
}

interface StoryLabel {
  film: string;
  main_character?: string;
  hook?: { type?: string; summary?: string; until_s?: number };
  thesis?: { text?: string };
  chapters?: Array<{ title?: string; role?: string }>;
  twist?: { summary?: string };
  ending?: { type?: string; summary?: string } | string;
  open_loops?: Array<{ text?: string }>;
}

const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;

export async function buildStylePack(channelId: ChannelId, roots: { reference: string; data: string }): Promise<StylePack> {
  const ch = CHANNELS.find((c) => c.id === channelId);
  if (!ch) throw new Error(`unknown channel ${channelId}`);
  const sources: string[] = [];

  const profRaw = await readJsonSafe(path.join(roots.data, "style-profiles", `${channelId}.json`), 0);
  if (!profRaw.ok) throw new Error(`style profile missing for ${channelId}; run \`opumia analyze-styles\``);
  const profile = StyleProfile.parse(profRaw.value);
  sources.push(`data/style-profiles/${channelId}.json`);
  const { generatedAt: _g, ...profileStable } = profile;

  const analysis = path.join(roots.reference, ".analysis");
  const prefix = ch.metaPrefix ?? "";

  // Technique cards written for this channel's films.
  let cards: unknown = null;
  for (const f of (await readdir(path.join(analysis, "playbook")).catch(() => [] as string[])).filter((x) => /^answer_\d+\.json$/.test(x)).sort()) {
    const j = await readJsonSafe<{ films?: Array<{ film: string }>; cards?: unknown[] }>(path.join(analysis, "playbook", f), 0);
    if (!j.ok) continue;
    const films = j.value.films ?? [];
    const match = prefix ? films.some((x) => x.film.startsWith(`${prefix}-`)) : films.some((x) => /^\d{2}$/.test(x.film));
    if (match) {
      cards = j.value;
      sources.push(`Reference/.analysis/playbook/${f}`);
      break;
    }
  }
  const fam = await readJsonSafe<unknown>(path.join(analysis, "playbook", "families.json"), 0);
  if (fam.ok) sources.push("Reference/.analysis/playbook/families.json");

  // Condensed story labels (hook type, thesis, chapter roles, twist, ending) per film.
  const labels: string[] = [];
  const storyFiles = (await readdir(path.join(analysis, "story")).catch(() => [] as string[]))
    .filter((f) => (prefix ? f.startsWith(`${prefix}-`) : /^\d{2}\.json$/.test(f)))
    .sort();
  for (const f of storyFiles) {
    const j = await readJsonSafe<StoryLabel>(path.join(analysis, "story", f), 0);
    if (!j.ok) continue;
    const s = j.value;
    const ending = typeof s.ending === "string" ? s.ending : s.ending ? `${s.ending.type ?? ""}: ${s.ending.summary ?? ""}` : "";
    labels.push(
      [
        `## ${s.film} — ${s.main_character ?? ""}`,
        `hook (${s.hook?.type ?? "?"}, until ${s.hook?.until_s ?? "?"}s): ${s.hook?.summary ?? ""}`,
        `thesis: ${s.thesis?.text ?? ""}`,
        `beats: ${(s.chapters ?? []).map((c) => c.role).filter(Boolean).join(" → ")}`,
        `twist: ${s.twist?.summary ?? ""}`,
        `open loops: ${(s.open_loops ?? []).map((o) => o.text).filter(Boolean).slice(0, 3).join(" | ")}`,
        `ending: ${ending}`,
      ].join("\n"),
    );
  }
  if (labels.length) sources.push(`Reference/.analysis/story/${prefix || "NN"}-*.json`);

  // Real cold opens (first ~25 s of narration) — rhythm reference only.
  const opens: string[] = [];
  const videos = (await discoverVideos(roots.reference, ch)).sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 8);
  for (const v of videos) {
    if (!v.transcriptFile?.endsWith(".json")) continue;
    const w = await readJsonSafe<{ words?: Array<{ word: string; start: number }> }>(v.transcriptFile, 0);
    if (!w.ok || !w.value.words) continue;
    const words = w.value.words.filter((x) => x.start < 25).map((x) => x.word);
    if (words.length > 20) opens.push(`- "${v.title}": ${words.join(" ")}`);
  }
  if (opens.length) sources.push(`${ch.dir}/**/pretrain.json (first 25 s, top-viewed 8)`);

  const text = [
    `# CHANNEL STYLE PACK: ${ch.displayName} (${channelId})`,
    `This pack describes how the reference channel writes and paces its documentaries. Use it to match the hook formula, act structure, pacing and rhetorical tone. It is a style reference: never copy its sentences, facts or topics.`,
    `\n# 1. MEASURED STYLE PROFILE (JSON)\n${JSON.stringify(stable(profileStable))}`,
    cards ? `\n# 2. STORY TECHNIQUE CARDS FOR THIS CHANNEL (JSON)\n${JSON.stringify(stable(cards))}` : "",
    fam.ok ? `\n# 3. STORY FAMILIES (spines and beat shares)\n${JSON.stringify(stable(fam.value))}` : "",
    labels.length ? `\n# 4. STORY LABELS OF ${labels.length} REFERENCE FILMS\n${labels.join("\n\n")}` : "",
    opens.length ? `\n# 5. REAL COLD OPENS (first 25 s, transcribed) — study rhythm and sentence length only\n${opens.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { channelId, profile, text, sources };
}
