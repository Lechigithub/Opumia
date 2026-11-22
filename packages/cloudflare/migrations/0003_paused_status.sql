-- Build list 3, part D: a job paused by a failure outside the platform (usage limit, expired key, outage) waits
-- durably and resumes on its own. SQLite cannot change a CHECK constraint, so the table is rebuilt.
CREATE TABLE jobs_new (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  channel     TEXT NOT NULL,
  aspect      TEXT NOT NULL CHECK (aspect IN ('9:16', '16:9')),
  duration_s  REAL NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'done', 'failed')),
  stage       TEXT,
  workflow_id TEXT,
  verdict     TEXT,
  final_key   TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
INSERT INTO jobs_new SELECT id, topic, channel, aspect, duration_s, status, stage, workflow_id, verdict, final_key, error, created_at, updated_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, updated_at);
