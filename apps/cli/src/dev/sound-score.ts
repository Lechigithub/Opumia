// The sound designer agent on a planned job: timeline sound → agent sound, measured against the channel, with
// listening. The job's plan files are not changed (audio stems for listening are written under out/<job>/audio).
// Output: out/<job>/sound.agent.json; history data/agents/sound/score-history.json.
//   npx tsx apps/cli/src/dev/sound-score.ts out/<job> [channel]
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildStylePack, isUsable, soundAgent, usageLedger } from "@opumia/agents";
import { LibraryIndex, ResolutionReport, ScenePlan, Storyboard, StyleProfile, TimedScript, type ChannelId } from "@opumia/contracts";
import { buildManifest, listen, listeningText, lookFromProfile, watchClip } from "@opumia/motion-engine";
import { resolveAudio } from "@opumia/resolver";
import { buildAudioProfile } from "../audio-profile.js";
import { cooldownRefs } from "../asset-usage.js";
import { loadKeys } from "../keys.js";

loadKeys(process.cwd());
const [job, channel = "magnates-media"] = process.argv.slice(2);
if (!job) throw new Error("usage: sound-score.ts out/<job> [channel]");
const jd = path.resolve(job);
const data = path.resolve("data");
const library = path.resolve("Library");
const rd = async (f: string) => JSON.parse(await readFile(path.join(jd, f), "utf8"));
const board = Storyboard.parse(await rd("storyboard.json"));
const scenes = ScenePlan.parse(await rd("scenes.json"));
const resolution = ResolutionReport.parse(await rd("resolution.json"));
const timed = TimedScript.parse(await rd("timed-script.json"));
const design = await rd("design.json");
const prof = StyleProfile.parse(JSON.parse(await readFile(`data/style-profiles/${channel}.json`, "utf8")));
const index = LibraryIndex.parse(JSON.parse(await readFile(path.join(data, "library-index.json"), "utf8")));
const pack = await buildStylePack(channel as ChannelId, { reference: path.resolve("Reference"), data });
const ap = await buildAudioProfile({ data, library, index });
const cool = await cooldownRefs(data, path.basename(jd));
const usable = index.assets.filter(isUsable);
const listenSound = async (st: { shots: Storyboard["shots"]; music: Storyboard["music"] }, fromS: number, toS: number) => {
  const sb = Storyboard.parse({ ...board, shots: st.shots, music: st.music });
  const res = await resolveAudio({ storyboard: sb, index, libraryRoot: library, jobDir: jd, resolution });
  const m = await buildManifest({ storyboard: sb, script: timed, resolution: res, libraryRoot: library, outputPath: path.join(jd, "_edit.mp4"), narrationPath: timed.voice.audioPath, scenes: new Map<string, unknown>(scenes.scenes.map((x) => [x.shotId, x])) });
  const c = await watchClip({ manifest: m, look: lookFromProfile(prof.look, design.palette?.primarySoft), design, publicDir: path.join(jd, "public"), jobDir: jd, fromS, toS });
  const l = await listen({ manifest: m, jobDir: jd, fromS, toS, cutsS: m.video.map((v) => v.startFrame / m.fps) });
  return { strip: c.strip, text: `${c.fromS.toFixed(1)}–${c.toS.toFixed(1)} s, frames: ${c.frames.join(", ")}\n${listeningText(l)}` };
};
const t0 = Date.now();
const res = await soundAgent({ storyboard: board, script: timed, scenes, sfxAssets: usable.filter((a) => a.category === "sfx" && a.kind === "audio"), musicAssets: usable.filter((a) => a.category === "music" && a.kind === "audio"), sfxProfile: ap.sfx, musicProfile: ap.music, profile: pack.profile, cooldown: { sfx: cool.sfx, music: cool.music }, seed: path.basename(jd), drops: board.music.flatMap((m) => m.drops ?? []), channel: channel as ChannelId, data, resolution, listen: listenSound, memoryDir: path.join(data, "agents", "sound"), log: console.log });
const row = { job: path.basename(jd), at: new Date().toISOString(), pass: res.report.pass, before: res.report.before.score, after: res.report.after.score, ops: res.report.ops.length, seconds: Math.round((Date.now() - t0) / 1000), usd: res.report.agent.usd, outside: res.report.after.rows.filter((r) => r.outside > 0).map((r) => r.key) };
await writeFile(path.join(jd, "sound.agent.json"), JSON.stringify({ ...res.report, shots: res.shots.map((s) => ({ id: s.id, sfx: s.sfx })), music: res.music }, null, 1) + "\n");
const hf = path.join(data, "agents", "sound", "score-history.json");
await mkdir(path.dirname(hf), { recursive: true });
const hist: unknown[] = await readFile(hf, "utf8").then((t) => JSON.parse(t), () => []);
hist.push(row);
await writeFile(`${hf}.tmp`, JSON.stringify(hist, null, 1) + "\n");
await rename(`${hf}.tmp`, hf);
console.log(JSON.stringify(row), `ledger $${usageLedger().reduce((t, r) => t + r.usd, 0).toFixed(3)}`);
