// Hand-made film: cut the subjects out of real photos and frames (BiRefNet, local; keeps only source pixels).
//   npx tsx apps/cli/src/dev/hand/cutouts.ts out/hand-ftx
import { readdir } from "node:fs/promises";
import path from "node:path";
import { removeBackground } from "@opumia/senses";

const dir = path.join(path.resolve(process.argv[2]!), "downloads", "cut");
for (const f of (await readdir(dir)).filter((f) => /_src\.(jpe?g|png)$/.test(f))) {
  const out = path.join(dir, f.replace(/_src\.(jpe?g|png)$/, ".png"));
  const r = await removeBackground(path.join(dir, f), out, path.join(process.cwd(), "data"));
  console.log(f, JSON.stringify(r).slice(0, 120));
}
