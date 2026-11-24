// Pixel quality of a clip across its length (every 1 s), to choose moments above the channel's frame floor.
//   npx tsx apps/cli/src/dev/hand/clip-scan.ts <clip.mp4> …
import { execFileSync } from "node:child_process";
import { measureCraft } from "@opumia/senses";
for (const f of process.argv.slice(2)) {
  const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
  const row: string[] = [];
  for (let t = 0.5; t < d - 0.3; t += 1) { const c = await measureCraft(f, t); row.push(`${t.toFixed(1)}:${Math.round(c.sharpTop)}/${Math.round(c.contrast)}`); }
  console.log(f.split("/").pop(), row.join(" "));
}
