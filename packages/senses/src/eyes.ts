import { mkdir } from "node:fs/promises";
import path from "node:path";
import { mean, median, r3, rgbFrames, run, std } from "./ff.js";

/**
 * Eyes: objective measurements of a picture, a clip or a whole film, using the same method on our renders and
 * on reference films, so the two can be compared number for number.
 *
 *  - luma          mean brightness 0..1 (BT.601)
 *  - colourfulness Hasler–Süsstrunk M (0 = grey, 15 slightly, 33 moderately, 45 averagely, 59 quite, 82 highly)
 *  - saturation    mean HSV saturation 0..1
 *  - palette       dominant colours (hue-binned, weighted by saturation·value), most present first
 *  - hueSpread     how many distinct colour families carry the picture (entropy of the hue histogram, 0..1)
 *  - motion        mean absolute frame-to-frame change 0..1 at 5 fps (camera + content movement)
 *  - cutsPerMin    hard cuts per minute (ffmpeg scene detector, same threshold everywhere)
 *  - stillShare    share of time where almost nothing moves (a held still or a slow zoom on a still)
 */
export interface Look {
  seconds: number;
  frames: number;
  luma: number;
  lumaStd: number;
  colourfulness: number;
  saturation: number;
  darkShare: number;
  palette: Array<{ hex: string; share: number }>;
  hueSpread: number;
  motion: number;
  stillShare: number;
  cutsPerMin: number;
}

const W = 64;
const H = 36;
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

function hsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, mx ? d / mx : 0, mx / 255];
}

