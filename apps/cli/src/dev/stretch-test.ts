// Stretch re-render (build list 3, item 17) on the offline smoke film: one shot's scene changes, only its frames are
// rendered again and spliced in. Checks: same frame count, frames outside the stretch unchanged, inside changed.
//   npx tsx apps/cli/src/dev/smoke.ts && npx tsx apps/cli/src/dev/stretch-test.ts
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { RenderManifest } from "@opumia/contracts";
import { lookFromProfile, renderStretches } from "@opumia/motion-engine";
import { run } from "@opumia/senses";

const job = path.join(process.cwd(), "out", "_smoke");
const m = RenderManifest.parse(JSON.parse(readFileSync(path.join(job, "manifest.json"), "utf8")));
const layer = m.video.find((l) => l.shotId === "sh006" && l.ref === "scene")!;
const spec = (layer.props as { spec: { elements: Array<{ type: string; props?: Record<string, unknown> }> } }).spec;
for (const e of spec.elements) if (e.type === "component" && e.props?.text === "a bet") e.props.text = "the wager";
const prev = path.join(job, "video_silent.mp4");
const out = path.join(job, "video_spliced.mp4");
copyFileSync(prev, out);
const profile = JSON.parse(readFileSync("data/style-profiles/magnates-media.json", "utf8"));
await renderStretches({ manifest: m, look: lookFromProfile(profile.look), publicDir: path.join(job, "public"), previous: prev, out, ranges: [[layer.startFrame, layer.endFrame - 1]], log: console.log });
const frames = async (f: string) => Number((await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", f])).stdout.toString().trim());
const psnr = async (fr: number) => {
  const r = await run("ffmpeg", ["-hide_banner", "-i", prev, "-i", out, "-filter_complex", `[0:v]select=eq(n\\,${fr})[a];[1:v]select=eq(n\\,${fr})[b];[a][b]psnr`, "-frames:v", "1", "-f", "null", "-"]).catch((e: { stderr?: Buffer }) => ({ stderr: e.stderr ?? Buffer.from("") }));
  const t = (r as { stderr?: Buffer | string }).stderr?.toString() ?? "";
  return Number(/average:([\d.inf]+)/.exec(t)?.[1]?.replace("inf", "99") ?? "0");
};
const [n0, n1] = [await frames(prev), await frames(out)];
const before = await psnr(Math.max(0, layer.startFrame - 30)), inside = await psnr(layer.startFrame + 40), after = await psnr(Math.min(m.durationFrames - 1, layer.endFrame + 30));
const fails = [n0 !== n1 ? `frame count ${n0} → ${n1}` : "", before < 35 ? `frame before the stretch changed (psnr ${before})` : "", after < 35 ? `frame after the stretch changed (psnr ${after})` : "", inside >= 45 ? `frame inside the stretch did not change (psnr ${inside})` : ""].filter(Boolean);
console.log(`frames ${n0} → ${n1}; psnr before ${before}, inside ${inside}, after ${after}`);
console.log(fails.length ? `FAIL\n${fails.join("\n")}` : "PASS stretch re-render");
process.exit(fails.length ? 1 : 0);
