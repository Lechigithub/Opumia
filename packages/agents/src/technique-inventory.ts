/**
 * The craft inventory (owner, 2026-11-23: "unless I ask they will not be discovered"): the platform discovers what the
 * channel does instead of waiting for a failure to show it.
 *
 *  1. DISCOVER (`discoverTechniques`): a model watches real stretches of the channel — 16 frames across 10 seconds,
 *     with the words spoken, the measured hits, music cues and drop-outs — and names EVERY technique it sees (picture,
 *     motion, type, edit, sound), open-vocabulary. The names are merged into one taxonomy with definitions.
 *  2. RATE (`labelTechniques` → `ensureTechniqueBand`): the same labeller counts each technique on many real stretches
 *     → how often the channel uses it per minute, and in what share of stretches.
 *  3. MAP (`mapTechniquesToTools`): each technique against what the platform can make and which agent owns it.
 *  4. COVER (`techniqueCoverage`): our film measured with the same labeller → per technique: the channel's rate, ours,
 *     whether a tool exists and who uses it. Missing tools are build items; tools not used are agent and gate items.
 * Everything is cached in data/technique-inventory/<channel>/.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelId } from "@opumia/contracts";
import { run } from "@opumia/senses";
import * as z from "zod/v4";
import { filmVideo } from "./clip-judge.js";
import { MODELS, ROLE_MODEL, plain, structured } from "./llm.js";
import { loadReferenceIndex } from "./reference-index.js";

export const TECH_CATEGORIES = ["picture", "motion", "type", "data", "edit", "sound", "structure"] as const;
export interface Technique { id: string; name: string; category: (typeof TECH_CATEGORIES)[number]; definition: string; seeIn: string }
export interface TechniqueBand { channel: string; stretches: number; seconds: number; techniques: Array<{ id: string; perMin: number; share: number; perMinBand: { p10: number; median: number; p90: number } }>; builtAt: string }

const dirOf = (data: string, channel: string) => path.join(data, "technique-inventory", channel);
/** Owner decision (2026-11-23): techniques we never make — the channel's own corner logo / watermark bug. They are left
 *  out of the inventory entirely: not rated, not briefed, not checked, never listed as missing. */
const EXCLUDED = /watermark|logo bug|corner logo|channel (bug|logo|brand)/i;
export const excludedTechnique = (t: { id: string; name: string }) => EXCLUDED.test(t.name) || EXCLUDED.test(t.id.replace(/_/g, " "));
const save = async (f: string, v: unknown) => {
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify(v, null, 1) + "\n");
  await rename(f + ".tmp", f);
};
const load = async <T>(f: string): Promise<T | null> => (existsSync(f) ? (JSON.parse(await readFile(f, "utf8")) as T) : null);

/** A stretch as the model sees it: 16 frames across `len` seconds (4×4, left to right, top to bottom). */
export async function stretchSheet(video: string, fromS: number, len: number, out: string): Promise<string | null> {
  if (existsSync(out)) return out;
  await mkdir(path.dirname(out), { recursive: true });
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", fromS.toFixed(2), "-t", len.toFixed(2), "-i", video, "-vf", `fps=${(16 / len).toFixed(4)},scale=320:-2,tile=4x4`, "-frames:v", "1", "-q:v", "4", out]).catch(() => null);
  return existsSync(out) ? out : null;
}
const image = async (f: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(f)).toString("base64") } });

