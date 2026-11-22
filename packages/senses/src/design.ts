/**
 * Design fundamentals measured on pixels (ffmpeg decode + plain TS, no model) — the same function for the reference
 * channel's thumbnails and frames and for ours, so a band can be learned and ours checked against it.
 *
 *  focus        how concentrated the visual weight (local contrast/edges) is: share of all edge energy held by the
 *               strongest tenth of the frame. A clear focal point scores high; an even collage or a flat frame low.
 *  focusX/Y     where that weight's centre sits (0–1).
 *  depth        sharpness of the sharpest region over the median region (foreground vs background separation).
 *  separation   luminance difference between the focal region and its surround (does the subject pop?).
 *  hueContrast  strength of colour contrast: the two strongest saturated hue families, weighted by how far apart
 *               they are on the colour wheel (complementary = 1); 0 for a one-colour or grey frame.
 *  oneColour    share of saturated pixels in the single strongest hue family (1 = everything one colour).
 *  light        strength of a directional light gradient (0 flat … 1 strong), and its direction in degrees
 *               (0 = light from the left, 90 = from the top).
 *  keyRatio     bright highlights against the typical tone (p98 / p50 luma): punchy lighting vs flat.
 */
import { execFile } from "node:child_process";

export interface Design { focus: number; focusX: number; focusY: number; depth: number; separation: number; hueContrast: number; oneColour: number; light: number; lightDeg: number; keyRatio: number }

const W = 320;
const H = 180;
const C = 16; // cells of 20×... (320/16 = 20 px, 180/9 = 20 px)
const CW = W / C;
const RH = 9;
const CH = H / RH;

function rgb(file: string, atS?: number): Promise<Buffer> {
  return new Promise((res, rej) =>
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", ...(atS ? ["-ss", String(atS)] : []), "-i", file, "-vf", `scale=${W}:${H}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 22 }, (e, out) => (e ? rej(e) : out.length >= W * H * 3 ? res(out) : rej(new Error("short frame")))),
  );
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]! : 0;
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export async function measureDesign(file: string, atS?: number): Promise<Design> {
  const px = await rgb(file, atS);
  const L = new Float32Array(W * H);
  const hueBins = new Float64Array(12);
  let satTotal = 0;
  for (let i = 0; i < W * H; i++) {
    const r = px[3 * i]! / 255, g = px[3 * i + 1]! / 255, b = px[3 * i + 2]! / 255;
    L[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx : 0;
    if (sat > 0.25 && mx > 0.15) {
      let h = 0;
      const d = mx - mn;
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const wgt = sat * mx;
      hueBins[Math.floor(h / 30) % 12]! += wgt;
      satTotal += wgt;
    }
  }
  // edge energy per cell
  const cell = new Float64Array(C * RH);
  const sharp = new Float64Array(C * RH);
  const lum = new Float64Array(C * RH);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = L[i + 1]! - L[i - 1]!, gy = L[i + W]! - L[i - W]!;
      const lap = 4 * L[i]! - L[i - 1]! - L[i + 1]! - L[i - W]! - L[i + W]!;
      const c = Math.floor(y / CH) * C + Math.floor(x / CW);
      cell[c]! += Math.sqrt(gx * gx + gy * gy);
      sharp[c]! += lap * lap;
      lum[c]! += L[i]!;
    }
  const n = C * RH;
  const per = CW * CH;
  for (let c = 0; c < n; c++) lum[c]! /= per;
  const total = cell.reduce((a, b) => a + b, 0) || 1;
  const order = [...cell.keys()].sort((a, b) => cell[b]! - cell[a]!);
  const top = order.slice(0, Math.ceil(n / 10));
  const focus = top.reduce((a, c) => a + cell[c]!, 0) / total;
  let fx = 0, fy = 0;
  for (let c = 0; c < n; c++) { fx += (cell[c]! / total) * (((c % C) + 0.5) / C); fy += (cell[c]! / total) * ((Math.floor(c / C) + 0.5) / RH); }
  const sh = [...sharp];
  const depth = pct(sh, 0.95) / Math.max(1e-6, pct(sh, 0.5));
  const topSet = new Set(top);
  const inL = top.reduce((a, c) => a + lum[c]!, 0) / top.length;
  const outCells = [...Array(n).keys()].filter((c) => !topSet.has(c));
  const outL = outCells.reduce((a, c) => a + lum[c]!, 0) / Math.max(1, outCells.length);
  // colour
  const bins = [...hueBins.keys()].sort((a, b) => hueBins[b]! - hueBins[a]!);
  const first = hueBins[bins[0]!]! / Math.max(1e-6, satTotal);
  const second = hueBins[bins[1]!]! / Math.max(1e-6, satTotal);
  const dist = Math.min(Math.abs(bins[0]! - bins[1]!), 12 - Math.abs(bins[0]! - bins[1]!)) / 6;
  const satShare = satTotal / (W * H);
  const hueContrast = satShare < 0.02 ? 0 : Math.min(1, (second / Math.max(1e-6, first)) * dist * Math.min(1, satShare * 6));
  // light: plane fit of cell luminance
  let sx = 0, sy = 0, sl = 0;
  for (let c = 0; c < n; c++) sl += lum[c]!;
  const mean = sl / n;
  for (let c = 0; c < n; c++) { const x = ((c % C) + 0.5) / C - 0.5, y = (Math.floor(c / C) + 0.5) / RH - 0.5; sx += x * (lum[c]! - mean); sy += y * (lum[c]! - mean); }
  const ax = sx / (n / 12), ay = sy / (n / 12);
  const lightMag = Math.sqrt(ax * ax + ay * ay);
  const lightDeg = ((Math.atan2(-ay, -ax) * 180) / Math.PI + 360) % 360;
  const ls = Array.from(L);
  return {
    focus: r3(focus), focusX: r3(fx), focusY: r3(fy), depth: r3(Math.min(50, depth)), separation: r3(Math.abs(inL - outL)),
    hueContrast: r3(hueContrast), oneColour: r3(first), light: r3(Math.min(1, lightMag * 2)), lightDeg: Math.round(lightDeg),
    keyRatio: r3(Math.min(20, pct(ls, 0.98) / Math.max(0.02, pct(ls, 0.5)))),
  };
}

