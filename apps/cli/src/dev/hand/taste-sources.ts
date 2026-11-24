// What does the picture-taste head mark down: our design, or the raw pictures under it? Score raw source clips
// (stock, press) at 3 moments each, and a held-out real channel film, with the same head.
//   npx tsx apps/cli/src/dev/hand/taste-sources.ts label=file …
import path from "node:path";
import { scoreTaste } from "@opumia/agents";
const root = process.cwd();
for (const a of process.argv.slice(2)) {
  const [label, file] = a.split("=") as [string, string];
  const s = await scoreTaste({ root, data: path.join(root, "data"), channel: "magnates-media", kind: "shot", items: [0.5, 1.5, 2.5].map((t) => ({ file, t })) });
  console.log(`${label}: score ${s.map((x) => x?.score).join(" ")} | pro ${s.map((x) => x?.pro).join(" ")} | channel ${s.map((x) => x?.channel).join(" ")}`);
}
