# PR Check Status

GitWire creates a `gitwire/evaluated` check run on every pull request, providing visibility directly in GitHub's PR UI.

## Overview

When GitWire processes a PR event (open, synchronize, reopened), it creates a GitHub Check Run with the status `gitwire/evaluated`. This check appears in the PR's checks panel alongside CI results.

## Check States

| State | When |
|-------|------|
| `queued` | Created when PR event is received |
| `completed (success)` | Worker processed successfully |
| `completed (neutral)` | Worker skipped (disabled, filtered, waived) |
| `completed (failure)` | Worker encountered an error |

## What You See

On any PR where GitWire is installed, you'll see:

```
✓ gitwire/evaluated — Evaluated by GitWire
  Triage: labeled (3 labels)
  AI Review: 2 findings
  Pillars checked: triage, ai_review, merge_queue
```

## How It Works

1. **Webhook handler** — Creates the check on `pull_request` events (opened, synchronize, reopened)
2. **Workers** — Update the check on completion with a summary of what was done
3. **GitHub permissions** — Requires `checks: write` in the GitHub App permissions

## Configuration

PR check status is always active when the GitHub App has `checks: write` permission. No configuration needed.

If the permission is missing, check creation is silently skipped — other GitWire features continue to work normally.
