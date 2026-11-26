// Hand-made film vs our agent films vs the real channel, with local measures only (no model call):
// trained picture taste (SigLIP heads), the ears (voice humanness, mix), measured look.
//   npx tsx apps/cli/src/dev/hand/compare.ts label=file[@startS] …
import path from "node:path";
import { execFileSync } from "node:child_process";
import { scoreSoundTaste, scoreTaste } from "@opumia/agents";
import { measureLook } from "@opumia/senses";

const root = process.cwd();
const data = path.join(root, "data");
const dur = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
const med = (xs: number[]) => { const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
for (const arg of process.argv.slice(2)) {
  const [label, spec] = arg.split("=") as [string, string];
  const [file, startS] = spec.split("@") as [string, string?];
  const t0 = Number(startS ?? 0);
  const span = Math.min(80, dur(file) - t0 - 0.5);
  const ts = Array.from({ length: Math.floor(span / 2) }, (_, i) => t0 + 1 + i * 2);
  const taste = (await scoreTaste({ root, data, channel: "magnates-media", kind: "shot", items: ts.map((t) => ({ file, t })) })).map((x) => x?.score ?? NaN);
  const wins = Array.from({ length: Math.floor(span / 8) }, (_, i) => ({ file, t: t0 + i * 8, dur: 4 }));
  const voice = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: wins });
  const mix = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "mix", items: wins });
  const bed = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "bed", items: wins });
  const look = await measureLook(file, { ss: t0, t: span }).catch(() => null) as Record<string, unknown> | null;
  const tasteOk = taste.filter((x) => x >= 4.4).length;
  console.log(`${label}: taste median ${r(med(taste), 1)} (real 6.1, real p10 4.4, ours 4.9) — ${tasteOk}/${taste.length} frames ≥ real p10 | voice ${r(voice?.median ?? NaN)} (real ${voice?.realMedian}) | mix ${r(mix?.median ?? NaN)} (real ${mix?.realMedian}; voice-biased) | bed ${r(bed?.median ?? NaN)} (real p10 ${bed?.realP10}, median ${bed?.realMedian}) | look ${look ? JSON.stringify(Object.fromEntries(Object.entries(look).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, r(v as number)]))) : "-"}`);
}
