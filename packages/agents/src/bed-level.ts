/**
 * Music beds at the channel's level under the voice. Measured on all 37 of the channel's films (Reference sound.json,
 * demucs): in a cold open the bed sits ≈ 15.8 dB under the voice (p10 8.9, p90 21.7); over a whole film ≈ 19.1 dB
 * (build list 6; an earlier 9.5 dB came from Ponzi alone). Our films sat ≈ 20 dB under, a thin pad that vanished between lines.
 *
 * Each cue's gain is set from its bed's own measured loudness over the span it plays (ffmpeg EBU R128 on the file,
 * cached), with a model taken from the hand passes: the bed under speech ≈ its loudness + gain − (|duck| + 3) dB.
 * A cue that opens the film and ends by the title card (or within the first 45 s) is the cold open: duck −9, ≈ 10.5 dB
 * under the voice. Later cues keep the whole-film duck (−14) at ≈ 15 dB under. Beds whose loudness swings more than
 * ≈ 8 dB over their span are reported as unsteady (the cold-open bed should not fall away between lines).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
type Cue = { assetId: string; startS: number; endS: number; gainDb: number; inS?: number; duckDb?: number } & Record<string, unknown>;

/** Short-term loudness (LUFS, 3 s windows) over a bed's span [inS, inS + len], looped like the mix loops it. */
export async function bedLoudness(file: string, inS: number, len: number, cacheDir: string): Promise<{ lufs: number; p10: number; p90: number } | null> {
  const key = `${file}|${inS.toFixed(1)}|${Math.min(len, 90).toFixed(0)}`;
  const cf = path.join(cacheDir, "bed-loudness.json");
  const cache = existsSync(cf) ? (JSON.parse(await readFile(cf, "utf8")) as Record<string, { lufs: number; p10: number; p90: number }>) : {};
  if (cache[key]) return cache[key]!;
  const r = await pexec("ffmpeg", ["-hide_banner", "-nostats", "-stream_loop", "-1", "-ss", inS.toFixed(2), "-t", Math.min(len, 90).toFixed(2), "-i", file, "-af", "ebur128=metadata=1,ametadata=print:key=lavfi.r128.S", "-f", "null", "-"], { maxBuffer: 1 << 26 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const v = String(r.stderr).split("\n").filter((l) => l.includes("lavfi.r128.S=")).map((l) => Number(l.split("=")[1])).filter((x) => Number.isFinite(x) && x > -70).slice(30);
  if (v.length < 10) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]!;
  const out = { lufs: Math.round(q(0.5) * 10) / 10, p10: Math.round(q(0.1) * 10) / 10, p90: Math.round(q(0.9) * 10) / 10 };
  cache[key] = out;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(`${cf}.tmp`, JSON.stringify(cache, null, 1));
  await rename(`${cf}.tmp`, cf);
  return out;
}

// Build list 6 (2026-11-25), measured on all 37 MagnatesMedia films with demucs htdemucs (two stems, the same separation
// as Reference sound.json; reproduced on Ponzi at r = 0.999): the voice sits over the bed by p10 8.9 / median 15.8 /
// p90 21.7 dB in the first 70 s, and 14.8 / 19.1 / 24.7 dB over whole films. The old 10.5 / 15 came from Ponzi alone,
// near the channel's loudest-bed extreme. Hand film Wirecard v4.4, separated the same way: 8.8 dB (too loud).
export const BED_GAP = { coldOpen: 15.8, body: 19.1 } as const;
export const BED_GAP_BAND = { coldOpen: [8.9, 21.7], body: [14.8, 24.7] } as const;
const VOICE_LUFS = -17; // the narrator chain's level while speaking (measured on our mixes)

/** Sets every cue's gain (and the cold open's duck) so its bed sits at the channel's distance under the voice. */
export async function levelBeds(o: { music: Cue[]; fileOf: (assetId: string) => string | null; titleCardEndS?: number; cacheDir: string }): Promise<{ music: Cue[]; notes: string[] }> {
  const notes: string[] = [];
  const music: Cue[] = [];
  for (const [k, m] of o.music.entries()) {
    const f = o.fileOf(m.assetId);
    const cold = k === 0 && m.startS < 1 && (o.titleCardEndS !== undefined ? m.endS <= o.titleCardEndS + 2 : m.endS <= 45);
    const duck = cold ? -9 : m.duckDb ?? -14;
    const lv = f ? await bedLoudness(f, m.inS ?? 0, m.endS - m.startS, o.cacheDir) : null;
    if (!lv) { music.push({ ...m, ...(cold ? { duckDb: duck } : {}) }); notes.push(`cue ${k}: loudness not measurable, gain kept`); continue; }
    const target = VOICE_LUFS - (cold ? BED_GAP.coldOpen : BED_GAP.body);
    const gain = Math.max(-12, Math.min(8, Math.round((target - lv.lufs + Math.abs(duck) + 3) * 2) / 2));
    music.push({ ...m, gainDb: gain, ...(cold || m.duckDb !== undefined ? { duckDb: duck } : {}) });
    const swing = lv.p90 - lv.p10;
    notes.push(`cue ${k}${cold ? " (cold open)" : ""}: bed ${lv.lufs} LUFS (swings ${swing.toFixed(1)} dB) → gain ${gain} dB, duck ${duck} dB, ≈ ${cold ? BED_GAP.coldOpen : BED_GAP.body} dB under the voice${swing > 8 ? " — UNSTEADY: it falls away in places; a steadier bed holds the cold open" : ""}`);
  }
  return { music, notes };
}
