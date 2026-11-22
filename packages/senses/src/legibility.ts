/**
 * Eyes for words on screen (build list 2, step 1): can a viewer read this text on a phone? Measured on the rendered
 * frame, inside each text element's box, no model:
 *
 *  contrast   the box's pixels are split into their two tones (Otsu); the WCAG contrast ratio between them is the
 *             contrast of the letters against what is behind them. Under 3:1 is unreadable for display text
 *             (WCAG large-text minimum); 4.5:1 is comfortable.
 *  phonePx    the letters' cap height on a phone held upright watching a 16:9 video full width (360 px wide), or a
 *             9:16 video full screen (360 × 640). Under 7 px cannot be read at a glance.
 *  inside     the box stays inside the title-safe area (5 % margins).
 */
import { run } from "./ff.js";

export interface TextBox { label: string; x: number; y: number; w: number; h: number }
export interface Legibility { label: string; contrast: number; phonePx: number; inside: boolean; issues: string[] }

const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const relLum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

export async function measureLegibility(frame: string, boxes: TextBox[], o: { aspect?: "16:9" | "9:16" } = {}): Promise<Legibility[]> {
  const FW = 640, FH = o.aspect === "9:16" ? 1138 : 360;
  const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", frame, "-vf", `scale=${FW}:${FH}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 26 } as never);
  const px = (r as unknown as { stdout: Buffer }).stdout;
  const phoneScale = o.aspect === "9:16" ? 640 / 1 : 360 / 1; // phone height of the frame (9:16 full screen) or width (16:9)
  return boxes.map((b) => {
    const x0 = Math.max(0, Math.floor(b.x * FW)), x1 = Math.min(FW, Math.ceil((b.x + b.w) * FW));
    const y0 = Math.max(0, Math.floor(b.y * FH)), y1 = Math.min(FH, Math.ceil((b.y + b.h) * FH));
    const lums: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * FW + x) * 3; lums.push(relLum(px[i]!, px[i + 1]!, px[i + 2]!)); }
    let contrast = 1;
    if (lums.length > 20) {
      // Otsu on 64 bins of relative luminance
      const bins = new Array<number>(64).fill(0);
      for (const l of lums) bins[Math.min(63, Math.floor(l * 64))]!++;
      let best = 0, th = 32, sumAll = 0;
      for (let k = 0; k < 64; k++) sumAll += k * bins[k]!;
      let wB = 0, sumB = 0;
      for (let k = 0; k < 64; k++) {
        wB += bins[k]!;
        if (!wB || wB === lums.length) continue;
        sumB += k * bins[k]!;
        const mB = sumB / wB, mF = (sumAll - sumB) / (lums.length - wB);
        const between = wB * (lums.length - wB) * (mB - mF) ** 2;
        if (between > best) (best = between), (th = k);
      }
      const lo = lums.filter((l) => l * 64 <= th), hi = lums.filter((l) => l * 64 > th);
      // the minority tone is the letters; use robust means (ignore the outer 10 % of each tone)
      const rob = (xs: number[]) => { const s = [...xs].sort((a, c) => a - c); const k = Math.floor(s.length * 0.1); const m = s.slice(k, s.length - k); return m.reduce((a, c) => a + c, 0) / Math.max(1, m.length); };
      if (lo.length > 3 && hi.length > 3) contrast = (rob(hi) + 0.05) / (rob(lo) + 0.05);
    }
    const phonePx = b.h * 0.72 * (o.aspect === "9:16" ? phoneScale : (phoneScale * 9) / 16);
    const inside = b.x >= 0.05 && b.y >= 0.05 && b.x + b.w <= 0.95 && b.y + b.h <= 0.95;
    const issues: string[] = [];
    if (contrast < 3) issues.push(`letters ${contrast.toFixed(1)}:1 against what is behind them (needs 3:1, comfortable 4.5:1)`);
    if (phonePx < 7) issues.push(`${phonePx.toFixed(1)} px tall on a phone (needs 7)`);
    if (!inside) issues.push("outside the title-safe area");
    return { label: b.label, contrast: Math.round(contrast * 10) / 10, phonePx: Math.round(phonePx * 10) / 10, inside, issues };
  });
}

/** Text boxes of a scene spec's words (text, phrase, 3D type, labels on infographics), in frame fractions. */
export function textBoxesOf(spec: { elements: Array<Record<string, unknown>> }): TextBox[] {
  const out: TextBox[] = [];
  for (const e of spec.elements) {
    // a kit component: its words are its string props; its box is the one the scene designer gave it
    if (e.type === "component") {
      const props = (e.props ?? {}) as Record<string, unknown>;
      const t = Object.entries(props).filter(([k, v]) => typeof v === "string" && !/^(slot|color|colour|align|variant|style|kind|mode|side|tone|edge|code|unit)$/i.test(k)).map(([, v]) => v as string).join(" ").trim();
      if (!t) continue;
      const w = Number(e.w ?? 0.5);
      out.push({ label: t.slice(0, 40), x: Number(e.x ?? 0), y: Number(e.y ?? 0), w, h: Math.min(0.9, Number(e.h ?? 0) || 0.16) });
      continue;
    }
    // older scene files (history only): text elements drawn by the removed menu renderer
    const t = String(e.text ?? e.headline ?? e.label ?? "");
    if (!t || !["text", "phrase", "text3d", "newspaper", "counter"].includes(String(e.type))) continue;
    const size = Number(e.size ?? (e.type === "text3d" ? 0.14 : e.type === "newspaper" ? 0.05 : 0.05));
    const w = Number(e.w ?? 0.5);
    // characters that fit on one line at this size (display faces are about 0.6 of their height wide)
    const perLine = Math.max(4, Math.floor((w * 16) / 9 / (size * 0.6)));
    const lines = Math.max(1, Math.ceil(t.length / perLine));
    out.push({ label: t.slice(0, 40), x: Number(e.x ?? 0), y: Number(e.y ?? 0), w, h: Math.min(0.9, size * 1.35 * lines) });
  }
  return out;
}
