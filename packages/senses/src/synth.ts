/**
 * Craft inventory: tonal pluck accents (the channel's plucked notes under labels and small reveals). The library has
 * none, so a small set is synthesised deterministically with FFmpeg — decaying harmonic tones on a pentatonic scale.
 * Designed sound, not generated media: the same inputs give the same file. Cached in data/synth/sfx/.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { run } from "./ff.js";

export const PLUCK_NOTES: Array<{ name: string; hz: number }> = [
  { name: "a3", hz: 220 }, { name: "c4", hz: 261.63 }, { name: "d4", hz: 293.66 }, { name: "e4", hz: 329.63 }, { name: "g4", hz: 392 }, { name: "a4", hz: 440 },
];

/** The pluck files, made once: id, absolute path, note. */
export async function ensurePlucks(dataDir: string): Promise<Array<{ id: string; file: string; note: string; seconds: number }>> {
  const dir = path.join(dataDir, "synth", "sfx");
  await mkdir(dir, { recursive: true });
  const out: Array<{ id: string; file: string; note: string; seconds: number }> = [];
  for (const n of PLUCK_NOTES) {
    const file = path.join(dir, `pluck_${n.name}.mp3`);
    if (!existsSync(file)) {
      const f = n.hz.toFixed(2);
      const expr = `0.6*sin(2*PI*${f}*t)*exp(-7*t)+0.25*sin(4*PI*${f}*t)*exp(-11*t)+0.12*sin(6*PI*${f}*t)*exp(-16*t)+0.05*sin(2*PI*${f}*1.003*t)*exp(-5*t)`;
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=1.4`, "-af", "afade=t=in:d=0.004,aecho=0.6:0.4:60:0.18,volume=1.6", "-c:a", "libmp3lame", "-q:a", "2", file]);
    }
    out.push({ id: `synth_pluck_${n.name}`, file, note: n.name, seconds: 1.4 });
  }
  return out;
}
