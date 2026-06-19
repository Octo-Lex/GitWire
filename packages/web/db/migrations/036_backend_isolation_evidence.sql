-- 036_backend_isolation_evidence.sql
-- Durable backend isolation evidence for executor pass authorization.
--
-- A backend can become pass-capable only when valid evidence exists
-- AND all required probes passed. This table stores the durable,
-- content-addressed evidence record.
--
-- Write-once: INSERT ON CONFLICT DO NOTHING. Never deleted.

CREATE TABLE IF NOT EXISTS backend_isolation_evidence (
  evidence_id            TEXT PRIMARY KEY,
  execution_backend_id   TEXT NOT NULL,
  executor_version       TEXT NOT NULL,
  image_ref              TEXT NOT NULL,
  image_digest           TEXT NOT NULL,
  container_runtime      TEXT NOT NULL,
  runtime_version        TEXT,
  probe_suite_hash       TEXT NOT NULL,
  probe_results          TEXT NOT NULL,
  all_probes_passed      BOOLEAN NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up evidence by backend + image digest
CREATE INDEX IF NOT EXISTS idx_backend_evidence_lookup
  ON backend_isolation_evidence (execution_backend_id, image_digest);
