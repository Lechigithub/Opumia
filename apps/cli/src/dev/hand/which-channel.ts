// Which reference channel do a film's frames look like? Nearest 15 real shots (all five channels) per frame, voted.
//   npx tsx apps/cli/src/dev/hand/which-channel.ts <file> [startS] [n]
import path from "node:path";
import { embedPictures, loadReferenceIndex, nearest } from "@opumia/agents";
const root = process.cwd(), data = path.join(root, "data");
const [file, s0 = "0", n = "40"] = process.argv.slice(2) as [string, string?, string?];
const ix = (await loadReferenceIndex(data))!;
const vs = await embedPictures({ root, data, items: Array.from({ length: Number(n) }, (_, i) => ({ file, t: Number(s0) + 1 + i * 2 })) });
const votes: Record<string, number> = {}; const per: string[] = [];
for (const [k, v] of vs.entries()) {
  if (!v) continue;
  const nn = nearest(ix.shotVec, ix.shotOk, v, 15);
  const c: Record<string, number> = {};
  for (const x of nn) { const ch = ix.shots[x.i]!.channel; c[ch] = (c[ch] ?? 0) + 1; votes[ch] = (votes[ch] ?? 0) + 1; }
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0]!;
  per.push(`${Number(s0) + 1 + k * 2}s:${top[0].slice(0, 4)}`);
}
console.log(Object.entries(votes).sort((a, b) => b[1] - a[1]).map(([c, x]) => `${c} ${Math.round((100 * x) / Object.values(votes).reduce((a, b) => a + b, 0))}%`).join(" | "));
console.log(per.join(" "));
