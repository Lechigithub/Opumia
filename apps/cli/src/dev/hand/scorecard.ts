// The style scorecard (build list 6): every local instrument on one film, against the channel's own band, in one table.
// No API. Each line: our value, the channel's band (p10–p90 over its films), and where we sit.
//   npx tsx apps/cli/src/dev/hand/scorecard.ts <job dir> <name> [timed-script.json] [--version-of a,b]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { embedAudio, loadSoundTaste, measureMotion, scoreSoundTaste } from "@opumia/agents";
import { embedPython } from "@opumia/ingest";
const root = process.cwd(), data = path.join(root, "data");
const argv = process.argv.slice(2); const pos = argv.filter((x, i) => !x.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--")));
const [jobArg, name, timedArg] = pos as [string, string, string?];
const job = path.resolve(jobArg); const film = path.join(job, "film_16x9.mp4");
const timed = timedArg ?? ["timed-script.json", "timed-script-marcus.json"].map((f) => path.join(job, f)).find(existsSync)!;
const vi = process.argv.indexOf("--version-of"); const versionOf = vi > 0 ? process.argv[vi + 1]! : "";
const rows: Array<[string, string, string, string]> = [];
const add = (k: string, v: number | null | undefined, lo: number, hi: number, note = "") => rows.push([k, v === null || v === undefined || !Number.isFinite(v) ? "-" : String(Math.round(v * 1000) / 1000), `${lo}–${hi}`, v === null || v === undefined || !Number.isFinite(v) ? "not measured" : v < lo ? `BELOW by ${Math.round((lo - v) * 1000) / 1000}` : v > hi ? `ABOVE by ${Math.round((v - hi) * 1000) / 1000}` : `in band${note}`]);
// 1. the ratchet's measures (look, grade, type, text, sound events, picture shares, taste, voice)
const rat = execFileSync("npx", ["tsx", "apps/cli/src/dev/hand/ratchet.ts", name, film, "--job", job], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n");
const m = JSON.parse(rat.find((l) => l.startsWith("{"))!) as Record<string, number>;
const bands = JSON.parse((rat.find((l) => l.startsWith("BANDS ")) ?? "BANDS {}").slice(6)) as Record<string, [number, number]>;
for (const [k, b] of Object.entries(bands)) if (k !== "voiceOverBed") add(k, m[k], b[0], b[1]);
add("taste (median)", m.taste, 4.4, 6.1, " (channel p10 4.4, median 6.1)");
// 2. motion across all 37 films (not one film's numbers)
const mb = JSON.parse(readFileSync(path.join(data, "quality-profile", "magnates-media-motion-band.json"), "utf8")) as { films: Record<string, Record<string, number>> };
const q = (k: string, p: number) => { const v = Object.values(mb.films).map((f) => f[k]!).sort((a, b) => a - b); return Math.round(v[Math.round(p * (v.length - 1))]! * 100) / 100; };
const mo = await measureMotion(film, { len: 70 });
for (const k of ["motionMed", "moving", "softShare", "cutsPerMin"] as const) add(`motion: ${k}`, (mo as unknown as Record<string, number>)[k], q(k, 0.1), q(k, 0.9));
// 3. the world check (line fit with words masked; nothing of ours too close)
const wj = JSON.parse(execFileSync(embedPython(), ["-I", "tools/world/world_check.py", name, film, timed, "--json", "--no-save", ...(versionOf ? ["--version-of", versionOf] : [])], { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as { lineFit: { mean: number; band: { p10: number; p90: number } }; tooClose: Array<{ film: string }> };
add("line fit (words masked)", wj.lineFit.mean, wj.lineFit.band.p10, wj.lineFit.band.p90);
rows.push(["too close to an earlier film of ours", String(wj.tooClose.length), "0", wj.tooClose.length ? `TOO CLOSE: ${wj.tooClose.map((x) => x.film).join(", ")}` : "none"]);
// 4. sound: voice over bed and the bed's swell (demucs, like the channel's), the music itself (clean stem), the voice
const sg = execFileSync(embedPython(), ["-I", "apps/cli/src/dev/hand/stem-gap.py", film, "65"], { encoding: "utf8" }).trim().split("\n").at(-1)!;
const [ob, sw] = [...sg.matchAll(/([\d.]+) dB/g)].map((x) => Number(x[1]));
add("voice over bed (dB)", ob ?? null, 8.9, 21.7, " (channel median 15.8)"); add("bed swell between lines (dB)", sw ?? null, 1.6, 13.5, " (channel median 6.7)");
const st = mkdtempSync(path.join(tmpdir(), "sc-"));
execFileSync("npx", ["tsx", "apps/cli/src/dev/hand/stems.ts", job, st], { stdio: "ignore" });
const bh = await loadSoundTaste(data, "magnates-media", "bed");
if (bh && existsSync(path.join(st, "stem-bed.wav"))) {
  const items = Array.from({ length: 12 }, (_, i) => ({ file: path.join(st, "stem-bed.wav"), t: 1 + i * 5, dur: 6 }));
  const v = await embedAudio({ root, data, items });
  const s = v.filter(Boolean).map((x) => 1 / (1 + Math.exp(-bh.w.reduce((a, w, d) => a + w * x![d]!, bh.b)))).sort((a, b) => a - b);
  add("music and effects (bed head, clean stem)", s[Math.floor(s.length / 2)] ?? null, bh.calibration.real.p10, 1, ` (channel median ${bh.calibration.real.median})`);
}
const vo = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: Array.from({ length: 10 }, (_, i) => ({ file: film, t: 2 + i * 6, dur: 4 })) });
if (vo) add("voice humanness", vo.median, vo.realP10, 1, ` (real median ${vo.realMedian})`);
// the table
const w: [number, number, number] = [Math.max(...rows.map((r) => r[0].length)), Math.max(...rows.map((r) => r[1].length)), Math.max(...rows.map((r) => r[2].length))];
console.log(`\nSTYLE SCORECARD — ${name} (the channel's bands, p10–p90 over its own films)\n`);
for (const r of rows) console.log(`${r[0].padEnd(w[0])}  ${r[1].padStart(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}`);
const out = rows.filter((r) => /BELOW|ABOVE|TOO CLOSE/.test(r[3]));
console.log(`\n${rows.length - out.length} of ${rows.length} inside the channel's band; outside: ${out.map((r) => r[0]).join(", ") || "none"}`);
