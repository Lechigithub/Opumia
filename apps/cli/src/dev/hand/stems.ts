// The film's own stems (voice; everything else) from its manifest, for listening to the bed alone.
//   npx tsx apps/cli/src/dev/hand/stems.ts out/hand-ftx [outDir]
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RenderManifest } from "@opumia/contracts";
import { premixStems } from "@opumia/motion-engine";
const job = path.resolve(process.argv[2] ?? "out/hand-ftx"), out = path.resolve(process.argv[3] ?? path.join(job, "ears-now"));
await mkdir(out, { recursive: true });
console.log(await premixStems(RenderManifest.parse(JSON.parse(await readFile(path.join(job, "manifest.json"), "utf8"))), out));
