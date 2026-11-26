// The voice-blind bed head (build list 6, G3), no API, on real artefacts: our synthetic narrator over Ponzi's bed may cost
// at most 0.10 (the head must not hear the voice), and a bed known to sound unlike the channel ("Lightless Dawn", 0.33
// alone) under Ponzi's own voice must cost at least 0.2 (it must hear the music). The old "mix" head moved about the
// same for both (−0.15 / −0.13): it was scoring our synthetic narrator and rewarded a bed loud enough to hide him.
import { existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { embedPython } from "@opumia/ingest";
import { scoreSoundTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const ponzi = execFileSync("sh", ["-c", "ls Reference/MagnatesMedia/20221214*/*.mp4 | head -1"]).toString().trim();
const ours = path.join(root, "out", "hand-wirecard-v4", "film_16x9.mp4");
if (!ponzi || !existsSync(ours)) { console.log("artefacts missing: skipped"); process.exit(0); }
const d = mkdtempSync(path.join(tmpdir(), "bedhead-"));
for (const [n, f] of [["p", ponzi], ["o", ours]] as const) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "2", "-t", "30", "-i", f, "-ac", "2", "-ar", "44100", path.join(d, `${n}.wav`)]);
}
execFileSync(embedPython(), ["-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs", "--shifts", "0", "--overlap", "0.1", "-o", d, path.join(d, "p.wav"), path.join(d, "o.wav")], { stdio: "ignore" });
const st = (n: string, s: string) => path.join(d, "htdemucs", n, `${s}.wav`);
const mix = (v: string, b: string, out: string) => execFileSync("ffmpeg", ["-v", "error", "-y", "-i", v, "-i", b, "-filter_complex", "amix=inputs=2:normalize=0,alimiter=limit=0.9", path.join(d, out)]);
const bad = path.join(d, "bad.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "40", "-t", "30", "-i", path.join(root, "Library", "music", "free_incompetech_lightless_dawn.mp3"), "-ac", "2", "-ar", "44100", "-af", "volume=-14dB", bad]);
mix(st("p", "vocals"), st("p", "no_vocals"), "pp.wav"); mix(st("o", "vocals"), st("p", "no_vocals"), "op.wav"); mix(st("p", "vocals"), bad, "po.wav");
const sc = async (f: string) => (await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "bed", items: [0, 7, 14, 21].map((t) => ({ file: path.join(d, f), t, dur: 8 })) }))!.median;
const [pp, op, po] = [await sc("pp.wav"), await sc("op.wav"), await sc("po.wav")];
const voiceEffect = pp - op, bedEffect = pp - po;
console.log(`Ponzi ${pp.toFixed(2)} | our voice over Ponzi's bed ${op.toFixed(2)} (−${voiceEffect.toFixed(2)}) | Ponzi's voice over a known-bad bed ${po.toFixed(2)} (−${bedEffect.toFixed(2)})`);
if (voiceEffect > 0.1) { console.error("the bed head is listening to the voice again"); process.exit(1); }
if (bedEffect < 0.2) { console.error("the bed head no longer hears the music"); process.exit(1); }
