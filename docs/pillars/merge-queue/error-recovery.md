# Error Recovery

Automatic retry and rollback when merge operations fail.

## Auto-Retry

When a merge fails (e.g., merge conflict, CI failure), GitWire can automatically retry:

| Setting | Default | Description |
|---------|---------|-------------|
| Max retries | 3 | Maximum retry attempts |
| Backoff | Exponential | Delay between retries |
| Auto-remove | After max retries | Remove from queue after exhausting retries |

## Rollback

When `rollback_enabled` is true in the queue config, GitWire can automatically:

1. **Revert** the merge commit
2. **Create** a revert PR with the reverted changes
3. **Record** the rollback event for traceability

### Rollback Event Record

| Field | Description |
|-------|-------------|
| `merge_commit` | SHA of the problematic merge |
| `revert_commit` | SHA of the revert (if completed) |
| `revert_pr_number` | PR number of the revert |
| `trigger_reason` | Why the rollback was triggered |
| `status` | `pending`, `completed` |

### Trigger Reasons

| Reason | Description |
|--------|-------------|
| `ci_failure` | Post-merge CI check failed |
| `manual` | Maintainer triggered rollback |
| `policy_violation` | Merged code violates a policy |

## Viewing Rollbacks

```bash
curl https://gitwire.yourdomain.com/api/phase2/rollbacks \
  -H "Authorization: Bearer YOUR_API_KEY"
```

→ [Feedback Rules](/pillars/merge-queue/feedback-rules)
