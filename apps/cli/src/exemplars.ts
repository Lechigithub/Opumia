/**
 * Reference exemplar library: what the agents LOOK AT and LISTEN TO instead of reading statistics about it.
 *
 *   opumia build-exemplars --channel magnates-media [--films N]
 *
 * Writes data/exemplars/<channel>/ (generated, git-ignored, rebuildable; Reference/ and Library/ are only read):
 *   index.json        everything below, with paths relative to the exemplar folder
 *   shots/            two frames (early, late) of every hand-labelled reference shot — motion is visible
 *   thumbs/           every reference thumbnail, with title, views and measured look
 *   looks             per-film measured look (brightness, colourfulness, palette, motion) + the channel band
 *   narrator          measured voice profile (pitch travel, melody, dynamics, pauses, pace)
 *   techniques        the channel's technique clips in Library/moments (referenced in place)
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { visualGrammar } from "@opumia/agents";
import { CHANNELS, discoverVideos } from "@opumia/ingest";
import { measureLook, measurePace, measureProsody, mean, median, pct, r3, run, std, type Look, type Prosody } from "@opumia/senses";

interface Ctx { root: string; library: string; reference: string; data: string; log: (s: string) => void }

export interface ExemplarIndex {
  schemaVersion: 1;
  channel: string;
  shots: Array<{ id: string; film: string; kind: string; designed: boolean; link: string; layout: string; motion: string; elements: string[]; shows: string; line: string; frames: string[] }>;
  thumbs: Array<{ film: string; title: string; views: number | null; file: string; look: Pick<Look, "luma" | "colourfulness" | "saturation" | "palette" | "hueSpread"> }>;
  looks: { films: Array<{ film: string } & Look>; band: Record<"luma" | "colourfulness" | "saturation" | "hueSpread" | "motion" | "stillShare" | "darkShare" | "cutsPerMin", { p25: number; p50: number; p75: number }> };
  narrator: { films: number; prosody: Record<keyof Omit<Prosody, "seconds">, { p25: number; p50: number; p75: number }>; pausesPerMin: { p25: number; p50: number; p75: number }; pauseMedianS: number; longPauseShare: number; wpm: { p25: number; p50: number; p75: number }; sentenceWpmStd: number };
  techniques: Array<{ kind: string; film: string; clip: string; strip: string }>;
  generatedAt: string;
}

const band = (xs: number[]) => ({ p25: r3(pct(xs, 0.25)), p50: r3(median(xs)), p75: r3(pct(xs, 0.75)) });

/** Pauses from a 100 ms level track (reference: demucs voice stem levels; ours: narration levels). */
export function pausesFromLevels(db: number[]): { perMin: number; medianS: number; longShare: number } {
  const loud = pct(db.filter((v) => v > -70), 0.9);
  const gate = loud - 26;
  const pauses: number[] = [];
  let runLen = 0;
  let speech = false;
  for (const v of db) {
    if (v < gate) runLen++;
    else {
      if (speech && runLen >= 2 && runLen < 40) pauses.push(runLen * 0.1);
      runLen = 0;
      speech = true;
    }
  }
  const minutes = db.length / 600;
  return { perMin: r3(pauses.length / Math.max(0.1, minutes)), medianS: r3(median(pauses)), longShare: r3(pauses.filter((p) => p >= 0.5).length / Math.max(1, pauses.length)) };
}

