-- db/migrations/014_action_feed.sql
-- Unified action feed: view aggregating all GitWire actions
-- into a single queryable stream for the dashboard and API.

-- Drop if exists (idempotent)
DROP VIEW IF EXISTS action_feed;

CREATE VIEW action_feed AS

-- ── CI Healing Patches ──────────────────────────────────────────────────────
SELECT
  'ci_heal'                          AS source,
  h.id                               AS source_id,
  r.full_name                        AS repo,
  h.github_pr_number                 AS target_number,
  h.github_pr_url                    AS target_url,
  h.failure_type                     AS action_type,
  h.status                           AS status,
  array_to_string(h.files_changed, ', ') AS detail,
  h.created_at                       AS created_at

FROM heal_prs h
JOIN repositories r ON r.github_id = h.repo_id

UNION ALL

-- ── Issue Fix Attempts ──────────────────────────────────────────────────────
SELECT
  'issue_fix'                        AS source,
  f.id                               AS source_id,
  r.full_name                        AS repo,
  f.issue_number                     AS target_number,
  NULL                               AS target_url,
  f.status                           AS action_type,
  f.status                           AS status,
  ('complexity: ' || COALESCE(f.complexity, '?') || COALESCE('; ' || f.error, '')) AS detail,
  f.created_at                       AS created_at

FROM fix_attempts f
JOIN repositories r ON r.github_id = f.repo_id

UNION ALL

-- ── Maintainer Actions ──────────────────────────────────────────────────────
SELECT
  'maintainer'                       AS source,
  m.id                               AS source_id,
  r.full_name                        AS repo,
  NULLIF(regexp_replace(m.target_number, '[^0-9]', '', 'g'), '')::bigint AS target_number,
  NULL                               AS target_url,
  m.action_type                      AS action_type,
  m.status                           AS status,
  COALESCE(m.result, '')             AS detail,
  m.created_at                       AS created_at

FROM maintainer_actions m
JOIN repositories r ON r.github_id = m.repo_id

UNION ALL

-- ── Config Changes ──────────────────────────────────────────────────────────
SELECT
  'config_change'                    AS source,
  c.id                               AS source_id,
  r.full_name                        AS repo,
  NULL                               AS target_number,
  NULL                               AS target_url,
  c.action                           AS action_type,
  'applied'                          AS status,
  ('by: ' || c.changed_by)           AS detail,
  c.changed_at                       AS created_at

FROM config_history c
JOIN repositories r ON r.github_id = c.repo_id

UNION ALL

-- ── Duplicate Signals ───────────────────────────────────────────────────────
SELECT
  'duplicate'                        AS source,
  d.id                               AS source_id,
  r.full_name                        AS repo,
  d.source_issue_id                  AS target_number,
  NULL                               AS target_url,
  'detected'                         AS action_type,
  d.status                           AS status,
  ('similarity: ' || ROUND(d.similarity::numeric, 3))::text AS detail,
  d.created_at                       AS created_at

FROM duplicate_signals d
JOIN repositories r ON r.github_id = d.repo_id

UNION ALL

-- ── Merge Queue Events ──────────────────────────────────────────────────────
SELECT
  'merge_queue'                      AS source,
  q.id                               AS source_id,
  r.full_name                        AS repo,
  q.pr_number                        AS target_number,
  NULL                               AS target_url,
  'queued'                           AS action_type,
  q.status                           AS status,
  (q.author_login || ': ' || LEFT(q.pr_title, 80)) AS detail,
  q.admitted_at                      AS created_at

FROM merge_queue_entries q
JOIN repositories r ON r.github_id = q.repo_id

UNION ALL

-- ── AI Reviews ──────────────────────────────────────────────────────────────
SELECT
  'ai_review'                        AS source,
  a.id                               AS source_id,
  r.full_name                        AS repo,
  a.pr_number                        AS target_number,
  NULL                               AS target_url,
  'review'                           AS action_type,
  a.verdict                          AS status,
  ('confidence: ' || a.confidence || '; findings: ' || COALESCE(jsonb_array_length(a.findings), 0)) AS detail,
  a.started_at                       AS created_at

FROM ai_reviews a
JOIN repositories r ON r.github_id = a.repo_id

UNION ALL

-- ── Enforcement Violations ──────────────────────────────────────────────────
SELECT
  'enforcement'                      AS source,
  e.id                               AS source_id,
  r.full_name                        AS repo,
  NULL                               AS target_number,
  NULL                               AS target_url,
  'violation'                        AS action_type,
  e.status                           AS status,
  ('branch: ' || e.branch)           AS detail,
  e.detected_at                      AS created_at

FROM enforcement_violations e
JOIN repositories r ON r.github_id = e.repo_id

UNION ALL

-- ── Webhook Deliveries (last 1000) ──────────────────────────────────────────
SELECT
  'webhook'                          AS source,
  w.id                               AS source_id,
  w.repo                             AS repo,
  NULL                               AS target_number,
  NULL                               AS target_url,
  w.event_name || '.' || COALESCE(w.action, '') AS action_type,
  CASE WHEN w.processed THEN 'processed' ELSE 'failed' END AS status,
  COALESCE(w.error, '')              AS detail,
  w.received_at                      AS created_at

FROM webhook_deliveries w

ORDER BY created_at DESC;
