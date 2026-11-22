/**
 * Video taste judge (build list 2, step 1): judges MOVING stretches, not stills. Each stretch of our film (a strip of 8
 * frames across its seconds, so motion, cuts and type animation are visible) is shown blind beside two real stretches
 * of the channel that say something close in meaning (reference-library.ts:findPassages), and a judge who knows the
 * channel names the imitation. Realness = 1 − the judge's probability that ours is the imitation (2/3 when it
 * cannot tell). The trained taste heads (taste.ts) also score the same frames, as a second, model-free read.
 *
 * Calibration (`calibrateClipJudge`): the same test with a third REAL stretch in our place — a fair judge picks it a
 * third of the time; the measured rate is stored with every result so a score is read against it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelId } from "@opumia/contracts";
import { run } from "@opumia/senses";
import * as z from "zod/v4";
import { MODELS, plain, structured } from "./llm.js";
import { loadReferenceIndex } from "./reference-index.js";
import { findPassages } from "./reference-library.js";
import { scoreTaste } from "./taste.js";

export interface ClipVerdict { fromS: number; toS: number; said: string; realness: number; picked: boolean; confidence: number; tells: string[]; taste: number | null; refs: string[] }
export interface ClipJudgeReport { channel: string; clips: ClipVerdict[]; realness: number; taste: number | null; calibration: { realPickedAsImitation: number; n: number } | null; usd: number }

const Verdict = z.object({ imitation: z.enum(["A", "B", "C"]), confidence: z.number().describe("0–1"), tells: z.array(z.string()).describe("what gave the imitation away, concrete (cut, type, motion, picture, colour, composition)") });

async function strip(video: string, fromS: number, toS: number, out: string): Promise<string | null> {
  if (existsSync(out)) return out;
  const t = Math.max(1, toS - fromS);
  await mkdir(path.dirname(out), { recursive: true });
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", fromS.toFixed(2), "-t", t.toFixed(2), "-i", video, "-vf", `fps=${(8 / t).toFixed(4)},scale=320:-2,tile=4x2`, "-frames:v", "1", "-q:v", "4", out]).catch(() => null);
  return existsSync(out) ? out : null;
}
const img = async (f: string): Promise<Anthropic.Beta.BetaImageBlockParam> => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(f)).toString("base64") } });
const seeded = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16);

async function filmVideo(reference: string, data: string, filmId: string): Promise<string | null> {
  const ix = await loadReferenceIndex(data);
  const th = ix?.thumbs.find((t) => t.film === filmId);
  if (!th) return null;
  const dir = path.join(reference, path.dirname(th.file));
  const { readdirSync } = await import("node:fs");
  const mp4 = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".mp4")) : undefined;
  return mp4 ? path.join(dir, mp4) : null;
}

async function blind(channel: string, strips: string[], seed: string): Promise<{ order: number[]; v: z.infer<typeof Verdict>; usd: number }> {
  const s = seeded(seed);
  const order = [0, 1, 2].sort((a, b) => ((s >> (a * 3)) & 7) - ((s >> (b * 3)) & 7) || a - b);
  const L = ["A", "B", "C"];
  const user: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const [k, idx] of order.entries()) user.push({ type: "text", text: `${L[k]} — eight frames across a few seconds, left to right, top to bottom:` }, await img(strips[idx]!));
  user.push({ type: "text", text: "Two are from real films of the channel; one is an imitation made by another studio. Which is the imitation?" });
  const r = await structured({ stage: "eval.clip", model: MODELS.sonnet, system: [plain(`You have edited many films for the YouTube documentary channel ${channel} and can spot an imitation of its style: its motion design, typography, transitions, cutting, picture choice and colour. Judge craft and style, not topic or video quality.`)], user, schema: Verdict, effort: "medium", maxTokens: 1500 });
  return { order, v: r.data, usd: r.usage.usd };
}

/** Judge stretches of one of our films against the channel. `clips` are [fromS, toS, words said]. */
export async function judgeClips(o: { data: string; reference: string; root: string; channel: ChannelId; video: string; clips: Array<{ fromS: number; toS: number; said: string }>; workDir: string; log?: (s: string) => void }): Promise<ClipJudgeReport> {
  let usd = 0;
  const out: ClipVerdict[] = [];
  const cal = await readFile(path.join(o.data, "eval", `clip-calibration-${o.channel}.json`), "utf8").then((t) => JSON.parse(t) as ClipJudgeReport["calibration"], () => null);
  for (const c of o.clips) {
    const dur = c.toS - c.fromS;
    const ps = (await findPassages({ data: o.data, channel: o.channel, said: c.said, seconds: Math.max(6, dur), k: 4 })).slice(0, 2);
    const refStrips: string[] = [];
    const refs: string[] = [];
    for (const p of ps) {
      const v = await filmVideo(o.reference, o.data, p.film);
      if (!v) continue;
      const f = await strip(v, p.t0, p.t0 + dur, path.join(o.workDir, `ref_${p.film}_${p.t0.toFixed(1)}_${dur.toFixed(1)}.jpg`));
      if (f) (refStrips.push(f), refs.push(`${p.title} @ ${p.t0.toFixed(0)} s`));
    }
    const ours = await strip(o.video, c.fromS, c.toS, path.join(o.workDir, `ours_${c.fromS.toFixed(1)}_${c.toS.toFixed(1)}.jpg`));
    if (!ours || refStrips.length < 2) continue;
    const b = await blind(o.channel, [ours, refStrips[0]!, refStrips[1]!], `${o.video}|${c.fromS}`);
    usd += b.usd;
    const pickedIdx = b.order[["A", "B", "C"].indexOf(b.v.imitation)]!;
    const conf = Math.max(0, Math.min(1, b.v.confidence));
    const pOurs = pickedIdx === 0 ? conf + (1 - conf) / 3 : (1 - conf) / 3;
    const tasteS = await scoreTaste({ root: o.root, data: o.data, channel: o.channel, kind: "shot", items: [0.25, 0.5, 0.75].map((q) => ({ file: o.video, t: c.fromS + dur * q })) }).catch(() => []);
    const tv = (tasteS as Array<{ score: number } | null>).flatMap((x) => (x ? [x.score] : []));
    out.push({ fromS: c.fromS, toS: c.toS, said: c.said.slice(0, 160), realness: Math.round((1 - pOurs) * 100) / 100, picked: pickedIdx === 0, confidence: conf, tells: pickedIdx === 0 ? b.v.tells.slice(0, 5) : [], taste: tv.length ? Math.round((tv.reduce((a, x) => a + x, 0) / tv.length) * 10) / 10 : null, refs });
    o.log?.(`  clip ${c.fromS.toFixed(0)}–${c.toS.toFixed(0)} s: ${pickedIdx === 0 ? `picked out (${conf.toFixed(2)})` : "not picked"}${out.at(-1)!.taste !== null ? `, taste ${out.at(-1)!.taste}` : ""}`);
  }
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 100) / 100 : 0);
  const ts = out.flatMap((x) => (x.taste === null ? [] : [x.taste]));
  return { channel: o.channel, clips: out, realness: mean(out.map((x) => x.realness)), taste: ts.length ? mean(ts) : null, calibration: cal, usd: Math.round(usd * 1000) / 1000 };
}

