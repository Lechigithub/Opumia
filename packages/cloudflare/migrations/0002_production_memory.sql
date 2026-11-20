-- Cross-film production memory (mirrors data/production-memory.json; ProductionMemory in @opumia/contracts).
CREATE TABLE IF NOT EXISTS production_memory (
  kind TEXT NOT NULL,          -- 'blocked' | 'bad_query' | 'blueprint' | 'outcome'
  channel TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,           -- asset ref, normalised query, or job id
  json TEXT NOT NULL,          -- the record, Zod-validated on read/write
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, channel, key)
);
CREATE INDEX IF NOT EXISTS production_memory_channel ON production_memory (channel, kind);