interface RefStretch { film: string; video: string; fromS: number; len: number; text: string }
/** Real stretches spread over the channel's films and positions (opening, middle, late), deterministic. */
async function realStretches(o: { data: string; reference: string; channel: ChannelId; n: number; len: number; salt: string }): Promise<RefStretch[]> {
  const ix = await loadReferenceIndex(o.data);
  if (!ix) return [];
  const audio = await readFile(path.join(o.data, "reference-index", "audio.jsonl"), "utf8").then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { film: string; hits: Array<{ t: number; cls: string }> }), () => []);
  const films = ix.manifest.films.filter((f) => f.channel === o.channel && f.durS > 120).sort((a, b) => createHash("sha1").update(o.salt + a.id).digest("hex").localeCompare(createHash("sha1").update(o.salt + b.id).digest("hex")));
  const out: RefStretch[] = [];
  for (let k = 0; out.length < o.n && k < o.n * 3; k++) {
    const f = films[k % films.length]!;
    const video = await filmVideo(o.reference, o.data, f.id);
    if (!video) continue;
    const q = [0.03, 0.2, 0.4, 0.6, 0.8][Math.floor(k / films.length) % 5]!;
    const fromS = Math.max(0, f.durS * q);
    const toS = fromS + o.len;
    const shots = ix.shots.filter((s) => s.film === f.id && s.t1 > fromS && s.t0 < toS);
    const hits = (audio.find((a) => a.film === f.id)?.hits ?? []).filter((h) => h.t >= fromS && h.t < toS);
    const text = [
      `Words spoken: "${shots.map((s) => s.line).join(" ").slice(0, 400)}"`,
      `Cuts at: ${shots.map((s) => (s.t0 - fromS).toFixed(1)).filter((t) => Number(t) > 0).join(", ") || "none"} s`,
      `Sound effects (measured): ${hits.map((h) => `${h.cls} at ${(h.t - fromS).toFixed(1)} s`).join(", ") || "none"}`,
      `Music: ${shots.some((s) => s.cueChange) ? "a music cue changes in this stretch" : "one bed"}${shots.some((s) => s.musicDrop) ? "; the music drops out" : ""}`,
    ].join("\n");
    out.push({ film: f.id, video, fromS, len: o.len, text });
  }
  return out;
}

const Seen = z.object({ techniques: z.array(z.object({ name: z.string().describe("a short canonical name, e.g. 'extruded 3D title', 'whip pan transition', 'duotone portrait cut-out', 'map with animated route'"), category: z.enum(TECH_CATEGORIES), evidence: z.string().describe("where in the stretch (frame numbers or seconds) and what exactly is seen or heard") })) });
const DISCOVER_SYSTEM = `You are a senior motion designer and editor taking apart a YouTube documentary channel's craft. You are shown 16 frames across a short stretch of one of its real films (left to right, top to bottom, evenly spaced), the words spoken over it, where the cuts fall, and the measured sound effects and music events.
Name EVERY technique used — be exhaustive and concrete. Include: how pictures are treated (grades, duotone, cut-outs, collage, textures, grain, light leaks, vignette, paper), how things move (camera moves, parallax, 2.5D, 3D objects or type, speed ramps, shakes, zoom punches, tracking text, masks, reveals), how words are set (size, placement in the picture, kinetic type, highlights, stencils, labels), how data is shown (numbers, counters, charts, maps, icons, timelines, documents, screenshots), how it is cut (cut rhythm, transitions such as whips, flashes, glitches, match cuts, freeze frames), sound (hits, risers, music changes, drop-outs, silence, foley) and structure (title cards, chapter cards, recurring visual motifs). One entry per distinct technique; never a vague one ("good editing").`;

