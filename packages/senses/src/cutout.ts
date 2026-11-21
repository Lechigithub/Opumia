import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffBytes, run } from "./ff.js";

/**
 * Cutouts from real photographs: separate the subject from its background (BiRefNet-lite, MIT, ONNX on
 * onnxruntime-node). Nothing is generated — every pixel of the result comes from the source picture; the model
 * only decides which pixels to keep. Used for thumbnails and sticker cutouts in scenes.
 */
const REPO = "onnx-community/BiRefNet_lite-ONNX";
const SIZE = 1024;

type Session = { inputNames: readonly string[]; outputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>> };
let sessionP: Promise<{ session: Session; Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown }> | null = null;

async function model(dataDir: string) {
  if (!sessionP) {
    sessionP = (async () => {
      const dir = path.join(dataDir, "models", "cutout");
      const file = path.join(dir, "birefnet_lite.onnx");
      if (!existsSync(file)) {
        await mkdir(dir, { recursive: true });
        const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/onnx/model.onnx`, { signal: AbortSignal.timeout(900_000) });
        if (!res.ok) throw new Error(`cutout model download failed (${res.status})`);
        await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
        await rename(`${file}.part`, file);
      }
      const ort = await import("onnxruntime-node");
      const session = (await ort.InferenceSession.create(file, { graphOptimizationLevel: "all" })) as unknown as Session;
      return { session, Tensor: ort.Tensor as never };
    })();
  }
  return sessionP;
}

export interface Cutout {
  path: string;
  width: number;
  height: number;
  /** Share of the picture kept as subject (0..1). Near 0 or near 1 means there was no clear subject. */
  coverage: number;
  /** Share of mask pixels that are decisively subject or background (crisp edges → high). */
  confidence: number;
}

/** Cut the subject out of a photo → transparent PNG cropped to the subject. */
export async function removeBackground(input: string, outPng: string, dataDir: string): Promise<Cutout> {
  const { session, Tensor } = await model(dataDir);
  const probe = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", input]);
  const [w, h] = probe.stdout.trim().split(",").map(Number) as [number, number];
  const rgb = await ffBytes(["-i", input, "-frames:v", "1", "-vf", `scale=${SIZE}:${SIZE}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
  const n = SIZE * SIZE;
  const x = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) x[c * n + i] = (rgb[i * 3 + c]! / 255 - mean[c]!) / std[c]!;
  const out = await session.run({ [session.inputNames[0]!]: new Tensor("float32", x, [1, 3, SIZE, SIZE]) });
  const logits = out[session.outputNames.at(-1)!]!.data;
  const mask = Buffer.alloc(n);
  let kept = 0;
  let decisive = 0;
  let x0 = SIZE, y0 = SIZE, x1 = 0, y1 = 0;
  for (let i = 0; i < n; i++) {
    const p = 1 / (1 + Math.exp(-logits[i]!));
    mask[i] = Math.round(p * 255);
    if (p > 0.5) {
      kept++;
      const px = i % SIZE;
      const py = (i / SIZE) | 0;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    if (p > 0.9 || p < 0.1) decisive++;
  }
  const coverage = kept / n;
  if (kept < n * 0.005) throw new Error("cutout: no subject found");
  // Crop to the subject with a small margin, in source pixels.
  const mx = 0.02;
  const cx0 = Math.max(0, Math.floor((x0 / SIZE - mx) * w));
  const cy0 = Math.max(0, Math.floor((y0 / SIZE - mx) * h));
  const cw = Math.min(w - cx0, Math.ceil(((x1 - x0) / SIZE + mx * 2) * w));
  const ch = Math.min(h - cy0, Math.ceil(((y1 - y0) / SIZE + mx * 2) * h));
  const dir = await mkdtemp(path.join(os.tmpdir(), "opumia-cut-"));
  try {
    const raw = path.join(dir, "mask.gray");
    await writeFile(raw, mask);
    await mkdir(path.dirname(outPng), { recursive: true });
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${SIZE}x${SIZE}`, "-i", raw, "-filter_complex", `[1:v]scale=${w}:${h}:flags=bicubic[m];[0:v]format=rgba[c];[c][m]alphamerge,crop=${cw}:${ch}:${cx0}:${cy0}`, "-frames:v", "1", "-update", "1", outPng], { timeout: 120_000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { path: outPng, width: cw, height: ch, coverage: Math.round(coverage * 1000) / 1000, confidence: Math.round((decisive / n) * 1000) / 1000 };
}
