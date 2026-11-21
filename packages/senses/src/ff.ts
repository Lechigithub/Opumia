import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const run = promisify(execFile);

/** Run ffmpeg and collect stdout as one Buffer (raw frames / PCM). */
export function ffBytes(args: string[], maxBytes = 512 << 20): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let n = 0;
    let err = "";
    p.stdout.on("data", (c: Buffer) => {
      n += c.length;
      if (n <= maxBytes) chunks.push(c);
    });
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 300)}`))));
  });
}

export const probeDuration = async (f: string) => Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout.trim()) || 0;

/** Mono float PCM of [ss, ss+t) at `sr`, optionally through an ffmpeg audio filter. */
export async function pcm(file: string, o: { ss?: number; t?: number; sr?: number; af?: string } = {}): Promise<Float32Array> {
  const sr = o.sr ?? 16000;
  const buf = await ffBytes([...(o.ss ? ["-ss", String(o.ss)] : []), ...(o.t ? ["-t", String(o.t)] : []), "-i", file, "-vn", "-ac", "1", "-ar", String(sr), ...(o.af ? ["-af", o.af] : []), "-f", "f32le", "-"]);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** Raw RGB frames (w×h) sampled at `fps` from [ss, ss+t). */
export async function rgbFrames(file: string, o: { ss?: number; t?: number; fps: number; w: number; h: number }): Promise<Uint8Array[]> {
  // A still image is one frame: no seek, no fps filter (both can yield zero frames on image inputs).
  const still = /\.(jpe?g|png|webp)$/i.test(file);
  const buf = await ffBytes(still ? ["-i", file, "-frames:v", "1", "-vf", `scale=${o.w}:${o.h}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"] : [...(o.ss ? ["-ss", String(o.ss)] : []), ...(o.t ? ["-t", String(o.t)] : []), "-i", file, "-an", "-vf", `fps=${o.fps},scale=${o.w}:${o.h}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
  const size = o.w * o.h * 3;
  const out: Uint8Array[] = [];
  for (let i = 0; i + size <= buf.length; i += size) out.push(new Uint8Array(buf.buffer, buf.byteOffset + i, size));
  return out;
}

export const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
export const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]! : 0);
export const mean = (xs: number[]) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0);
export const std = (xs: number[]) => {
  const m = mean(xs);
  return xs.length ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) : 0;
};
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
