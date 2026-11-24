// Hand-made film: screenshots of the cited source articles (real pages; overlays hidden by screenshotPage).
//   npx tsx apps/cli/src/dev/hand/shots-pages.ts out/hand-ftx name=url …
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { closeBrowser, screenshotPage } from "@opumia/resolver";

const [jobArg, ...pairs] = process.argv.slice(2);
const dir = path.join(path.resolve(jobArg!), "downloads", "pages");
await mkdir(dir, { recursive: true });
for (const p of pairs) {
  const i = p.indexOf("=");
  const ok = await screenshotPage(p.slice(i + 1), path.join(dir, `${p.slice(0, i)}.jpg`)).catch(() => false);
  console.log(`${p.slice(0, i)}: ${ok}`);
}
await closeBrowser();
