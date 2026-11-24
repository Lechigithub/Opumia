import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StyleProfile, type ChannelId } from "@opumia/contracts";
import { CHANNELS, discoverVideos, readJsonSafe } from "@opumia/ingest";
import { loadChannelProfile } from "./channel-profile.js";
import { beatLibrary, beatText, captionPolicy, grammarText, visualGrammar, type BeatPassage, type CaptionPolicy, type GrammarRow } from "./reference-grammar.js";

/**
 * A deterministic, cacheable text bundle describing how a reference channel writes.
 * Byte-stable across runs (sorted inputs, no timestamps) so the prompt-cache prefix holds.
 */
export interface StylePack {
  channelId: ChannelId;
  profile: StyleProfile;
  text: string;
  sources: string[];
  /** Learned from the reference: whether long-form burns word captions (most documentary channels don't). */
  captions: CaptionPolicy;
  /** Hand-labelled reference shots joined with their narration (what the editor showed over each line). */
  grammar: GrammarRow[];
  /** Real narration passages per story role. */
  beats: BeatPassage[];
}

interface StoryLabel {
  film: string;
  main_character?: string;
  hook?: { type?: string; summary?: string; until_s?: number };
  thesis?: { text?: string };
  chapters?: Array<{ title?: string; role?: string }>;
  ending?: { type?: string; summary?: string } | string;
  open_loops?: Array<{ text?: string; opened_i?: number; opened_t0?: number }>;
  twist?: { summary?: string; i?: number; t0?: number };
}

const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;

/**
 * Build (locally, from Reference/) or load (cloud, from data/style-packs/) the channel style pack.
 * Building always refreshes the cache file so the cloud container never needs the Reference tree.
 */
export async function buildStylePack(channelId: ChannelId, roots: { reference: string; data: string }): Promise<StylePack> {
  const cacheFile = path.join(roots.data, "style-packs", `${channelId}.json`);
  const haveReference = await stat(path.join(roots.reference, ".analysis")).then(() => true, () => false);
  if (!haveReference) {
    const c = await readJsonSafe<{ channelId: ChannelId; text: string; sources: string[]; captions?: CaptionPolicy; grammar?: GrammarRow[]; beats?: BeatPassage[] }>(cacheFile, 0);
    if (!c.ok) throw new Error(`Reference/ not available and no cached style pack at ${cacheFile}`);
    const prof = await readJsonSafe(path.join(roots.data, "style-profiles", `${channelId}.json`), 0);
    if (!prof.ok) throw new Error(`style profile missing for ${channelId}`);
    return { channelId, profile: StyleProfile.parse(prof.value), text: c.value.text, sources: c.value.sources, captions: c.value.captions ?? { burnLongForm: false, bottomTextShare: 0, films: 0 }, grammar: c.value.grammar ?? [], beats: c.value.beats ?? [] };
  }
  const pack = await buildFromReference(channelId, roots);
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ channelId, text: pack.text, sources: pack.sources, captions: pack.captions, grammar: pack.grammar, beats: pack.beats }) + "\n");
  return pack;
}