/** Real vs real: how often the judge calls a real stretch the imitation (a fair judge: about a third). */
export async function calibrateClipJudge(o: { data: string; reference: string; channel: ChannelId; n: number; workDir: string; log?: (s: string) => void }): Promise<{ realPickedAsImitation: number; n: number; usd: number }> {
  const ix = await loadReferenceIndex(o.data);
  if (!ix) throw new Error("no reference index");
  const films = ix.manifest.films.filter((f) => f.channel === o.channel);
  let picked = 0, n = 0, usd = 0;
  for (let k = 0; k < o.n && films.length >= 3; k++) {
    const trio = [films[(k * 7) % films.length]!, films[(k * 7 + 3) % films.length]!, films[(k * 7 + 5) % films.length]!];
    const strips: string[] = [];
    for (const [j, f] of trio.entries()) {
      const v = await filmVideo(o.reference, o.data, f.id);
      const t0 = 60 + ((k * 97 + j * 53) % Math.max(60, f.durS - 180));
      const s = v ? await strip(v, t0, t0 + 8, path.join(o.workDir, `cal_${f.id}_${t0}.jpg`)) : null;
      if (s) strips.push(s);
    }
    if (strips.length < 3) continue;
    const b = await blind(o.channel, strips, `cal|${k}`);
    usd += b.usd;
    n++;
    if (b.order[["A", "B", "C"].indexOf(b.v.imitation)] === 0) picked++;
  }
  const res = { realPickedAsImitation: Math.round((picked / Math.max(1, n)) * 100) / 100, n };
  await mkdir(path.join(o.data, "eval"), { recursive: true });
  const f = path.join(o.data, "eval", `clip-calibration-${o.channel}.json`);
  await writeFile(`${f}.tmp`, JSON.stringify(res) + "\n");
  await rename(`${f}.tmp`, f);
  o.log?.(`  clip judge calibration: a real stretch was called the imitation ${picked} of ${n} times (fair: about a third)`);
  return { ...res, usd: Math.round(usd * 1000) / 1000 };
}