/** Step 1: open-vocabulary discovery on real stretches (Sonnet), merged into one taxonomy (Sonnet). */
export async function discoverTechniques(o: { data: string; reference: string; channel: ChannelId; n?: number; fresh?: boolean; log?: (s: string) => void }): Promise<Technique[]> {
  const f = path.join(dirOf(o.data, o.channel), "taxonomy.json");
  if (!o.fresh) {
    const hit = await load<Technique[]>(f);
    if (hit) return hit.filter((t) => !excludedTechnique(t));
  }
  const st = await realStretches({ data: o.data, reference: o.reference, channel: o.channel, n: o.n ?? 30, len: 10, salt: "discover" });
  o.log?.(`  techniques: watching ${st.length} real stretches of ${o.channel}…`);
  const raw: Array<{ name: string; category: string; evidence: string }> = [];
  for (let i = 0; i < st.length; i += 5) {
    await Promise.all(st.slice(i, i + 5).map(async (s, k) => {
      const sheet = await stretchSheet(s.video, s.fromS, s.len, path.join(dirOf(o.data, o.channel), "sheets", `${s.film}_${s.fromS.toFixed(0)}.jpg`));
      if (!sheet) return;
      const r = await structured({ stage: "techniques.discover", model: MODELS.sonnet, system: [plain(DISCOVER_SYSTEM)], user: [await image(sheet), { type: "text", text: s.text }], schema: Seen, effort: "medium", maxTokens: 4000 }).catch(() => null);
      for (const t of r?.data.techniques ?? []) raw.push(t);
      o.log?.(`    stretch ${i + k + 1}: ${r?.data.techniques.length ?? 0} techniques`);
    }));
  }
  const Tax = z.object({ techniques: z.array(z.object({ id: z.string().describe("snake_case"), name: z.string(), category: z.enum(TECH_CATEGORIES), definition: z.string().describe("one sentence a labeller can apply"), seeIn: z.string().describe("how to recognise it in a 16-frame sheet plus the listed sound events") })) });
  const r = await structured({ stage: "techniques.taxonomy", model: MODELS.sonnet, system: [plain("You merge technique sightings from many stretches of one documentary channel into ONE taxonomy: merge synonyms and near-duplicates, keep distinct techniques apart (a 3D extruded title is not a flat title; a whip pan is not a flash cut), drop vague entries. Aim for 40–80 techniques, each something a designer or editor could deliberately make. Keep ones seen only once if they are specific.")], user: raw.map((t) => `- [${t.category}] ${t.name}: ${t.evidence.slice(0, 160)}`).join("\n"), schema: Tax, effort: "medium", maxTokens: 16000 });
  const tax = r.data.techniques.map((t) => ({ ...t, id: t.id.replace(/[^a-z0-9_]/gi, "_").toLowerCase() })).filter((t) => !excludedTechnique(t));
  await save(f, tax);
  await save(path.join(dirOf(o.data, o.channel), "sightings.json"), raw);
  return tax;
}

const Counts = z.object({ seen: z.array(z.object({ id: z.string(), count: z.number().describe("how many times in this stretch (an instance per shot or per event)") })) });
/** Step 2's labeller, the same for real stretches and ours: which techniques appear in a stretch, and how often. */
export async function labelTechniques(o: { sheet: string; text: string; taxonomy: Technique[] }): Promise<Record<string, number>> {
  const r = await structured({
    stage: "techniques.label", model: ROLE_MODEL.labels,
    system: [plain(`You label a short stretch of a documentary (16 frames across ~10 seconds, left to right, top to bottom, plus the words, cuts and measured sound events) with the techniques it uses, from this list only. Count an instance per shot or per event. Be strict: mark a technique only when you can see (or the sound list shows) it.\n\n${o.taxonomy.map((t) => `${t.id} — ${t.name}: ${t.definition} (see: ${t.seeIn})`).join("\n")}`)],
    user: [await image(o.sheet), { type: "text", text: o.text }], schema: Counts, effort: "low", maxTokens: 2500,
  }).catch(() => null);
  const ids = new Set(o.taxonomy.map((t) => t.id));
  const out: Record<string, number> = {};
  for (const s of r?.data.seen ?? []) if (ids.has(s.id) && s.count > 0) out[s.id] = (out[s.id] ?? 0) + Math.min(10, Math.round(s.count));
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.round((s.length - 1) * p))]! : 0;
};

