// The parallel film agent's shared plan and the Remotion scaffold built from it (code, no model).
// plan.json is written by the planner; every scene is then built by its own builder in src/scenes/<id>.tsx, rendered
// through its own entry (src/entries/<id>.tsx), so builders work at the same time and one broken scene never breaks
// another's render. src/Film.tsx is generated: each scene in a <Sequence> that starts `lead` seconds before its first
// word (it enters over the outgoing scene, which keeps playing under it) — later scenes sit on top.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FPS = 24;
export interface ScenePlan {
  id: string; from: number; to: number; lead?: number;
  words: string; idea: string; seen: string;
  camera?: string; onScreen?: string; enter?: string; sound?: string;
  pictures?: Array<{ need: string; how?: string }>;
}
export interface FilmPlan { title?: string; world: string; signatureObject: string; scenes: ScenePlan[] }

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

/** What is wrong with a plan (empty = usable). lengthS is the film (narration + title); narrationS the voice alone. */
export function validatePlan(plan: FilmPlan | null, lengthS: number, narrationS: number, job?: string): string[] {
  if (!plan) return ["plan.json is missing or not valid JSON"];
  const e: string[] = [];
  if (!plan.world?.trim()) e.push("world: describe the film's world (grade, type, texture, devices)");
  if (!plan.signatureObject?.trim()) e.push("signatureObject: one real thing this story owns, returning 2–3 times");
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
  });
  const last = sc.at(-1);
  if (last && (last.to < narrationS - 0.05 || last.to > lengthS + 0.1)) e.push(`the last scene must end at ${lengthS.toFixed(2)} s (the film's length), not ${last.to}`);
  if (job && !existsSync(path.join(job, "src", "world.tsx"))) e.push("src/world.tsx is missing: the film's world as code (colours, type, the grade, the signature object) that every scene imports");
  return e;
}

const write = (f: string, s: string) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, s); };
/** Write the stubs, the per-scene entries, the world check entry and the generated Film.tsx. Never touches a built scene. */
export function scaffold(job: string, plan: FilmPlan, lengthS: number): void {
  const src = path.join(job, "src");
  for (const [i, s] of plan.scenes.entries()) {
    const f = path.join(src, "scenes", `${s.id}.tsx`);
    if (!existsSync(f)) write(f, `${STUB}\nimport React from "react";\nimport { AbsoluteFill } from "remotion";\nexport type SceneProps = { start: number; lead: number; length: number };\nconst Scene: React.FC<SceneProps> = () => <AbsoluteFill style={{ background: "#050505" }} />;\nexport default Scene;\n`);
    const w = sceneWindow(plan, i, lengthS);
    const props = `{ start: ${s.from}, lead: ${(s.from - w.startS).toFixed(3)}, length: ${(s.to - s.from).toFixed(3)} }`;
    write(path.join(src, "entries", `${s.id}.tsx`), `// generated: scene ${s.id} alone (film time ${w.startS.toFixed(2)}–${(w.startS + w.frames / FPS).toFixed(2)} s)\nimport React from "react";\nimport { Composition, registerRoot } from "remotion";\nimport Scene from "../scenes/${s.id}";\nconst Root: React.FC = () => <Composition id="Film" component={() => <Scene {...${props}} />} width={1920} height={1080} fps={${FPS}} durationInFrames={${w.frames}} />;\nregisterRoot(Root);\n`);
  }
  write(path.join(src, "entries", "_world.tsx"), `// generated: checks that src/world.tsx compiles\nimport React from "react";\nimport { AbsoluteFill, Composition, registerRoot } from "remotion";\nimport * as World from "../world";\nconst Root: React.FC = () => <Composition id="Film" component={() => <AbsoluteFill style={{ background: "#000" }} data-world={Object.keys(World).length} />} width={1920} height={1080} fps={${FPS}} durationInFrames={1} />;\nregisterRoot(Root);\n`);
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
