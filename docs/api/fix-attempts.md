# Fix Attempts API

Autonomous Contributor fix-attempt management.

## Trigger Fix

```http
POST /api/fix/:owner/:repo/issues/:number
```

Queues an autonomous fix request for a specific issue.

```bash
curl -X POST https://gitwire.yourdomain.com/api/fix/owner/repo/issues/42 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

The caller identifies only the repository and issue. **Do not supply a GitHub App installation id.** GitWire resolves the active repository and installation from server-owned state before enqueueing, then re-resolves the current binding when the worker consumes the job.

A legacy `installation_id` query parameter, if present during compatibility cutover, is ignored and cannot select execution authority.

**202 response:**

```json
{
  "queued": true,
  "status": "queued",
  "jobId": "123",
  "repo": "owner/repo",
  "issueNumber": 42
}
```

`202` means the command was accepted by the queue. It does not mean a patch or PR was produced.

Autonomous Contributor accepts only **open issue** targets. GitHub's Issues API also exposes pull requests by number; those targets are rejected rather than routed into issue-fix execution.

Before mutating GitHub, Autonomous Contributor verifies that the repository/installation binding is still current, the default branch still points to the exact commit from which the candidate fix was generated, the issue's title/body/state/eligibility labels still match the analyzed intent, and the deterministic issue-fix branch does not already exist. Drift supersedes the attempt rather than applying stale work, and an existing branch is never force-reset based only on its name.

When repository configuration enables dry-run mode, the issue-fix GitHub client permits evidence reads but mechanically suppresses all non-read GitHub requests. Dry-run attempts are recorded as `dry_run`; they do not create comments, branches, commits, labels, or pull requests and do not consume live fix-attempt limits.

## Get Fix Status

```http
GET /api/fix/:owner/:repo/issues/:number
```

Returns stored fix-attempt state for an issue.

## List Fix Attempts

```http
GET /api/fix/:owner/:repo/attempts
```

Returns stored fix-attempt rows for a repository, newest first, up to the requested limit (maximum 100).

> Current storage is unique on `(repo_id, issue_number)` and updates that row across retries; this endpoint should not be interpreted as immutable attempt history.

→ [Heal History API](/api/heal-history)