/** Step 2: the channel's rate of every technique (per minute; share of stretches), over many real stretches. */
export async function ensureTechniqueBand(o: { data: string; reference: string; channel: ChannelId; taxonomy: Technique[]; n?: number; fresh?: boolean; log?: (s: string) => void }): Promise<TechniqueBand> {
  const f = path.join(dirOf(o.data, o.channel), "band.json");
  if (!o.fresh) {
    const hit = await load<TechniqueBand>(f);
    if (hit) return { ...hit, techniques: hit.techniques.filter((b) => o.taxonomy.some((t) => t.id === b.id)) };
  }
  const st = await realStretches({ data: o.data, reference: o.reference, channel: o.channel, n: o.n ?? 80, len: 10, salt: "band" });
  o.log?.(`  techniques: rating ${o.taxonomy.length} techniques on ${st.length} real stretches…`);
  const rows: Array<Record<string, number>> = [];
  for (let i = 0; i < st.length; i += 8)
    await Promise.all(st.slice(i, i + 8).map(async (s) => {
      const sheet = await stretchSheet(s.video, s.fromS, s.len, path.join(dirOf(o.data, o.channel), "sheets", `${s.film}_${s.fromS.toFixed(0)}.jpg`));
      if (sheet) rows.push(await labelTechniques({ sheet, text: s.text, taxonomy: o.taxonomy }));
    }));
  const minutes = (rows.length * 10) / 60;
  const band: TechniqueBand = {
    channel: o.channel, stretches: rows.length, seconds: rows.length * 10,
    techniques: o.taxonomy.map((t) => {
      const per = rows.map((r) => ((r[t.id] ?? 0) * 60) / 10);
      return { id: t.id, perMin: Math.round((rows.reduce((a, r) => a + (r[t.id] ?? 0), 0) / Math.max(1e-6, minutes)) * 100) / 100, share: Math.round((rows.filter((r) => r[t.id]).length / Math.max(1, rows.length)) * 1000) / 1000, perMinBand: { p10: pct(per, 0.1), median: pct(per, 0.5), p90: pct(per, 0.9) } };
    }).sort((a, b) => b.perMin - a.perMin),
    builtAt: new Date().toISOString(),
  };
  await save(f, band);
  return band;
}

// ---- step 3: what the platform can make, and who makes it

/**
 * What the platform can make today, by owner — kept next to the code that makes it. A technique is matched against
 * this catalogue (`mapTechniquesToTools`); when a tool is added, its line is added here.
 */
