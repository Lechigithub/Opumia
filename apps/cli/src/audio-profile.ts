import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isUsable } from "@opumia/agents";
import type { LibraryIndex } from "@opumia/contracts";
import { measureMusic, measureSound, type MusicProfile, type SoundCharacter } from "@opumia/senses";

/**
 * Measured character of every usable sound effect and music bed in the Library (data/audio-profile.json).
 * Asset ids are stable and the files never change, so each file is measured once; later runs only add new ones.
 *   opumia profile-audio
 */
export interface AudioProfile { schemaVersion: 1; sfx: Record<string, SoundCharacter>; music: Record<string, MusicProfile> }
const file = (data: string) => path.join(data, "audio-profile.json");

export async function loadAudioProfile(data: string): Promise<AudioProfile> {
  try {
    return JSON.parse(await readFile(file(data), "utf8")) as AudioProfile;
  } catch {
    return { schemaVersion: 1, sfx: {}, music: {} };
  }
}

export async function buildAudioProfile(o: { data: string; library: string; index: LibraryIndex; log?: (s: string) => void }): Promise<AudioProfile> {
  const log = o.log ?? (() => {});
  const prof = await loadAudioProfile(o.data);
  const usable = o.index.assets.filter(isUsable);
  const sfx = usable.filter((a) => a.category === "sfx" && a.kind === "audio" && !prof.sfx[a.id]);
  const music = usable.filter((a) => a.category === "music" && a.kind === "audio" && !prof.music[a.id]);
  if (!sfx.length && !music.length) return prof;
  log(`  audio profile: measuring ${sfx.length} sound effect(s) and ${music.length} music bed(s)…`);
  const pool = async <T>(items: T[], n: number, fn: (x: T) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let k = next++; k < items.length; k = next++) await fn(items[k]!).catch(() => {});
    }));
  };
  await pool(sfx, 6, async (a) => {
    prof.sfx[a.id] = await measureSound(path.join(o.library, a.relPath));
  });
  await pool(music, 4, async (a) => {
    prof.music[a.id] = await measureMusic(path.join(o.library, a.relPath), { t: 120 });
  });
  await mkdir(o.data, { recursive: true });
  const sorted: AudioProfile = { schemaVersion: 1, sfx: Object.fromEntries(Object.entries(prof.sfx).sort(([a], [b]) => a.localeCompare(b))), music: Object.fromEntries(Object.entries(prof.music).sort(([a], [b]) => a.localeCompare(b))) };
  await writeFile(`${file(o.data)}.tmp`, JSON.stringify(sorted) + "\n");
  await rename(`${file(o.data)}.tmp`, file(o.data));
  const fam = new Map<string, number>();
  for (const c of Object.values(sorted.sfx)) fam.set(c.family, (fam.get(c.family) ?? 0) + 1);
  log(`  audio profile: ${Object.keys(sorted.sfx).length} effects (${[...fam.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ")}), ${Object.keys(sorted.music).length} beds`);
  return sorted;
}
