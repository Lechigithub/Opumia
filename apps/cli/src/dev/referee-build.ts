// Build and prove the referee (see referee/referee.ts).
//   npx tsx apps/cli/src/dev/referee-build.ts [--no-judge] [--max-usd 8]
// Free: look measures + the taste model retrained in folds. Paid (≤ --max-usd): the masked blind judge.
// Writes data/referee/<channel>.json (holdout, thresholds, per-signal separation, per-film scores).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSets, measureLook, lookBand, lookDistance, judgeStretch, refsFor, separation, OURS, V7, type Stretch, type Scores } from "../referee/referee.js";
import { pool } from "../film-agent/plan.js";

const ROOT = path.resolve(process.env.OPUMIA_ROOT ?? process.cwd());
const DATA = path.join(ROOT, "data"), REF = path.resolve(ROOT, process.env.OPUMIA_REFERENCE_DIR ?? "Reference");
const CHANNEL = "magnates-media";
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const WORK = path.join(DATA, "referee", "work");
mkdirSync(WORK, { recursive: true });
const jread = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };
const { loadKeys } = await import("../keys.js");
loadKeys(ROOT);

const t0 = Date.now();
const { holdout, sets } = await buildSets({ root: ROOT, data: DATA, reference: REF, channel: CHANNEL });
const by = (c: Stretch["cls"]) => sets.filter((s) => s.cls === c);
console.log(`sets: ${by("train").length} training stretches (${new Set(by("train").map((s) => s.film)).size} films), ${by("real").length} held-back real (${holdout.length} films), ${by("ours").length} ours (${new Set(by("ours").map((s) => s.film)).size} films), ${by("v7").length} v7`);
const scores = new Map<string, Scores>(sets.map((s) => [s.id, {}]));