export const CAPABILITIES: Array<{ id: string; owner: string; can: string }> = [
  { id: "footage", owner: "picture researcher", can: "real footage and photos from stock, archives, press (YouTube excerpts), Wikipedia; clean full-frame footage; public-domain feature films and period cinematic clips from the library as film-clip / reenactment B-roll; staged stock reenactments with anonymous actors" },
  { id: "camera", owner: "director / editor", can: "slow zoom in or out (ken burns), a lateral move travelling across a wide picture or clip (tracking pan), a punch-in reframe up to 2x for an extreme close-up insert on high-resolution footage (and stock searched for macro shots), a pull-back reveal; 2.5D parallax: a photo card over its background, and a cut-out subject over its own picture with every element moving at its own depth" },
  { id: "worlds", owner: "scene designer", can: "treated backdrops built from real pictures: black-and-white with a colour accent, duotone, collage, paper and print (tinted), a terminal/UI screen, a bold flat colour field, a radial burst, a filmstrip with sprocket holes sliding frame to frame, a contact-sheet grid of rounded cells with grout and neighbours at the edges sliding to the next cell, a split screen of two pictures with a bar between, a stylised gradient / nebula ground with a picture as a silhouette skyline, a built 3D room (Three.js) with the picture on its lit back wall and the camera dollying in" },
  { id: "photo_grades", owner: "scene designer / colourist", can: "picture grades: natural, mono, high-contrast black and white, duotone, punch, sepia, split tone, negative (inverted), low-key moody, warm golden glow, thermal false colour, solarise; footage tinted in a duotone or wash of the film's colours; a two-tone complementary grade (cool ground, warm pictures in front); a photo laid over the frame as a double exposure; grain, vignette, light leak and halftone / grunge dot finish on any shot" },
  { id: "photo_frames", owner: "scene designer", can: "a placed picture as a white-bordered polaroid print (several swooping in at different depths: floating photo cards), in a glowing neon frame, with ripped torn-paper edges, or as a screen / document tilted in 3D perspective drifting over a dark ground" },
  { id: "atmosphere", owner: "scene designer", can: "real filmed atmosphere layers from the licensed library: smoke and fog drift, embers and sparks, dust particles, film scratches, film burns, the sprocket gate of old film, light leaks; drawn snow, confetti and warm bokeh" },
  { id: "scene_fx", owner: "scene designer", can: "a glitch burst with RGB split / chromatic aberration; glitch-slice, blurred-and-tilted settle and swoop entrances for any element; shallow depth of field; a rack focus (blur to sharp); scanlines with a flicker (neon / CRT type); a ruler / numeral grid over a picture; an interface cursor that travels and clicks (UI close-up)" },
  { id: "exits_drift", owner: "scene designer", can: "any element leaves before the cut by sliding off or eroding away (blur, crumble, fade); a cut-out object (banknotes, coins, papers, leaves) repeated as a falling or floating layer over a shot" },
  { id: "cutout", owner: "scene designer", can: "background removal of a photo (cut-out), colour-matched, contact shadow, rim light; as a black silhouette figure, with a white outline, or with a coloured glow (faces are never retouched or altered — owner rule)" },
  { id: "card3d", owner: "scene designer", can: "Three.js 3D picture card: a photo as a lit, turning card in 3D" },
  { id: "text3d", owner: "scene designer", can: "Three.js extruded 3D type: spoken words as bevelled, lit, turning 3D letters, painted or metallic chrome / gold" },
  { id: "kit_type", owner: "art director", can: "the film's kit draws headline variants: words on a banner / strip / tape, a bold centred all-caps title, a keyword in a marker highlight, glowing / neon type, giant ghosted type behind the subject, a small lead-in caption above a title; phrases built word by word, as a karaoke bar lighting up words, letter by letter as a typewriter with a cursor, or settling in blurred and tilted; labels as a person-introduction card, a lower-third name plate, a tilted sticker, a leader line drawing on with its label, a hand-drawn arrow, circle, underline or scribble, a handwritten callout, a pronunciation caption; chapter cards and a title lock-up with subtitle; a quote / epigraph card (a verbatim quotation and who said it); a recurring framed-shape motif across the film; a label can be placed on the depicted subject (static placement per shot, no motion tracking)" },
  { id: "kit_components", owner: "art director / scene designer", can: "the film's own kit components (React, written per film) with their own entrance animations" },
  { id: "charts", owner: "director / kit", can: "data drawn by the kit from verified facts: bar and line charts with animated build, a single big number, a row of pictograms showing a share, a ruler / numeral grid over a picture" },
  { id: "maps", owner: "director / kit", can: "a map (geojson + relief raster) with a flyover and a route; a flat map filled with pictograms at its points" },
  { id: "documents", owner: "director / kit", can: "a document or article page with a highlighted passage; real article screenshots; a screenshot tilted in perspective" },
  { id: "library_objects", owner: "scene designer", can: "licensed cut-out objects and line icons from the library placed in a scene" },
  { id: "transitions", owner: "editor", can: "hard cut, fade, dip to black, whip pan (motion blur), light leak, prismatic flare, white flash or a flash in the film's accent colour, zoom punch on a hit, zoom-through (a shape scaling through the frame), coloured bar wipe, ink-blot cover, match cut, the film's own transition; split a shot into punch-ins; move cuts" },
  { id: "captions", owner: "render", can: "word-synced burned captions (shorts)" },
  { id: "sound_hits", owner: "sound designer", can: "designed hits (thud, boom, impact, click), risers, accents placed on visual moments and cuts; tonal plucked notes (synthesised) on labels and small reveals" },
  { id: "music", owner: "sound designer", can: "music beds by mood, cue changes at story turns, drop-outs, riser into the climax, ducking under the voice, room tone" },
  { id: "narration", owner: "voice director", can: "narration by a cloned voice, per-line direction, tone per act" },
];

