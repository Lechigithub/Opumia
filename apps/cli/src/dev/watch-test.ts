// Watch and listen to a stretch of a planned film (no full render).
//   npx tsx apps/cli/src/dev/watch-test.ts out/<job> <fromS> <toS>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadChannelProfile } from "@opumia/agents";
import { RenderManifest, StyleProfile } from "@opumia/contracts";
import { listen, listeningText, lookFromProfile, watchClip } from "@opumia/motion-engine";
const [job, a = "0", b = "10"] = process.argv.slice(2);
if (!job) throw new Error("usage: watch-test.ts out/<job> from to");
const jd = path.resolve(job);
const m = RenderManifest.parse(JSON.parse(await readFile(path.join(jd, "manifest.json"), "utf8")));
const design = JSON.parse(await readFile(path.join(jd, "design.json"), "utf8"));
const prof = StyleProfile.parse(JSON.parse(await readFile("data/style-profiles/magnates-media.json", "utf8")));
const t0 = Date.now();
const clip = await watchClip({ manifest: m, look: lookFromProfile(prof.look, design.palette?.primarySoft), design, publicDir: path.join(jd, "public"), jobDir: jd, fromS: Number(a), toS: Number(b), log: console.log });
console.log("clip", path.relative(process.cwd(), clip.file), "strip", path.relative(process.cwd(), clip.strip), clip.motion, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
const cp = await loadChannelProfile(path.resolve("data"), "magnates-media");
const cuts = m.video.map((l) => l.startFrame / m.fps);
const l = await listen({ manifest: m, jobDir: jd, fromS: Number(a), toS: Number(b), cutsS: [...new Set(cuts)], reference: { ...(cp ? { hitsPerMin: cp.band.hitsPerMin! } : {}), voiceOverBedDb: { p10: 16.5, median: 18.1, p90: 20.6 } } });
console.log(listeningText(l), `\n${((Date.now() - t0) / 1000).toFixed(0)} s total`);
