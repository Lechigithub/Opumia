// The parallel film agent's shared plan and the Remotion scaffold built from it (code, no model).
// plan.json is written by the planner; every scene is then built by its own builder in src/scenes/<id>.tsx, rendered
// through its own entry (src/entries/<id>.tsx), so builders work at the same time and one broken scene never breaks
// another's render. src/Film.tsx is generated: each scene in a <Sequence> that starts `lead` seconds before its first
// word (it enters over the outgoing scene, which keeps playing under it) — later scenes sit on top.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FPS = 24;
/** The film's frame (job.json aspect: 16:9 → 1920×1080, 9:16 → 1080×1920) and its file name. */
export function frameOf(job: string): { w: number; h: number; aspect: "16:9" | "9:16"; film: string } {
  let aspect: "16:9" | "9:16" = "16:9";
  try { aspect = (JSON.parse(readFileSync(path.join(job, "job.json"), "utf8")) as { aspect?: string }).aspect === "9:16" ? "9:16" : "16:9"; } catch { /* default */ }
  return aspect === "9:16" ? { w: 1080, h: 1920, aspect, film: "film_9x16.mp4" } : { w: 1920, h: 1080, aspect, film: "film_16x9.mp4" };
}
/** The finished film's path in a workspace. */
export const filmPath = (job: string) => path.join(job, frameOf(job).film);
/** A 9:16 film's cover (packaging writes it; mix.ts makes it frame one; the gate checks it is there). */
export const coverPath = (job: string): string | null => ["cover_9x16.jpg", "cover_9x16.png"].map((f) => path.join(job, f)).find((f) => existsSync(f)) ?? null;
export interface ScenePlan {
  id: string; from: number; to: number; lead?: number;
  words: string; idea: string; seen: string;
  camera?: string; onScreen?: string; enter?: string; sound?: string;
  pictures?: Array<{ need: string; how?: string }>;
  /** the real people, companies, places it names (for searches, the face check and the thumbnail) */
  entities?: Array<{ name: string; type: "person" | "company" | "place" | "landmark" | "event" | "product" }>;
  /** the year the line is about (the period check dates footage against it) */
  year?: number;
  /** a story turn, or the film's biggest line (the sound draft puts a riser, hit or drop-out there) */
  mark?: "turn" | "biggest" | "chapter";
}
export interface FilmPlan {
  title?: string; world: string; signatureObject: string; scenes: ScenePlan[];
  /** the world's colours and typefaces (also handed to the thumbnail) */
  palette?: { primary?: string; accent?: string; surface?: string; text?: string };
  fonts?: { display?: string; body?: string };
}

/** Run tasks with at most n at once. */
export async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]!); }));
  return out;
}

/** Media paths in a piece of code: staticFile("…") and any literal path into public/ (v/, img/, a/) passed as a prop
 *  (src="v/clip.mp4"). Juicero rebuild, 2026-11-26: clips passed as props were invisible to the fair-use count. */
