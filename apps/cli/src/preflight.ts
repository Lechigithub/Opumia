/**
 * Preflight gate: every release-gate check that can be computed BEFORE the render — from the plan, the scene
 * previews and the narration — so a film that would fail is repaired or stopped before render time is spent.
 *
 * Each check names the OWNER that fixes it (produce.ts sends it there, then the check is run again). Nothing is
 * ever reduced to a weaker look (build list 3, L8):
 *   replace_picture  the picture leaves its shot, the picture tools find another, the scene designer designs again
 *   redesign_scene   the scene designer fixes the scene, told the defect
 *   regrade          the colourist, told what the previews measured
 *   reseed_sound     the sound designer picks effects and music again
 * "blocker" checks stop the render when they still fail; "advisory" checks are reported (they have no automatic
 * repair — e.g. how expressive a fixed voice is — and the finished-film gate still judges them).
 */
import { measureSeams } from "@opumia/senses";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RenderManifest, ResolutionReport, ScenePlan, Storyboard, TimedScript } from "@opumia/contracts";
import { contactSheet, measureLook, measurePace, measureProsody, measureSound, pct, r3, rgbFrames } from "@opumia/senses";
import { periodCheck, reviewFrame, yearOf } from "@opumia/resolver";
import { measureCraft } from "@opumia/senses";
import type { QualityBand } from "@opumia/agents";
import type { ExemplarIndex } from "./exemplars.js";

export type Repair = "replace_picture" | "redesign_scene" | "regrade" | "reseed_sound";
export interface PreflightCheck {
  id: string;
  label: string;
  value: number;
  target: string;
  pass: boolean;
  level: "blocker" | "advisory";
  repair?: Repair;
  /** Shots the repair applies to. */
  shots?: string[];
  note?: string;
}

/**
 * How much one colour carries a set of frames: each frame's dominant hue family (12 families, weighted by how
 * saturated and bright the pixels are); the result is the share of coloured frames whose family is the film's
 * most common one or its neighbour. A film washed in one tone scores near 1; the reference films score lower.
 */
export async function hueDominance(frames: string[]): Promise<number | null> {
  // A frame is "carried" by a colour family when at least half of ALL its pixels are saturated pixels of that
  // family (or its neighbour) — a wash or a colour stage. Natural footage (wood, skin, sky, grey machinery)
  // mixes hues and neutrals and is carried by none. -1 = not carried.
  const fam: number[] = [];
  for (const f of frames) {
    const px = (await rgbFrames(f, { fps: 1, w: 64, h: 36 }).catch(() => []))[0];
    if (!px) continue;
    const hist = new Array<number>(12).fill(0);
    const total = px.length / 3;
    for (let i = 0; i + 2 < px.length; i += 3) {
      const r = px[i]! / 255;
      const g = px[i + 1]! / 255;
      const b = px[i + 2]! / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const d = mx - mn;
      if (mx < 0.18 || d / (mx || 1) < 0.45) continue;
      const h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
      hist[Math.floor(h / 30) % 12]!++;
    }
    const top = hist.indexOf(Math.max(...hist));
    const cover = (hist[top]! + hist[(top + 1) % 12]! + hist[(top + 11) % 12]!) / total;
    fam.push(cover >= 0.5 ? top : -1);
  }
  if (fam.length < 6) return null;
  const count = new Array<number>(12).fill(0);
  for (const k of fam) if (k >= 0) count[k]!++;
  const top = count.indexOf(Math.max(...count));
  return fam.filter((k) => k >= 0 && (k === top || k === (top + 1) % 12 || k === (top + 11) % 12)).length / fam.length;
}

