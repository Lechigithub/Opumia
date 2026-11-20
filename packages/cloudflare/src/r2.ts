import type { BlobHead, BlobStore } from "@opumia/contracts/adapters";

/** R2-backed BlobStore (StorageAdapter). Keys are POSIX paths: `library/…`, `data/…`, `jobs/<id>/…`. */
export class R2BlobStore implements BlobStore {
  constructor(
    private readonly bucket: R2Bucket,
    readonly readOnly = false,
    private readonly prefix = "",
  ) {}

  private k(key: string) {
    if (key.split("/").includes("..")) throw new Error(`invalid key: ${key}`);
    return `${this.prefix}${key.replace(/^\/+/, "")}`;
  }

  async head(key: string): Promise<BlobHead | null> {
    const o = await this.bucket.head(this.k(key));
    return o ? { key, bytes: o.size, mtimeMs: o.uploaded.getTime() } : null;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const o = await this.bucket.get(this.k(key));
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }

  async getText(key: string): Promise<string | null> {
    const o = await this.bucket.get(this.k(key));
    return o ? o.text() : null;
  }

  /** Single PUT is atomic in R2 (readers see the old or the new object, never a partial one). */
  async put(key: string, body: Uint8Array | string): Promise<void> {
    if (this.readOnly) throw new Error("R2BlobStore is read-only");
    await this.bucket.put(this.k(key), body);
  }

  async *list(prefix: string): AsyncIterable<BlobHead> {
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: this.k(prefix), ...(cursor ? { cursor } : {}) });
      for (const o of page.objects) yield { key: o.key.slice(this.prefix.length), bytes: o.size, mtimeMs: o.uploaded.getTime() };
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

/** Alias matching the platform vocabulary. */
export type { BlobStore as StorageAdapter } from "@opumia/contracts/adapters";
