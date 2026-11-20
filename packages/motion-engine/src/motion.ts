import { ASPECT_DIMENSIONS, type Aspect, type CameraMove } from "@opumia/contracts";

/**
 * Sprint 1: pure, framework-free motion math shared by the Remotion compositions (Sprint 3)
 * and the FFmpeg fallback path. No rendering here yet.
 */

export const aspectPreset = (aspect: Aspect, fps: 24 | 25 | 30 | 60 = 30) => ({ aspect, fps, ...ASPECT_DIMENSIONS[aspect] });

const ease = (t: number, kind: "linear" | "ease_in_out" | "ease_out") =>
  kind === "linear" ? t : kind === "ease_out" ? 1 - (1 - t) ** 3 : t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;

export interface Transform {
  scale: number;
  /** Translation in normalized frame units (fraction of output width/height). */
  x: number;
  y: number;
}

/** Evaluate a camera move at progress t ∈ [0,1]. Deterministic, so renders are reproducible. */
export function cameraAt(move: CameraMove, t: number): Transform {
  const p = Math.min(1, Math.max(0, t));
  switch (move.type) {
    case "static":
      return { scale: 1, x: 0, y: 0 };
    case "ken_burns": {
      const e = ease(p, move.easing);
      const scale = move.fromScale + (move.toScale - move.fromScale) * e;
      const fx = move.from[0] + (move.to[0] - move.from[0]) * e;
      const fy = move.from[1] + (move.to[1] - move.from[1]) * e;
      // Keep the focus point centred while staying inside the source frame.
      const max = (scale - 1) / 2;
      const clamp = (v: number) => Math.max(-max, Math.min(max, v));
      return { scale, x: clamp((0.5 - fx) * scale), y: clamp((0.5 - fy) * scale) };
    }
    case "pan": {
      const e = ease(p, "ease_in_out");
      const scale = 1 + move.amount;
      const d = (move.amount / 2) * (2 * e - 1);
      const dir = { left: [-d, 0], right: [d, 0], up: [0, -d], down: [0, d] }[move.direction] as [number, number];
      return { scale, x: dir[0], y: dir[1] };
    }
    case "parallax":
      return { scale: 1 + move.depth * 0.1, x: move.depth * 0.05 * (2 * p - 1), y: 0 };
    case "shake": {
      const a = move.intensity * 0.01;
      return { scale: 1 + a * 2, x: a * Math.sin(p * 97), y: a * Math.cos(p * 131) };
    }
  }
}

/**
 * Crop window (normalized) to reframe a 16:9 source into 9:16 around a focus point.
 * Returns the source-space rect [x, y, w, h].
 */
export function reframe916(srcW: number, srcH: number, focus: [number, number] = [0.5, 0.5]): [number, number, number, number] {
  const target = 9 / 16;
  const srcRatio = srcW / srcH;
  if (srcRatio <= target) return [0, 0, 1, 1];
  const w = target / srcRatio;
  const x = Math.min(1 - w, Math.max(0, focus[0] - w / 2));
  return [x, 0, w, 1];
}
