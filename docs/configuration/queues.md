# Queues

Reference for all BullMQ queue names used by GitWire workers.

## QUEUES Constant

Defined in `@gitwire/core`:

```js
import { QUEUES } from "@gitwire/core";
```

## All Queues

| Queue Name | Constant | Worker |
|------------|----------|--------|
| `webhook-events` | `QUEUES.WEBHOOK_EVENTS` | [Webhook Worker](/workers/webhook-worker) |
| `triage` | `QUEUES.TRIAGE` | [Triage Worker](/workers/triage-worker) |
| `ci-healing` | `QUEUES.CI_HEALING` | [CI Heal Worker](/workers/ci-heal-worker) |
| `sync` | `QUEUES.SYNC` | [Sync Worker](/workers/sync-worker) |
| `maintainer` | `QUEUES.MAINTAINER` | [Maintainer Worker](/workers/maintainer-worker) |
| `issue-fix` | `QUEUES.ISSUE_FIX` | [Issue Fix Worker](/workers/issue-fix-worker) |
| `phase2` | `QUEUES.PHASE2` | [Phase 2 Worker](/workers/phase2-worker) |
| `phase3` | `QUEUES.PHASE3` | [Phase 3 Worker](/workers/phase3-worker) |
| `phase4` | `QUEUES.PHASE4` | [Phase 4 Worker](/workers/phase4-worker) |

## Queue Configuration

All queues use these BullMQ defaults:

| Setting | Value |
|---------|-------|
| Concurrency | 1 per worker |
| Attempts | 3 |
| Backoff | Exponential |
| Remove on complete | Last 100 |
| Remove on fail | Last 500 |

→ [Heal Status](/configuration/heal-status)
