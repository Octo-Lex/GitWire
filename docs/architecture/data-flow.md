# Data Flow

How data flows through GitWire from GitHub webhook to final action.

## Webhook Processing Flow

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant CF as Cloudflare
    participant APP as GitWire API
    participant HAND as webhookHandlers/
    participant Q as Redis Queue
    participant W as Worker
    participant AI as Claude
    participant DB as PostgreSQL

    GH->>CF: Webhook (HTTPS POST)
    CF->>APP: Forward to /webhooks/github
    APP->>APP: Verify HMAC-SHA256 signature
    APP->>DB: Log webhook_delivery
    APP->>HAND: routeWebhookToQueue(event, payload)
    HAND->>HAND: Dispatch to handler by event type
    HAND->>Q: Enqueue to target queue
    APP-->>CF: 200 OK
    Q->>W: Pick up job
    W->>GH: Fetch additional data
    W->>AI: Send context for analysis
    AI-->>W: Classification/fix/review
    W->>DB: Store results
    W->>GH: Apply labels/comment/PR
```

## Webhook Routing Detail

The webhook dispatcher (`lib/webhookHandlers/index.js`) uses a handler registry pattern. Each event type maps to a dedicated handler file:

| Event | Handler | Downstream Queue |
|-------|---------|-----------------|
| `issues` (opened, reopened, edited) | `handleIssues.js` | `triage` |
| `pull_request` (opened, reopened, ready_for_review) | `handlePullRequest.js` | `triage`, `phase4` |
| `pull_request` (synchronize) | `handlePullRequest.js` | `phase4` (re-review) |
| `pull_request` (closed) | `handlePullRequest.js` | Reconciliation |
| `workflow_run` (completed, failure) | `handleWorkflowRun.js` | `ci-healing` |
| `workflow_run` (completed, success) | `handleWorkflowRun.js` | `phase2`, test ingestion |
| `check_suite` (completed) | `handleCheckSuite.js` | `phase2` check |
| `issue_comment` (/gitwire commands) | `handleIssueComment.js` | Sub-dispatcher |
| `push` | `handlePush.js` | Config cache invalidation |
| `installation` | `handleInstallation.js` | `sync` |
| Other events | Generic handler | `webhook-events` |

## Sync Flow

```mermaid
sequenceDiagram
    participant APP as GitWire API
    participant Q as Sync Queue
    participant SW as Sync Worker
    participant GH as GitHub API
    participant DB as PostgreSQL

    APP->>Q: full-sync job
    Q->>SW: Pick up
    SW->>GH: List installations
    loop For each installation
        SW->>GH: List repositories
        loop For each repo
            SW->>GH: Fetch issues
            SW->>GH: Fetch PRs
            SW->>GH: Fetch CI runs
            SW->>GH: Fetch collaborators
            SW->>DB: Upsert all data
        end
    end
```

## CI Healing Flow

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant APP as GitWire
    participant AI as Claude
    participant DB as PostgreSQL

    GH->>APP: workflow_run (conclusion: failure)
    APP->>DB: Record CI run
    APP->>AI: Diagnose failure
    AI-->>APP: failure_type + root_cause
    APP->>GH: Fetch failing file
    APP->>AI: Generate full-file fix
    AI-->>APP: Corrected file content
    APP->>APP: Validate fix (risk, confidence, scope)
    APP->>GH: Create branch + commit + PR
    APP->>DB: Record heal_prs
```

## AI Review Flow

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant APP as GitWire
    participant AI as Claude
    participant DB as PostgreSQL

    GH->>APP: pull_request (opened/synchronize)
    APP->>GH: Fetch PR diff + file tree
    APP->>APP: Build review bundle (config, CI, issues, prior reviews)
    APP->>AI: Structured review prompt with schema enforcement
    AI-->>APP: JSON findings + verdict + confidence
    APP->>APP: Validate schema + extract findings
    APP->>GH: Create Check Run (GitWire)
    APP->>GH: Post findings as PR comments
    APP->>DB: Record ai_reviews + audit trail
```

## Issue Fix Pipeline Flow

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant APP as GitWire
    participant AI as Claude
    participant DB as PostgreSQL

    GH->>APP: issue_comment (/gitwire fix) or triage trigger
    APP->>APP: Stage 1: Init context (idempotency, config, rate limit)
    APP->>GH: Stage 2: Fetch issue labels + file tree
    APP->>AI: Stage 3: Analyze issue complexity
    AI-->>APP: Candidate files + complexity
    APP->>GH: Stage 4: Fetch top-ranked files
    APP->>AI: Generate fix for each file
    AI-->>APP: Corrected file content
    APP->>APP: Stage 5: Validate (risk, confidence, blocked paths)
    APP->>GH: Stage 6: Create branch + commit + PR
    APP->>DB: Record managed action + fix attempt
```

→ [Security](/architecture/security) | [Webhook Routing](/architecture/webhook-routing) | [Action Lifecycle](/architecture/action-lifecycle)

> **Last validated:** v0.12.1
