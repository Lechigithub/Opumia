// Craft inventory: the point tracker on a real clip (no model). npx tsx apps/cli/src/dev/track-test.ts <clip>
import { trackPoint } from "@opumia/senses";
const p = await trackPoint(process.argv[2]!, { ss: 0, t: 3, x: Number(process.argv[3] ?? 0.5), y: Number(process.argv[4] ?? 0.5) });
console.log(p.length, "samples:", p.filter((_, i) => i % 4 === 0).map((q) => `${q.t}s(${q.x},${q.y})`).join(" "));
