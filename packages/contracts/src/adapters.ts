/**
 * Persistence ports. Local implementations live in @opumia/ingest (fs/JSON);
 * Cloudflare implementations (R2 / D1 / Workflows) plug in later without touching stages.
 */

export interface BlobHead {
  key: string;
  bytes: number;
  mtimeMs: number;
}

/** Key-addressed blob storage. Local: filesystem roots. Cloud: R2. */
export interface BlobStore {
  readonly readOnly: boolean;
  head(key: string): Promise<BlobHead | null>;
  get(key: string): Promise<Uint8Array | null>;
  getText(key: string): Promise<string | null>;
  /** Atomic write (temp + rename locally; single PUT on R2). Throws on a read-only store. */
  put(key: string, body: Uint8Array | string): Promise<void>;
  list(prefix: string): AsyncIterable<BlobHead>;
}

/** Typed document/catalog store. Local: JSON files. Cloud: D1. */
export interface CatalogDb<T extends { id: string }> {
  upsertMany(rows: T[]): Promise<void>;
  get(id: string): Promise<T | null>;
  all(): Promise<T[]>;
  query(predicate: (row: T) => boolean): Promise<T[]>;
}

/** A pipeline stage: pure function of validated input → validated output, keyed for idempotency. */
export interface Stage<I, O> {
  readonly name: string;
  /** Deterministic key (stage + input hash) used for caching and Workflow step idempotency. */
  key(input: I): string;
  run(input: I): Promise<O>;
}
