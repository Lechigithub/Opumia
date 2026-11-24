// Hand-made film: Wikipedia/Commons pictures of the film's subjects (no model call; I look at them myself).
//   npx tsx apps/cli/src/dev/hand/fetch-wiki.ts out/hand-ftx
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { wikipediaImages } from "@opumia/resolver";

const job = path.resolve(process.argv[2] ?? "out/hand-ftx");
const dl = path.join(job, "downloads", "wiki");
await mkdir(dl, { recursive: true });
const subjects = [
  { name: "Sam Bankman-Fried", type: "person" }, { name: "Changpeng Zhao", type: "person" }, { name: "John J. Ray III", type: "person" },
  { name: "Lewis Kaplan", type: "person" }, { name: "FTX (company)", type: "company" }, { name: "Binance", type: "company" },
  { name: "Enron", type: "company" }, { name: "Alameda Research", type: "company" }, { name: "Bankruptcy of FTX", type: "event" },
  { name: "Caroline Ellison", type: "person" },
];
const all = [];
for (const s of subjects) {
  const r = await wikipediaImages(s, dl, 8).catch(() => []);
  console.log(`${s.name}: ${r.length}`);
  for (const c of r) all.push({ subject: s.name, file: path.relative(job, c.localFile!), frame: path.relative(job, c.frameFile!), title: c.title, licence: c.license, credit: c.attributionText, url: c.pageUrl, fairUse: c.fairUse });
}
await writeFile(path.join(job, "downloads", "wiki.json"), JSON.stringify(all, null, 2));
