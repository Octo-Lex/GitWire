# Phase 4 Worker

AI code review gate and audit trail management.

## Queue: `phase4`

## AI Review Processing

1. Receive job when PR is opened or updated
2. Load review config for the repository
3. Fetch PR diff and changed files from GitHub
4. Send to Claude with review instructions:
   - Check logic, security, architecture, cost, tests
   - Respect `ignore_patterns` and file limits
5. Parse findings and determine verdict
6. Create GitHub Check Run (if `checks:write` permission available)
7. Optionally create PR Review with inline comments
8. Record in `ai_reviews` table
9. Create audit trail entry

## Audit Trail Processing

Every significant action creates an audit entry:

1. Serialize the payload as JSON
2. Compute SHA-256 hash
3. Link to previous entry via `prev_hash`
4. Insert immutable record (never updated/deleted)

### Chain Verification

Verification checks `prev_hash` linkage between consecutive entries. PostgreSQL normalizes JSONB key order on storage, so verification checks the chain linkage rather than rehashing round-tripped payloads.

## Check Run Fallback

If the GitHub App doesn't have `checks:write` permission:
- Gracefully falls back to PR Review comments only
- Logs a warning, doesn't fail the job
- Review still recorded in the database

→ [Dashboard](/dashboard/web-dashboard)
