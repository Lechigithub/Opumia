// Hand-made film: named Commons files, downloaded with their licence and author (one request at a time, polite).
//   npx tsx apps/cli/src/dev/hand/fetch-commons.ts out/hand-ftx
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const dl = path.join(job, "downloads", "commons");
await mkdir(dl, { recursive: true });
const FILES = [
  "File:MIT Bitcoin Expo 2022 - Sam Bankman.png", "File:Sam Bankman-Fried.png", "File:Sam Bankman-Fried (cropped).png",
  "File:Changpeng Zhao (2018).jpg", "File:Changpeng Zhao in 2022.jpg", "File:CZ at Vietnam NFT Summit.jpg",
  "File:Logo of Enron Corporation (1997).svg", "File:Enron Code of Ethics cover.jpg",
  "File:FTX logo.svg", "File:Alameda Research logo.svg", "File:FTX Arena Downtown Miami - But not for long - 11 November 2022.jpg",
  "File:Lewis A. Kaplan.jpg", "File:Moynihan-courthouse.jpg", "File:Daniel Patrick Moynihan United States Courthouse (55314001073).jpg",
  "File:Moynihan US courthouse from Madison St jeh.jpg",
];
const UA = { "user-agent": "OpumiaResearch/1.0 (documentary research; one request at a time)" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const metaFile = path.join(job, "downloads", "commons.json");
const meta: Record<string, unknown>[] = existsSync(metaFile) ? JSON.parse(await readFile(metaFile, "utf8")) : [];
const strip = (s?: string) => (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
for (const t of FILES) {
  if (meta.some((m) => m.title === t)) continue;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(2500 * (attempt + 1));
    const r = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(t)}&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=2400&format=json`, { headers: UA });
    const txt = await r.text();
    if (!txt.startsWith("{")) continue;
    const pg = Object.values((JSON.parse(txt) as { query: { pages: Record<string, { imageinfo?: Array<Record<string, any>> }> } }).query.pages)[0];
    const ii = pg?.imageinfo?.[0];
    if (!ii) break;
    const url: string = ii.mime === "image/svg+xml" || ii.width > 2400 ? ii.thumburl : ii.url;
    await sleep(1500);
    const img = await fetch(url, { headers: UA });
    if (!img.ok) continue;
    const ext = path.extname(new URL(url).pathname) || ".jpg";
    const file = path.join(dl, t.replace(/^File:/, "").replace(/[^A-Za-z0-9.]+/g, "_").replace(/\.[a-z]+$/i, "") + ext);
    await writeFile(file, Buffer.from(await img.arrayBuffer()));
    const md = ii.extmetadata ?? {};
    meta.push({ title: t, file: path.relative(job, file), licence: strip(md.LicenseShortName?.value), author: strip(md.Artist?.value), page: ii.descriptionurl, width: ii.width, height: ii.height });
    console.log(`${t}: ${strip(md.LicenseShortName?.value)} — ${strip(md.Artist?.value).slice(0, 60)}`);
    await writeFile(metaFile, JSON.stringify(meta, null, 2));
    break;
  }
}
