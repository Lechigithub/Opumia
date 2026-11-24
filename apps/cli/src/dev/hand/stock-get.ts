// Hand-made film: download the stock candidates chosen by eye (keys from stock-look's candidates.json).
//   npx tsx apps/cli/src/dev/hand/stock-get.ts out/hand-ftx pexels_123 …
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { downloadCandidate, type StockCandidate } from "@opumia/resolver";
import { loadKeys } from "../../keys.js";

loadKeys(process.cwd());
const [jobArg, ...keys] = process.argv.slice(2);
const job = path.resolve(jobArg!);
const cat: Record<string, StockCandidate> = JSON.parse(await readFile(path.join(job, "downloads", "stock-look", "candidates.json"), "utf8"));
const dir = path.join(job, "downloads", "stock");
await mkdir(dir, { recursive: true });
const pickedFile = path.join(job, "downloads", "stock.json");
const picked: Record<string, unknown> = existsSync(pickedFile) ? JSON.parse(await readFile(pickedFile, "utf8")) : {};
for (const k of keys) {
  const c = cat[k];
  if (!c) { console.log(`unknown ${k}`); continue; }
  const f = await downloadCandidate(c, dir);
  picked[k] = { file: path.relative(job, f), title: c.title, provider: c.provider, page: c.pageUrl, licence: c.license, credit: c.attributionText, durationS: c.durationS };
  console.log(`${k} → ${path.basename(f)}`);
}
await writeFile(pickedFile, JSON.stringify(picked, null, 2));
