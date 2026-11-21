import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FactSheet, ResolutionReport, Storyboard } from "@opumia/contracts";

/**
 * Cross-film asset cooldown (data/asset-usage.json): which film used which picture, sound effect and music bed.
 * A new film may not reuse a picture or sound that any of the last `COOLDOWN_FILMS` films used, so no two films
 * share clips or hits. Wikipedia portraits and logos are exempt (the real picture of a subject is the right one).
 */
export const COOLDOWN_FILMS = 12;
interface Usage { job: string; at: string; pictures: string[]; sfx: string[]; music: string[] }
const file = (data: string) => path.join(data, "asset-usage.json");

async function load(data: string): Promise<Usage[]> {
  try {
    return JSON.parse(await readFile(file(data), "utf8")) as Usage[];
  } catch {
    return [];
  }
}

/** Refs on cooldown for a new film (everything the last films used, except this job's own earlier runs). */
export async function cooldownRefs(data: string, job: string): Promise<{ pictures: Set<string>; sfx: Set<string>; music: Set<string> }> {
  const recent = (await load(data)).filter((u) => u.job !== job).slice(-COOLDOWN_FILMS);
  return { pictures: new Set(recent.flatMap((u) => u.pictures)), sfx: new Set(recent.flatMap((u) => u.sfx)), music: new Set(recent.flatMap((u) => u.music)) };
}

export async function recordUsage(data: string, job: string, resolution: ResolutionReport, board: Storyboard): Promise<void> {
  const pictures = [...new Set(resolution.media.filter((m) => (m.role === "primary" || m.role === "layer") && m.provider !== "wikipedia").flatMap((m) => [m.ref, m.ref.split("#")[0]!, m.ref.split("@")[0]!]))].sort();
  const all = (await load(data)).filter((u) => u.job !== job);
  all.push({ job, at: new Date().toISOString(), pictures, sfx: [...new Set(board.shots.flatMap((s) => s.sfx.map((x) => x.assetId)))].sort(), music: [...new Set(board.music.map((m) => m.assetId))].sort() });
  await mkdir(data, { recursive: true });
  await writeFile(`${file(data)}.tmp`, JSON.stringify(all.slice(-80), null, 1) + "\n");
  await rename(`${file(data)}.tmp`, file(data));
}

/** Story era from the verified facts (20th–90th percentile of the years they state). */
export function eraOfFacts(facts: FactSheet): { min: number; max: number } | null {
  const years = facts.claims.flatMap((c) => [...c.text.matchAll(/\b(1[89]\d\d|20[0-4]\d)\b/g)].map((m) => Number(m[1]))).filter((y) => y <= new Date().getFullYear() + 1).sort((a, b) => a - b);
  if (years.length < 3) return null;
  return { min: years[Math.floor(years.length * 0.2)]!, max: years[Math.min(years.length - 1, Math.floor(years.length * 0.9))]! };
}
