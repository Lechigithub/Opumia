// Local adapter test: real R2 + D1 semantics via wrangler's platform proxy (Miniflare), no Cloudflare account.
import { getPlatformProxy } from "wrangler";
import { AssetRecord, LibraryIndex } from "@opumia/contracts";
import { readFileSync } from "node:fs";
import { R2BlobStore } from "../src/r2.ts";
import { D1CatalogDb, JobsTable } from "../src/d1.ts";

const { env, dispose } = await getPlatformProxy<{ MEDIA: R2Bucket; DB: D1Database }>({ configPath: "wrangler.toml", persist: true });
const store = new R2BlobStore(env.MEDIA);
await store.put("data/hello.json", JSON.stringify({ hi: 1 }));
await store.put("data/nested/a.txt", "a");
const head = await store.head("data/hello.json");
const listed: string[] = [];
for await (const h of store.list("data/")) listed.push(h.key);
console.log("R2 head", head?.bytes, "text", await store.getText("data/hello.json"), "list", listed.sort());
const ro = new R2BlobStore(env.MEDIA, true);
await ro.put("x", "y").then(() => console.log("R2 read-only FAILED to block"), (e: Error) => console.log("R2 read-only blocks writes:", e.message));

const index = LibraryIndex.parse(JSON.parse(readFileSync("../../data/library-index.json", "utf8")));
const db = new D1CatalogDb(env.DB, "assets", AssetRecord);
const sample = index.assets.filter((a) => a.category === "sfx").slice(0, 120);
await db.upsertMany(sample);
await db.upsertMany(sample.slice(0, 5)); // idempotent upsert
const one = await db.get(sample[0]!.id);
const all = await db.all();
const where = await db.where("$.category", "sfx");
console.log("D1 upsert", sample.length, "get ok", one?.id === sample[0]!.id, "all", all.length, "where(category=sfx)", where.length, "roundtrip equal", JSON.stringify(one) === JSON.stringify(AssetRecord.parse(sample[0])));
const jobs = new JobsTable(env.DB);
const id = `test-${Date.now()}`;
await jobs.create({ id, topic: "t", channel: "moon", aspect: "16:9", duration_s: 120 });
await jobs.update(id, { status: "running", stage: "render" });
console.log("D1 jobs", await jobs.get(id).then((j) => `${j?.status}/${j?.stage}`));
await dispose();
