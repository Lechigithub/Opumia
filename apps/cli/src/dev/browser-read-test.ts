// The browser reader must always come back (proof film 2, 2026-11-26: research died silently mid-run — a browser call
// that never settles leaves Node with nothing to wait on, and it exits 0 without a word).
//   npx tsx apps/cli/src/dev/browser-read-test.ts [url …]
import { pageTextViaBrowser, screenshotPage, closeBrowser } from "@opumia/resolver";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let settled = false;
process.on("beforeExit", () => { if (!settled) { console.log("FAIL the reader never came back (the process ran out of work while waiting)"); process.exitCode = 1; } });
const urls = process.argv.slice(2).length ? process.argv.slice(2) : ["https://techcrunch.com/2017/09/01/rip-juicero/", "https://www.bloomberg.com/news/features/2017-04-19/silicon-valley-s-400-juicer-may-be-feeling-the-squeeze", "https://en.wikipedia.org/wiki/Juicero"];
const dir = mkdtempSync(path.join(tmpdir(), "browser-read-"));
const t0 = Date.now();
for (const [i, u] of urls.entries()) {
  const s = Date.now();
  const text = await pageTextViaBrowser(u);
  console.log(`read ${((Date.now() - s) / 1000).toFixed(1)} s — ${text ? `${text.length} chars` : "null"} — ${u}`);
  const ok = await screenshotPage(u, path.join(dir, `p${i}.jpg`));
  console.log(`  screenshot ${ok ? "ok" : "failed"}`);
}
await closeBrowser();
settled = true;
console.log(`PASS the reader came back every time (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
