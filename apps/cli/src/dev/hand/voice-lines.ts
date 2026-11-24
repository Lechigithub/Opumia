// The voice score per narration line, in the finished film (windows of 2 s inside each line, 4 offsets).
//   npx tsx apps/cli/src/dev/hand/voice-lines.ts <film.mp4> <timed-script.json>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreSoundTaste } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const [film, ts] = process.argv.slice(2) as [string, string];
const segs = (JSON.parse(await readFile(ts, "utf8")) as { segments: Array<{ id: string; startS: number; endS: number; text: string }> }).segments;
for (const s of segs) {
  const wins: Array<{ file: string; t: number; dur: number }> = [];
  for (let t = s.startS; t + 3 <= s.endS + 0.01; t += 1) wins.push({ file: path.resolve(film), t, dur: 3 });
  if (!wins.length) wins.push({ file: path.resolve(film), t: s.startS, dur: Math.max(1.5, s.endS - s.startS) });
  const r = await scoreSoundTaste({ root, data, channel: "magnates-media", kind: "voice", items: wins });
  console.log(`${s.id} ${(r?.median ?? NaN).toFixed(2)}  ${s.text.slice(0, 80)}`);
}
