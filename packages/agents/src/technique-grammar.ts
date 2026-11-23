/**
 * How the channel USES each technique (owner, 2026-11-23: "do they know how to use the tools the way MagnatesMedia
 * would?"). Learned from real stretches labelled with the same technique labeller as the inventory, each kept with
 * the words spoken over it, its place in the film, what its lines do (story-measure line kinds) and the techniques it
 * sits with. From those examples a grammar is written per technique: the lines and moments it serves, how long it is
 * held, what it pairs with, and what the channel never does with it — plus the real examples themselves, which the
 * agents can look at (`techniqueExamples`).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelId } from "@opumia/contracts";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";
import { labelLines } from "./story-measure.js";
import { CATEGORY_OWNER, labelTechniques, loadInventory, realStretchesFor, stretchSheet, type Technique } from "./technique-inventory.js";

export interface TechniqueExample { film: string; fromS: number; position: number; words: string; lineKinds: string[]; sheet: string; seen: Record<string, number> }
export interface TechniqueGrammar { id: string; name: string; owner: string; examples: number; when: string; lines: string[]; positions: string; holds: string; pairsWith: string[]; avoid: string; preset: string; exampleRefs: Array<{ sheet: string; words: string; position: number }> }

const dir = (data: string, channel: string) => path.join(data, "technique-inventory", channel);
const save = async (f: string, v: unknown) => {
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f + ".tmp", JSON.stringify(v, null, 1) + "\n");
  await rename(f + ".tmp", f);
};

/** Real stretches labelled and KEPT (words, position, line kinds, techniques) — the examples the grammar learns from. */
export async function ensureTechniqueExamples(o: { data: string; reference: string; channel: ChannelId; n?: number; fresh?: boolean; log?: (s: string) => void }): Promise<TechniqueExample[]> {
  const f = path.join(dir(o.data, o.channel), "rows.json");
  if (!o.fresh && existsSync(f)) return JSON.parse(await readFile(f, "utf8")) as TechniqueExample[];
  const inv = await loadInventory(o.data, o.channel);
  if (!inv) throw new Error("no craft inventory yet");
  const st = await realStretchesFor({ data: o.data, reference: o.reference, channel: o.channel, n: o.n ?? 160, len: 10, salt: "grammar" });
  o.log?.(`  grammar: labelling ${st.length} real stretches with their words…`);
  const rows: TechniqueExample[] = [];
  for (let i = 0; i < st.length; i += 8)
    await Promise.all(st.slice(i, i + 8).map(async (s) => {
      const sheet = await stretchSheet(s.video, s.fromS, s.len, path.join(dir(o.data, o.channel), "sheets", `${s.film}_${s.fromS.toFixed(0)}.jpg`));
      if (!sheet) return;
      const seen = await labelTechniques({ sheet, text: s.text, taxonomy: inv.taxonomy });
      rows.push({ film: s.film, fromS: s.fromS, position: s.position, words: (/Words spoken: "([^"]*)"/.exec(s.text)?.[1] ?? "").slice(0, 400), lineKinds: [], sheet, seen });
    }));
  // what each stretch's words DO (the same line labeller as the writer's story band)
  const kinds = await labelLines(rows.map((r) => r.words || "(no narration)"));
  rows.forEach((r, k) => (r.lineKinds = [kinds[k] ?? "story"]));
  await save(f, rows);
  return rows;
}

const G = z.object({ grammar: z.array(z.object({ id: z.string(), when: z.string().describe("on what kind of line / moment the channel uses it, concretely"), lines: z.array(z.string()).describe("the line kinds it serves most (scene, story, fact, explain, motive, quote, question, address, tease, maxim)"), positions: z.string().describe("where in a film: opening, middle, ending, chapter starts"), holds: z.string().describe("how long it is held / how it moves"), pairsWith: z.array(z.string()).describe("technique ids it usually appears with"), avoid: z.string().describe("what the channel never or rarely does with it — misuse to refuse"), preset: z.string().describe("the typical recipe in a sentence (what it is applied to, how strong)") })) });

/** The grammar per technique (Sonnet, one call per category; cached). */
export async function ensureTechniqueGrammar(o: { data: string; reference: string; channel: ChannelId; fresh?: boolean; log?: (s: string) => void }): Promise<TechniqueGrammar[]> {
  const f = path.join(dir(o.data, o.channel), "grammar.json");
  if (!o.fresh && existsSync(f)) return JSON.parse(await readFile(f, "utf8")) as TechniqueGrammar[];
  const inv = await loadInventory(o.data, o.channel);
  if (!inv) throw new Error("no craft inventory yet");
  const rows = await ensureTechniqueExamples({ data: o.data, reference: o.reference, channel: o.channel, ...(o.log ? { log: o.log } : {}) });
  const out: TechniqueGrammar[] = [];
  const cats = [...new Set(inv.taxonomy.map((t) => t.category))];
  for (const cat of cats) {
    const techs = inv.taxonomy.filter((t) => t.category === cat);
    const blocks = techs.map((t) => {
      const ex = rows.filter((r) => r.seen[t.id]);
      const co: Record<string, number> = {};
      for (const r of ex) for (const k of Object.keys(r.seen)) if (k !== t.id) co[k] = (co[k] ?? 0) + 1;
      const top = Object.entries(co).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
      return `### ${t.id} — ${t.name}: ${t.definition}\nseen in ${ex.length} of ${rows.length} real stretches; with: ${top.join(", ") || "-"}\n${ex.slice(0, 10).map((r) => `- at ${Math.round(r.position * 100)} % of the film, line kind ${r.lineKinds.join("/")}: "${r.words.slice(0, 180)}"`).join("\n")}`;
    });
    o.log?.(`  grammar: ${cat} (${techs.length} techniques)…`);
    const r = await structured({ stage: "techniques.grammar", model: MODELS.sonnet, system: [plain("You are the lead editor of a documentary YouTube channel, writing the house style guide for each technique the channel uses, from real examples: the exact moments, lines and positions where it is used. Be concrete and channel-specific; when the examples are few, say what they show and keep 'avoid' to clear misuses (e.g. a technique on a line it never serves).")], user: blocks.join("\n\n"), schema: G, effort: "medium", maxTokens: 12000 }).catch(() => null);
    for (const g of r?.data.grammar ?? []) {
      const t = techs.find((x) => x.id === g.id);
      if (!t) continue;
      const ex = rows.filter((x) => x.seen[t.id]);
      out.push({ ...g, name: t.name, owner: CATEGORY_OWNER[t.category], examples: ex.length, exampleRefs: ex.slice(0, 4).map((x) => ({ sheet: x.sheet, words: x.words.slice(0, 200), position: x.position })) });
    }
  }
  await save(f, out);
  return out;
}

/** The grammar of an owner's techniques, as text for its brief. */
export async function grammarBrief(o: { data: string; channel: string; owner: string; /** take these categories instead of the owner (the art director: type) */ categories?: string[] }): Promise<string> {
  const f = path.join(dir(o.data, o.channel), "grammar.json");
  if (!existsSync(f)) return "";
  const inv = o.categories ? await loadInventory(o.data, o.channel) : null;
  const catOf = (id: string) => inv?.taxonomy.find((t) => t.id === id)?.category ?? "";
  const g = (JSON.parse(await readFile(f, "utf8")) as TechniqueGrammar[]).filter((x) => (o.categories ? o.categories.includes(catOf(x.id)) : x.owner === o.owner) && x.examples > 0);
  if (!g.length) return "";
  return `## How the channel uses each technique in your craft (learned from real stretches; call see_technique for real examples)\n${g.map((x) => `- **${x.name}** (\`${x.id}\`): ${x.when} Lines: ${x.lines.join(", ")}. Where: ${x.positions}. Held: ${x.holds}. With: ${x.pairsWith.join(", ") || "-"}. Never: ${x.avoid} Recipe: ${x.preset}`).join("\n")}`;
}

/** Real examples of one technique: the sheet pictures (16 frames over 10 s) and the words spoken over them. */
export async function techniqueExamples(o: { data: string; channel: string; id: string; n?: number }): Promise<{ grammar: TechniqueGrammar | null; examples: Array<{ sheet: string; words: string; position: number }> }> {
  const f = path.join(dir(o.data, o.channel), "grammar.json");
  const g = existsSync(f) ? (JSON.parse(await readFile(f, "utf8")) as TechniqueGrammar[]).find((x) => x.id === o.id) ?? null : null;
  const rf = path.join(dir(o.data, o.channel), "rows.json");
  const rows = existsSync(rf) ? (JSON.parse(await readFile(rf, "utf8")) as TechniqueExample[]) : [];
  return { grammar: g, examples: rows.filter((r) => r.seen[o.id] && existsSync(r.sheet)).slice(0, o.n ?? 3).map((r) => ({ sheet: r.sheet, words: r.words, position: r.position })) };
}

export type { Technique };

/** The agents' tool: real examples of a technique — frames across 10 s of real films with the words spoken over them,
 *  and the channel's grammar for it — looked at before using it. */
export function seeTechniqueTool(o: { data: string; channel: string }): import("./llm.js").AgentTool {
  return {
    name: "see_technique",
    description: "See how the channel itself uses one technique before you use it: up to three real stretches (16 frames across 10 seconds each, left to right, top to bottom) with the words spoken over them, and the channel's grammar for it — the lines and moments it serves, what it pairs with, and what the channel never does with it. Give the technique id from your brief.",
    schema: z.object({ id: z.string() }),
    run: (async (i: { id: string }) => {
      const r = await techniqueExamples({ data: o.data, channel: o.channel, id: i.id, n: 3 });
      if (!r.grammar && !r.examples.length) return `no technique "${i.id}" in the inventory`;
      const out: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }> = [];
      if (r.grammar) out.push({ type: "text", text: `${r.grammar.name}: ${r.grammar.when}\nLines: ${r.grammar.lines.join(", ")}. Where: ${r.grammar.positions}. Held: ${r.grammar.holds}. With: ${r.grammar.pairsWith.join(", ") || "-"}.\nNever: ${r.grammar.avoid}\nRecipe: ${r.grammar.preset}` });
      for (const e of r.examples) {
        out.push({ type: "text", text: `REAL, at ${Math.round(e.position * 100)} % of its film — said: "${e.words.slice(0, 220)}"` });
        out.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(e.sheet)).toString("base64") } });
      }
      return out;
    }) as never,
  };
}

/** A technique's recipe in the scene format: what it sets when the scene designer names it (cached; validated). */
export const PresetSpec = z.object({
  world: z.enum(["none", "mono_accent", "duotone", "burst", "collage", "flat_field", "paper", "terminal", "filmstrip", "contact_grid", "split", "gradient", "room3d"]).describe("the backdrop the shot is built in; none = the shot's own footage. filmstrip = pictures as frames on a sprocket strip; contact_grid = a grid of picture cells; collage = prints laid out; split = two pictures side by side"),
  grade: z.enum(["none", "mono", "duotone", "punch", "sepia", "contrast_bw", "split", "invert", "lowkey", "warm_glow", "thermal", "solarise"]),
  frame: z.enum(["none", "polaroid", "neon", "torn", "perspective"]),
  atmos: z.enum(["none", "smoke", "embers", "dust", "scratches", "burn", "sprocket", "leak", "snow", "confetti", "bokeh"]),
  enter: z.enum(["none", "fade", "slide_left", "slide_right", "slide_up", "pop", "stamp", "zoom", "wipe", "settle", "glitch", "swoop"]),
  cutout: z.enum(["none", "silhouette", "outline", "glow", "retouch"]),
  glitch: z.boolean().describe("an RGB-split glitch burst"), dof: z.number().describe("0–1 background defocus"), rack: z.boolean().describe("blur-to-sharp focus pull at the start"), scanlines: z.boolean().describe("CRT scanlines with flicker"), grid: z.boolean().describe("a RULER / measuring numeral grid laid over a picture — NOT a grid of pictures (that is world contact_grid)"), twotone: z.boolean().describe("cool ground, warm pictures"),
  halftone: z.number(), grain: z.number(), leak: z.number(),
  drift: z.enum(["none", "fall", "float"]),
  transition: z.enum(["none", "cut", "fade", "whip", "dip_black", "light_leak", "flash", "flash_color", "zoom_punch", "zoom_through", "prism", "bar_wipe", "ink", "smoke_cover", "fire_cover"]),
  kit: z.string().describe("the kit role / variant that draws it, if it is type or data (e.g. 'headline:banner', 'phrase:karaoke', 'label:intro', 'number:icons'); else empty"),
});
export type Preset = z.infer<typeof PresetSpec>;

export async function ensureTechniquePresets(o: { data: string; channel: string; fresh?: boolean }): Promise<Record<string, Preset>> {
  const f = path.join(dir(o.data, o.channel), "presets.json");
  if (!o.fresh && existsSync(f)) return JSON.parse(await readFile(f, "utf8")) as Record<string, Preset>;
  const gf = path.join(dir(o.data, o.channel), "grammar.json");
  if (!existsSync(gf)) return {};
  const g = JSON.parse(await readFile(gf, "utf8")) as TechniqueGrammar[];
  const out: Record<string, Preset> = {};
  const Out = z.object({ presets: z.array(z.object({ id: z.string(), preset: PresetSpec })) });
  for (let i = 0; i < g.length; i += 30) {
    const part = g.slice(i, i + 30);
    const r = await structured({ stage: "techniques.presets", model: MODELS.sonnet, system: [plain("Map each documentary technique to the platform's scene format: the fields that make it, everything else 'none' / false / 0. Be faithful to the recipe and the channel's typical strength (grain 0.2–0.5, dof 0.3–0.7). For type and data techniques set `kit` to the kit role:variant that draws them. Techniques that are cutting or sound decisions set only `transition` or nothing.")], user: part.map((x) => `${x.id} — ${x.name}: ${x.when} Recipe: ${x.preset}`).join("\n"), schema: Out, effort: "low", maxTokens: 12000 }).catch(() => null);
    for (const p of r?.data.presets ?? []) if (part.some((x) => x.id === p.id)) out[p.id] = p.preset;
  }
  await save(f, out);
  return out;
}

/**
 * Correct use: each technique a shot uses, with the line spoken over it and its place in the film, judged against the
 * channel's grammar for that technique (Haiku, one call per 25 uses). A use the channel would not make — a chapter card
 * mid-scene, a person card for an unnamed figure, a celebratory burst on a collapse — is a misuse for its owner to fix.
 */
export interface TechniqueUse { shotId: string; technique: string; line: string; position: number }
export interface UseVerdict extends TechniqueUse { ok: boolean; why: string }
export async function checkTechniqueUses(o: { data: string; channel: string; uses: TechniqueUse[] }): Promise<UseVerdict[]> {
  const gf = path.join(dir(o.data, o.channel), "grammar.json");
  if (!existsSync(gf) || !o.uses.length) return [];
  const g = new Map((JSON.parse(await readFile(gf, "utf8")) as TechniqueGrammar[]).map((x) => [x.id, x]));
  const uses = o.uses.filter((u) => g.has(u.technique));
  const Out = z.object({ verdicts: z.array(z.object({ i: z.number(), ok: z.boolean(), why: z.string().describe("one line; for a misuse, what the channel does instead") })) });
  const out: UseVerdict[] = [];
  for (let k = 0; k < uses.length; k += 25) {
    const part = uses.slice(k, k + 25);
    const r = await structured({ stage: "techniques.use", model: MODELS.haiku, system: [plain("You check a documentary's use of the channel's techniques against the channel's own grammar for each. A use is wrong only when it contradicts the grammar (the 'never' list, or a line / moment the technique clearly does not serve). Be fair: a reasonable use the grammar does not forbid is ok.")], user: part.map((u, i) => { const x = g.get(u.technique)!; return `[${i}] technique ${x.name}: used ${x.when} | never: ${x.avoid}\n    OUR USE at ${Math.round(u.position * 100)} % of the film, over the line: "${u.line.slice(0, 200)}"`; }).join("\n"), schema: Out, effort: "low", maxTokens: 3000 }).catch(() => null);
    for (const v of r?.data.verdicts ?? []) if (part[v.i]) out.push({ ...part[v.i]!, ok: v.ok, why: v.why });
  }
  return out;
}
