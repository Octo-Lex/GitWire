# Worker Events (Inter-Worker Chaining)

How GitWire workers communicate with each other through a lightweight Redis event bus.

## The Problem

Workers are isolated by design — each processes a single queue. But some workflows need cross-worker coordination:

- After creating a heal PR, CI heal wants triage to label it
- After completing an AI review, the merge queue should re-check eligibility
- After fixing an issue, triage should know the fix PR exists

Without an event bus, the only way to chain workers is webhook re-delivery, which is slow and unreliable.

## Architecture

```
┌─────────────┐  emit   ┌───────────────┐  consume  ┌─────────────┐
│ ciHealWorker │ ──────> │ Redis ZSET    │ ────────> │ phase4Worker │
│ phase4Worker │ ──────> │ gitwire:events│           │ phase2Worker │
└─────────────┘         └───────────────┘           └─────────────┘
```

**Storage:** Redis sorted set `gitwire:events` with timestamp scores.

**TTL:** Events expire after 1 hour (auto-cleaned on each emit).

**Tracking:** `gitwire:events:processed:{subscriber}` set prevents double-processing.

## Event Types

| Event | Emitted By | Consumed By | Payload |
|-------|-----------|-------------|---------|
| `heal_pr_created` | CI Heal Worker | Triage, AI Review | `{ repo, repoId, prNumber, branch, installationId, failureType }` |
| `review_completed` | Phase 4 Worker | Merge Queue (Phase 2) | `{ repo, repoId, prNumber, installationId }` |

## Emitting Events

Workers call `emitWorkerEvent()` at the end of successful processing:

```javascript
import { emitWorkerEvent } from "../services/workerEvents.js";

// After creating a heal PR
await emitWorkerEvent("heal_pr_created", {
  repo: repository.full_name,
  repoId: repository.id,
  prNumber: pr.number,
  branch: branchName,
  installationId: installation.id,
});
```

## Consuming Events

Workers call `processWorkerEvents()` to handle pending events:

```javascript
import { processWorkerEvents } from "../services/workerEvents.js";

await processWorkerEvents("phase2Worker", ["review_completed"], async (event) => {
  const { repoId, prNumber } = event.data;
  // Re-check merge eligibility for this PR
});
```

## Extending

To add a new event:

1. Choose a descriptive event name (verb_noun format)
2. Emit from the source worker after successful processing
3. Subscribe in the target worker with `processWorkerEvents()`
4. Events are automatically cleaned up after 1 hour
