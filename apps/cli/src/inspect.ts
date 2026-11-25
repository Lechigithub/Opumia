/**
 * Eyes and ears for the agents (build list 2, step 2). Every agent that watches a stretch of the film gets the same
 * measured report beside the frames it sees, from the step-1 detectors run on that rendered stretch:
 *  - picture: unbridged jumps (the same picture changing with nothing bridging it), pops, flicker, and the bridged
 *    changes and transitions the channel uses (against its band, data/detector-band/);
 *  - words on screen: legibility of every text element on screen in the stretch (contrast, phone size);
 *  - voice: seams in the narration under the stretch (dead air, hard onsets/cutoffs, room jumps);
 *  - taste: the trained taste heads on three frames of the stretch (the channel's real median beside it).
 * Nothing here calls a model except the cheap embedding of three frames.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureFlowBand, flowText, loadTaste, measureMotion, measureTextHold, scoreTaste } from "@opumia/agents";
import type { ChannelId } from "@opumia/contracts";
import { measureJumps, measureLegibility, measureSeams, run, textBoxesOf } from "@opumia/senses";

export interface StretchFindings { jumps: Array<{ atS: number; kind: string; detail: string }>; bridgedPerMin: number; unreadable: Array<{ shotId: string; label: string; issue: string }>; seams: Array<{ atS: number; kind: string; detail: string }>; taste: number | null; realTaste: number | null }

const band = (data: string, channel: string) => {
  const f = path.join(data, "detector-band", `${channel.replace(/-/g, "")}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { band: Record<string, { p10: number; median: number; p90: number }> }).band : null;
};

export async function inspectStretch(o: {
  clip: { file: string; fromS: number; toS: number };
  scenes: Array<{ shotId: string; elements: Array<Record<string, unknown>> }>;
  shots: Array<{ id: string; startS: number; endS: number }>;
  narration: string | null;
  root: string;
  data: string;
  channel: ChannelId;
  aspect?: "16:9" | "9:16";
}): Promise<{ findings: StretchFindings; text: string }> {
  const { file, fromS, toS } = o.clip;
  const len = toS - fromS;
  const j = await measureJumps(file, { fps: 24 }).catch(() => null);
  const jumps = (j?.events ?? []).map((e) => ({ ...e, atS: Math.round((fromS + e.atS) * 100) / 100 }));
  // legibility: each shot with words, at 70 % of its time inside the stretch (entrances finished)
  const unreadable: StretchFindings["unreadable"] = [];
  const fdir = path.join(path.dirname(file), "inspect");
  await mkdir(fdir, { recursive: true });
  for (const sh of o.shots.filter((s) => s.endS > fromS && s.startS < toS)) {
    const sc = o.scenes.find((x) => x.shotId === sh.id);
    const boxes = sc ? textBoxesOf(sc) : [];
    if (!boxes.length) continue;
    const t = Math.max(fromS, sh.startS) + (Math.min(toS, sh.endS) - Math.max(fromS, sh.startS)) * 0.7 - fromS;
    const fr = path.join(fdir, `${path.basename(file, ".mp4")}_${sh.id}.jpg`);
    if (!existsSync(fr)) await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", Math.max(0, t).toFixed(2), "-i", file, "-frames:v", "1", fr]).catch(() => null);
    if (!existsSync(fr)) continue;
    for (const l of await measureLegibility(fr, boxes, o.aspect ? { aspect: o.aspect } : {})) for (const issue of l.issues) unreadable.push({ shotId: sh.id, label: l.label, issue });
  }
  const s = o.narration ? await measureSeams(o.narration, { ss: fromS, t: len }).catch(() => null) : null;
  const seams = (s?.seams ?? []).map((x) => ({ ...x, atS: Math.round(x.atS * 100) / 100 }));
  const ts = await scoreTaste({ root: o.root, data: o.data, channel: o.channel, kind: "shot", items: [0.2, 0.5, 0.8].map((q) => ({ file, t: len * q })) }).catch(() => []);
  const tv = (ts as Array<{ score: number } | null>).flatMap((x) => (x ? [x.score] : []));
  const taste = tv.length ? Math.round((tv.reduce((a, x) => a + x, 0) / tv.length) * 10) / 10 : null;
  const realTaste = (await loadTaste(o.data, o.channel, "shot").catch(() => null))?.calibration.real.median ?? null;
  const b = band(o.data, o.channel);
  const bridgedPerMin = j?.bridgedPerMin ?? 0;
  const findings: StretchFindings = { jumps, bridgedPerMin, unreadable, seams, taste, realTaste };
  const lines = [
    `MEASURED on this stretch (${fromS.toFixed(1)}–${toS.toFixed(1)} s):`,
    `- picture: ${jumps.length ? jumps.map((e) => `${e.atS} s ${e.kind} — ${e.detail}`).join("; ") : "no unbridged jump, pop or flicker"}; ${bridgedPerMin}/min same-picture changes bridged by a transition${b ? ` (the channel: ${b.bridgedPerMin!.p10}–${b.bridgedPerMin!.p90}/min, mostly light flashes ${b.flashPerMin!.median}/min)` : ""}`,
    `- words on screen: ${unreadable.length ? unreadable.map((u) => `${u.shotId} "${u.label}": ${u.issue}`).join("; ") : "all readable at phone size"}`,
    `- voice: ${seams.length ? `${seams.length} seam(s) — ${seams.slice(0, 5).map((x) => `${x.atS} s ${x.kind}`).join(", ")}` : "no seam heard"}`,
    `- trained taste: ${taste ?? "?"}/10${realTaste !== null ? ` (the channel's real shots: median ${realTaste})` : ""}`,
  ];
  // the hand film's measures: does the picture change by moving, does the frame keep moving, do words stay up
  const fb = await ensureFlowBand({ root: o.root, data: o.data, reference: path.join(o.root, "Reference"), channel: o.channel }).catch(() => null);
  const ft = flowText(await measureMotion(file, { len }).catch(() => null), await measureTextHold(file, { root: o.root, data: o.data, len }).catch(() => null), fb);
  if (ft) lines.push(ft);
  return { findings, text: lines.join("\n") };
}
