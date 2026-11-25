/**
 * The film's art director, from a blank slate (build list 2, step 5). Film 1 looked like the earlier Kodak film: the
 * same cards, fonts and patterns, because every film was assembled from one menu renderer. This agent instead WRITES
 * the film's own motion-design kit as code (Remotion/React): its typefaces, the cards, labels, number and quote
 * treatments, picture frames and the transition that bridges its cuts — designed for this film's story and pictures,
 * studied against the channel's real frames, rendered on the film's own footage, measured, and revised. Only the
 * channel's grammar is shared between films; nothing else is.
 *
 *  skill    packages/agents/skills/film-designer.md
 *  tools    study_reference, list_fonts, palette_from_pictures, write_kit, set_tokens, render_samples,
 *           render_transition, submit_kit, note_lesson
 *  owns     every look decision of the film (build list 3, L1/L3/L5): the design tokens in design.json (palette,
 *           texture, act grades), the stage behind shots without footage, every word on screen (one component per
 *           role in KIT_ROLES, the phrase synced to the voice) and the drawing of charts, maps and documents
 *  memory   <memoryDir>/<channel>.md, owner-notes.md; data/film-kits.json (what produced films used: fonts, palette,
 *           concept — a new kit may not repeat their typefaces)
 *  safety   the kit may import only react, remotion, @craft and @remotion/google-fonts/<Font>; no network, no file system,
 *           no eval; pictures only through the shot's slots. Checked before it is written.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import * as z from "zod/v4";
import { readMemory } from "./lessons.js";
import { agentLoop, cached, plain, ROLE_MODEL, type AgentTool } from "./llm.js";
import { producedJobs } from "./produced.js";
import { designFromKit, KIT_ROLES, ROLE_CONTRACT, type KitTokens } from "./kit-design.js";
import type { ChannelId, FilmDesignSystem } from "@opumia/contracts";

export interface KitSampleResult { shotId: string; mid: string; sheet: string; text: string }
export interface FilmDesignerOptions {
  /** Craft inventory: extra tools (see_technique: real examples and the channel's grammar of each technique). */
  extraTools?: AgentTool[];
  channel: ChannelId;
  topic: string;
  /** How many acts the film has (one colour grade each). */
  acts: number;
  /** Called with the film's design tokens each time the art director sets them (written to design.json). */
  onDesign: (d: FilmDesignSystem) => Promise<void>;
  job: string;
  title: string;
  data: string;
  /** design/film/ of the job: the kit is written here. */
  kitDir: string;
  /** The film's concept and story (treatment, narration). */
  brief: string;
  /** Shots that can host samples: id, the line spoken, what the picture shows. */
  shots: Array<{ id: string; line: string; picture: string }>;
  /** Every Google font the renderer can load (import names). */
  fonts: string[];
  /** Real channel frames by kind (exemplars) for study. */
  reference: Array<{ kind: string; frame: string; line: string }>;
  /** Dominant colours of the film's own pictures. */
  palette: () => Promise<string[]>;
  /** Render component samples on the film's own shots; each result carries the measured report (legibility, design, taste, likeness to earlier films). */
  renderSamples: (samples: Array<{ shotId: string; elements: unknown[] }>) => Promise<KitSampleResult[]>;
  /** Render the film transition across a cut (a strip of frames). */
  renderTransition: () => Promise<{ strip: string; text: string } | null>;
  memoryDir?: string;
  /** Ladder rungs (build list 3, items 13–14): change an accepted kit (add a component, retune the tokens, move away
   * from an earlier film) or, with `fresh`, design a new visual concept from a blank slate. */
  change?: { request: string; fresh: boolean; tokens?: KitTokens };
  log?: (s: string) => void;
}
export interface FilmDesignerReport { pass: boolean; fonts: string[]; components: string[]; roles: Record<string, string>; transition: string | null; renders: number; note: string; agent: { turns: number; calls: Record<string, number>; usd: number } }

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const img = async (file: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg", data: (await readFile(file)).toString("base64") } });
/** Hue distance in degrees (90 when either colour is near-neutral). */
const hueGap = (a: string, b: string) => {
  const hue = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as [number, number, number];
    const mx = Math.max(r, g, bl), d = mx - Math.min(r, g, bl);
    if (d < 0.08) return -1;
    return ((mx === r ? ((g - bl) / d + 6) % 6 : mx === g ? (bl - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  };
  const x = hue(a), y = hue(b);
  if (x < 0 || y < 0) return 90;
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};
const tail = (t: string, n: number) => t.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join("\n");

/** What a kit may contain: checked before it is written (the kit runs inside the render's browser). */
export function checkKitCode(code: string, fonts: Set<string>, o: { composite?: boolean } = {}): string[] {
  const issues: string[] = [];
  for (const m of code.matchAll(/^\s*import\s+[^'"]*from\s+["']([^"']+)["']/gm)) {
    const mod = m[1]!;
    const font = /^@remotion\/google-fonts\/(.+)$/.exec(mod)?.[1];
    // "@craft": the channel's techniques as shared engine tools (hand film v31–v32); a scene composite may also use
    // the film's own kit ("@film")
    if (mod === "react" || mod === "remotion" || mod === "@craft" || (o.composite && mod === "@film")) continue;
    if (font) { if (!fonts.has(font)) issues.push(`unknown font "${font}" (use list_fonts)`); continue; }
    issues.push(`import "${mod}" is not allowed (only react, remotion, @craft${o.composite ? ", @film" : ""} and @remotion/google-fonts/<Font>)`);
  }
  if (/\brequire\s*\(|\bimport\s*\(|\beval\s*\(|new\s+Function|\bfetch\s*\(|XMLHttpRequest|WebSocket|\bprocess\.|document\.cookie|localStorage|window\.location|https?:\/\//.test(code)) issues.push("no network, eval, dynamic import, process or URLs in a kit — pictures come only through the shot's slots (staticFile(slots[...]))");
  if (!o.composite && !/export\s+const\s+FILM\b/.test(code)) issues.push("the kit must `export const FILM = { components, transitions, transition, transitionFrames, fonts, meta }`");
  if (o.composite && !/export\s+default\b/.test(code)) issues.push("a composite must `export default` its component");
  if (code.length > 60_000) issues.push("the kit is too long (keep it under 60 kB)");
  return issues;
}

export async function filmDesignerAgent(o: FilmDesignerOptions): Promise<FilmDesignerReport> {
  const log = o.log ?? (() => {});
  const fontSet = new Set(o.fonts);
  const kitFile = path.join(o.kitDir, "index.tsx");
  const made = await producedJobs(o.data);
  const earlier = await readFile(path.join(o.data, "film-kits.json"), "utf8").then((t) => (JSON.parse(t) as Array<{ job: string; fonts: string[]; palette: string[]; tokens?: { primary: string; accent: string; surface: string }; concept: string; transition: string }>).filter((k) => made.has(k.job) && k.job !== o.job), () => []);
  const usedFonts = new Set(earlier.flatMap((k) => k.fonts));
  let code: string | null = existsSync(kitFile) && !o.change?.fresh ? await readFile(kitFile, "utf8") : null;
  let studied = 0, renders = 0, transitionSeen = false, lastRenderOk = false, accepted: string | null = null, noteSaved = false;
  // a change to an accepted kit starts from it: studied, transition seen, tokens set — the change still has to be
  // rendered, looked at and submitted again
  let tokens: KitTokens | null = o.change && !o.change.fresh && o.change.tokens ? o.change.tokens : null;
  if (o.change && !o.change.fresh && code) (studied = 2), (transitionSeen = true);
  let roles: Record<string, string> = {};
  const fontStack = (re: RegExp, fallback: string) => {
    const m = re.exec(code ?? "");
    return m?.[1] ?? m?.[2] ?? fallback;
  };
  const kitFontStacks = () => ({ display: fontStack(/display\s*:\s*`([^`]+)`|display\s*:\s*"([^"]+)"/, `"${kitFonts()[0] ?? "serif"}", serif`), body: fontStack(/body\s*:\s*`([^`]+)`|body\s*:\s*"([^"]+)"/, `"${kitFonts().at(-1) ?? "sans-serif"}", sans-serif`) });
  const kitFonts = () => [...(code ?? "").matchAll(/@remotion\/google-fonts\/([A-Za-z0-9]+)/g)].map((m) => m[1]!);
  /** FILM.roles in the kit's code: role → component name. */
  const kitRoles = (): Record<string, string> => {
    const m = /roles\s*:\s*\{([^}]*)\}/.exec((code ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
    return Object.fromEntries((m?.[1] ?? "").split(",").map((x) => x.split(":").map((y) => y.trim().replace(/^["']|["']$/g, ""))).filter((x) => x.length === 2 && x[0] && x[1]) as Array<[string, string]>);
  };
  const kitComponents = () => [...new Set([...(code ?? "").matchAll(/components\s*:\s*\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(",").map((x) => x.split(":")[0]!.trim()).filter(Boolean)))];

  const tools: AgentTool[] = [
    {
      name: "study_reference",
      description: "See real frames of the channel of one kind (title_card, words_over_footage, caption_on_footage, number_stat, quote_card, picture_composition, document_or_screen, comparison, map, logo, chart, infographic) — how its type, labels, numbers and frames are made. Up to 6 frames.",
      schema: z.object({ kind: z.string() }),
      run: (async (i: { kind: string }) => {
        studied++;
        const rs = o.reference.filter((r) => r.kind === i.kind).slice(0, 6);
        if (!rs.length) return `no reference frames of kind ${i.kind}; kinds: ${[...new Set(o.reference.map((r) => r.kind))].join(", ")}`;
        const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const r of rs) blocks.push({ type: "text", text: `${r.kind} — over the line "${r.line.slice(0, 100)}"` }, await img(r.frame));
        return blocks;
      }) as AgentTool["run"],
    },
    {
      name: "list_fonts",
      description: "Google fonts the renderer can load, by a name fragment (e.g. 'serif', 'grotesk', 'mono', 'condensed', 'display' or a family name). Fonts that earlier films of ours used are marked and may not be used again.",
      schema: z.object({ match: z.string() }),
      run: (async (i: { match: string }) => {
        const q = i.match.toLowerCase().replace(/[^a-z0-9]/g, "");
        const hits = o.fonts.filter((f) => f.toLowerCase().includes(q)).slice(0, 60);
        return `${hits.length ? hits.map((f) => `${f}${usedFonts.has(f) ? " (USED by an earlier film — not allowed)" : ""}`).join(", ") : "no font matches that"}\n(${o.fonts.length} fonts in all; name the family you know, e.g. Fraunces, Space Grotesk, IBM Plex Sans Condensed, DM Serif Display, Archivo, Bricolage Grotesque, Instrument Serif, Big Shoulders Display, Syne…)`;
      }) as AgentTool["run"],
    },
    {
      name: "palette_from_pictures",
      description: "The dominant colours of this film's own pictures (its footage and photos) — the palette grows out of the film's world, not a preset.",
      schema: z.object({}),
      run: (async () => (await o.palette()).join(", ")) as AgentTool["run"],
    },
    {
      name: "write_kit",
      description: "Write (or rewrite) the whole kit: one TSX module that `export const FILM = { components: {…}, roles: { headline: \"Name\", phrase: \"Name\", … every role }, transitions: {…}, transition: \"name\", transitionFrames: 8–14, fonts: { display, body }, meta: { Name: { use, props } } }`. roles maps each role (the engine draws chapter cards, stages, charts, maps and documents through it) to one of the components. Components are React function components using useCurrentFrame/spring/interpolate from remotion; each gets its own props plus `slots` (picture slot → staticFile path), `boxW`, `boxH`. Load fonts with `import { loadFont } from \"@remotion/google-fonts/<Font>\"; const { fontFamily } = loadFont();`. The channel's techniques are shared engine tools you may import from \"@craft\" (Slab3D carved 3D type, TwoSided, DepthRain, HeroCutout, rimLight, WrapAround, DoubleExposure, Whip, Flare, Phone, GlassSlab, Cracks, Shatter, shake, rnd, ramp) — give them this film's own colours and type. A transition receives `progress` 0→1 (the cut at 0.5) and draws over the whole frame (AbsoluteFill). Checked for safety before it is written.",
      schema: z.object({ code: z.string() }),
      run: (async (i: { code: string }) => {
        const issues = checkKitCode(i.code, fontSet);
        const fontsUsed = [...i.code.matchAll(/@remotion\/google-fonts\/([A-Za-z0-9]+)/g)].map((m) => m[1]!);
        const repeat = fontsUsed.filter((f) => usedFonts.has(f));
        // item 19: a font loads only the weights the kit uses (film 2 loaded every weight of every face)
        const names = [...i.code.matchAll(/import\s*\{\s*loadFont(?:\s+as\s+(\w+))?\s*\}\s*from\s*["']@remotion\/google-fonts\//g)].map((m) => m[1] ?? "loadFont");
        const loads = [...new Set(names)].flatMap((n) => [...i.code.matchAll(new RegExp(`\\b${n}\\s*\\(([^)]*)\\)`, "g"))]);
        const bare = loads.filter((m) => !/weights\s*:/.test(m[1] ?? ""));
        if (bare.length) issues.push(`${bare.length} loadFont() call(s) load every weight: pass only the weights used, e.g. loadFont("normal", { weights: ["400", "800"], subsets: ["latin"] })`);
        if (repeat.length) issues.push(`typefaces an earlier film used: ${repeat.join(", ")} — this film needs its own`);
        if (issues.length) return `NOT WRITTEN:\n${issues.map((x) => `- ${x}`).join("\n")}`;
        // syntax check before the render bundles it
        const ts = await import("typescript");
        const out = ts.transpileModule(i.code, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
        const diag = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).slice(0, 5);
        if (diag.length) return `NOT WRITTEN — syntax:\n${diag.join("\n")}`;
        await mkdir(o.kitDir, { recursive: true });
        await writeFile(`${kitFile}.tmp`, i.code);
        await rename(`${kitFile}.tmp`, kitFile);
        code = i.code;
        lastRenderOk = false;
        transitionSeen = false;
        return `written (${i.code.length} characters; fonts ${fontsUsed.join(", ") || "none"}; components ${kitComponents().join(", ") || "none found"}). Now render_samples on the film's own shots.`;
      }) as AgentTool["run"],
    },
    {
      name: "set_tokens",
      description: `Set the film's design tokens (written to design.json; the renderer, colourist, compositor and thumbnail read them): the palette (grown from palette_from_pictures — primary, primarySoft, accent, accentDeep, a dark surface and surfaceAlt, a light paper, a marker for highlights, text and textMuted), the texture (film grain 0–0.5, vignette 0–1) and one colour grade per act (${o.acts} act(s): tint, tintStrength 0–0.6, saturation 0.4–1.3, contrast 0.9–1.3). Text colours are pushed to legible contrast. Set them before render_samples; set them again whenever the look changes.`,
      schema: z.object({
        palette: z.object({ primary: HEX, primarySoft: HEX, accent: HEX, accentDeep: HEX, surface: HEX, surfaceAlt: HEX, paper: HEX, marker: HEX, text: HEX, textMuted: HEX }),
        texture: z.object({ grain: z.number().min(0).max(0.5), vignette: z.number().min(0).max(1) }),
        acts: z.array(z.object({ name: z.string(), tint: HEX, tintStrength: z.number().min(0).max(0.6), saturation: z.number().min(0.4).max(1.3), contrast: z.number().min(0.9).max(1.3) })).min(1),
      }),
      run: (async (i: KitTokens) => {
        if (i.acts.length !== o.acts) return `NOT SET: the film has ${o.acts} act(s); give exactly ${o.acts} grade(s)`;
        // item 19: the palette is checked against our earlier films' palettes while designing, not only at the gate
        const near = earlier.filter((k) => k.tokens).map((k) => ({ job: k.job, p: hueGap(i.palette.primary, k.tokens!.primary), a: hueGap(i.palette.accent, k.tokens!.accent) })).filter((x) => x.p < 25 && x.a < 25);
        if (near.length) return `NOT SET: primary and accent sit within 25° of hue of ${near.map((x) => `${x.job} (primary ${Math.round(x.p)}°, accent ${Math.round(x.a)}° apart)`).join(", ")} — this film needs its own colours`;
        const { design, adjusted } = designFromKit({ job: o.job, channel: o.channel, topic: o.topic, concept: accepted ?? o.title, fonts: kitFontStacks(), tokens: i });
        tokens = { palette: design.palette, texture: design.texture, acts: design.acts };
        await o.onDesign(design);
        lastRenderOk = false;
        return `set${adjusted.length ? ` (legibility: ${adjusted.join("; ")})` : ""}. Render samples to see them.`;
      }) as AgentTool["run"],
    },
    {
      name: "render_samples",
      description: "Render kit components on the film's own shots, as they will appear: give up to 6 samples, each a shotId and its elements (`{ type: \"component\", name, props, x, y, w, h?, at, rot: 0, z: 0.6, enter: \"fade\" }` — x/y/w/h are fractions of the frame, `at` seconds into the shot). You see each shot early/middle/end and a measured report: legibility on a phone, design (focal point, depth, colour), trained taste against the channel's real shots, and how close it looks to our earlier films.",
      schema: z.object({ samples: z.array(z.object({ shotId: z.string(), elements: z.array(z.record(z.string(), z.unknown())).min(1).max(6) })).min(1).max(6) }),
      run: (async (i: { samples: Array<{ shotId: string; elements: unknown[] }> }) => {
        if (!code) return "write the kit first";
        if (!tokens) return "set_tokens first (the samples are rendered with the film's palette, texture and grade)";
        const res = await o.renderSamples(i.samples).catch((e: Error) => [{ shotId: "", mid: "", sheet: "", text: `RENDER FAILED: ${e.message.slice(0, 600)}` }]);
        if (res.length === 1 && !res[0]!.sheet) return res[0]!.text;
        renders += res.length;
        lastRenderOk = !res.some((r) => /UNREADABLE|TOO CLOSE|FAILED/.test(r.text));
        const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
        for (const r of res) blocks.push({ type: "text", text: `${r.shotId}:\n${r.text}` }, await img(r.sheet));
        return blocks;
      }) as AgentTool["run"],
    },
    {
      name: "render_transition",
      description: "See the kit's transition across a real cut of the film (frames across the cut).",
      schema: z.object({}),
      run: (async () => {
        if (!code) return "write the kit first";
        if (!tokens) return "set_tokens first";
        const r = await o.renderTransition().catch((e: Error) => ({ strip: "", text: `RENDER FAILED: ${e.message.slice(0, 400)}` }));
        if (!r || !r.strip) return r?.text ?? "no cut to show it on";
        transitionSeen = true;
        return [{ type: "text" as const, text: r.text }, await img(r.strip)];
      }) as AgentTool["run"],
    },
    {
      name: "submit_kit",
      description: `Hand the kit to the scene designer. Refused until you have studied the reference, the kit has its own typefaces, the tokens are set, FILM.roles names a component for every role (${KIT_ROLES.join(", ")}), every component has meta, its transition has been seen across a cut, and the last samples rendered readable and not too close to an earlier film.`,
      schema: z.object({ concept: z.string().describe("the film's visual idea in one or two sentences"), meta: z.record(z.string(), z.object({ use: z.string(), props: z.string() })).describe("every component: what it is for and its props, for the scene designer"), note: z.string() }),
      run: (async (i: { concept: string; meta: Record<string, { use: string; props: string }>; note: string }) => {
        const r0 = kitRoles();
        const miss: string[] = [];
        if (!tokens) miss.push("set_tokens");
        const noRole = KIT_ROLES.filter((r) => !r0[r] || !kitComponents().includes(r0[r]!));
        if (noRole.length) miss.push(`FILM.roles must name a kit component for every role (missing or not in the kit: ${noRole.join(", ")})`);
        if (studied < 2) miss.push("study the reference (at least two kinds)");
        if (!code) miss.push("write the kit");
        if (kitFonts().length < 1) miss.push("load the film's own typefaces");
        const unknownMeta = Object.keys(i.meta).filter((k) => !kitComponents().includes(k));
        const noMeta = kitComponents().filter((k) => !i.meta[k]);
        if (unknownMeta.length || noMeta.length) miss.push(`meta must describe exactly the kit's components (${noMeta.length ? `missing ${noMeta.join(", ")}` : ""}${unknownMeta.length ? ` unknown ${unknownMeta.join(", ")}` : ""})`);
        if (!transitionSeen) miss.push("render_transition and look at it");
        if (!lastRenderOk) miss.push("render_samples until they are readable and not too close to an earlier film");
        if (miss.length) return `NOT ACCEPTED:\n${miss.map((x) => `- ${x}`).join("\n")}`;
        accepted = `${i.concept} — ${i.note}`;
        roles = Object.fromEntries(KIT_ROLES.map((r) => [r, r0[r]!]));
        const byComp = new Map(Object.entries(roles).map(([r, c]) => [c, r]));
        const components = Object.fromEntries(Object.entries(i.meta).map(([k, v]) => [k, { ...v, ...(byComp.has(k) ? { role: byComp.get(k)! } : {}) }]));
        await writeFile(path.join(o.kitDir, "meta.json"), JSON.stringify({ concept: i.concept, roles, components, fonts: kitFonts(), transition: /transition\s*:\s*["']([^"']+)/.exec(code ?? "")?.[1] ?? null }, null, 1) + "\n");
        await o.onDesign(designFromKit({ job: o.job, channel: o.channel, topic: o.topic, concept: i.concept, fonts: kitFontStacks(), tokens: tokens! }).design);
        const pal = await o.palette().catch(() => [] as string[]);
        const rec = { job: o.job, fonts: kitFonts(), palette: pal.slice(0, 6), ...(tokens ? { tokens: { primary: tokens.palette.primary, accent: tokens.palette.accent, surface: tokens.palette.surface } } : {}), concept: i.concept, transition: /transition\s*:\s*["']([^"']+)/.exec(code ?? "")?.[1] ?? "", at: new Date().toISOString() };
        const f = path.join(o.data, "film-kits.json");
        const all = await readFile(f, "utf8").then((t) => JSON.parse(t) as unknown[], () => []);
        await writeFile(`${f}.tmp`, JSON.stringify([...all.filter((x) => (x as { job: string }).job !== o.job), rec], null, 1) + "\n");
        await rename(`${f}.tmp`, f);
        return "Accepted. If this film taught you something about designing, call note_lesson once; then stop.";
      }) as AgentTool["run"],
    },
    {
      name: "note_lesson",
      description: "Save one lesson for the next film's art director.",
      schema: z.object({ lesson: z.string() }),
      run: (async (i: { lesson: string }) => {
        noteSaved = true;
        if (!o.memoryDir) return "no memory configured";
        await mkdir(o.memoryDir, { recursive: true });
        await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LESSON (${o.title.slice(0, 60)}): ${i.lesson.replace(/\s+/g, " ").trim()}\n`);
        return "saved";
      }) as AgentTool["run"],
    },
  ];
  const skill = await readFile(new URL("../skills/film-designer.md", import.meta.url), "utf8");
  const notes = o.memoryDir ? await readMemory(o.memoryDir, o.channel, { data: o.data }) : "";
  const owner = o.memoryDir ? await readFile(path.join(o.memoryDir, "owner-notes.md"), "utf8").catch(() => "") : "";
  const earlierText = earlier.length ? `## Our earlier films (do not repeat their look)\n${earlier.slice(-8).map((k) => `- ${k.job}: fonts ${k.fonts.join(", ")}; palette ${k.tokens ? `primary ${k.tokens.primary}, accent ${k.tokens.accent}, surface ${k.tokens.surface}` : k.palette.join(" ")}; ${k.concept.slice(0, 160)}; transition ${k.transition}`).join("\n")}\n\n` : "";
  const system = [cached(skill), plain(`${earlierText}${notes.trim() ? `## Your own notes from earlier films\n${notes}\n\n` : ""}${owner.trim() ? `## The owner's notes (take these seriously)\n${tail(owner, 20)}\n\n` : ""}`)];
  const contract = KIT_ROLES.map((r) => `- ${r}: ${ROLE_CONTRACT[r]}`).join("\n");
  const user = `${o.change ? `${o.change.fresh ? "START AGAIN with a NEW visual concept (the current one must not be reused)" : "CHANGE the accepted kit (design/film/index.tsx is loaded; keep every component and prop the scene designer already uses unless the change says otherwise)"}: ${o.change.request}\n\n` : ""}Design the look of "${o.title}"${o.change && !o.change.fresh ? "" : " from a blank slate"}.\n\nROLES your kit must play (one component each; the engine passes these props):\n${contract}\n\nBRIEF:\n${o.brief.slice(0, 5000)}\n\nSHOTS you can render samples on (id — line — picture):\n${o.shots.map((s) => `${s.id} — "${s.line.slice(0, 90)}" — ${s.picture.slice(0, 70)}`).join("\n")}\n\nStart by studying the reference.`;
  const model = ROLE_MODEL.artDirector;
  log(`  art director (blank slate): ${o.title.slice(0, 60)} (${model})…`);
  let grace = 1;
  tools.push(...(o.extraTools ?? []));
  const run = await agentLoop({ stage: "film-designer.agent", fixed: 0.85, finish: { message: "Your budget for this stage is used up. Call submit_kit NOW with the work you have — change nothing else first. If it is refused, fix only what the refusal names and call submit_kit again." }, model, system, user, tools, effort: "medium", maxTurns: o.change ? 14 : 24, maxSeconds: o.change ? 300 : 600, maxUsd: o.change ? 0.6 : 1.2, maxTokens: 32000, done: () => accepted !== null && (noteSaved || grace-- <= 0), nudge: "The kit is not submitted. Study, write the kit, render samples on the film's shots, look, revise, and submit.", log });
  const report: FilmDesignerReport = { pass: accepted !== null, fonts: kitFonts(), components: kitComponents(), roles, transition: /transition\s*:\s*["']([^"']+)/.exec(code ?? "")?.[1] ?? null, renders, note: accepted ?? "not submitted", agent: { turns: run.turns, calls: run.calls, usd: Math.round(run.usd * 1e4) / 1e4 } };
  if (o.memoryDir) {
    await mkdir(o.memoryDir, { recursive: true });
    await appendFile(path.join(o.memoryDir, `${o.channel}.md`), `- LOG ${new Date().toISOString().slice(0, 10)} "${o.title.slice(0, 60)}": ${report.pass ? "kit accepted" : "not accepted"}; fonts ${report.fonts.join(", ")}; ${report.components.length} components; ${renders} renders; ${(accepted ?? "").slice(0, 200).replace(/\s+/g, " ")}\n`);
  }
  log(`  art director: ${report.pass ? "kit accepted" : "NOT accepted"} — fonts ${report.fonts.join(", ") || "none"}, ${report.components.length} components, transition ${report.transition ?? "none"}, ${renders} renders, ${run.turns} turns, $${report.agent.usd}`);
  return report;
}
