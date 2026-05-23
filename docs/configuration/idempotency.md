# Idempotency

How GitWire prevents duplicate actions from webhook retries, race conditions, and concurrent processing.

## The Problem

GitHub retries webhooks on timeout or 5xx errors. If two workers pick up the same event simultaneously, the same action could be applied twice:

- Duplicate labels on an issue
- Duplicate triage comments
- Duplicate fix PRs for the same CI failure

## How It Works

Every worker checks a Redis-backed idempotency key before processing:

```
gitwire:idem:{source}:{key}
```

| Worker | Key Pattern | TTL |
|--------|-------------|-----|
| CI Healing | `ci_healing:run-{runId}` | 1 hour |
| Triage | `triage:issue-{number}-{action}` | 1 hour |
| AI Review | `ai_review:pr-{number}-{sha}` | 1 hour |
| Issue Fix | `issue_fix:issue-{number}` | 1 hour |

### Flow

1. Worker receives a job
2. Calls `checkAndMark(source, key)` — atomic check-and-set in Redis
3. If the key already exists → **duplicate detected**, skip processing
4. If the key is new → **fresh operation**, proceed and set the key with TTL

### Bypassing Idempotency

Manual re-evaluation via `/gitwire run` clears the idempotency key before re-queueing, ensuring the operation actually runs:

```bash
/gitwire run review    # Clears idempotency, re-queues AI review
```

## Configuration

No configuration needed — idempotency is always active. The 1-hour TTL is sufficient for GitHub's retry window (which is typically under 30 seconds).
