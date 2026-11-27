// Background fetching (owner, 2026-11-26): the moment the plan exists, every scene's picture searches start at once
// in code, so each builder opens its workspace with candidates already on disk (news strips, stock sheets, Commons
// photos, film-library hits). The builder still chooses, cuts the moment and can search again — nothing is placed
// for it (the old pipeline placed pictures nobody had chosen, and that is what made its films generic).
// Each search runs in the scene's own mode (its downloads folder, its ledgers), so nothing collides.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool, type FilmPlan } from "./plan.js";

export interface Search { scene: string; tool: "press" | "stock" | "commons" | "films"; args: string[] }

/** Turn a scene's picture needs into searches. `how` may say "press: …", "stock: …", "commons: …", "films: …",
 *  "film scene: …" (a film or TV scene), several separated by " / "; a need without a hint becomes a stock search. */
export function searchesOf(plan: FilmPlan): Search[] {
  const out: Search[] = [];
  for (const s of plan.scenes) {
    const people = (s.entities ?? []).filter((e) => e.type === "person").map((e) => e.name);
    const world = (s.entities ?? []).filter((e) => e.type !== "person").map((e) => e.name);
    for (const p of s.pictures ?? []) {
      const hints = (p.how ?? "").split(/\s+\/\s+|;\s*/).map((h) => /^\s*(press|news|stock|commons|photo|films?|film scene|movie)\s*:\s*(.+)$/i.exec(h)).filter((m): m is RegExpExecArray => Boolean(m));
      if (!hints.length) { out.push({ scene: s.id, tool: "stock", args: [p.need.slice(0, 80)] }); continue; }
      for (const m of hints) {
        const kind = m[1]!.toLowerCase(), q = m[2]!.trim().replace(/^["']|["']$/g, "").slice(0, 100);
        if (kind === "press" || kind === "news") out.push({ scene: s.id, tool: "press", args: [q, "--n", "4", ...(people.length ? ["--person", people.join(",")] : []), ...(world.length ? ["--world", world.join(",")] : [])] });
        else if (kind === "film scene" || kind === "movie") out.push({ scene: s.id, tool: "press", args: [q, "--film", "--n", "4"] });
        else if (kind === "commons" || kind === "photo") out.push({ scene: s.id, tool: "commons", args: [q, "--n", "3"] });
        else if (kind.startsWith("film")) out.push({ scene: s.id, tool: "films", args: [q, "--n", "8"] });
        else out.push({ scene: s.id, tool: "stock", args: [q] });
      }
    }
  }
  // one scene's stock searches go in one call (one sheet set)
  const merged: Search[] = [];
  for (const x of out) {
    const same = x.tool === "stock" ? merged.find((m) => m.tool === "stock" && m.scene === x.scene && m.args.length < 4) : undefined;
    if (same) same.args.push(...x.args); else merged.push({ ...x, args: [...x.args] });
  }
  return merged;
}

const runTool = (o: { root: string; job: string; channel: string; env: Record<string, string | undefined> }, x: Search, timeoutS: number) => new Promise<string>((resolve) => {
  const p = spawn("npx", ["tsx", path.join(o.root, "apps/cli/src/film-agent/tools.ts"), x.tool, ...x.args], { cwd: o.root, env: { ...o.env, FILM_JOB: o.job, FILM_SCENE: x.scene, FILM_CHANNEL: o.channel, OPUMIA_ROOT: o.root } });
  let text = "";
  p.stdout.on("data", (d) => (text += d));
  p.stderr.on("data", () => {});
  const t = setTimeout(() => p.kill("SIGTERM"), timeoutS * 1000);
  p.on("close", () => { clearTimeout(t); resolve(text.trim()); });
});

/** Run every scene's searches (several at once, each with a time cap) and write downloads/<scene>/PREFETCH.md. */
export async function prefetch(o: { root: string; job: string; channel: string; plan: FilmPlan; env: Record<string, string | undefined>; parallel?: number; timeoutS?: number; log?: (s: string) => void }): Promise<{ searches: number; seconds: number }> {
  const t0 = Date.now();
  const all = searchesOf(o.plan);
  const results = await pool(all, o.parallel ?? 6, async (x) => ({ x, text: await runTool(o, x, o.timeoutS ?? 150) }));
  for (const s of o.plan.scenes) {
    const mine = results.filter((r) => r.x.scene === s.id);
    const dir = path.join(o.job, "downloads", s.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "PREFETCH.md"), `# Searches already run for ${s.id} (before you started)\n\nLook at every strip and sheet before choosing; search again whenever none of these shows the line.\n\n${mine.map((r) => `## film-tools ${r.x.tool} ${r.x.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n\n${r.text || "(nothing found or it timed out)"}`).join("\n\n") || "(the plan named no pictures for this scene)"}\n`);
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  o.log?.(`  prefetch: ${all.length} searches for ${o.plan.scenes.length} scenes in ${seconds} s`);
  return { searches: all.length, seconds };
}
