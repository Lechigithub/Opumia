-- Opumia D1 schema: a typed document catalog (Zod-validated in code) + the production job ledger.

CREATE TABLE IF NOT EXISTS catalog (
  collection TEXT NOT NULL,          -- assets | style_profiles | fact_sheets | storyboards | qa_reports | …
  id         TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS catalog_category ON catalog (collection, json_extract(data, '$.category'));

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  channel     TEXT NOT NULL,
  aspect      TEXT NOT NULL CHECK (aspect IN ('9:16', '16:9')),
  duration_s  REAL NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  stage       TEXT,
  workflow_id TEXT,
  verdict     TEXT,
  final_key   TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, updated_at);