/** The same measure on every reference film's labelled shots (cached in data/.cache): the channel's own range. */
export async function referenceHueDominance(data: string, ex: ExemplarIndex): Promise<{ p50: number; p75: number; max: number; films: number } | null> {
  const file = path.join(data, ".cache", `hue-dominance-v2-${ex.channel}.json`);
  const hit = await readFile(file, "utf8").then((t) => JSON.parse(t) as { generatedAt: string; p50: number; p75: number; max: number; films: number }, () => null);
  if (hit && hit.generatedAt === ex.generatedAt) return hit;
  const dir = path.join(data, "exemplars", ex.channel);
  const byFilm = new Map<string, string[]>();
  for (const sh of ex.shots) byFilm.set(sh.film, [...(byFilm.get(sh.film) ?? []), ...sh.frames.slice(-1).map((f) => path.join(dir, f))]);
  const vals: number[] = [];
  for (const frames of byFilm.values()) {
    const v = frames.length >= 8 ? await hueDominance(frames) : null;
    if (v !== null) vals.push(v);
  }
  if (vals.length < 3) return null;
  const out = { generatedAt: ex.generatedAt, p50: r3(pct(vals, 0.5)), p75: r3(pct(vals, 0.75)), max: r3(Math.max(...vals)), films: vals.length };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(out, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
  return out;
}

const readJson = async <T>(f: string): Promise<T | null> => readFile(f, "utf8").then((t) => JSON.parse(t) as T, () => null);
const baseRef = (ref: string) => ref.split("#")[0]!.split("@")[0]!;

export interface PreflightInput {
  /** Step 7: every real person the film names (no stranger's face under a line naming one). */
  people?: string[];
  /** Step 4: trained taste of the final scene frames (median) against the channel's real shots. */
  taste?: { median: number; realP10: number; realMedian: number; low: string[] };
  jobDir: string;
  /** The channel's cut rate (cuts a minute), as the director is held to it. */
  cutBand?: { lo: number; hi: number };
  board: Storyboard;
  scenes: ScenePlan;
  resolution: ResolutionReport;
  manifest: RenderManifest;
  timed: TimedScript;
  exemplars: ExemplarIndex | null;
  /** The voice's own measured pace (words a minute) — the narration is checked against this, not the reference. */
  naturalWpm?: number;
  /** Scenes that still show a visible defect on their final preview (shot id → what is wrong). */
  sceneDefects: Map<string, string[]>;
  /** Middle preview frame of every scene (final design). */
  previewFrames: string[];
  /** The channel's own pixel-level quality bar (agents/quality-band.ts). */
  quality?: QualityBand | null;
  /** The channel's own range for how much one colour carries a film (referenceHueDominance). */
  hueRef?: { p75: number; max: number } | null;
  /** Pictures and sounds the recent films used (cross-film cooldown). */
  recent: { pictures: Set<string>; sfx: Set<string>; music: Set<string> };
}

export async function preflightChecks(o: PreflightInput): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => out.push({ ...c, value: r3(c.value) });
  const shots = o.board.shots;
  const pics = o.resolution.media.filter((m) => m.role === "primary" || m.role === "layer");

  // --- Pictures: nothing repeated inside the film, nothing a recent film used.
  // The editor splits a shot into punch-ins of the same clip ("sh008" → "sh008_2", "sh008_2_2"): the halves are one
  // shot and one continuous clip, never a repeat or a second clip from the same source.
  const rootOf = (id: string) => id.replace(/(_\d+)+$/, "");
  {
    const seen = new Map<string, string>();
    const wikiSeen = new Map<string, Set<string>>();
    const dupShots: string[] = [];
    for (const m of [...pics].sort((a, b) => a.shotId.localeCompare(b.shotId))) {
      // The same logo or portrait may anchor several scenes as a small picture; footage and web photos may not repeat.
      const k = baseRef(m.ref);
      // A logo or portrait may anchor two scenes as a small picture; a third time reads as a template.
      if (m.role === "layer" && m.provider === "wikipedia") {
        const roots = wikiSeen.get(k) ?? new Set<string>();
        roots.add(rootOf(m.shotId));
        wikiSeen.set(k, roots);
        if (roots.size > 2) dupShots.push(m.shotId);
        continue;
      }
      if (seen.has(k) && rootOf(seen.get(k)!) !== rootOf(m.shotId)) dupShots.push(m.shotId);
      else seen.set(k, m.shotId);
    }
    add({ id: "repeat_in_film", label: "Pictures used more than once in the film", value: dupShots.length, target: "0", pass: dupShots.length === 0, level: "blocker", repair: "replace_picture", shots: dupShots });
    const shared = pics.filter((m) => !(m.provider === "wikipedia") && o.recent.pictures.has(baseRef(m.ref))).map((m) => m.shotId);
    add({ id: "shared_pictures", label: "Pictures a recent film already used", value: shared.length, target: "0", pass: shared.length === 0, level: "blocker", repair: "replace_picture", shots: shared });
  }

  // --- Step 7 (film 1: a staged actress under lines about Joy Marshall): a shot whose NARRATION names a real person
  // may not show a face unless the picture is verified press of that person.
  if (o.people?.length) {
    const words = o.timed.segments.flatMap((sg) => sg.words);
    const stand: string[] = [];
    for (const sh of shots) {
      const said = words.filter((w) => w.startS >= sh.startS - 0.05 && w.startS < sh.endS).map((w) => w.word).join(" ").toLowerCase();
      const named = o.people.filter((p) => { const last = p.toLowerCase().split(/\s+/).at(-1) ?? ""; return last.length > 2 && new RegExp(`\\b${last.replace(/[^a-z]/g, "")}\\b`).test(said); });
      if (!named.length) continue;
      for (const m of o.resolution.media.filter((x) => x.shotId === sh.id && (x.role === "primary" || x.role === "layer"))) {
        const verified = m.origin === "press" && named.some((p) => (m.depicts ?? "").toLowerCase().includes(p.toLowerCase().split(/\s+/).at(-1)!));
        if (!verified && m.seen?.face) stand.push(sh.id);
      }
    }
    const uniq = [...new Set(stand)];
    add({ id: "stand_in_face", label: "Shots where the narration names a real person over a face that is not verified as them", value: uniq.length, target: "0", pass: uniq.length === 0, level: "blocker", repair: "replace_picture", shots: uniq });
  }

  // --- Fair use: one clip per source video, clips ≤ 7.5 s, press footage ≤ 45 % of the runtime.
  {
    const clips = o.resolution.media.filter((m) => m.role === "primary" && m.origin === "press" && m.kind === "video");
    const byVideo = new Map<string, string[]>();
    for (const c of clips) byVideo.set(baseRef(c.ref), [...(byVideo.get(baseRef(c.ref)) ?? []), c.shotId]);
    // one clip per source video: halves of an editor split are the same clip
    const extra = [...byVideo.values()].flatMap((v) => { const first = rootOf([...v].sort()[0]!); return v.filter((id) => rootOf(id) !== first); });
    add({ id: "fair_use_one_clip", label: "Extra clips taken from one source video", value: extra.length, target: "0", pass: extra.length === 0, level: "blocker", repair: "replace_picture", shots: extra });
    const dur = (id: string) => {
      const sh = shots.find((x) => x.id === id);
      return sh ? sh.endS - sh.startS : 0;
    };
    // a split clip's length is its halves together (one continuous excerpt)
    const fam = new Map<string, typeof clips>();
    for (const c of clips) fam.set(`${rootOf(c.shotId)}|${baseRef(c.ref)}`, [...(fam.get(`${rootOf(c.shotId)}|${baseRef(c.ref)}`) ?? []), c]);
    // unsplit: the excerpt recorded at download; split: the halves' shot lengths added (the stored figure is the
    // whole clip from before the split, so adding to it would count twice)
    const used = new Map([...fam].map(([k, cs]) => [k, cs.length === 1 ? (cs[0]!.fairUse?.usedS ?? dur(cs[0]!.shotId)) : cs.reduce((t, c) => t + dur(c.shotId), 0) + 0.8] as [string, number]));
    const long = clips.filter((c) => (used.get(`${rootOf(c.shotId)}|${baseRef(c.ref)}`) ?? 0) > 7.5).map((c) => c.shotId);
    add({ id: "fair_use_clip_length", label: "Press clips longer than 7.5 s", value: long.length, target: "0", pass: long.length === 0, level: "blocker", repair: "replace_picture", shots: long });
    const share = clips.reduce((t, c) => t + dur(c.shotId), 0) / Math.max(1, o.timed.durationS);
    add({ id: "fair_use_share", label: "Share of the runtime on press footage", value: share, target: "≤ 0.45", pass: share <= 0.45, level: "blocker", repair: "replace_picture", shots: share > 0.45 ? clips.sort((a, b) => dur(b.shotId) - dur(a.shotId)).slice(0, 1).map((c) => c.shotId) : [] });
  }

  // --- Coverage: enough of the film stands on real pictures (from the sourcing report).
  {
    const src = await readJson<{ needPicture: number; withFootage: number; withScenePictureOnly: number; refusedByRateLimit?: Record<string, number> }>(path.join(o.jobDir, "sourcing.json"));
    if (src && src.needPicture) {
      const cov = (src.withFootage + src.withScenePictureOnly) / src.needPicture;
      const refused = Object.values(src.refusedByRateLimit ?? {}).reduce((t, n) => t + n, 0);
      add({ id: "picture_coverage", label: "Shots that need a picture and have one", value: cov, target: "≥ 0.6", pass: cov >= 0.6, level: "blocker", ...(refused ? { note: `${refused} searches were refused by rate limits — run sourcing again later (--redo resolve)` } : { note: "sourcing and its re-plan already ran; a film this bare would be a slide deck" }) });
    }
  }

  // --- Edit: designed treatment on nearly every shot, little plain slow-zoom footage, no long run on one bare backdrop.
  {
    const designedShots = new Set(o.manifest.video.filter((l) => l.sourceKind === "designed" && !["captions", "chapter"].includes(l.ref)).map((l) => l.shotId));
    const treated = shots.filter((s) => designedShots.has(s.id)).length / Math.max(1, shots.length);
    const slow = shots.filter((s) => !designedShots.has(s.id) && (s.camera.type === "ken_burns" || s.camera.type === "static")).length / Math.max(1, shots.length);
    // Clean footage is part of the style (measured: about four of the channel's shots in ten carry nothing), so
    // a scene with no elements counts as designed here; what matters is that every shot is a decided scene.
    add({ id: "designed_share", label: "Shots with a decided scene (designed or deliberately clean)", value: treated, target: "≥ 0.7", pass: treated >= 0.7, level: "blocker" });
    const cleanStill = o.scenes.scenes.filter((sc) => sc.elements.length === 0 && o.resolution.media.find((m) => m.shotId === sc.shotId && m.role === "primary")?.kind !== "video").map((sc) => sc.shotId);
    add({ id: "dead_frames", label: "Clean shots without moving footage (a still or an empty stage with nothing on it)", value: cleanStill.length, target: "0", pass: cleanStill.length === 0, level: "blocker", repair: "redesign_scene", shots: cleanStill });
    add({ id: "slow_zoom_share", label: "Plain footage with only a slow zoom or static", value: slow, target: "≤ 0.2", pass: slow <= 0.2, level: "blocker" });
    const order = [...o.scenes.scenes].sort((a, b) => a.shotId.localeCompare(b.shotId));
    let run = 0;
    let worst = 0;
    for (const [k, sc] of order.entries()) {
      run = sc.backdrop !== "footage" && order[k - 1]?.backdrop === sc.backdrop ? run + 1 : 1;
      if (sc.backdrop !== "footage") worst = Math.max(worst, run);
    }
    const stageRun = order.filter((sc, k) => sc.backdrop !== "footage" && order[k - 1]?.backdrop === sc.backdrop && order[k - 2]?.backdrop === sc.backdrop).map((sc) => sc.shotId);
    add({ id: "bare_backdrop_run", label: "Longest run of scenes on the kit's stage", value: worst, target: "≤ 2", pass: worst <= 2, level: "blocker", repair: "replace_picture", shots: stageRun });
    const bareIds = order.filter((sc) => sc.backdrop !== "footage" && !sc.elements.some((e) => e.type === "photo" || e.type === "cutout" || e.type === "card3d")).map((sc) => sc.shotId);
    const bare = bareIds.length / Math.max(1, order.length);
    add({ id: "picture_less_scenes", label: "Scenes with no picture at all (only the kit's words on its stage)", value: bare, target: "≤ 0.35", pass: bare <= 0.35, level: "blocker", ...(bare > 0.35 ? { repair: "replace_picture" as const, shots: bareIds.slice(0, Math.ceil(bareIds.length - order.length * 0.35)) } : {}), note: "more of these and the film reads as a slide deck" });
  }

  // --- Period: footage under a line set before 2009 must not look later than the line (a dedicated dating
  // check on the footage itself, not on the designed frame). Real press footage of the subject is exempt.
  {
    const src = await readJson<{ rows: Array<{ shotId: string; when?: string }> }>(path.join(o.jobDir, "sourcing.json"));
    const items: Array<{ shotId: string; frameFile: string; year: number }> = [];
    for (const m of o.resolution.media.filter((x) => x.role === "primary" && x.origin !== "press")) {
      const year = yearOf(src?.rows.find((r) => r.shotId === m.shotId)?.when);
      if (year === null || year > 2008) continue;
      const frame = `${m.localPath}.period.jpg`;
      if (await reviewFrame(m.localPath, frame, m.kind === "video" ? 1 : 0)) items.push({ shotId: m.shotId, frameFile: frame, year });
    }
    if (items.length) {
      const dated = await periodCheck(items);
      const late = items.map((it, k) => ({ it, d: dated[k]! })).filter((x) => !x.d.ok);
      add({ id: "period_footage", label: "Footage that looks later than the line it sits under", value: late.length, target: "0", pass: late.length === 0, level: "blocker", repair: "replace_picture", shots: late.map((x) => x.it.shotId), ...(late.length ? { note: late.slice(0, 4).map((x) => `${x.it.shotId} (line set in ${x.it.year}): ${x.d.evidence.slice(0, 60)}`).join("; ") } : {}) });
    }
  }

  // --- Fit: footage rated below 6/10 against its own line (the picture review's score) is replaced.
  {
    const weak = o.resolution.media.filter((m) => m.role === "primary" && m.origin !== "press" && typeof m.seen?.fit === "number" && m.seen.fit < 6).map((m) => m.shotId);
    add({ id: "weak_fit", label: "Footage rated below 6/10 against its own line", value: weak.length, target: "0", pass: weak.length === 0, level: "blocker", repair: "replace_picture", shots: weak });
  }

  // --- Edit: the cut rate inside the channel's band.
  if (o.cutBand) {
    const cpm = o.board.shots.length / Math.max(0.1, o.timed.durationS / 60);
    add({ id: "cut_pace", label: "Cuts a minute against the channel's band", value: Math.round(cpm * 10) / 10, target: `${o.cutBand.lo.toFixed(0)}–${o.cutBand.hi.toFixed(0)}`, pass: cpm >= o.cutBand.lo && cpm <= o.cutBand.hi, level: "blocker" });
  }

  // --- Edit: a shot the editor split in two (the same picture on both sides of the cut) is bridged, never a jump.
  {
    const sh = o.board.shots;
    const prim = (id: string) => o.resolution.media.find((m) => m.shotId === id && m.role === "primary");
    const jumps = sh.filter((x, k) => k > 0 && x.transitionIn === "cut" && (/_\d+$/.test(x.id) && x.id.replace(/_\d+$/, "") === sh[k - 1]!.id.replace(/_\d+$/, "") || (prim(x.id) && prim(sh[k - 1]!.id) && baseRef(prim(x.id)!.ref) === baseRef(prim(sh[k - 1]!.id)!.ref)))).map((x) => x.id);
    add({ id: "unbridged_split", label: "Cuts inside one picture with nothing bridging them (a jump)", value: jumps.length, target: "0", pass: jumps.length === 0, level: "blocker", repair: "redesign_scene", shots: jumps });
  }

  // --- Sharpness: footage far softer than the channel's own frames (an upscaled or smeared source) is replaced.
  if (o.quality) {
    const soft: string[] = [];
    for (const m of o.resolution.media.filter((x) => x.role === "primary" && x.origin !== "press")) {
      const c = await measureCraft(m.localPath, m.kind === "video" ? Math.min(1, (m.durationS ?? 2) / 2) : undefined).catch(() => null);
      if (c && c.sharpTop < o.quality.frames.sharpTop.p10) soft.push(m.shotId);
    }
    const lim = Math.max(1, Math.round(o.resolution.media.filter((x) => x.role === "primary").length * 0.1));
    add({ id: "soft_footage", label: "Footage softer than the channel's softest tenth of frames", value: soft.length, target: `≤ ${lim}`, pass: soft.length <= lim, level: "blocker", repair: "replace_picture", shots: soft });
  }

  add({ id: "scene_defects", label: "Scenes with a visible defect on the final preview", value: o.sceneDefects.size, target: "0", pass: o.sceneDefects.size === 0, level: "blocker", repair: "redesign_scene", shots: [...o.sceneDefects.keys()], ...(o.sceneDefects.size ? { note: [...o.sceneDefects.entries()].slice(0, 4).map(([k, v]) => `${k}: ${v[0]}`).join("; ") } : {}) });

  // --- Look, measured on the final preview frames against the channel's own films (movement needs the render).
  const band = o.exemplars?.looks.band;
  if (band && o.previewFrames.length >= 4) {
    const sheet = await contactSheet(o.previewFrames, path.join(o.jobDir, "preflight_look.jpg"), { cols: 6, cellW: 320 });
    const look = await measureLook(sheet).catch(() => null);
    if (look) {
      add({ id: "preview_luma", label: "Brightness of the scenes", value: look.luma, target: `≥ ${band.luma.p25}`, pass: look.luma >= band.luma.p25 * 0.95, level: "blocker", repair: "regrade" });
      add({ id: "preview_colourfulness", label: "Colourfulness of the scenes", value: look.colourfulness, target: `≥ ${band.colourfulness.p25}`, pass: look.colourfulness >= band.colourfulness.p25 * 0.95, level: "blocker", repair: "regrade" });
      add({ id: "preview_hue_spread", label: "Colour variety across the scenes", value: look.hueSpread, target: `≥ ${band.hueSpread.p25}`, pass: look.hueSpread >= band.hueSpread.p25 * 0.95, level: "blocker", repair: "regrade" });
    }
    const dom = await hueDominance(o.previewFrames);
    if (dom !== null && o.hueRef) {
      const lim = Math.min(0.9, Math.max(o.hueRef.p75 * 1.1, o.hueRef.max) + 0.05);
      add({ id: "one_colour_film", label: "Share of scenes carried by the same colour (a film washed in one tone reads as monochrome)", value: dom, target: `≤ ${r3(lim)} (the channel's films: up to ${o.hueRef.max})`, pass: dom <= lim, level: "blocker", repair: "regrade" });
    }
  }

  // --- Step 4: taste is the objective — the film's scenes, as a whole, at least at the channel's lowest tenth.
  if (o.taste) {
    add({ id: "film_taste", label: "Taste of the film's scenes against the channel's real shots (trained heads, median)", value: o.taste.median, target: `≥ ${o.taste.realP10} (the channel's median ${o.taste.realMedian})`, pass: o.taste.median >= o.taste.realP10, level: "blocker", ...(o.taste.low.length ? { repair: "redesign_scene" as const, note: `lowest scenes: ${o.taste.low.slice(0, 6).join(", ")}`, shots: o.taste.low.map((x) => x.split(" ")[0]!) } : {}) });
  }

  // --- Uniqueness of the plan against earlier films.
  {
    const fp = await readJson<{ closest: { to: string; over: string[] } | null }>(path.join(o.jobDir, "fingerprint.json"));
    const over = fp?.closest?.over ?? [];
    const soundOnly = over.length > 0 && over.every((x) => x.startsWith("sound"));
    // D38: the look of the scenes (SigLIP centroid, film-score.ts) against our earlier films, in the channel's own range.
    const fs = await readJson<{ look: { nearestOurs: { job: string; distance: number } | null; minBetween: number } | null }>(path.join(o.jobDir, "film-score.json"));
    const nl = fs?.look?.nearestOurs;
    if (nl && fs?.look) add({ id: "unique_look", label: `Look of the scenes against our nearest film (${nl.job})`, value: nl.distance, target: `≥ ${fs.look.minBetween} (two of the channel's films rarely sit closer)`, pass: nl.distance >= fs.look.minBetween, level: "blocker" });
    add({ id: "unique_plan", label: `Respects in which the plan is too close to ${fp?.closest?.to ?? "an earlier film"}`, value: over.length, target: "0", pass: over.length === 0, level: "blocker", ...(soundOnly ? { repair: "reseed_sound" as const } : {}), ...(over.length ? { note: over.join("; ") } : {}) });
  }

  // --- Sound: no effect or bed a recent film used; no single family carrying the film.
  {
    const sfx = shots.flatMap((s) => s.sfx.map((f) => f.assetId));
    const sharedSfx = [...new Set(sfx)].filter((x) => o.recent.sfx.has(x)).length / Math.max(1, new Set(sfx).size);
    add({ id: "shared_sfx", label: "Sound effects a recent film already used", value: sharedSfx, target: "≤ 0.34 of the film's effects", pass: sharedSfx <= 0.34, level: "blocker", repair: "reseed_sound" });
    const sharedMusic = o.board.music.filter((m) => o.recent.music.has(m.assetId)).length;
    add({ id: "shared_music", label: "Music beds a recent film already used", value: sharedMusic, target: "0", pass: sharedMusic === 0, level: "blocker", repair: "reseed_sound" });
    const files = o.resolution.media.filter((m) => m.role === "sfx").map((m) => m.localPath);
    if (files.length >= 3) {
      const fam = new Map<string, number>();
      for (const f of [...new Set(files)].slice(0, 24)) {
        const c = await measureSound(f).catch(() => null);
        if (c) fam.set(c.family, (fam.get(c.family) ?? 0) + 1);
      }
      const total = [...fam.values()].reduce((t, v) => t + v, 0);
      if (total) {
        const top = Math.max(...fam.values()) / total;
        add({ id: "sfx_variety", label: "Share of the most-used sound family", value: top, target: "≤ 0.6", pass: top <= 0.6, level: "blocker", repair: "reseed_sound" });
      }
    }
  }

  // --- Voice. Words must be right (blockers). Pace is checked against THIS voice's natural pace, never the
  // reference narrator's. Expressiveness is compared with the reference narrator and reported (a fixed voice
  // has no automatic repair for it).
  {
    const rep = await readJson<{ wer: number | null; unresolved: string[] }>(path.join(o.jobDir, "narration.report.json"));
    if (rep) {
      add({ id: "voice_unresolved", label: "Narration lines with an unresolved word or pronunciation problem", value: rep.unresolved.length, target: "0", pass: rep.unresolved.length === 0, level: "blocker", ...(rep.unresolved.length ? { note: `${rep.unresolved.slice(0, 2).join("; ")} — re-run the narration (--redo narration)` } : {}) });
      if (rep.wer !== null) add({ id: "voice_wer", label: "Word error against the script", value: rep.wer, target: "≤ 0.01", pass: rep.wer <= 0.01, level: "blocker" });
      // Step 3: no join you can hear — no digital silence, no voice starting or stopping dead (senses/seams.ts).
      const sm = await measureSeams(o.timed.voice.audioPath).catch(() => null);
      if (sm) {
        const hard = sm.seams.filter((x) => x.kind !== "floor_jump");
        add({ id: "voice_seams", label: "Joins you can hear in the narration (dead air, a voice starting or stopping dead)", value: hard.length, target: "0", pass: hard.length === 0, level: "blocker", ...(hard.length ? { note: `${hard.slice(0, 4).map((x) => `${x.atS} s ${x.kind}`).join(", ")} — re-run the narration (--redo narration)` } : {}) });
      }
    }
    const words = o.timed.segments.flatMap((s) => s.words.map((w) => ({ word: w.word, start: w.startS, end: w.endS })));
    const pace = measurePace(words);
    if (o.naturalWpm) add({ id: "voice_natural_pace", label: "Narration pace against this voice's own natural pace (wpm)", value: pace.wpm, target: `${Math.round(o.naturalWpm * 0.88)}–${Math.round(o.naturalWpm * 1.12)} (natural ${o.naturalWpm})`, pass: pace.wpm >= o.naturalWpm * 0.88 && pace.wpm <= o.naturalWpm * 1.12, level: "blocker", note: "outside this band the voice was pushed or dragged" });
    const n = o.exemplars?.narrator;
    if (n) {
      add({ id: "voice_pace_variety", label: "Pace variety between sentences", value: pace.sentenceWpmStd, target: `≥ ${r3(n.sentenceWpmStd * 0.7)}`, pass: pace.sentenceWpmStd >= n.sentenceWpmStd * 0.7, level: "advisory" });
      const p = await measureProsody(o.timed.voice.audioPath).catch(() => null);
      if (p) {
        add({ id: "voice_pitch_travel", label: "Pitch travel (semitones)", value: p.f0RangeSt, target: `≥ ${n.prosody.f0RangeSt.p25}`, pass: p.f0RangeSt >= n.prosody.f0RangeSt.p25 * 0.95, level: "advisory" });
        add({ id: "voice_melody", label: "Phrase melody (semitones)", value: p.melodySt, target: `≥ ${n.prosody.melodySt.p25}`, pass: p.melodySt >= n.prosody.melodySt.p25 * 0.95, level: "advisory" });
        add({ id: "voice_dynamics", label: "Voice dynamics (dB)", value: p.energyStdDb, target: `≥ ${n.prosody.energyStdDb.p25}`, pass: p.energyStdDb >= n.prosody.energyStdDb.p25 * 0.9, level: "advisory" });
      }
      if (n.wordGapPausesPerMin) {
        let g = 0;
        for (let k = 0; k + 1 < words.length; k++) if (words[k + 1]!.start - words[k]!.end >= 0.25) g++;
        const perMin = (g / Math.max(1, o.timed.durationS)) * 60;
        const lim = Math.max(4, n.wordGapPausesPerMin.p75 * 1.3);
        add({ id: "voice_pauses", label: "Pauses per minute (≥ 0.25 s)", value: perMin, target: `≤ ${r3(lim)}`, pass: perMin <= lim, level: "advisory" });
      }
    }
  }
  return out;
}