const Map_ = z.object({ map: z.array(z.object({ id: z.string(), status: z.enum(["available", "partial", "missing"]), tool: z.string().describe("capability id(s) that make it, or empty"), owner: z.string().describe("the agent who would use it"), gap: z.string().describe("what is missing to make it as the channel does; empty when available") })) });
export interface ToolMap { id: string; status: "available" | "partial" | "missing"; tool: string; owner: string; gap: string }
/** Step 3: each technique against the catalogue (Sonnet, once per taxonomy; cached). */
export async function mapTechniquesToTools(o: { data: string; channel: string; taxonomy: Technique[]; fresh?: boolean }): Promise<ToolMap[]> {
  const f = path.join(dirOf(o.data, o.channel), "tools.json");
  const key = createHash("sha1").update(JSON.stringify([o.taxonomy.map((t) => t.id), CAPABILITIES])).digest("hex").slice(0, 12);
  if (!o.fresh) {
    const hit = await load<{ key: string; map: ToolMap[] }>(f);
    if (hit?.key === key) return hit.map;
  }
  const r = await structured({ stage: "techniques.tools", model: MODELS.sonnet, system: [plain("You map documentary techniques to a video platform's capabilities. available = the platform can make it as the channel does today; partial = a related tool exists but it cannot make this exactly (say what is missing); missing = nothing makes it. Be strict and concrete.")], user: `CAPABILITIES:\n${CAPABILITIES.map((c) => `- ${c.id} (${c.owner}): ${c.can}`).join("\n")}\n\nTECHNIQUES:\n${o.taxonomy.map((t) => `- ${t.id} [${t.category}] ${t.name}: ${t.definition}`).join("\n")}`, schema: Map_, effort: "medium", maxTokens: 12000 });
  await save(f, { key, map: r.data.map });
  return r.data.map;
}

// ---- step 4: our film, measured the same way

export interface TechniqueRow { id: string; name: string; category: string; channelPerMin: number; channelShare: number; oursPerMin: number; status: ToolMap["status"] | "unknown"; owner: string; gap: string; verdict: "ok" | "unused" | "missing_tool" | "overused" | "rare" }
export async function techniqueCoverage(o: { data: string; reference: string; channel: ChannelId; video: string; workDir: string; taxonomy: Technique[]; band: TechniqueBand; tools: ToolMap[]; said?: (fromS: number, toS: number) => string; /** cuts, sound effects and music in the stretch — the same facts the real stretches are labelled with */ events?: (fromS: number, toS: number) => string; log?: (s: string) => void }): Promise<TechniqueRow[]> {
  const durS = Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", o.video]).catch(() => ({ stdout: "0" }))).stdout.trim()) || 0;
  const rows: Array<Record<string, number>> = [];
  const starts: number[] = [];
  for (let t = 0; t + 6 < durS; t += 10) starts.push(t);
  await Promise.all(starts.map(async (t) => {
    const sheet = await stretchSheet(o.video, t, Math.min(10, durS - t), path.join(o.workDir, `tech_${t}.jpg`));
    if (sheet) rows.push(await labelTechniques({ sheet, text: [o.said ? `Words spoken: "${o.said(t, t + 10)}"` : "", o.events ? o.events(t, t + 10) : ""].filter(Boolean).join("\n"), taxonomy: o.taxonomy }));
  }));
  const minutes = Math.max(1e-6, durS / 60);
  return o.taxonomy.map((t) => {
    const b = o.band.techniques.find((x) => x.id === t.id);
    const m = o.tools.find((x) => x.id === t.id);
    const ours = rows.reduce((a, r) => a + (r[t.id] ?? 0), 0) / minutes;
    const ch = b?.perMin ?? 0;
    const rare = (b?.share ?? 0) < 0.05;
    const verdict: TechniqueRow["verdict"] = rare ? "rare" : m?.status === "missing" ? "missing_tool" : ours < Math.max(0.15, (b?.perMinBand.p10 ?? 0), ch * 0.35) ? "unused" : ours > Math.max(ch * 2.5, (b?.perMinBand.p90 ?? 0) * 1.2) && ch > 0 ? "overused" : "ok";
    return { id: t.id, name: t.name, category: t.category, channelPerMin: ch, channelShare: b?.share ?? 0, oursPerMin: Math.round(ours * 100) / 100, status: (m?.status ?? "unknown") as TechniqueRow["status"], owner: m?.owner ?? "", gap: m?.gap ?? "", verdict };
  }).sort((a, b) => b.channelPerMin - a.channelPerMin);
}

