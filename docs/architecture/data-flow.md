# Data Flow

How data flows through GitWire from GitHub webhook to final action.

## Webhook Processing Flow

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant CF as Cloudflare
    participant APP as GitWire API
    participant Q as Redis Queue
    participant W as Worker
    participant AI as Claude
    participant DB as PostgreSQL

    GH->>CF: Webhook (HTTPS POST)
    CF->>APP: Forward to /webhooks/github
    APP->>APP: Verify HMAC-SHA256 signature
    APP->>DB: Log webhook_delivery
    APP->>Q: Enqueue job
    APP-->>CF: 200 OK
    Q->>W: Pick up job
    W->>GH: Fetch additional data
    W->>AI: Send context for analysis
    AI-->>W: Classification/fix/review
    W->>DB: Store results
    W->>GH: Apply labels/comment/PR
```

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
    APP->>APP: Validate fix
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
    APP->>GH: Fetch PR diff
    APP->>AI: Review code
    AI-->>APP: Findings + verdict
    APP->>GH: Create Check Run
    APP->>DB: Record ai_reviews
    APP->>DB: Create audit_trail_entry
```

→ [Security](/architecture/security)