/**
 * replace_picture, first step: the offending picture is taken out of its shot (the earlier use of a repeated picture
 * stays). Returns the trimmed media list and the shots whose scenes must be designed again without it.
 */
export function dropPictures(resolution: ResolutionReport, checks: PreflightCheck[], recent: Set<string>): { media: ResolutionReport["media"]; shots: Set<string> } {
  const failing = checks.filter((c) => !c.pass && c.repair === "replace_picture" && c.shots?.length);
  const want = (id: string) => new Set(failing.filter((c) => c.id === id).flatMap((c) => c.shots ?? []));
  const repeat = want("repeat_in_film");
  const shared = want("shared_pictures");
  const press = new Set(failing.filter((c) => c.id.startsWith("fair_use")).flatMap((c) => c.shots ?? []));
  const late = new Set([...want("period_footage"), ...want("soft_footage"), ...want("weak_fit")]);
  const face = want("stand_in_face");
  const first = new Map<string, string>();
  const keepWiki = new Map<string, Set<string>>(); // the first two shots a portrait or logo appears in
  for (const m of [...resolution.media].filter((x) => x.role === "primary" || x.role === "layer").sort((x, y) => x.shotId.localeCompare(y.shotId))) {
    if (!first.has(baseRef(m.ref))) first.set(baseRef(m.ref), m.shotId);
    if (m.role === "layer" && m.provider === "wikipedia") {
      const set = keepWiki.get(baseRef(m.ref)) ?? new Set<string>();
      if (set.size < 2) set.add(m.shotId);
      keepWiki.set(baseRef(m.ref), set);
    }
  }
  const shots = new Set<string>();
  const media = resolution.media.filter((m) => {
    if (m.role !== "primary" && m.role !== "layer") return true;
    const wiki = m.role === "layer" && m.provider === "wikipedia";
    const gone = (repeat.has(m.shotId) && !wiki && first.get(baseRef(m.ref)) !== m.shotId) || (repeat.has(m.shotId) && wiki && !keepWiki.get(baseRef(m.ref))?.has(m.shotId)) || (shared.has(m.shotId) && !wiki && recent.has(baseRef(m.ref))) || (press.has(m.shotId) && m.role === "primary" && m.origin === "press") || (late.has(m.shotId) && m.role === "primary" && m.origin !== "press") || (face.has(m.shotId) && m.role === "primary");
    if (gone) shots.add(m.shotId);
    return !gone;
  });
  return { media, shots };
}
