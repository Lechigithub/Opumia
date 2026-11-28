// Watch a stretch of a finished film file: a strip of frames, its loudness, near-silences and cuts — what a viewer
// gets (the viewer QA agent's eyes on the film agent's finished film).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { run } from "@opumia/senses";

/**
 * Watch a stretch of a finished film file (build list B10): a strip of evenly spaced frames from the mp4 itself,
 * its loudness, near-silences, and the cuts in it (scene changes) — what a viewer gets, after mastering.
 */
export async function watchFile(o: { video: string; fromS: number; toS: number; outDir: string; stripFrames?: number }): Promise<{ strip: string; text: string }> {
  await mkdir(o.outDir, { recursive: true });
  const t = Math.max(0.5, o.toS - o.fromS);
  const n = o.stripFrames ?? 8;
  const key = createHash("sha1").update(`${path.resolve(o.video)}|${o.fromS}|${o.toS}|${n}`).digest("hex").slice(0, 12);
  const strip = path.join(o.outDir, `film_${key}.jpg`);
  if (!existsSync(strip)) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", o.fromS.toFixed(2), "-t", t.toFixed(2), "-i", o.video, "-vf", `fps=${(n / t).toFixed(4)},scale=320:-2,tile=4x${Math.ceil(n / 4)}`, "-frames:v", "1", strip]);
  const lo = await run("ffmpeg", ["-hide_banner", "-nostats", "-ss", o.fromS.toFixed(2), "-t", t.toFixed(2), "-i", o.video, "-af", "ebur128=peak=true,silencedetect=n=-45dB:d=0.4", "-f", "null", "-"]).catch(() => null);
  const err = lo?.stderr ?? "";
  const sum = err.slice(err.lastIndexOf("Summary:"));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1] ?? NaN);
  const lra = Number(/LRA:\s+(-?[\d.]+) LU/.exec(sum)?.[1] ?? NaN);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(sum)?.[1] ?? NaN);
  const silences = [...err.matchAll(/silence_start: (-?[\d.]+)[\s\S]*?silence_end: (-?[\d.]+)/g)].map((m) => [o.fromS + Number(m[1]), o.fromS + Number(m[2])] as [number, number]);
  const sc = await run("ffmpeg", ["-hide_banner", "-nostats", "-ss", o.fromS.toFixed(2), "-t", t.toFixed(2), "-i", o.video, "-vf", "scale=160:-2,select='gt(scene,0.32)',showinfo", "-an", "-f", "null", "-"]).catch(() => null);
  const cuts = [...(sc?.stderr ?? "").matchAll(/pts_time:([\d.]+)/g)].map((m) => o.fromS + Number(m[1]));
  const step = t / n;
  const text = [
    `${o.fromS.toFixed(1)}–${o.toS.toFixed(1)} s of the finished film; frames left to right, top to bottom at ${Array.from({ length: n }, (_, k) => (o.fromS + step * (k + 0.5)).toFixed(1)).join(", ")} s.`,
    `sound: ${Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : "loudness ?"}, range ${Number.isFinite(lra) ? lra.toFixed(1) : "?"} LU, peak ${Number.isFinite(peak) ? peak.toFixed(1) : "?"} dBFS${silences.length ? `; near-silence ${silences.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`).join(", ")}` : ""}.`,
    `picture: ${cuts.length} cut(s) detected${cuts.length ? ` at ${cuts.map((c) => c.toFixed(1)).join(", ")} s` : ""}.`,
  ].join("\n");
  return { strip, text };
}
