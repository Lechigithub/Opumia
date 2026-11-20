import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaProbe } from "@opumia/contracts";

const run = promisify(execFile);

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  pix_fmt?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}
interface FfOut {
  streams?: FfStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

const fpsOf = (s?: string) => {
  if (!s) return undefined;
  const [n, d] = s.split("/").map(Number);
  if (!n || !d) return undefined;
  const v = n / d;
  return v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : undefined;
};

const num = (s?: string) => {
  const v = s === undefined ? NaN : Number(s);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

/** Read-only ffprobe of one file. Images report width/height only. */
export async function ffprobe(file: string, kind: "video" | "audio" | "image", timeoutMs = 30_000): Promise<MediaProbe> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", file],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  const j = JSON.parse(stdout) as FfOut;
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && s.width);
  const a = streams.find((s) => s.codec_type === "audio");
  const p: MediaProbe = {};
  if (v) {
    p.width = v.width;
    p.height = v.height;
    if (kind !== "image") {
      p.videoCodec = v.codec_name;
      p.fps = fpsOf(v.avg_frame_rate) ?? fpsOf(v.r_frame_rate);
      p.pixFmt = v.pix_fmt;
      const rot = v.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? num(v.tags?.rotate);
      if (rot) p.rotation = rot;
    }
  }
  if (kind !== "image") {
    const d = num(j.format?.duration);
    if (d !== undefined) p.durationS = Math.round(d * 1000) / 1000;
    const br = num(j.format?.bit_rate);
    if (br !== undefined) p.bitRate = Math.round(br);
    p.hasAudio = Boolean(a);
    if (a) {
      p.audioCodec = a.codec_name;
      const sr = num(a.sample_rate);
      if (sr) p.sampleRate = Math.round(sr);
      if (a.channels) p.channels = a.channels;
    }
  }
  // Drop undefined keys so cache/output JSON is stable.
  return Object.fromEntries(Object.entries(p).filter(([, val]) => val !== undefined)) as MediaProbe;
}

/** Run async tasks with bounded concurrency, preserving order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>, onProgress?: (done: number) => void): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
      done++;
      onProgress?.(done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function hasFfprobe(): Promise<boolean> {
  try {
    await run("ffprobe", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