export function mediaRefs(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/staticFile\(\s*[`"']([^`"'$]+)[`"']/g)) out.add(m[1]!);
  for (const m of code.matchAll(/[`"']((?:v|img|a)\/[^`"'$\s]+\.(?:mp4|mov|webm|jpe?g|png|webp|mp3|wav))[`"']/gi)) out.add(m[1]!);
  return [...out];
}
/** Every staticFile the film's code draws (src/, generated entries excluded): what is actually on screen. */
export function filmMedia(job: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string) => { if (!existsSync(d)) return; for (const f of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== "entries") walk(p); } else if (/\.(tsx?|jsx?)$/.test(f.name)) for (const m of mediaRefs(readFileSync(p, "utf8"))) out.add(m); } };
  walk(path.join(job, "src"));
  return out;
}

export const STUB = "// STUB — this scene has not been built yet";
const lead = (s: ScenePlan | undefined) => Math.max(0, Math.min(1.5, s?.lead ?? 0.5));
/** Where scene i sits in the film: it starts `lead` before its words and runs until the next scene's entrance ends. */
export function sceneWindow(plan: FilmPlan, i: number, lengthS: number): { startS: number; frames: number; fromFrame: number } {
  const s = plan.scenes[i]!, next = plan.scenes[i + 1];
  const startS = Math.max(0, s.from - (i === 0 ? 0 : lead(s)));
  const endS = Math.min(lengthS, next ? next.from : lengthS);
  const fromFrame = Math.round(startS * FPS);
  return { startS, fromFrame, frames: Math.max(1, Math.round(endS * FPS) - fromFrame) };
}

export function readPlan(job: string): FilmPlan | null {
  try { return JSON.parse(readFileSync(path.join(job, "plan.json"), "utf8")) as FilmPlan; } catch { return null; }
}

/**
 * The signature object is a real thing from the story, filmed or photographed — never a graphic the film draws
 * (agent Juicero, 2026-11-27: "the press gauge — a force dial" drawn in code returned in six scenes; the viewer QA
 * called it templated and those scenes scored lowest on the referee). Returns why it is refused, or null.
 */
export function drawnObject(so: string): string | null {
  const t = so.toLowerCase();
  const drawn = /\b(drawn|in code|animated|vector|graphic|icon|ui|hud|dashboard|readout|diagram|chart|infographic|progress bar|motion graphic)\b/.exec(t)?.[1];
  if (drawn) return `"${drawn}": the signature object is a real thing from this story that the camera saw (a product, a document, a place, a prop in real footage or a real photo), not something the film draws`;
  const component = /<([A-Z]\w*)\s*\/?>/.exec(so)?.[1];
  if (component) return `"<${component}>": a component the film draws — the signature object is a real thing from this story that the camera saw`;
  const instrument = /\b(dial|gauge|meter|timer|counter|clock|needle|scoreboard|ticker)\b/.exec(t)?.[1];
  if (instrument && !/\b(footage|filmed|photo|photograph|photographed|clip|archive|news)\b/.test(t)) return `"${instrument}": an instrument reads as a drawn device unless it is the real one on film — name the real thing and where its picture comes from (footage, photo), or choose another`;
  return null;
}

/**
 * A search for a person performing or reacting to the line, the channel's most common shot (a performed actor, lit
 * low-key, under a big caption). Search test, 2026-11-27: queries like "man counting money desk lamp" found 7 of 155
 * candidates at the channel's level (4 fitting their line); objects and places ("sports car night garage") 1 of 157;
 * the agents' mood searches ("dark moody single light bulb") found dark pictures that fit nothing.
 */
export const PERSON = /\b(man|men|woman|women|person|people|hands?|fingers|worker|workers|businessman|businessmen|businesswoman|investors?|executives?|crowd|faces?|customers?|engineers?|founder|boss|salesman|employees?|couple|family|child|kid|actors?|reporters?|audience|speaker|presenter|chef|banker|lawyer|judge|guy|girl|boy|he|she)\b/i;
const REAL_HINT = /\b(press|news|clip|screenshot|film scene|movie)\b/i;
/** A scene with no real material must plan at least one stock or films search for a person acting out the line. */
export function needsPerformedSearch(s: ScenePlan): boolean {
  const hows = (s.pictures ?? []).map((p) => p.how ?? "");
  if (hows.some((h) => REAL_HINT.test(h))) return false;
  const searches = hows.flatMap((h) => h.split(/\s+\/\s+|;\s*/)).map((h) => /^\s*(stock|films?)\s*:\s*(.+)$/i.exec(h)?.[2] ?? "").filter(Boolean);
  return !searches.some((q) => PERSON.test(q));
}

/** What is wrong with a plan (empty = usable). lengthS is the film (narration + title); narrationS the voice alone. */
export function validatePlan(plan: FilmPlan | null, lengthS: number, narrationS: number, job?: string): string[] {
  if (!plan) return ["plan.json is missing or not valid JSON"];
  const e: string[] = [];
  if (!plan.world?.trim()) e.push("world: describe the film's world (grade, type, texture, devices)");
  if (!plan.signatureObject?.trim()) e.push("signatureObject: one real thing this story owns, returning 2–3 times");
  else { const d = drawnObject(plan.signatureObject); if (d) e.push(`signatureObject: ${d}`); }
  const sc = plan.scenes ?? [];
  const lo = Math.ceil(lengthS / 9), hi = Math.ceil(lengthS / 2.5);
  if (sc.length < lo || sc.length > hi) e.push(`scenes: ${sc.length} — a ${Math.round(lengthS)} s film has ${lo}–${hi} (a scene per idea, 2.5–9 s)`);
  const ids = new Set<string>();
  sc.forEach((s, i) => {
    const n = `scene ${s.id ?? i + 1}`;
    if (!/^s\d{2}$/.test(s.id ?? "")) e.push(`${n}: id must be s01, s02, …`);
    if (ids.has(s.id)) e.push(`${n}: id used twice`);
    ids.add(s.id);
    if (!(s.to > s.from)) e.push(`${n}: to must be after from`);
    if (s.to - s.from > 12) e.push(`${n}: ${(s.to - s.from).toFixed(1)} s — split it (≤ 12 s)`);
    if (s.to - s.from < 1.2) e.push(`${n}: ${(s.to - s.from).toFixed(1)} s — too short to read (≥ 1.2 s)`);
    for (const k of ["idea", "seen"] as const) if (!s[k]?.trim()) e.push(`${n}: "${k}" is empty`);
    if (typeof s.words !== "string") e.push(`${n}: "words" (the narration over it, "" for the title)`);
    const prev = sc[i - 1];
    if (i === 0 && Math.abs(s.from) > 0.05) e.push(`${n}: the first scene starts at 0`);
    if (prev && Math.abs(prev.to - s.from) > 0.05) e.push(`${n}: starts at ${s.from} but ${prev.id} ends at ${prev.to} — scenes must touch`);
    if (needsPerformedSearch(s)) e.push(`${n}: no real material and no search for a person acting out the line — add to pictures[].how a "stock: …" search for a person performing or reacting to it ("man counting money desk lamp", "man staring at machine dark room"): the channel's most common shot; objects, places and moods rarely read like it`);
  });
  const last = sc.at(-1);
  if (last && (last.to < narrationS - 0.05 || last.to > lengthS + 0.1)) e.push(`the last scene must end at ${lengthS.toFixed(2)} s (the film's length), not ${last.to}`);
  // a long film's chapters (the script's segments carry them): each chapter opens on a scene marked "chapter" (the
  // channel's chapter card, measured ≈ every 3 min), starting within 1 s of the chapter's first word
  if (job) {
    const ts = (() => { try { return JSON.parse(readFileSync(path.join(job, "timed-script.json"), "utf8")) as { segments?: Array<{ startS: number; chapter?: string }> }; } catch { return {}; } })();
    let prevCh: string | undefined;
    for (const sg of ts.segments ?? []) {
      if (sg.chapter && sg.chapter !== prevCh && prevCh !== undefined && !sc.some((s) => s.mark === "chapter" && Math.abs(s.from - sg.startS) <= 1)) e.push(`chapter "${sg.chapter}" starts at ${sg.startS.toFixed(1)} s: open it on a scene marked "chapter" (from within 1 s of it) — the channel's chapter card`);
      if (sg.chapter) prevCh = sg.chapter;
    }
  }
  if (job && !existsSync(path.join(job, "src", "world.tsx"))) e.push("src/world.tsx is missing: the film's world as code (colours, type, the grade, the signature object) that every scene imports");
  return e;
}

const write = (f: string, s: string) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, s); };
/** Write the stubs, the per-scene entries, the world check entry and the generated Film.tsx. Never touches a built scene. */
export function scaffold(job: string, plan: FilmPlan, lengthS: number): void {
  const src = path.join(job, "src"), fr = frameOf(job);
  for (const [i, s] of plan.scenes.entries()) {
    const f = path.join(src, "scenes", `${s.id}.tsx`);
    if (!existsSync(f)) write(f, `${STUB}\nimport React from "react";\nimport { AbsoluteFill } from "remotion";\nexport type SceneProps = { start: number; lead: number; length: number };\nconst Scene: React.FC<SceneProps> = () => <AbsoluteFill style={{ background: "#050505" }} />;\nexport default Scene;\n`);
    const w = sceneWindow(plan, i, lengthS);
    const props = `{ start: ${s.from}, lead: ${(s.from - w.startS).toFixed(3)}, length: ${(s.to - s.from).toFixed(3)} }`;
    write(path.join(src, "entries", `${s.id}.tsx`), `// generated: scene ${s.id} alone (film time ${w.startS.toFixed(2)}–${(w.startS + w.frames / FPS).toFixed(2)} s)\nimport React from "react";\nimport { Composition, registerRoot } from "remotion";\nimport Scene from "../scenes/${s.id}";\nconst Root: React.FC = () => <Composition id="Film" component={() => <Scene {...${props}} />} width={${fr.w}} height={${fr.h}} fps={${FPS}} durationInFrames={${w.frames}} />;\nregisterRoot(Root);\n`);
  }
  write(path.join(src, "entries", "_world.tsx"), `// generated: checks that src/world.tsx compiles\nimport React from "react";\nimport { AbsoluteFill, Composition, registerRoot } from "remotion";\nimport * as World from "../world";\nconst Root: React.FC = () => <Composition id="Film" component={() => <AbsoluteFill style={{ background: "#000" }} data-world={Object.keys(World).length} />} width={${fr.w}} height={${fr.h}} fps={${FPS}} durationInFrames={1} />;\nregisterRoot(Root);\n`);
  const imports = plan.scenes.map((s) => `import ${s.id.toUpperCase()} from "./scenes/${s.id}";`).join("\n");
  const seqs = plan.scenes.map((s, i) => {
    const w = sceneWindow(plan, i, lengthS);
    return `    <Sequence from={${w.fromFrame}} durationInFrames={${w.frames}} name="${s.id}"><${s.id.toUpperCase()} start={${s.from}} lead={${(s.from - w.startS).toFixed(3)}} length={${(s.to - s.from).toFixed(3)}} /></Sequence>`;
  }).join("\n");
  write(path.join(src, "Film.tsx"), `// generated from plan.json by the film agent's orchestrator — edit the scenes, not this file\nimport React from "react";\nimport { AbsoluteFill, Sequence } from "remotion";\n${imports}\nexport const FilmRoot: React.FC = () => (\n  <AbsoluteFill style={{ background: "#000" }}>\n${seqs}\n  </AbsoluteFill>\n);\n`);
}

