# Phase 2 Worker

Handles merge queue operations, error recovery, and feedback.

## Queue: `phase2`

## Responsibilities

| Task | Trigger | Action |
|------|---------|--------|
| Queue processing | PR admitted | Wait for checks, merge |
| Error recovery | Merge failure | Retry or rollback |
| Feedback dispatch | Merge event | Send notifications |
| Telemetry recording | All events | Record pipeline events |

## Merge Queue Processing

1. Pick up admitted PR from queue
2. Wait for required status checks to pass
3. If all pass → merge with configured method (squash/merge/rebase)
4. If checks fail → mark as `blocked`, increment retry count
5. If retries exhausted → remove from queue, notify

## Error Recovery

- Configurable max retries (default 3)
- Exponential backoff between retries
- On final failure: create rollback event if `rollback_enabled`
- Rollback creates a revert PR on GitHub

## Feedback Dispatch

When a feedback rule matches an event:
1. Load rule configuration
2. If `post_pr_comment` → post comment on the PR
3. If `slack_webhook` → send Slack notification
4. If `teams_webhook` → send Teams notification

→ [Phase 3 Worker](/workers/phase3-worker)