export async function measureLook(file: string, o: { ss?: number; t?: number; fps?: number } = {}): Promise<Look> {
  const fps = o.fps ?? 5;
  const frames = await rgbFrames(file, { ...(o.ss !== undefined ? { ss: o.ss } : {}), ...(o.t !== undefined ? { t: o.t } : {}), fps, w: W, h: H });
  if (!frames.length) throw new Error(`no frames decoded from ${file}`);
  const n = W * H;
  const lumas: number[] = [];
  const colour: number[] = [];
  const sats: number[] = [];
  const diffs: number[] = [];
  let dark = 0;
  const BINS = 24;
  const hue = new Array<number>(BINS).fill(0);
  const acc = Array.from({ length: BINS }, () => [0, 0, 0, 0]);
  let neutral = 0;
  let prev: Uint8Array | null = null;
  for (const f of frames) {
    let y = 0;
    let s = 0;
    const rg: number[] = [];
    const yb: number[] = [];
    let d = 0;
    for (let i = 0; i < n; i++) {
      const r = f[i * 3]!;
      const g = f[i * 3 + 1]!;
      const b = f[i * 3 + 2]!;
      y += 0.299 * r + 0.587 * g + 0.114 * b;
      rg.push(r - g);
      yb.push(0.5 * (r + g) - b);
      const [hh, ss, vv] = hsv(r, g, b);
      s += ss;
      const w = ss * vv;
      if (ss > 0.18 && vv > 0.15) {
        const k = Math.floor(hh / (360 / BINS)) % BINS;
        hue[k]! += w;
        const a = acc[k]!;
        a[0]! += r * w;
        a[1]! += g * w;
        a[2]! += b * w;
        a[3]! += w;
      } else neutral += 1;
      if (prev) d += Math.abs(r - prev[i * 3]!) + Math.abs(g - prev[i * 3 + 1]!) + Math.abs(b - prev[i * 3 + 2]!);
    }
    const yl = y / n / 255;
    lumas.push(yl);
    if (yl < 0.12) dark++;
    sats.push(s / n);
    colour.push(Math.sqrt(std(rg) ** 2 + std(yb) ** 2) + 0.3 * Math.sqrt(mean(rg) ** 2 + mean(yb) ** 2));
    if (prev) diffs.push(d / (n * 3 * 255));
    prev = f;
  }
  const total = hue.reduce((t, x) => t + x, 0) || 1;
  const palette = hue
    .map((w, k) => ({ w, k }))
    .filter((x) => x.w / total > 0.04)
    .sort((a, b) => b.w - a.w)
    .slice(0, 6)
    .map(({ w, k }) => ({ hex: hex(acc[k]![0]! / acc[k]![3]!, acc[k]![1]! / acc[k]![3]!, acc[k]![2]! / acc[k]![3]!), share: r3(w / total) }));
  const ent = -hue.reduce((t, x) => (x > 0 ? t + (x / total) * Math.log(x / total) : t), 0) / Math.log(BINS);
  // Cuts with the same detector everywhere.
  const sc = await run("ffmpeg", ["-hide_banner", ...(o.ss ? ["-ss", String(o.ss)] : []), ...(o.t ? ["-t", String(o.t)] : []), "-i", file, "-an", "-vf", "scale=320:-2,select='gt(scene,0.3)',showinfo", "-f", "null", "-"], { maxBuffer: 128 << 20 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const cuts = (sc.stderr.match(/pts_time:/g) ?? []).length;
  const seconds = frames.length / fps;
  // Frame changes at a hard cut are not "motion": drop the top spikes before averaging.
  const calm = diffs.filter((d) => d < 0.12);
  return {
    seconds: r3(seconds),
    frames: frames.length,
    luma: r3(mean(lumas)),
    lumaStd: r3(std(lumas)),
    colourfulness: r3(mean(colour)),
    saturation: r3(mean(sats)),
    darkShare: r3(dark / frames.length),
    palette,
    hueSpread: r3(ent * (1 - neutral / (n * frames.length))),
    motion: r3(median(calm) * 100) / 100,
    stillShare: r3(calm.filter((d) => d < 0.004).length / Math.max(1, calm.length)),
    cutsPerMin: r3((cuts / Math.max(1, seconds)) * 60),
  };
}

/** One image from several (contact sheet), for an agent or a person to compare at a glance. */
export async function contactSheet(files: string[], out: string, o: { cols?: number; cellW?: number; labels?: string[] } = {}): Promise<string> {
  if (!files.length) throw new Error("contactSheet: no files");
  const cols = o.cols ?? Math.min(4, files.length);
  const rows = Math.ceil(files.length / cols);
  const cw = o.cellW ?? 480;
  const ch = Math.round((cw * 9) / 16);
  await mkdir(path.dirname(out), { recursive: true });
  const inputs = files.flatMap((f) => ["-i", f]);
  const scaled = files.map((_, i) => `[${i}:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`).join(";");
  const layout = files.map((_, i) => `${(i % cols) * cw}_${Math.floor(i / cols) * ch}`).join("|");
  const filter = files.length === 1 ? `${scaled};[v0]null[o]` : `${scaled};${files.map((_, i) => `[v${i}]`).join("")}xstack=inputs=${files.length}:layout=${layout}:fill=black[o]`;
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[o]", "-frames:v", "1", "-update", "1", "-q:v", "3", out], { maxBuffer: 16 << 20 });
  void rows;
  return out;
}

/** Evenly spaced frames of [ss, ss+t) as files (for motion sheets: the same shot at several moments). */
export async function grabFrames(file: string, outDir: string, o: { ss: number; t: number; n: number; width?: number; prefix?: string }): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const out: string[] = [];
  for (let k = 0; k < o.n; k++) {
    const at = o.ss + (o.t / o.n) * (k + 0.5);
    const p = path.join(outDir, `${o.prefix ?? "f"}${String(k).padStart(2, "0")}.jpg`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-update", "1", "-vf", `scale=${o.width ?? 640}:-2`, "-q:v", "4", p]);
    out.push(p);
  }
  return out;
}

/**
 * Is a frame carried by one colour? The share of ALL its pixels that are saturated pixels of its leading colour
 * family (or a neighbour). Natural footage mixes hues and neutrals and scores low; a wash or a colour stage
 * scores high (0.5 and above reads as "one colour").
 */
export async function colourCover(file: string): Promise<number | null> {
  const px = (await rgbFrames(file, { fps: 1, w: 64, h: 36 }).catch(() => []))[0];
  if (!px) return null;
  const hist = new Array<number>(12).fill(0);
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i]! / 255;
    const g = px[i + 1]! / 255;
    const b = px[i + 2]! / 255;
    const mx = Math.max(r, g, b);
    const d = mx - Math.min(r, g, b);
    if (mx < 0.18 || d / (mx || 1) < 0.45) continue;
    const h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    hist[Math.floor(h / 30) % 12]!++;
  }
  const top = hist.indexOf(Math.max(...hist));
  return (hist[top]! + hist[(top + 1) % 12]! + hist[(top + 11) % 12]!) / (px.length / 3);
}