async function buildFromReference(channelId: ChannelId, roots: { reference: string; data: string }): Promise<StylePack> {
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

  const devices = await narrativeDevices(analysis, storyFiles);
  if (devices) sources.push(`Reference/.analysis/story_in/${prefix || "NN"}-*.txt (sentence transcripts)`);
  const captions = await captionPolicy(roots.reference, channelId);
  sources.push(`${ch.dir}/**/pretrain.json shot OCR (caption policy: burn=${captions.burnLongForm}, lower-band caption share ${captions.bottomTextShare})`);
  const grammar = await visualGrammar(roots.reference, channelId, ch.metaPrefix);
  if (grammar.length) sources.push(`Reference/.analysis/designed/answer_*.json (${grammar.length} labelled shots) × pretrain words`);
  const beats = await beatLibrary(roots.reference, storyFiles);

  // The unified channel profile (every shot of every film, by position, relationships, variety, views).
  const cp = await loadChannelProfile(roots.data, channelId);
  if (cp) sources.push(`data/channel-profile/${channelId}.json (v${cp.version}, ${cp.corpus.shots} shots)`);
  const unified = cp
    ? `\n# 1b. UNIFIED CHANNEL PROFILE v${cp.version} — measured on all ${cp.corpus.shots} shots of ${cp.corpus.films} films (overrides section 1 where they differ)\n${cp.directives.map((d) => `- ${d}`).join("\n")}\nBy position (pooled): ${JSON.stringify(stable(Object.fromEntries(Object.entries(cp.byPosition).map(([k, v]) => [k, { cutsPerMin: v.pooled.cutsPerMin, shotMedianS: v.pooled.shotMedianS, textSlam: v.pooled.textSlam, picture: v.pooled.picture, hitsPerMin: v.pooled.hitsPerMin }]))))}\nLine → picture: ${JSON.stringify(stable(cp.relations.lineToPicture))}`
    : "";
  const text = [
    `# CHANNEL STYLE PACK: ${ch.displayName} (${channelId})`,
    `This pack describes how the reference channel writes and paces its documentaries. Use it to match the hook formula, act structure, pacing and rhetorical tone. Reproduce how it writes as exactly as you can: hook formula, act and story structure, beat order, sentence shapes and length, rhetoric and tone. Any topic is open. Only two limits: never reuse its sentences word for word, and every fact comes from this film's verified fact sheet.`,
    `\n# 1. MEASURED STYLE PROFILE (JSON)\n${JSON.stringify(stable(profileStable))}`,
    unified,
    cards ? `\n# 2. STORY TECHNIQUE CARDS FOR THIS CHANNEL (JSON)\n${JSON.stringify(stable(cards))}` : "",
    fam.ok ? `\n# 3. STORY FAMILIES (spines and beat shares)\n${JSON.stringify(stable(fam.value))}` : "",
    labels.length ? `\n# 4. STORY LABELS OF ${labels.length} REFERENCE FILMS\n${labels.join("\n\n")}` : "",
    opens.length ? `\n# 5. REAL COLD OPENS (first 25 s, transcribed) — study rhythm and sentence length only\n${opens.join("\n")}` : "",
    devices ?? "",
    grammarText(grammar),
    beatText(beats),
  ]
    .filter(Boolean)
    .join("\n");
  return { channelId, profile, text, sources, captions, grammar, beats };
}

/** Sentence-level transcript: "[i] 12.3s text" lines → index → {t, text}. */
async function readSentences(file: string): Promise<Map<number, { t: number; text: string }>> {
  const { readFile } = await import("node:fs/promises");
  const m = new Map<number, { t: number; text: string }>();
  const raw = await readFile(file, "utf8").catch(() => "");
  for (const line of raw.split(/\r?\n/)) {
    const x = /^\[(\d+)\] ([\d.]+)s (.*)$/.exec(line);
    if (x) m.set(Number(x[1]), { t: Number(x[2]), text: x[3]!.trim() });
  }
  return m;
}

