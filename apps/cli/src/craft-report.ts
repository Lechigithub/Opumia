/**
 * Build list 5, item 4: every agent's craft score against the reference, at the film's own length, written to
 * out/<job>/craft.json and to the craft history (data/craft-scores/<channel>.jsonl).
 *
 *  - story: the scene-and-character profile (moments, wants, unbridged time jumps, filler) against the scene band of
 *    real windows of this length; blind judge: our narration beside a real window of the same length.
 *  - edit, sound, look, picture: CRAFT_MEASURES on our plan as one stretch against real stretches of this length;
 *    blind judges for edit and sound read the two timelines side by side (text), picture reuses the judge on previews.
 *  - voice: the voice director's human-delivery measures against the delivery band (no reference voice band: the
 *    reference audio has music under it). No pairwise judge (the judge cannot listen).
 *  - packaging: the packaging agent's measures against the channel's thumbnails and titles.
 * Each score is read against the channel's own floor: the lowest tenth of its real stretches scored the same way.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { colourBand, CRAFT_MEASURES, craftBand, craftHistory, ensureReferenceFilms, ensureSceneBand, judgeCraftPair, labelSceneLines, ourSoundStretch, packagingReferenceMeasures, realScoreFloor, referenceStretches, sceneProfile, scoreAgainst, stretchOfPlan, ensureFillerBan, openingLineCount, VOICE_DELIVERY_BAND, type Craft, type CraftBandFile, type CraftScore } from "@opumia/agents";
import type { ChannelId, ResolutionReport, ScenePlan, ScriptDraft, Storyboard, TimedScript } from "@opumia/contracts";

export interface CraftReport { at: string; lengthS: number; scores: CraftScore[]; floors: Partial<Record<Craft, number | null>>; inBand: Partial<Record<Craft, boolean>>; usd: number }

const asBand = (craft: Craft, lengthS: number, bands: CraftBandFile["bands"]): CraftBandFile => ({ craft, channel: "", lengthS, stretches: 0, films: [], bands, builtAt: "" });
const edlText = (shots: Array<{ t0: number; t1: number; picture: string; overlay: string; line: string; cutInPause?: boolean }>, hits: Array<{ t: number }>) =>
  shots.slice(0, 40).map((s) => `${s.t0.toFixed(1)}–${s.t1.toFixed(1)} s (${(s.t1 - s.t0).toFixed(1)} s) ${s.picture}${s.overlay !== "none" ? " +text" : ""}${s.cutInPause ? " [cut in a pause]" : ""}${hits.some((h) => h.t >= s.t0 && h.t < s.t1) ? " [hit]" : ""} — "${s.line.slice(0, 60)}"`).join("\n");

export async function craftReport(o: { root: string; data: string; reference: string; jobDir: string; channel: ChannelId; draft: ScriptDraft; timed: TimedScript; board: Storyboard; scenes: ScenePlan; resolution: ResolutionReport; judge?: boolean; pictureRealness?: number | null; log?: (s: string) => void }): Promise<CraftReport> {
  const L = o.board.durationS;
  const scores: CraftScore[] = [];
  const floors: CraftReport["floors"] = {};
  let usd = 0;
  const words = o.timed.segments.flatMap((sg) => sg.words);
  const plan = { channel: o.channel, storyboard: { shots: o.board.shots as never, durationS: L }, scenes: o.scenes.scenes as never, media: o.resolution.media as never, words: words as never };
  const reals = await referenceStretches({ data: o.data, channel: o.channel, lengthS: L, n: 4 });

  // ---- story
  const films = await ensureReferenceFilms({ reference: o.reference, data: o.data, channelId: o.channel }).catch(() => []);
  const sb = films.length ? await ensureSceneBand({ data: o.data, channelId: o.channel, films, lengthS: L }).catch(() => null) : null;
  if (sb) {
    const ban = await ensureFillerBan({ data: o.data, root: o.root, channelId: o.channel, films }).catch(() => null);
    const lines = o.draft.segments.flatMap((sg) => sg.text.split(/(?<=[.!?])\s+/)).filter(Boolean);
    const labels = await labelSceneLines(lines);
    const p = sceneProfile(lines, labels, ban, openingLineCount(lines, Math.round(Math.min(20, L / 4) * 3)));
    const band = asBand("story", sb.lengthS, { moment: { p10: sb.moment.p25, median: sb.moment.p50, p90: sb.moment.p90 }, agency: { p10: sb.agency.p25, median: sb.agency.p50, p90: sb.agency.p90 }, jumpsPer10: { p10: 0, median: sb.jumpsPer10.p50, p90: sb.jumpsPer10.p90 }, filler: { p10: 0, median: 0, p90: 0 } });
    const sc = scoreAgainst("story", { moment: p.moment, agency: p.agency, jumpsPer10: p.jumpsPer10, filler: p.filler.length }, band);
    if (o.judge && films[0]) {
      const wps = sb.wordsPerSecond;
      const want = Math.round(L * wps);
      const f = films[Math.abs(o.board.shots.length) % films.length]!;
      const realText: string[] = [];
      for (let i = 0, n = 0; i < f.lines.length && n < want; i++) (realText.push(f.lines[i]!), (n += f.lines[i]!.split(/\s+/).length));
      const j = await judgeCraftPair({ channel: o.channel, craft: "story", ours: { text: lines.join(" ") }, real: { text: realText.join(" ") }, seed: `${o.jobDir}|story` }).catch(() => null);
      if (j) (usd += j.usd, (sc.judge = { realness: j.realness, tells: j.tells }));
    }
    scores.push(sc);
  }

  // ---- edit, look, picture, sound: one stretch of our plan against real stretches of this length
  const ours = stretchOfPlan(plan);
  // look: the colourist's own measure (the same function on the channel's real frames and our final previews)
  {
    const cb = await colourBand(o.data, o.channel).catch(() => null);
    const col = await readFile(path.join(o.jobDir, "colour.json"), "utf8").then((t) => JSON.parse(t) as { after?: { luma: number; colourfulness: number; tintedShare: number } }, () => null);
    if (cb && col?.after) scores.push(scoreAgainst("look", col.after, asBand("look", L, { luma: { p10: cb.luma.p25, median: (cb.luma.p25 + cb.luma.p75) / 2, p90: cb.luma.p75 }, colourfulness: { p10: cb.colourfulness.p25, median: (cb.colourfulness.p25 + cb.colourfulness.p75) / 2, p90: cb.colourfulness.p75 }, tintedShare: { p10: 0, median: cb.tintedShare.median, p90: Math.max(0.12, cb.tintedShare.median * 1.5) } })));
  }
  for (const craft of ["edit", "picture"] as const) {
    const band = await craftBand({ data: o.data, channel: o.channel, craft, lengthS: L }).catch(() => null);
    if (!band) continue;
    const m = await CRAFT_MEASURES[craft]!(ours as never);
    const sc = scoreAgainst(craft, m, band);
    if (craft === "picture" && o.pictureRealness !== undefined && o.pictureRealness !== null) sc.judge = { realness: o.pictureRealness, tells: [] };
    if (craft === "edit" && o.judge && reals[0]) {
      const j = await judgeCraftPair({ channel: o.channel, craft: "edit", ours: { text: edlText(ours.shots, ours.hits) }, real: { text: edlText(reals[0].shots, reals[0].hits) }, seed: `${o.jobDir}|edit` }).catch(() => null);
      if (j) (usd += j.usd, (sc.judge = { realness: j.realness, tells: j.tells }));
    }
    scores.push(sc);
    floors[craft] = await realScoreFloor({ data: o.data, channel: o.channel, craft, lengthS: L }).catch(() => null);
  }
  {
    const band = await craftBand({ data: o.data, channel: o.channel, craft: "sound", lengthS: L }).catch(() => null);
    if (band) {
      const st = ourSoundStretch({ storyboard: { shots: o.board.shots, durationS: L }, music: o.board.music, scenes: o.scenes, resolution: o.resolution, words });
      const sc = scoreAgainst("sound", await CRAFT_MEASURES.sound!(st), band);
      if (o.judge && reals[1]) {
        const desc = (s: typeof st) => `${s.hits.length} strong hits at ${s.hits.map((h) => h.t.toFixed(1)).join(", ")} s; music cue changes at ${s.shots.filter((x) => x.cueChange).map((x) => x.t0.toFixed(1)).join(", ") || "none"}; drop-outs at ${s.shots.filter((x) => x.musicDrop).map((x) => x.t0.toFixed(1)).join(", ") || "none"}; cuts at ${s.shots.map((x) => x.t0.toFixed(1)).join(", ")}`;
        const j = await judgeCraftPair({ channel: o.channel, craft: "sound", ours: { text: desc(st) }, real: { text: desc(reals[1] as typeof st) }, seed: `${o.jobDir}|sound` }).catch(() => null);
        if (j) (usd += j.usd, (sc.judge = { realness: j.realness, tells: j.tells }));
      }
      scores.push(sc);
      floors.sound = await realScoreFloor({ data: o.data, channel: o.channel, craft: "sound", lengthS: L }).catch(() => null);
    }
  }

  // ---- voice: human delivery (the voice director's own measures)
  const nr = await readFile(path.join(o.jobDir, "narration.report.json"), "utf8").then((t) => JSON.parse(t) as { delivery?: { measures?: Record<string, number> } }, () => null);
  if (nr?.delivery?.measures) scores.push(scoreAgainst("voice", nr.delivery.measures, asBand("voice", L, VOICE_DELIVERY_BAND)));

  // ---- packaging (after the package exists)
  const pub = await readFile(path.join(o.jobDir, "publish.json"), "utf8").then((t) => JSON.parse(t) as { craft?: Record<string, number> | null }, () => null);
  if (pub?.craft) {
    const prof = await readFile(path.join(o.data, "thumbnail-profile", `${o.channel}.json`), "utf8").then((t) => JSON.parse(t) as { items?: Array<{ words?: number | string[] }> }, () => null);
    const titles = await readFile(path.join(o.data, "thumbnail-profile", `${o.channel}-titles.json`), "utf8").then((t) => JSON.parse(t), () => null);
    const tw = (prof?.items ?? []).map((x) => (Array.isArray(x.words) ? x.words.length : Number(x.words ?? 0)));
    if (tw.length) scores.push(scoreAgainst("packaging", pub.craft, asBand("packaging", L, packagingReferenceMeasures(tw, titles))));
  }

  const inBand: CraftReport["inBand"] = {};
  for (const s of scores) {
    const f = floors[s.craft];
    inBand[s.craft] = f === undefined || f === null ? s.outside.length === 0 || s.score >= 75 : s.score >= f;
  }
  const rep: CraftReport = { at: new Date().toISOString(), lengthS: Math.round(L), scores, floors, inBand, usd: Math.round(usd * 1000) / 1000 };
  await writeFile(path.join(o.jobDir, "craft.json"), JSON.stringify(rep, null, 2) + "\n");
  await craftHistory({ data: o.data, channel: o.channel, job: path.basename(o.jobDir), scores }).catch(() => {});
  o.log?.(`  craft scores at ${Math.round(L)} s: ${scores.map((s) => `${s.craft} ${s.score}${floors[s.craft] != null ? `/${floors[s.craft]}` : ""}${s.judge ? ` (judge ${s.judge.realness})` : ""}${inBand[s.craft] ? "" : " ✗"}`).join(", ")}`);
  return rep;
}
