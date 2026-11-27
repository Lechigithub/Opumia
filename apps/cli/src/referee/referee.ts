// The referee (owner, 2026-11-26: "my eyes should not be relied on, that's why the reference exists"): the platform's
// own judge of whether a film looks like the channel, built and PROVEN on material it never saw.
//   - held-back real films: 8 of the channel's 37 films are kept out of every model's training (and, later, out of the
//     agents' reach); their stretches are the "real" test class;
//   - our films: every 16:9 film we produced, all short of the channel; v7 (hand-built) is reported on its own and must
//     score above Juicero;
//   - three signals, each with its threshold set on TRAINING material only:
//       look   the stretch's measured look (brightness, contrast, dark share, saturation, colour, grain, sharpness,
//              vignette, warmth) against the band of the training films' stretches (tools/referee/look.py);
//       taste  the trained image model (taste.ts), retrained in folds so no test film was ever in its training;
//       judge  a blind three-way pick by a model that knows the channel: the stretch beside two training-film stretches
//              at the same place in a film, every logo corner masked (the old judge read the missing logo, not style).
//   A signal (or their vote) is trusted only if, on the test set, it flags ≥ 90 % of our stretches and ≤ 15 % of real.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";

export interface Stretch { id: string; cls: "real" | "ours" | "v7" | "train"; film: string; video: string; from: number; to: number; pos: number }
export interface Scores { look?: number; taste?: number; judge?: { picked: boolean; confidence: number; tells: string[] } }

const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
export const POSITIONS = [0.015, 0.25, 0.5, 0.75, 0.92];
const LEN = 8;
const h = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16);

/** Our produced 16:9 films (all short of the channel); v7 is the hand-built best. */
export const OURS: Array<{ job: string; file: string }> = [
  ["agent-juicero-2", "film_16x9.mp4"], ["bl4b-theranos", "how-theranos-fooled-silicon-valley_16x9.mp4"], ["bl4c-nokia", "how-nokia-lost-the-smartphone-war_16x9.mp4"],
  ["bl5-blockbuster", "how-blockbuster-turned-down-netflix_16x9.mp4"], ["bl5b-wework", "how-wework-burned-through-billions_16x9.mp4"], ["bl5c-quibi", "how-quibi-spent-a-fortune-and-shut-down-in-six-m_16x9.mp4"],
  ["eval-quick-kodak", "how-kodak-invented-the-digital-camera-and-still-_16x9.mp4"], ["eval-quick-theranos", "how-theranos-fooled-silicon-valley_16x9.mp4"], ["film1-kodak-3", "how-kodak-invented-the-digital-camera-and-still-_16x9.mp4"],
  ["enron-mm", "enron-the-empire-built-on-paper_16x9.mp4"], ["hand-ftx", "film_16x9.mp4"], ["hand-wirecard", "film_16x9.mp4"], ["hand-wirecard-v4", "film_16x9.mp4"],
  ["hand-wirecard-v5", "film_16x9.mp4"], ["hand-wirecard-v6", "film_16x9.mp4"],
].map(([job, file]) => ({ job: job!, file: file! }));
export const V7 = { job: "hand-wirecard-v7", file: "film_16x9.mp4" };

const dur = (f: string) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim() || 0);
const at = (d: number, p: number) => Math.max(0, Math.min(d - LEN - 0.5, p * d));

/** The channel's films, the 8 held back (spread evenly by id), and every stretch of the test and training sets. */
export async function buildSets(o: { root: string; data: string; reference: string; channel: string }) {
  const { filmVideo } = await import("@opumia/agents");
  const man = jread<{ films: Array<{ id: string; channel: string; durS: number }> }>(path.join(o.data, "reference-index", "manifest.json"), { films: [] });
  const films = man.films.filter((f) => f.channel === o.channel).sort((a, b) => a.id.localeCompare(b.id));
  const holdout = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => films[Math.min(films.length - 1, Math.round(((i + 0.5) * films.length) / 8))]!.id));
  const sets: Stretch[] = [];
  for (const f of films) {
    const v = await filmVideo(o.reference, o.data, f.id);
    if (!v) continue;
    POSITIONS.forEach((p, k) => { const a = at(f.durS, p); sets.push({ id: `${f.id}@${k}`, cls: holdout.has(f.id) ? "real" : "train", film: f.id, video: v, from: a, to: a + LEN, pos: k }); });
  }
  for (const x of [...OURS, V7]) {
    const v = path.join(o.root, "out", x.job, x.file);
    if (!existsSync(v)) continue;
    const d = dur(v);
    POSITIONS.forEach((p, k) => { const a = at(d, p); sets.push({ id: `${x.job}@${k}`, cls: x.job === V7.job ? "v7" : "ours", film: x.job, video: v, from: a, to: a + LEN, pos: k }); });
  }
  return { holdout: [...holdout], sets };
}

// ---- look: distance from the training films' band (robust z per feature, root mean square)
export const LOOK_KEYS = ["luma", "contrast", "dark", "sat", "colourful", "grain", "sharp", "vignette", "warm"] as const;
export function lookBand(train: Array<Record<string, number>>) {
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]!; };
  return Object.fromEntries(LOOK_KEYS.map((k) => { const xs = train.map((t) => t[k]!).filter(Number.isFinite); const med = q(xs, 0.5), iqr = Math.max(1e-6, q(xs, 0.75) - q(xs, 0.25)); return [k, { med, scale: iqr / 1.35 }]; })) as Record<(typeof LOOK_KEYS)[number], { med: number; scale: number }>;
}
export const lookDistance = (f: Record<string, number>, band: ReturnType<typeof lookBand>) => Math.sqrt(LOOK_KEYS.reduce((t, k) => t + Math.min(9, ((f[k]! - band[k].med) / band[k].scale) ** 2), 0) / LOOK_KEYS.length);

