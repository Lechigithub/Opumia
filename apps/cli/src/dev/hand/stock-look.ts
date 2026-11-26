// Hand-made film: search stock for each need and lay the candidates' preview pictures on one sheet per query, so a
// person (here: the session) can look and choose. No model call.
//   npx tsx apps/cli/src/dev/hand/stock-look.ts out/hand-ftx "query a" "query b" …
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { searchStock, thumbOf, type StockCandidate } from "@opumia/resolver";
import { loadKeys } from "../../keys.js";

const root = process.cwd();
loadKeys(root);
const [jobArg, ...queries] = process.argv.slice(2);
const job = path.resolve(jobArg ?? "out/hand-ftx");
const dir = path.join(job, "downloads", "stock-look");
await mkdir(dir, { recursive: true });
const catFile = path.join(dir, "candidates.json");
const blank = path.join(dir, "_blank.jpg");
if (!existsSync(blank)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180", "-frames:v", "1", blank]);
const cat: Record<string, StockCandidate> = existsSync(catFile) ? JSON.parse(await readFile(catFile, "utf8")) : {};
const kind = (process.env.KIND as "video" | "image") ?? "video";
for (const q of queries) {
  const cands = (await searchStock(q, { kind, orientation: "landscape", perPage: 12, providers: ["pexels", "pixabay"] })).filter((c) => (c.width ?? 0) >= 1280).slice(0, 16);
  const tiles: string[] = [];
  const order: string[] = [];
  for (const [i, c] of cands.entries()) {
    const key = `${c.provider}_${c.externalId}`;
    cat[key] = c;
    const f = path.join(dir, `${key}.jpg`);
    // a candidate whose preview fails keeps its place as a black tile, so sheet position = index (Wirecard v7: a skipped
    // tile shifted every later one and five clips were downloaded under the wrong need)
    if (existsSync(f) || (await thumbOf({ url: c.thumbUrl ?? c.fileUrl ?? undefined, video: false }, f).catch(() => false))) tiles.push(f);
    else tiles.push(blank);
    order.push(key);
    console.log(`${q} [${i}] ${key} ${c.width}x${c.height} ${c.durationS ?? ""}s ${c.title.slice(0, 60)}`);
  }
  if (tiles.length) {
    const sheet = path.join(dir, `sheet_${q.replace(/\W+/g, "_")}.jpg`);
    const n = tiles.length;
    await writeFile(sheet.replace(/\.jpg$/, ".json"), JSON.stringify({ query: q, order: order.map((k, i) => ({ i, key: k, row: Math.floor(i / 4), col: i % 4 })) }, null, 1));
    execFileSync("ffmpeg", ["-v", "error", "-y", ...tiles.flatMap((t) => ["-i", t]), "-filter_complex", `${tiles.map((_, i) => `[${i}]scale=320:180:force_original_aspect_ratio=increase,crop=320:180[t${i}]`).join(";")};${tiles.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${n}:layout=${tiles.map((_, i) => `${(i % 4) * 320}_${Math.floor(i / 4) * 180}`).join("|")}:fill=black`, "-frames:v", "1", sheet]);
  }
}
await writeFile(catFile, JSON.stringify(cat, null, 2));