export const TENSION = /(^(but|however|unfortunately|and yet|yet|still|instead|except)\b|little did|there was (just )?(one|a) (tiny )?problem|would soon|was about to|had no idea|but then|the problem was|but that's not|didn't know|what happened next|or did (he|she|they)\?|things were about to|it wouldn't last|\?$)/i;
export const CONTRAST = /(\$[\d.,]+ ?(billion|million|trillion)|\d+(\.\d+)? ?(billion|million|%)).*\b(more than|bigger than|larger than|than the|compared|times (more|bigger|the)|every person|combined|double|triple|twice|half (of|its)|outsold|every other|nearly|almost)\b/i;

/**
 * Measured narrative devices + few-shot excerpts from the channel's sentence transcripts and story labels:
 * how cold opens start (in media res vs chronological), how often a tension marker lands, and real lines for
 * open loops, twists and contrast/scale framing. Deterministic (sorted films, fixed caps).
 */
async function narrativeDevices(analysis: string, storyFiles: string[]): Promise<string | null> {
  const hookTypes = new Map<string, number>();
  const hookEnds: number[] = [];
  const gaps: number[] = [];
  let chrono = 0;
  let films = 0;
  const coldOpens: string[] = [];
  const pivots: string[] = [];
  const loops: string[] = [];
  const twists: string[] = [];
  const contrasts: string[] = [];
  const hookEx = new Map<string, string[]>();
  const endEx = new Map<string, string[]>();
  for (const f of storyFiles) {
    const j = await readJsonSafe<StoryLabel & { thesis?: { i?: number; text?: string } }>(path.join(analysis, "story", f), 0);
    if (!j.ok) continue;
    const s = j.value;
    const sents = await readSentences(path.join(analysis, "story_in", f.replace(/\.json$/, ".txt")));
    if (!sents.size) continue;
    films++;
    hookTypes.set(s.hook?.type ?? "other", (hookTypes.get(s.hook?.type ?? "other") ?? 0) + 1);
    const ht = s.hook?.type ?? "other";
    if (s.hook?.summary && (hookEx.get(ht)?.length ?? 0) < 2) hookEx.set(ht, [...(hookEx.get(ht) ?? []), s.hook.summary.slice(0, 160)]);
    const en = typeof s.ending === "object" && s.ending ? s.ending : undefined;
    if (en?.type && en.summary && (endEx.get(en.type)?.length ?? 0) < 2) endEx.set(en.type, [...(endEx.get(en.type) ?? []), en.summary.slice(0, 160)]);
    if (typeof s.hook?.until_s === "number") hookEnds.push(s.hook.until_s);
    const ordered = [...sents.entries()].sort((a, b) => a[0] - b[0]);
    if (/\b(1[6-9]\d\d)\b/.test(ordered[0]?.[1].text ?? "") && !/\b20\d\d\b/.test(ordered[0]?.[1].text ?? "")) chrono++;
    const thesisI = s.thesis?.i ?? 3;
    if (coldOpens.length < 10) coldOpens.push(`- [${s.film}, hook=${s.hook?.type}] ${ordered.filter(([i]) => i <= thesisI).map(([, x]) => x.text).join(" ").slice(0, 700)}`);
    const after = sents.get(thesisI + 1)?.text;
    if (after && pivots.length < 10) pivots.push(`- ${after.slice(0, 220)}`);
    for (const o of (s.open_loops ?? []).slice(0, 2)) {
      const line = typeof o.opened_i === "number" ? sents.get(o.opened_i)?.text : undefined;
      if (line && loops.length < 30) loops.push(`- ${line.slice(0, 220)}`);
    }
    const tw = typeof s.twist?.i === "number" ? sents.get(s.twist.i)?.text : undefined;
    if (tw && twists.length < 12) twists.push(`- ${tw.slice(0, 220)}`);
    const marks = ordered.filter(([, x]) => TENSION.test(x.text)).map(([, x]) => x.t);
    for (let k = 1; k < marks.length; k++) gaps.push(marks[k]! - marks[k - 1]!);
    for (const [, x] of ordered) if (CONTRAST.test(x.text) && contrasts.length < 14) contrasts.push(`- ${x.text.slice(0, 240)}`);
  }
  if (!films) return null;
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const p75 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.75)] ?? 0;
  const hooks = [...hookTypes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(", ");
  return [
    `\n# 6. NARRATIVE DEVICES (measured on ${films} films' sentence transcripts)`,
    `- Cold open: hook types ${hooks}. The hook runs to a median ${Math.round(med(hookEnds))} s, then a one-line thesis ("This is the story of…"). Only ${chrono}/${films} films open with an old date — the channel opens IN MEDIA RES (the peak, the paradox, the stakes), and only AFTER the thesis jumps back ("The story begins in…").`,
    `- Tension loops: a tension turn (a "But…/However…/And yet…" reversal, a question, "little did", "there was one problem", "would soon", "had no idea") lands every ${Math.round(med(gaps))} s at the median (p75 ${Math.round(p75(gaps))} s). Every beat ends by opening the next question; payoffs come later.`,
    `- Contrast & scale: numbers are almost never bare — they are framed against a rival, a country, a lifetime or "every person on the planet".`,
    `\n## 6a. REAL COLD OPENS UP TO THE THESIS (open the way these open, as exactly as you can; never reuse the words)\n${coldOpens.join("\n")}`,
    `\n## 6b. THE PIVOT AFTER THE THESIS (how the flashback starts)\n${pivots.join("\n")}`,
    `\n## 6c. OPEN-LOOP / CLIFFHANGER LINES\n${loops.join("\n")}`,
    `\n## 6d. TWIST LINES\n${twists.join("\n")}`,
    `\n## 6e. CONTRAST & SCALE FRAMING LINES\n${contrasts.join("\n")}`,
    `\n# 7. BLUEPRINT CATALOG (labelled archetypes; pick per film, never by habit)`,
    `## 7a. COLD-OPEN ARCHETYPES (count · examples)`,
    ...[...hookEx.entries()].sort((a, b) => (hookTypes.get(b[0]) ?? 0) - (hookTypes.get(a[0]) ?? 0) || a[0].localeCompare(b[0])).map(([k, ex]) => `- ${k} (${hookTypes.get(k) ?? 0}): ${ex.join(" | ")}`),
    `## 7b. ENDING ARCHETYPES (examples)`,
    ...[...endEx.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, ex]) => `- ${k}: ${ex.join(" | ")}`),
  ].join("\n");
}