/** The brief a builder gets: its scene, its neighbours, where it sits. */
export function sceneBrief(plan: FilmPlan, i: number, lengthS: number): string {
  const s = plan.scenes[i]!, w = sceneWindow(plan, i, lengthS);
  const show = (x: ScenePlan | undefined, label: string) => x ? `${label} ${x.id} (${x.from}–${x.to} s): ${x.idea} — seen: ${x.seen}${x.enter ? ` — enters: ${x.enter}` : ""}` : `${label}: none`;
  return [
    `Your scene: ${s.id}, words ${s.from}–${s.to} s of the film. Your component is mounted from ${w.startS.toFixed(2)} s (that is its frame 0) for ${(w.frames / FPS).toFixed(2)} s: it receives props { start, lead, length } — its first word lands at frame round(lead × 24); after length + lead seconds the next scene enters over you while you keep playing.`,
    `Words: "${s.words}"`, `Idea: ${s.idea}`, `Seen: ${s.seen}`,
    s.camera ? `Camera: ${s.camera}` : "", s.onScreen ? `On screen: ${s.onScreen}` : "", s.enter ? `Enters: ${s.enter}` : "", s.sound ? `Sound (the finisher mixes it): ${s.sound}` : "",
    s.pictures?.length ? `Pictures it needs:\n${s.pictures.map((p) => `  - ${p.need}${p.how ? ` (${p.how})` : ""}`).join("\n")}` : "",
    show(plan.scenes[i - 1], "Before you:"), show(plan.scenes[i + 1], "After you:"),
  ].filter(Boolean).join("\n");
}