export function measureLook(o: { root: string; work: string; items: Stretch[] }): Record<string, Record<string, number>> {
  const py = process.env.OPUMIA_PY ?? path.join(process.env.HOME ?? "", "lechi_tts", "venv", "bin", "python");
  const cache = path.join(o.work, "look.json");
  const have = jread<Record<string, Record<string, number>>>(cache, {});
  const todo = o.items.filter((s) => !have[s.id]);
  if (todo.length) {
    const inF = path.join(o.work, "look-items.json"), outF = path.join(o.work, "look-new.json");
    writeFileSync(inF, JSON.stringify(todo.map((s) => ({ id: s.id, video: s.video, from: s.from, to: s.to }))));
    const r = spawnSync(py, ["-I", path.join(o.root, "tools/referee/look.py"), inF, outF], { encoding: "utf8", maxBuffer: 1 << 24 });
    if (r.status !== 0) throw new Error(`look.py failed: ${(r.stderr ?? "").slice(-600)}`);
    Object.assign(have, jread<Record<string, Record<string, number>>>(outF, {}));
    writeFileSync(cache, JSON.stringify(have));
  }
  return have;
}

// ---- judge: blind three-way pick, logo corners masked, references from training films at the same place in a film
const MASK = "drawbox=x=0:y=ih*0.80:w=iw*0.22:h=ih*0.20:color=black:t=fill,drawbox=x=iw*0.80:y=0:w=iw*0.20:h=ih*0.14:color=black:t=fill";
export function maskedStrip(video: string, from: number, to: number, out: string): string | null {
  if (existsSync(out)) return out;
  mkdirSync(path.dirname(out), { recursive: true });
  const t = Math.max(1, to - from);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", from.toFixed(2), "-t", t.toFixed(2), "-i", video, "-vf", `${MASK},fps=${(8 / t).toFixed(4)},scale=320:-2,tile=4x2`, "-frames:v", "1", "-q:v", "4", out]);
  return existsSync(out) ? out : null;
}
const Pick = z.object({ imitation: z.enum(["A", "B", "C"]), confidence: z.number().describe("0–1"), tells: z.array(z.string()).describe("concrete: picture, type, motion, texture, colour, layout") });
export async function judgeStretch(o: { channel: string; test: Stretch; refs: Stretch[]; work: string }): Promise<{ picked: boolean; confidence: number; tells: string[]; usd: number } | null> {
  const { structured, MODELS, plain } = await import("@opumia/agents");
  const { readFile } = await import("node:fs/promises");
  const strips = [o.test, ...o.refs].map((s) => maskedStrip(s.video, s.from, s.to, path.join(o.work, "strips", `${s.id.replace(/[^\w@.-]/g, "_")}.jpg`)));
  if (strips.some((s) => !s)) return null;
  const seed = h(o.test.id);
  const order = [0, 1, 2].sort((a, b) => ((seed >> (a * 4)) & 15) - ((seed >> (b * 4)) & 15) || a - b);
  const L = ["A", "B", "C"];
  const user: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }> = [];
  for (const [k, idx] of order.entries()) user.push({ type: "text", text: `${L[k]} — eight frames across eight seconds, left to right, top to bottom:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(strips[idx]!)).toString("base64") } });
  user.push({ type: "text", text: "Two of these are from real films of the channel; one is an imitation made by another studio. Corners are masked on all three, so logos tell you nothing. Which is the imitation? Judge the craft: footage, type, motion, texture, colour, composition." });
  const r = await structured({ stage: "referee.judge", model: MODELS.sonnet, system: [plain(`You have edited many films for the YouTube documentary channel ${o.channel} and know its craft: how it picks and treats footage, sets words into the picture, grades, textures and moves. You can tell its own work from an imitation.`)], user: user as never, schema: Pick, effort: "low", maxTokens: 1500 });
  const picked = order[L.indexOf(r.data.imitation)] === 0;
  return { picked, confidence: Math.max(0, Math.min(1, r.data.confidence)), tells: r.data.tells.slice(0, 6), usd: r.usage.usd };
}
/** Two training-film stretches at the same place in a film, chosen by the test stretch's id (deterministic). */
export function refsFor(test: Stretch, train: Stretch[]): Stretch[] {
  const same = train.filter((s) => s.pos === test.pos && s.film !== test.film);
  const a = h(`${test.id}|a`) % same.length;
  let b = h(`${test.id}|b`) % same.length;
  if (same[b]!.film === same[a]!.film) b = (b + 1) % same.length;
  return [same[a]!, same[b]!];
}

// ---- evaluation
export interface Separation { flaggedReal: number; caughtOurs: number; n: { real: number; ours: number }; trusted: boolean }
export function separation(sets: Stretch[], flag: (s: Stretch) => boolean | null): Separation {
  const r = sets.filter((s) => s.cls === "real").map(flag).filter((x): x is boolean => x !== null);
  const o = sets.filter((s) => s.cls === "ours").map(flag).filter((x): x is boolean => x !== null);
  const flaggedReal = r.filter(Boolean).length / Math.max(1, r.length), caughtOurs = o.filter(Boolean).length / Math.max(1, o.length);
  return { flaggedReal: Math.round(flaggedReal * 100) / 100, caughtOurs: Math.round(caughtOurs * 100) / 100, n: { real: r.length, ours: o.length }, trusted: caughtOurs >= 0.9 && flaggedReal <= 0.15 };
}