/** Which agent's craft a technique belongs to (by category), for briefs and for routing a gap to its owner. */
export const CATEGORY_OWNER: Record<(typeof TECH_CATEGORIES)[number], string> = { picture: "scene designer", motion: "scene designer", type: "scene designer", data: "scene designer", edit: "editor", sound: "sound designer", structure: "director" };

/**
 * A brief for one agent: the channel's techniques in its craft, how often the channel uses them (per minute, and in
 * what share of stretches), and the tool that makes each — so the agent knows the whole vocabulary of the style, not
 * only what a past failure taught it. Read from the cached inventory; empty when none has been built.
 */
export async function techniqueBrief(o: { data: string; channel: string; owner: string; durationS: number }): Promise<string> {
  const dir = dirOf(o.data, o.channel);
  const inv = await loadInventory(o.data, o.channel);
  if (!inv) return "";
  const { taxonomy: tax, band, tools } = inv;
  const mine = band.techniques.filter((b) => b.share >= 0.05).map((b) => ({ b, t: tax.find((x) => x.id === b.id)!, m: tools.find((x) => x.id === b.id) })).filter((x) => x.t && CATEGORY_OWNER[x.t.category] === o.owner);
  if (!mine.length) return "";
  const n = (perMin: number) => Math.round(perMin * (o.durationS / 60) * 10) / 10;
  return `## The channel's techniques in your craft (craft inventory: ${band.stretches} real stretches)\nHow often the channel uses each, and what it would mean in a film of ${Math.round(o.durationS)} s. Use the whole vocabulary at about the channel's rate — not only the few you reach for first.\n${mine.map(({ b, t, m }) => `- ${t.name} — ${b.perMin}/min (in ${Math.round(b.share * 100)} % of stretches; ≈ ${n(b.perMin)} in this film). ${t.definition}${m ? ` [${m.status === "available" ? `make it with: ${m.tool}` : m.status === "partial" ? `partly possible (${m.tool}): ${m.gap}` : `no tool yet: ${m.gap}`}]` : ""}`).join("\n")}`;
}

/** The cached inventory (taxonomy, band, tool map) — null until it has been built. */
export async function loadInventory(data: string, channel: string): Promise<{ taxonomy: Technique[]; band: TechniqueBand; tools: ToolMap[] } | null> {
  const dir = dirOf(data, channel);
  const taxonomy = await load<Technique[]>(path.join(dir, "taxonomy.json"));
  const band = await load<TechniqueBand>(path.join(dir, "band.json"));
  const tools = (await load<{ map: ToolMap[] }>(path.join(dir, "tools.json")))?.map ?? [];
  if (!taxonomy || !band) return null;
  const tax = taxonomy.filter((t) => !excludedTechnique(t));
  return { taxonomy: tax, band: { ...band, techniques: band.techniques.filter((b) => tax.some((t) => t.id === b.id)) }, tools: tools.filter((m) => tax.some((t) => t.id === m.id)) };
}

/**
 * Before the render: the channel's STAPLES (techniques it uses in at least 40 % of its stretches) that a tool can make
 * but none of the sampled preview stretches of our film shows. Each goes to its owner.
 */