export type DesignBand = Record<keyof Design, { p10: number; median: number; p90: number }> & { count: number };

export function designBand(xs: Design[]): DesignBand {
  const keys = ["focus", "focusX", "focusY", "depth", "separation", "hueContrast", "oneColour", "light", "lightDeg", "keyRatio"] as const;
  const out = { count: xs.length } as DesignBand;
  for (const k of keys) {
    const v = xs.map((x) => x[k]);
    out[k] = { p10: r3(pct(v, 0.1)), median: r3(pct(v, 0.5)), p90: r3(pct(v, 0.9)) };
  }
  return out;
}

/** Where a picture's design falls outside the reference's own range. */
export function designIssues(d: Design, b: DesignBand, what = "picture"): Array<{ kind: string; detail: string }> {
  const out: Array<{ kind: string; detail: string }> = [];
  if (d.focus < b.focus.p10) out.push({ kind: "no_focal_point", detail: `visual weight is spread evenly (focus ${d.focus}; the channel's ${what}s ${b.focus.p10}+, median ${b.focus.median}) — no single subject dominates; make one element clearly the hero (bigger, sharper, brighter) and quiet the rest.` });
  if (d.separation < b.separation.p10) out.push({ kind: "subject_does_not_pop", detail: `the focal area barely differs in brightness from its surround (${d.separation}; channel ${b.separation.p10}+, median ${b.separation.median}) — light the subject or darken/blur nothing but separate it: rim light, darker background, contrast.` });
  if (d.depth < b.depth.p10) out.push({ kind: "flat_depth", detail: `foreground and background are equally sharp (depth ${d.depth}; channel ${b.depth.p10}+) — everything sits on one plane; build foreground, middle and background.` });
  if (d.oneColour > b.oneColour.p90) out.push({ kind: "one_colour", detail: `${Math.round(d.oneColour * 100)}% of the colour is one hue family (channel at most ${Math.round(b.oneColour.p90 * 100)}%) — add a contrasting colour (often the complement) so the subject stands out.` });
  else if (d.hueContrast < b.hueContrast.p10) out.push({ kind: "weak_colour_contrast", detail: `weak colour contrast (${d.hueContrast}; channel ${b.hueContrast.p10}+, median ${b.hueContrast.median}) — pair two hues far apart on the wheel (orange against teal, red against cyan).` });
  // Two-sided: the channel's thumbnails are full frames; weight concentrated far beyond theirs means one element
  // floating on an empty stage, and extreme depth/separation means a pasted subject on a dark void.
  if (d.focus > b.focus.p90) out.push({ kind: "sparse_frame", detail: `all the visual weight sits in a small part of the frame (focus ${d.focus}; the channel's ${what}s at most ${b.focus.p90}, median ${b.focus.median}) — the rest is empty. The channel fills the frame: a real scene or texture behind the subject, supporting elements, no void.` });
  if (d.depth > b.depth.p90 && d.focus > b.focus.median) out.push({ kind: "pasted_on_void", detail: `a sharp subject over a featureless background (depth ${d.depth}; channel at most ${b.depth.p90}) — it reads pasted, not composed. Put a real, detailed picture behind it and let light and colour tie them together.` });
  if (d.keyRatio < b.keyRatio.p10) out.push({ kind: "flat_light", detail: `no bright highlights over the typical tone (key ${d.keyRatio}; channel ${b.keyRatio.p10}+) — the lighting reads flat; add a light source, highlights, glow that falls on the subject.` });
  return out;
}
