import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProductionMemory } from "@opumia/contracts";

/**
 * Cross-film ProductionMemory (data/production-memory.json; D1 table production_memory, migrations/0002).
 * Records what failed (blocked assets, bad queries) and what worked (blueprints used, benchmark outcomes) so
 * future films avoid repeats and mismatches without any topic-specific code.
 */
const file = (dataDir: string) => path.join(dataDir, "production-memory.json");
const empty = (): ProductionMemory => ProductionMemory.parse({ schemaVersion: 1 });
const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export async function loadMemory(dataDir: string): Promise<ProductionMemory> {
  try {
    return ProductionMemory.parse(JSON.parse(await readFile(file(dataDir), "utf8")));
  } catch {
    return empty();
  }
}

/** Atomic, key-sorted write (re-runs with unchanged inputs stay byte-identical). */
export async function saveMemory(dataDir: string, m: ProductionMemory): Promise<void> {
  const sort = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const out = { schemaVersion: 1, blocked: sort(m.blocked), badQueries: sort(m.badQueries), blueprints: sort(m.blueprints), outcomes: sort(m.outcomes) };
  const f = file(dataDir);
  await writeFile(`${f}.tmp`, JSON.stringify(ProductionMemory.parse(out), null, 2) + "\n");
  await rename(`${f}.tmp`, f);
}

/** Read-modify-write under one call. */
export async function updateMemory(dataDir: string, fn: (m: ProductionMemory) => void): Promise<ProductionMemory> {
  const m = await loadMemory(dataDir);
  fn(m);
  await saveMemory(dataDir, m);
  return m;
}

export const blockAsset = (m: ProductionMemory, ref: string, reason: string, job: string, query?: string) => {
  const prev = m.blocked[ref];
  m.blocked[ref] = { reason: reason.slice(0, 200), job, count: (prev?.count ?? 0) + 1, ...(query ? { query } : prev?.query ? { query: prev.query } : {}) };
  if (query) m.badQueries[norm(query)] = (m.badQueries[norm(query)] ?? 0) + 1;
};

export const blockedRefs = (m: ProductionMemory) => new Set(Object.keys(m.blocked));

/** Query phrasings that failed at least twice (shown to the director as "avoid"). */
export const badQueries = (m: ProductionMemory, min = 2) => Object.entries(m.badQueries).filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).map(([q]) => q).slice(0, 30);

/** Recent blueprints: this channel's last `n` plus every other channel's last 2 (no two films share a cadence). */
/** Blueprints of produced films only (`produced`, from produced.ts) — a test plan never set a channel habit. */
export const recentBlueprints = (m: ProductionMemory, channel: string, n = 4, produced?: Set<string>) => {
  const ok = (b: { job?: string }) => !produced || (b.job !== undefined && produced.has(b.job));
  return [...Object.entries(m.blueprints).filter(([c]) => c !== channel).flatMap(([, list]) => list.filter(ok).slice(-2)), ...(m.blueprints[channel] ?? []).filter(ok).slice(-n)];
};

export const recordBlueprint = (m: ProductionMemory, channel: string, b: { job: string; hook: string; ending: string; spine: string; beats?: string[] }) => {
  m.blueprints[channel] = [...(m.blueprints[channel] ?? []).filter((x) => x.job !== b.job), b].slice(-20);
};
