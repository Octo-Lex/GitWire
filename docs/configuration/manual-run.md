# `/gitwire run` — Manual Re-Evaluation

Force GitWire to re-process a PR or issue on demand.

## Overview

Sometimes you want GitWire to re-evaluate something without pushing a new commit or re-opening an issue. The `/gitwire run` command triggers an immediate re-run of one or all applicable workers.

## Usage

Comment on any issue or PR:

```
/gitwire run                  # Re-run all applicable workers
/gitwire run triage           # Re-run triage only
/gitwire run review           # Re-run AI review only
/gitwire run heal             # Re-attempt CI heal
/gitwire run fix              # Re-attempt issue fix
```

## Behavior

| Context | `/gitwire run` | `/gitwire run triage` | `/gitwire run review` | `/gitwire run heal` | `/gitwire run fix` |
|---------|---------------|----------------------|----------------------|---------------------|-------------------|
| **PR** | review + triage | triage | AI review | logs info* | — |
| **Issue** | triage + fix | triage | — | — | issue fix |

\* CI heal requires a `workflow_run.completed` webhook event. If there's no failed run to heal, it logs a message and exits.

## How It Works

1. Parses the comment via the comment router
2. Determines if the target is a PR or issue
3. **Clears the idempotency key** so the operation bypasses the dedup gate
4. Enqueues the job with `priority: 1` (high priority)
5. Posts a confirmation comment

## Idempotency Bypass

Normal worker jobs are protected by idempotency checks (preventing duplicate processing). `/gitwire run` explicitly clears the relevant idempotency key before re-queueing, so the re-run always processes.

## Permissions

Only maintainers can use `/gitwire run` (requires `OWNER`, `MEMBER`, or `COLLABORATOR` association on the repository).

## Response

After processing, GitWire posts a confirmation comment:

> ▶️ **GitWire:** Re-evaluation triggered for **review**. Results will appear shortly.
