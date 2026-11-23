// Build list 5, items 22, 26, 27 — offline, no model calls, on an existing job folder:
//  - the shared cut timeline (cuts, stressed words from voice-direction.json, story turns, pauses);
//  - music follows the story: cue changes on the writer's turns at the channel's rate for this length, a drop-out
//    before the biggest turn, a riser into the climax;
//  - fresh effects: nothing a recent film used, nothing twice; strong hits on cuts in the channel's proportion;
//  - our sound measured with the same craft function as real stretches of the same length.
//   npx tsx apps/cli/src/dev/sound-story-test.ts [out/<job>]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LibraryIndex, ScenePlan, Storyboard, TimedScript, ResolutionReport } from "@opumia/contracts";
import { buildCutTimeline, buildStylePack, craftBand, CRAFT_MEASURES, designSoundTimeline, emphasisOf, isUsable, musicRatesFor, ourSoundStretch, scoreAgainst, sfxFamilies, storyMusicPlan } from "@opumia/agents";
import { loadAudioProfile } from "../audio-profile.js";
import { cooldownRefs } from "../asset-usage.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const DATA = path.join(ROOT, "data");

export async function soundStoryTest(jobArg?: string): Promise<string[]> {
  const fails: string[] = [];
  const jobDir = path.resolve(ROOT, jobArg ?? "out/bl4c-nokia");
  const j = async (f: string) => JSON.parse(await readFile(path.join(jobDir, f), "utf8"));
  const board = Storyboard.parse(await j("storyboard.json"));
  const script = TimedScript.parse(await j("timed-script.json"));
  const scenes = ScenePlan.parse(await j("scenes.json"));
  const resolution = ResolutionReport.parse(await j("resolution.json"));
  const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(DATA, "library-index.json"), "utf8")));
  const ap = await loadAudioProfile(DATA);
  const usable = index.assets.filter(isUsable);
  const cool = await cooldownRefs(DATA, path.basename(jobDir));
  const channel = "magnates-media" as const;
  const fam = await sfxFamilies(DATA);
  const words = script.segments.flatMap((s) => s.words);

  // 22: the shared timeline
  const tl = buildCutTimeline({ storyboard: board, script, emphasis: await emphasisOf(jobDir) });
  if (!tl.cuts.length) fails.push("the timeline has no cuts");
  if (!tl.turns.length) fails.push("the timeline found no story turns in the writer's roles");
  console.log(`timeline: ${tl.cuts.length} cuts, ${tl.stressed.length} stressed words, ${tl.turns.length} turns (${tl.turns.map((t) => `${t.role}@${t.atS.toFixed(1)}`).join(", ")}), ${tl.pauses.length} pauses`);

  // the channel's music-to-story rates at this length
  const rates = await musicRatesFor(DATA, channel, script.durationS);
  if (!rates) fails.push("no sound craft band at this length");
  console.log(`channel at ${Math.round(script.durationS)} s: ${rates?.cueChangesPerMin} cue changes/min, ${rates?.musicDropsPerMin} drops/min, ${rates?.hitOnCutShare} hits on cuts`);

  // before: the film as it was made
  const band = await craftBand({ data: DATA, channel, craft: "sound", lengthS: script.durationS });
  const measure = CRAFT_MEASURES.sound!;
  const before = ourSoundStretch({ storyboard: board, music: board.music, scenes, resolution, words, sfxFamily: fam });
  const sb = band ? scoreAgainst("sound", await measure(before), band) : null;
  const recentBefore = (() => { const ids = [...new Set(board.shots.flatMap((s) => s.sfx.map((x) => x.assetId)))]; return ids.filter((x) => cool.sfx.has(x)).length / Math.max(1, ids.length); })();
  console.log(`BEFORE: sound craft ${sb?.score}/100, ${board.music.length} cue(s), ${board.music.reduce((n, m) => n + (m.drops?.length ?? 0), 0)} drop(s), recent-film effects ${Math.round(recentBefore * 100)} %; outside: ${sb?.outside.map((x) => `${x.key} ${x.ours} (${x.band.p10}–${x.band.p90})`).join(", ")}`);

  // after: the story-led timeline
  const out = designSoundTimeline({ storyboard: board, script, scenes, sfxAssets: usable.filter((a) => a.category === "sfx" && a.kind === "audio"), musicAssets: usable.filter((a) => a.category === "music" && a.kind === "audio"), sfxProfile: ap.sfx as never, musicProfile: ap.music as never, profile: (await buildStylePack(channel, { reference: path.join(ROOT, "Reference"), data: DATA })).profile, cooldown: { sfx: cool.sfx, music: cool.music }, seed: `${path.basename(jobDir)}-test`, timeline: tl, ...(rates ? { musicRates: rates } : {}), log: console.log });
  const after = ourSoundStretch({ storyboard: { shots: out.shots, durationS: board.durationS }, music: out.music, scenes, resolution, words, sfxFamily: fam });
  const sa = band ? scoreAgainst("sound", await measure(after), band) : null;
  const ids = out.shots.flatMap((s) => s.sfx.map((x) => x.assetId));
  const recent = [...new Set(ids)].filter((x) => cool.sfx.has(x)).length;
  console.log(`AFTER: sound craft ${sa?.score}/100, cues ${out.music.map((m) => `${m.startS.toFixed(1)}–${m.endS.toFixed(1)} ${m.mood}`).join(" | ")}, drops ${out.music.flatMap((m) => m.drops ?? []).map((d) => `${d.startS}–${d.endS}`).join(", ")}; ${JSON.stringify({ onCut: out.report.onCut, onStress: out.report.onStress, skipped: out.report.skippedNoFreshFile, riserIntoClimax: out.report.riserIntoClimax })}; outside: ${sa?.outside.map((x) => `${x.key} ${x.ours} (${x.band.p10}–${x.band.p90})`).join(", ") || "none"}`);

  // 27: fresh effects
  if (recent) fails.push(`${recent} effect(s) a recent film used`);
  if (ids.length !== new Set(ids).size) fails.push("an effect is used twice in the film");
  // 26: music follows the story
  if (rates && script.durationS >= 45 && out.music.length < 2) fails.push("music never changes cue at a story turn");
  for (const m of out.music.slice(1)) if (!tl.turns.some((t) => Math.abs(t.atS - m.startS) < 0.01)) fails.push(`cue change at ${m.startS} is not on a writer-marked turn`);
  if (script.durationS >= 30 && !out.music.some((m) => (m.drops?.length ?? 0) > 0)) fails.push("no drop-out (silence as punctuation)");
  if (!out.report.riserIntoClimax) fails.push("no riser into the climax");
  if (rates && out.report.onCut + 0.01 < Math.min(rates.hitOnCutShare, 0.2)) fails.push(`strong hits on cuts ${out.report.onCut} below the channel's ${rates.hitOnCutShare}`);
  if (sb && sa && sa.score < sb.score) fails.push(`sound craft score fell ${sb.score} → ${sa.score}`);

  // length-awareness: a 10-minute script with chapters gets more cues and drops than a 45 s one
  const fake = (durS: number) => ({ ...script, durationS: durS, segments: script.segments.map((sg, i, a) => ({ ...sg, startS: (durS * i) / a.length, endS: (durS * (i + 1)) / a.length })) });
  const short = storyMusicPlan(fake(45) as never, buildCutTimeline({ storyboard: board, script: fake(45) as never }), rates ?? undefined);
  const long = storyMusicPlan(fake(600) as never, buildCutTimeline({ storyboard: board, script: fake(600) as never }), rates ?? undefined);
  console.log(`length: 45 s → ${short.spans.length} cue(s), ${short.drops.length} drop(s); 600 s → ${long.spans.length} cue(s), ${long.drops.length} drop(s)`);
  if (long.spans.length < short.spans.length) fails.push("a longer film must not get fewer cues");
  return fails;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await soundStoryTest(process.argv[2]);
  console.log(f.length ? `FAIL\n${f.join("\n")}` : "PASS sound follows the story");
  process.exit(f.length ? 1 : 0);
}
