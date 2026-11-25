/**
 * Our stretch beside a real stretch of the channel at the same place in a film (hand film method, v31–v32: each beat
 * was judged beside the matched reference stretch, not alone). Top row ours, bottom row theirs, the same length, with
 * both measured by the same functions (motion: cuts against moves; words: how long they stay up). No model call; the
 * Reference tree is only read.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { channelFilms, measureMotion, measureTextHold } from "@opumia/agents";
import { run } from "@opumia/senses";

const probeDur = async (f: string) => Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).catch(() => ({ stdout: "0" }))).stdout.trim()) || 0;

async function row(video: string, fromS: number, len: number, out: string): Promise<boolean> {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", fromS.toFixed(2), "-t", len.toFixed(2), "-i", video, "-vf", `fps=${(6 / len).toFixed(4)},scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,tile=6x1`, "-frames:v", "1", "-q:v", "4", out]).catch(() => null);
  return existsSync(out);
}

export async function compareWithReference(o: { root: string; data: string; channel: string; ours: string; fromS: number; toS: number; filmS: number; outDir: string }): Promise<{ sheet: string; text: string }> {
  const len = Math.max(2, o.toS - o.fromS);
  const films = await channelFilms(path.join(o.root, "Reference"), o.channel, 40);
  if (!films.length) return { sheet: "", text: "no real films of the channel to compare with" };
  const pick = [...films].sort((a, b) => createHash("sha1").update(`${o.fromS}|${a}`).digest("hex").localeCompare(createHash("sha1").update(`${o.fromS}|${b}`).digest("hex")))[0]!;
  const dur = await probeDur(pick);
  // an opening is compared with an opening (the same seconds); later stretches at the same share of the film
  const refFrom = o.fromS < 30 ? o.fromS : Math.max(0, Math.min(dur - len, (o.fromS / Math.max(1, o.filmS)) * dur));
  await mkdir(o.outDir, { recursive: true });
  const key = `${o.fromS.toFixed(1)}_${o.toS.toFixed(1)}_${Date.now() % 100000}`;
  const a = path.join(o.outDir, `ours_${key}.jpg`), b = path.join(o.outDir, `ref_${key}.jpg`), sheet = path.join(o.outDir, `compare_${key}.jpg`);
  if (!(await row(o.ours, 0, len, a)) || !(await row(pick, refFrom, len, b))) return { sheet: "", text: "could not grab frames" };
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", a, "-i", b, "-filter_complex", "vstack", sheet]).catch(() => null);
  const [mo, mr, to, tr] = await Promise.all([measureMotion(o.ours, { len }), measureMotion(pick, { fromS: refFrom, len }), measureTextHold(o.ours, { root: o.root, data: o.data, len }), measureTextHold(pick, { root: o.root, data: o.data, fromS: refFrom, len })].map((p) => (p as Promise<unknown>).catch(() => null))) as [Awaited<ReturnType<typeof measureMotion>>, Awaited<ReturnType<typeof measureMotion>>, Awaited<ReturnType<typeof measureTextHold>>, Awaited<ReturnType<typeof measureTextHold>>];
  const m = (x: typeof mo) => (x ? `${x.cutsPerMin} cuts/min, ${Math.round(x.softShare * 100)} % of changes by moving, moving ${Math.round(x.moving * 100)} % of the time, motion ${x.motionMed}` : "not measurable");
  const t = (x: typeof to) => (x ? `${x.lines} big line(s), the typical word up ${x.holdTime} s` : "no big words");
  return {
    sheet: existsSync(sheet) ? sheet : "",
    text: `TOP: ours ${o.fromS.toFixed(1)}–${o.toS.toFixed(1)} s. BOTTOM: the channel (${path.basename(path.dirname(pick)).slice(0, 60)}, ${refFrom.toFixed(1)} s), six moments left to right.\n- ours: ${m(mo)}; ${t(to)}\n- the channel: ${m(mr)}; ${t(tr)}\nLook for what the real one does that ours does not: how many layers and at what depths, how big and sharp the subject is, how one picture becomes the next, how words arrive and how long they stay.`,
  };
}