export async function buildExemplars(ctx: Ctx, channel: string, maxFilms = 99): Promise<ExemplarIndex> {
  const ch = CHANNELS.find((c) => c.id === channel);
  if (!ch) throw new Error(`unknown channel ${channel}`);
  const out = path.join(ctx.data, "exemplars", channel);
  await mkdir(path.join(out, "shots"), { recursive: true });
  await mkdir(path.join(out, "thumbs"), { recursive: true });
  const vids = (await discoverVideos(ctx.reference, ch)).filter((v) => v.videoFile && !v.spare).sort((a, b) => a.relDir.localeCompare(b.relDir)).slice(0, maxFilms);
  const byDate = new Map(vids.map((v) => [v.uploadDate ?? "", v]));

  // --- Looks: three 40 s windows per film (15 %, 45 %, 75 %), same measurement we run on our own renders.
  ctx.log(`  looks: measuring ${vids.length} films…`);
  const looks: ExemplarIndex["looks"]["films"] = [];
  for (const v of vids) {
    const d = v.durationS ?? 600;
    const parts: Look[] = [];
    for (const f of [0.15, 0.45, 0.75]) parts.push(await measureLook(v.videoFile!, { ss: Math.max(40, d * f), t: 40, fps: 4 }));
    const avg = (k: keyof Look) => r3(mean(parts.map((p) => p[k] as number)));
    const pal = new Map<string, number>();
    for (const p of parts) for (const c of p.palette) pal.set(c.hex, (pal.get(c.hex) ?? 0) + c.share / parts.length);
    looks.push({ film: v.title, seconds: 120, frames: parts.reduce((t, p) => t + p.frames, 0), luma: avg("luma"), lumaStd: avg("lumaStd"), colourfulness: avg("colourfulness"), saturation: avg("saturation"), darkShare: avg("darkShare"), palette: [...pal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([hex, share]) => ({ hex, share: r3(share) })), hueSpread: avg("hueSpread"), motion: avg("motion"), stillShare: avg("stillShare"), cutsPerMin: avg("cutsPerMin") });
  }
  const lb = (k: "luma" | "colourfulness" | "saturation" | "hueSpread" | "motion" | "stillShare" | "darkShare" | "cutsPerMin") => band(looks.map((l) => l[k]));

  // --- Narrator: prosody on voice-dominant moments, pauses from the voice stem level track, pace from words.
  ctx.log(`  narrator: measuring voice on ${Math.min(12, vids.length)} films…`);
  const pros: Prosody[] = [];
  const pausePM: number[] = [];
  const pauseMed: number[] = [];
  const pauseLong: number[] = [];
  const wpm: number[] = [];
  const wstd: number[] = [];
  for (const v of vids.filter((x) => x.soundFile && x.transcriptFile).slice(0, 12)) {
    const snd = JSON.parse(await readFile(v.soundFile!, "utf8")) as { voice_db_100ms?: number[]; bed_db_100ms?: number[] };
    const vo = snd.voice_db_100ms ?? [];
    const bed = snd.bed_db_100ms ?? [];
    if (vo.length < 600) continue;
    const keep = (t: number) => {
      const i = Math.floor(t * 10);
      return (vo[i] ?? -99) - (bed[i] ?? 0) > 14 || (vo[i] ?? -99) < -45;
    };
    pros.push(await measureProsody(v.videoFile!, { ss: 60, t: 200, keep }));
    const p = pausesFromLevels(vo.slice(600, Math.min(vo.length - 300, 6000)));
    pausePM.push(p.perMin);
    pauseMed.push(p.medianS);
    pauseLong.push(p.longShare);
    const words = (JSON.parse(await readFile(v.transcriptFile!, "utf8")) as { words?: Array<{ word: string; start: number; end: number }> }).words ?? [];
    const pc = measurePace(words.filter((w) => w.start > 60 && w.start < 460));
    if (pc.sentences > 10) (wpm.push(pc.wpm), wstd.push(pc.sentenceWpmStd));
  }
  const pk = (k: keyof Omit<Prosody, "seconds">) => band(pros.map((p) => p[k]));

  // --- Shot exemplars: two frames per labelled shot (so entrances and motion are visible).
  const rows = await visualGrammar(ctx.reference, channel, ch.metaPrefix);
  ctx.log(`  shots: extracting frames for ${rows.length} labelled shots…`);
  const shots: ExemplarIndex["shots"] = [];
  for (const [k, r] of rows.entries()) {
    const v = byDate.get(r.film.split("-")[1] ?? "");
    if (!v || r.t0 === undefined || r.t1 === undefined) continue;
    const id = `${r.film}_${String(Math.round(r.t0 * 10)).padStart(6, "0")}`;
    const frames: string[] = [];
    for (const [tag, f] of [["a", 0.3], ["b", 0.85]] as const) {
      const rel = `shots/${id}_${tag}.jpg`;
      const file = path.join(out, rel);
      if (!existsSync(file)) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", (r.t0 + (r.t1 - r.t0) * f).toFixed(2), "-i", v.videoFile!, "-frames:v", "1", "-update", "1", "-vf", "scale=640:-2", "-q:v", "4", file]).catch(() => {});
      if (existsSync(file)) frames.push(rel);
    }
    if (frames.length) shots.push({ id, film: r.film, kind: r.kind.replace(/^other:/, ""), designed: r.designed, link: r.link, layout: r.layout, motion: r.motion, elements: r.elements, shows: r.shows, line: r.line, frames });
    if (k % 60 === 59) ctx.log(`    ${k + 1}/${rows.length}`);
  }

  // --- Thumbnails.
  const thumbs: ExemplarIndex["thumbs"] = [];
  for (const v of vids) {
    const src = path.join(v.dir, "thumbnail.jpg");
    if (!existsSync(src)) continue;
    const rel = `thumbs/${v.ytId}.jpg`;
    const file = path.join(out, rel);
    if (!existsSync(file)) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1", "-update", "1", "-vf", "scale=960:-2", "-q:v", "3", file]).catch(() => {});
    if (!existsSync(file)) continue;
    const l = await measureLook(file, { fps: 1 }).catch(() => null);
    if (l) thumbs.push({ film: v.title, title: v.title, views: v.views, file: rel, look: { luma: l.luma, colourfulness: l.colourfulness, saturation: l.saturation, palette: l.palette, hueSpread: l.hueSpread } });
  }

  // --- Technique clips (read in place from Library/moments).
  const techniques: ExemplarIndex["techniques"] = [];
  const mi = await readFile(path.join(ctx.library, "moments", ch.dir, "index.json"), "utf8").then((t) => JSON.parse(t) as Record<string, { moments: Array<{ film: string; clip: string; strip: string }> }>).catch(() => ({}) as Record<string, { moments: Array<{ film: string; clip: string; strip: string }> }>);
  for (const [kind, v] of Object.entries(mi)) for (const m of v.moments) techniques.push({ kind, film: m.film, clip: m.clip, strip: m.strip });

  const index: ExemplarIndex = {
    schemaVersion: 1,
    channel,
    shots,
    thumbs,
    looks: { films: looks, band: { luma: lb("luma"), colourfulness: lb("colourfulness"), saturation: lb("saturation"), hueSpread: lb("hueSpread"), motion: lb("motion"), stillShare: lb("stillShare"), darkShare: lb("darkShare"), cutsPerMin: lb("cutsPerMin") } },
    narrator: { films: pros.length, prosody: { voicedShare: pk("voicedShare"), f0Hz: pk("f0Hz"), f0RangeSt: pk("f0RangeSt"), melodySt: pk("melodySt"), energyStdDb: pk("energyStdDb"), pausesPerMin: pk("pausesPerMin"), pauseMedianS: pk("pauseMedianS"), longPauseShare: pk("longPauseShare") }, pausesPerMin: band(pausePM), pauseMedianS: r3(median(pauseMed)), longPauseShare: r3(median(pauseLong)), wpm: band(wpm), sentenceWpmStd: r3(median(wstd)) },
    techniques,
    generatedAt: new Date().toISOString(),
  };
  const file = path.join(out, "index.json");
  await writeFile(`${file}.tmp`, JSON.stringify(index, null, 1) + "\n");
  await rename(`${file}.tmp`, file);
  const b = index.looks.band;
  ctx.log(`  exemplars → ${path.relative(ctx.root, out)}/: ${shots.length} shots, ${thumbs.length} thumbnails, ${looks.length} film looks, ${techniques.length} technique clips`);
  ctx.log(`  channel look band (p25–p75): luma ${b.luma.p25}–${b.luma.p75}, colourfulness ${b.colourfulness.p25}–${b.colourfulness.p75}, hue spread ${b.hueSpread.p25}–${b.hueSpread.p75}, motion ${b.motion.p25}–${b.motion.p75}, still share ${b.stillShare.p50}`);
  ctx.log(`  narrator: ${index.narrator.wpm.p50} wpm (sentence spread ${index.narrator.sentenceWpmStd}), pitch travel ${index.narrator.prosody.f0RangeSt.p50} st, pauses ${index.narrator.pausesPerMin.p50}/min (median ${index.narrator.pauseMedianS} s)`);
  void std;
  return index;
}

export async function loadExemplars(data: string, channel: string): Promise<ExemplarIndex | null> {
  try {
    return JSON.parse(await readFile(path.join(data, "exemplars", channel, "index.json"), "utf8")) as ExemplarIndex;
  } catch {
    return null;
  }
}