export async function stapleGaps(o: { data: string; channel: string; sheets: Array<{ sheet: string; text: string; seconds?: number }> }): Promise<Array<{ id: string; name: string; owner: string; channelShare: number; tool: string; over?: { ours: number; channel: number } }>> {
  const inv = await loadInventory(o.data, o.channel);
  if (!inv || !o.sheets.length) return [];
  const seen: Record<string, number> = {};
  for (const s of o.sheets) for (const [k, v] of Object.entries(await labelTechniques({ sheet: s.sheet, text: s.text, taxonomy: inv.taxonomy }))) seen[k] = (seen[k] ?? 0) + v;
  const missing = inv.band.techniques.filter((b) => b.share >= 0.25 && !seen[b.id]).flatMap((b) => {
    const t = inv.taxonomy.find((x) => x.id === b.id);
    const m = inv.tools.find((x) => x.id === b.id);
    return t && m && m.status !== "missing" ? [{ id: b.id, name: t.name, owner: CATEGORY_OWNER[t.category], channelShare: b.share, tool: m.tool }] : [];
  });
  // and what we lean on far more than the channel does (charts at 10/min against its 1.3 on the proof films)
  const minutes = o.sheets.reduce((a, s) => a + (s.seconds ?? 10), 0) / 60;
  const over = inv.band.techniques.flatMap((b) => {
    const ours = (seen[b.id] ?? 0) / Math.max(1e-6, minutes);
    const t = inv.taxonomy.find((x) => x.id === b.id);
    return t && ours >= 3 && ours > Math.max(b.perMin * 2.5, b.perMinBand.p90 * 1.3) ? [{ id: b.id, name: `too much: ${t.name}`, owner: CATEGORY_OWNER[t.category], channelShare: b.share, tool: "", over: { ours: Math.round(ours * 10) / 10, channel: b.perMin } }] : [];
  });
  return [...missing, ...over];
}

/** After every film: its coverage joins the platform's open list (data/technique-inventory/<channel>/open.json) —
 *  techniques the channel uses that we have no tool for, or have and do not use, ranked by how much the channel uses
 *  them, with how many of our films missed each. */
export async function recordCoverage(o: { data: string; channel: string; job: string; rows: TechniqueRow[] }): Promise<Array<{ id: string; name: string; verdict: string; channelPerMin: number; films: number; owner: string; gap: string }>> {
  const f = path.join(dirOf(o.data, o.channel), "open.json");
  const prev = (await load<{ films: Record<string, Record<string, string>> }>(f)) ?? { films: {} };
  prev.films[o.job] = Object.fromEntries(o.rows.map((r) => [r.id, r.verdict]));
  const open = o.rows.filter((r) => r.verdict === "missing_tool" || r.verdict === "unused").map((r) => ({ id: r.id, name: r.name, verdict: r.verdict, channelPerMin: r.channelPerMin, films: Object.values(prev.films).filter((v) => v[r.id] === "missing_tool" || v[r.id] === "unused").length, owner: r.owner, gap: r.gap })).sort((a, b) => b.channelPerMin - a.channelPerMin);
  await save(f, { films: prev.films, open, updatedAt: new Date().toISOString() });
  return open;
}

/** The facts a stretch of OUR film is labelled with, from its manifest — the same as a real stretch's (cuts, measured
 *  sound effects, music cue changes and drop-outs). */
export function manifestEvents(m: { fps: number; video: Array<{ zIndex: number; startFrame: number }>; audio: Array<{ role: string; startFrame: number; ref?: string; dips?: Array<{ fromFrame: number; toFrame: number }> }> }, family?: (ref: string) => string | undefined) {
  return (a: number, b: number): string => {
    const s = (fr: number) => fr / m.fps;
    const cuts = [...new Set(m.video.filter((v) => v.zIndex === 0).map((v) => s(v.startFrame)).filter((t) => t > a + 0.05 && t < b))].sort((x, y) => x - y);
    const fx = m.audio.filter((x) => x.role === "sfx" && s(x.startFrame) >= a && s(x.startFrame) < b);
    const music = m.audio.filter((x) => x.role === "music");
    const cue = music.some((x) => s(x.startFrame) > a + 0.5 && s(x.startFrame) < b);
    const drop = music.some((x) => (x.dips ?? []).some((d) => s(d.fromFrame) < b && s(d.toFrame) > a));
    return [`Cuts at: ${cuts.map((t) => (t - a).toFixed(1)).join(", ") || "none"} s`, `Sound effects (measured): ${fx.map((x) => `${(family && x.ref && family(x.ref)) || "hit"} at ${(s(x.startFrame) - a).toFixed(1)} s`).join(", ") || "none"}`, `Music: ${cue ? "a music cue changes in this stretch" : "one bed"}${drop ? "; the music drops out" : ""}`].join("\n");
  };
}
