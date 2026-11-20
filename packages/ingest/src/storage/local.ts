import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BlobHead, BlobStore } from "@opumia/contracts/adapters";
import { atomicWrite, walk } from "../util/fs.js";

/** Filesystem BlobStore. Library/Reference are mounted read-only; data/ is writable. Swap for R2 later. */
export class LocalBlobStore implements BlobStore {
  constructor(
    readonly root: string,
    readonly readOnly: boolean,
  ) {}

  private resolve(key: string) {
    const abs = path.resolve(this.root, key);
    if (abs !== path.resolve(this.root) && !abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`key escapes root: ${key}`);
    return abs;
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const s = await stat(this.resolve(key));
      return s.isFile() ? { key, bytes: s.size, mtimeMs: Math.floor(s.mtimeMs) } : null;
    } catch {
      return null;
    }
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.resolve(key)));
    } catch {
      return null;
    }
  }

  async getText(key: string) {
    try {
      return await readFile(this.resolve(key), "utf8");
    } catch {
      return null;
    }
  }

  async put(key: string, body: Uint8Array | string) {
    if (this.readOnly) throw new Error(`BlobStore at ${this.root} is read-only`);
    await atomicWrite(this.resolve(key), typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
  }

  async *list(prefix: string): AsyncIterable<BlobHead> {
    for await (const e of walk(this.resolve(prefix))) yield { key: path.posix.join(prefix, e.rel), bytes: e.bytes, mtimeMs: e.mtimeMs };
  }
}
