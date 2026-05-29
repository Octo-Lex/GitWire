// src/services/issueService.js
import { db } from "../lib/db.js";

export const issueService = {
  /**
   * List issues with rich filtering for the triage panel.
   */
  async list({
    repoFullName,
    installationId,
    state = "open",
    labels,
    triagePriority,
    assignee,
    stale,           // only issues not updated in >7 days
    unassigned,
    search,
    sort = "created_at",
    order = "desc",
    limit = 50,
    offset = 0,
  } = {}) {
    const joins      = [`JOIN repositories r ON r.github_id = i.repo_id`];
    const conditions = [`i.state = $1`];
    const values     = [state];
    let   idx        = 2;

    if (repoFullName) {
      conditions.push(`r.full_name = $${idx++}`);
      values.push(repoFullName);
    }
    if (installationId) {
      conditions.push(`r.installation_id = $${idx++}`);
      values.push(installationId);
    }
    if (labels?.length) {
      conditions.push(`i.labels && $${idx++}`);   // array overlap
      values.push(labels);
    }
    if (triagePriority) {
      conditions.push(`i.triage_priority = $${idx++}`);
      values.push(triagePriority);
    }
    if (assignee) {
      conditions.push(`$${idx++} = ANY(i.assignees)`);
      values.push(assignee);
    }
    if (unassigned) {
      conditions.push(`array_length(i.assignees, 1) IS NULL`);
    }
    if (stale) {
      conditions.push(`i.updated_at < NOW() - INTERVAL '7 days'`);
    }
    if (search) {
      conditions.push(`i.title ILIKE $${idx++}`);
      values.push(`%${search}%`);
    }

    const allowedSorts = ["created_at", "updated_at", "number", "triage_priority"];
    const safeSort  = allowedSorts.includes(sort) ? sort : "created_at";
    const safeOrder = order === "asc" ? "ASC" : "DESC";

    values.push(limit, offset);

    const { rows } = await db.query(
      `SELECT
         i.*,
         r.full_name AS repo_full_name,
         r.owner,
         r.name AS repo_name
       FROM issues i
       ${joins.join(" ")}
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.${safeSort} ${safeOrder}
       LIMIT $${idx++} OFFSET $${idx++}`,
      values
    );
    return rows;
  },

  /**
   * Count issues by triage_priority for the summary panel.
   */
  async countByPriority(installationId) {
    const condition = installationId
      ? `AND r.installation_id = $1`
      : "";
    const values = installationId ? [installationId] : [];

    const { rows } = await db.query(
      `SELECT
         COALESCE(i.triage_priority, 'untriaged') AS priority,
         COUNT(*) AS count
       FROM issues i
       JOIN repositories r ON r.github_id = i.repo_id
       WHERE i.state = 'open' ${condition}
       GROUP BY priority
       ORDER BY CASE priority
         WHEN 'critical' THEN 1
         WHEN 'high'     THEN 2
         WHEN 'medium'   THEN 3
         WHEN 'low'      THEN 4
         ELSE 5 END`,
      values
    );
    return rows;
  },

  /**
   * Mark an issue as triaged (called by the triage worker after Claude runs).
   */
  async saveTriage(githubId, { type, priority, summary, repoId, number, title, state, labels }) {
    // Upsert — the issue row may not exist yet (triage runs before syncWorker).
    // INSERT creates the row with triage data; ON CONFLICT preserves existing
    // columns and only overwrites triage fields.
    await db.query(
      `INSERT INTO issues (github_id, repo_id, number, title, state, labels,
                          triage_type, triage_priority, triage_summary, triaged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (github_id) DO UPDATE SET
         triage_type     = EXCLUDED.triage_type,
         triage_priority = EXCLUDED.triage_priority,
         triage_summary  = EXCLUDED.triage_summary,
         triaged_at      = NOW(),
         updated_at      = NOW()`,
      [githubId, repoId, number, title, state, labels,
       type, priority, summary]
    );
  },
};