// 1. look
const look = measureLook({ root: ROOT, work: WORK, items: sets });
const band = lookBand(by("train").map((s) => look[s.id]).filter((x): x is Record<string, number> => Boolean(x)));
const trainD = by("train").map((s) => (look[s.id] ? lookDistance(look[s.id]!, band) : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
const lookT = trainD[Math.floor(trainD.length * 0.9)]!;
for (const s of sets) if (look[s.id]) scores.get(s.id)!.look = lookDistance(look[s.id]!, band);
console.log(`look: threshold ${lookT.toFixed(2)} (training films' 90th percentile)`);

// 2. taste, retrained in two folds so no test film is in its own model's training
const agents = await import("@opumia/agents");
const tasteFile = path.join(WORK, "taste.json"), maskedFile = path.join(WORK, "taste-masked.json");
const tasteCache = jread<Record<string, number>>(tasteFile, {});
// the same stretches with every corner masked: the channel's logo bug must not be what the model sees
const maskedCache = jread<Record<string, number>>(maskedFile, {});
const testJobs = [...OURS.map((x) => x.job), V7.job];
const folds = [testJobs.filter((_, i) => i % 2 === 0), testJobs.filter((_, i) => i % 2 === 1)];
let tasteT = 0;
for (const [f, fold] of folds.entries()) {
  const mine = sets.filter((s) => fold.includes(s.film) || (f === 0 && s.cls === "real"));
  const need = mine.filter((s) => tasteCache[s.id] === undefined);
  const needM = mine.filter((s) => maskedCache[s.id] === undefined);
  const modelFile = path.join(WORK, `taste-fold-${f}.json`);
  const m = existsSync(modelFile) ? (JSON.parse(readFileSync(modelFile, "utf8")) as Awaited<ReturnType<typeof agents.trainTaste>>) : await agents.trainTaste({ root: ROOT, data: DATA, reference: REF, channel: CHANNEL, kind: "shot", excludeFilms: holdout, excludeJobs: fold, write: false, log: (x) => console.log(x) });
  if (!existsSync(modelFile)) writeFileSync(modelFile, JSON.stringify(m));
  tasteT = Math.max(tasteT, m.calibration.real.p10);
  if (need.length) {
    const items = need.flatMap((s) => [2, 4, 6].map((d) => ({ file: s.video, t: s.from + d })));
    const vs = await agents.embedPictures({ root: ROOT, data: DATA, items });
    need.forEach((s, i) => { const v = [0, 1, 2].map((k) => vs[i * 3 + k]).filter((x): x is Float32Array => Boolean(x)); if (v.length) tasteCache[s.id] = v.reduce((t, x) => t + agents.tasteOf(m, x), 0) / v.length; });
    writeFileSync(tasteFile, JSON.stringify(tasteCache));
  }
  if (needM.length) {
    const items = needM.flatMap((s) => [2, 4, 6].map((d) => ({ file: s.video, t: s.from + d, degrade: "corners" })));
    const vs = await agents.embedPictures({ root: ROOT, data: DATA, items });
    needM.forEach((s, i) => { const v = [0, 1, 2].map((k) => vs[i * 3 + k]).filter((x): x is Float32Array => Boolean(x)); if (v.length) maskedCache[s.id] = v.reduce((t, x) => t + agents.tasteOf(m, x), 0) / v.length; });
    writeFileSync(maskedFile, JSON.stringify(maskedCache));
  }
  console.log(`taste fold ${f + 1}: pro AUC ${m.pro.auc}, channel AUC ${m.channelHead.auc}, real p10 ${m.calibration.real.p10}`);
}
for (const s of sets) if (tasteCache[s.id] !== undefined) scores.get(s.id)!.taste = tasteCache[s.id];

// 3. the masked blind judge (paid)
const judgeFile = path.join(WORK, "judge.json");
const judgeCache = jread<Record<string, NonNullable<Scores["judge"]>>>(judgeFile, {});
let usd = 0;
if (!process.argv.includes("--no-judge")) {
  const max = Number(arg("--max-usd") ?? 8);
  agents.setBudget(max);
  const todo = sets.filter((s) => s.cls !== "train" && !judgeCache[s.id]);
  console.log(`judge: ${todo.length} stretches to judge (limit $${max})`);
  await pool(todo, 4, async (s) => {
    if (usd > max - 0.1) return;
    const r = await judgeStretch({ channel: "MagnatesMedia", test: s, refs: refsFor(s, by("train")), work: WORK }).catch((e: Error) => (console.log(`  ! ${s.id}: ${e.message.slice(0, 120)}`), null));
    if (!r) return;
    usd += r.usd;
    judgeCache[s.id] = { picked: r.picked, confidence: r.confidence, tells: r.tells };
    writeFileSync(judgeFile, JSON.stringify(judgeCache));
  });
}
for (const s of sets) if (judgeCache[s.id]) scores.get(s.id)!.judge = judgeCache[s.id];

// 4. separation per signal and by vote
const sc = (s: Stretch) => scores.get(s.id)!;
const sig = {
  look: (s: Stretch) => (sc(s).look === undefined ? null : sc(s).look! > lookT),
  taste: (s: Stretch) => (sc(s).taste === undefined ? null : sc(s).taste! < tasteT),
  masked: (s: Stretch) => (maskedCache[s.id] === undefined ? null : maskedCache[s.id]! < tasteT),
  judge: (s: Stretch) => (sc(s).judge ? sc(s).judge!.picked : null),
};
const vote = (s: Stretch) => { const v = Object.values(sig).map((f) => f(s)).filter((x): x is boolean => x !== null); return v.length < 2 ? null : v.filter(Boolean).length >= 2; };
const sep = { look: separation(sets, sig.look), taste: separation(sets, sig.taste), masked: separation(sets, sig.masked), judge: separation(sets, sig.judge), vote: separation(sets, vote) };

// 5. per film
const films = [...new Set(sets.filter((s) => s.cls !== "train").map((s) => `${s.cls}|${s.film}`))].map((k) => {
  const [cls, film] = k.split("|") as [string, string];
  const xs = sets.filter((s) => s.film === film && s.cls === cls);
  const mean = (f: (s: Stretch) => number | undefined) => { const v = xs.map(f).filter((x): x is number => x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
  const rate = (f: (s: Stretch) => boolean | null) => { const v = xs.map(f).filter((x): x is boolean => x !== null); return v.length ? Math.round((v.filter(Boolean).length / v.length) * 100) / 100 : null; };
  return { film, cls, look: mean((s) => sc(s).look), taste: mean((s) => sc(s).taste), tasteMasked: mean((s) => maskedCache[s.id]), judgePicked: rate(sig.judge), flagged: rate(vote) };
});
// The bars the referee uses on new films (masked taste): a film must reach the lowest held-back channel film's score,
// rounded UP to the next tenth (strict: no film of ours passes it, even if a borderline real film would not); a stretch
// is pointed out below the held-back real stretches' 10th percentile.
const realFilmMasked = films.filter((f) => f.cls === "real" && f.tasteMasked !== null).map((f) => f.tasteMasked!);
const realStretchMasked = by("real").map((s) => maskedCache[s.id]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
const bars = realFilmMasked.length ? { film: Math.ceil(Math.min(...realFilmMasked) * 10) / 10, stretch: Math.round(realStretchMasked[Math.floor(realStretchMasked.length * 0.1)]! * 100) / 100 } : undefined;
const report = { channel: CHANNEL, builtAt: new Date().toISOString(), holdout, ...(bars ? { bars } : {}), thresholds: { look: Math.round(lookT * 100) / 100, taste: tasteT }, band, separation: sep, films, judgeUsd: Math.round(usd * 100) / 100, seconds: Math.round((Date.now() - t0) / 1000) };
writeFileSync(path.join(DATA, "referee", `${CHANNEL}.json`), JSON.stringify(report, null, 1));
console.log("\nseparation (flags real held-back stretches / catches our stretches; trusted needs ≤ 15 % / ≥ 90 %):");
for (const [k, v] of Object.entries(sep)) console.log(`  ${k.padEnd(6)} real flagged ${Math.round(v.flaggedReal * 100)} % of ${v.n.real}, ours caught ${Math.round(v.caughtOurs * 100)} % of ${v.n.ours}${v.trusted ? "  TRUSTED" : ""}`);
console.log("\nfilms (look distance ↓ better, taste ↑ better, judge picked ↓ better):");
for (const f of films.sort((a, b) => (a.cls === b.cls ? 0 : a.cls === "real" ? -1 : b.cls === "real" ? 1 : a.cls === "v7" ? -1 : 1))) console.log(`  ${f.cls.padEnd(5)} ${f.film.slice(0, 34).padEnd(34)} look ${f.look ?? "-"}  taste ${f.taste ?? "-"}  masked ${f.tasteMasked ?? "-"}  judge ${f.judgePicked ?? "-"}  flagged ${f.flagged ?? "-"}`);
// the production model the agents score with (trained on every film except the held-back ones), cached
if (bars && !process.argv.includes("--no-model")) {
  const { refereeModel } = await import("../referee/score.js");
  const m = await refereeModel({ root: ROOT, data: DATA, reference: REF, channel: CHANNEL, log: (x) => console.log(x) });
  console.log(`production model: pro AUC ${m.pro.auc}, channel AUC ${m.channelHead.auc} → data/referee/${CHANNEL}-taste.json`);
}
console.log(`bars: film ${bars?.film}, stretch ${bars?.stretch}`);
console.log(`\njudge spend $${usd.toFixed(2)}, ${Math.round((Date.now() - t0) / 60000)} min → data/referee/${CHANNEL}.json`);
void existsSync;
