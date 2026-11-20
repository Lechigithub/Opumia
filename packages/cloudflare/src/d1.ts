import type { CatalogDb } from "@opumia/contracts/adapters";
import type { ZodType, ZodTypeDef } from "zod";

/**
 * D1-backed CatalogDb (DatabaseAdapter). Each collection (assets, style_profiles, fact_sheets, …) is a
 * logical partition of one `catalog` table; rows are Zod-validated on write AND read.
 */
export class D1CatalogDb<T extends { id: string }> implements CatalogDb<T> {
  constructor(
    private readonly db: D1Database,
    private readonly collection: string,
    private readonly schema: ZodType<T, ZodTypeDef, unknown>,
  ) {}

  async upsertMany(rows: T[]): Promise<void> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO catalog (collection, id, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    );
    // D1 batches run in one implicit transaction; chunk to stay under statement limits.
    for (let i = 0; i < rows.length; i += 100) {
      await this.db.batch(rows.slice(i, i + 100).map((r) => stmt.bind(this.collection, r.id, JSON.stringify(this.schema.parse(r)), now)));
    }
  }

  async get(id: string): Promise<T | null> {
    const row = await this.db.prepare("SELECT data FROM catalog WHERE collection = ?1 AND id = ?2").bind(this.collection, id).first<{ data: string }>();
    return row ? this.schema.parse(JSON.parse(row.data)) : null;
  }

  async all(): Promise<T[]> {
    const { results } = await this.db.prepare("SELECT data FROM catalog WHERE collection = ?1 ORDER BY id").bind(this.collection).all<{ data: string }>();
    return results.map((r) => this.schema.parse(JSON.parse(r.data)));
  }

  /** Predicate query (in-Worker). For large collections prefer `where`, which filters in SQLite. */
  async query(predicate: (row: T) => boolean): Promise<T[]> {
    return (await this.all()).filter(predicate);
  }

  /** SQL-side filter on a JSON path, e.g. where("$.category", "footage"). */
  async where(jsonPath: string, value: string | number): Promise<T[]> {
    const { results } = await this.db.prepare("SELECT data FROM catalog WHERE collection = ?1 AND json_extract(data, ?2) = ?3 ORDER BY id").bind(this.collection, jsonPath, value).all<{ data: string }>();
    return results.map((r) => this.schema.parse(JSON.parse(r.data)));
  }
}

export type JobStatus = "queued" | "running" | "done" | "failed";
export interface JobRow {
  id: string;
  topic: string;
  channel: string;
  aspect: string;
  duration_s: number;
  status: JobStatus;
  stage: string | null;
  workflow_id: string | null;
  verdict: string | null;
  final_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Job ledger used by the Worker and Workflow. */
export class JobsTable {
  constructor(private readonly db: D1Database) {}
  create(j: Pick<JobRow, "id" | "topic" | "channel" | "aspect" | "duration_s">) {
    const now = new Date().toISOString();
    return this.db.prepare("INSERT INTO jobs (id, topic, channel, aspect, duration_s, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6)").bind(j.id, j.topic, j.channel, j.aspect, j.duration_s, now).run();
  }
  update(id: string, patch: Partial<Omit<JobRow, "id" | "created_at">>) {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
    return this.db.prepare(`UPDATE jobs SET ${sets}, updated_at = ?${keys.length + 2} WHERE id = ?1`).bind(id, ...keys.map((k) => patch[k] ?? null), new Date().toISOString()).run();
  }
  get(id: string) {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
  }
}

export type { CatalogDb as DatabaseAdapter } from "@opumia/contracts/adapters";
