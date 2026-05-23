# Custom Rules in the Webhook Pipeline

Custom rules are evaluated in real-time as GitHub webhook events arrive. This page explains the execution flow.

## When Rules Fire

Custom rules are evaluated for these GitHub events:

| Event | Actions |
|-------|---------|
| `issues` | `opened`, `reopened`, `edited` |
| `pull_request` | `opened`, `reopened`, `ready_for_review` |

## Pipeline Order

When a webhook arrives, GitWire processes it in this order:

```
GitHub Webhook
  │
  ├─ 1. Pillar Workers (existing)
  │     ├─ Triage: classify, label, detect duplicates
  │     ├─ AI Review: code review findings
  │     └─ CI Healing: diagnose failed runs
  │
  ├─ 2. Custom Rules (new)
  │     ├─ Build expression context from payload
  │     ├─ Load config + plugins
  │     ├─ Evaluate all rules
  │     └─ Execute matched actions via GitHub API
  │
  └─ 3. Audit & Response
        ├─ Log decisions to decision_log table
        ├─ Record managed actions for reconciliation
        └─ Return 202 to GitHub
```

## Expression Context

The context available to custom rules is built from the webhook payload:

| Variable | Source |
|----------|--------|
| `author` | `issue.user.login` or `pull_request.user.login` |
| `branch` | `pull_request.head.ref` |
| `title` | Issue or PR title |
| `body` | Issue or PR body |
| `labels` | Current labels on the item |
| `files` | PR changed files (fetched via API for PRs) |
| `changes` | `additions`, `deletions`, `changed_files` from PR |
| `repo` | `repository.full_name` |
| `is_new` | True for opened/reopened events |
| `is_draft` | True for draft PRs |

## Action Execution

When a rule matches, its actions execute immediately:

| Action | GitHub API | Managed? |
|--------|-----------|----------|
| `add-label` | POST `/issues/{n}/labels` | ✅ |
| `remove-label` | DELETE `/issues/{n}/labels/{name}` | ❌ |
| `add-comment` | POST `/issues/{n}/comments` | ✅ |
| `approve` | POST `/pulls/{n}/reviews` (APPROVE) | ✅ |
| `request-review` | POST `/pulls/{n}/requested_reviewers` | ✅ |
| `set-priority` | POST `/issues/{n}/labels` (priority:X) | ❌ |
| `skip` | No-op | ❌ |

### Managed Actions

Actions marked "Managed" are tracked in the `managed_actions` table. They are automatically:
- **Reconciled** on PR force-push (synchronize) — stale actions are re-evaluated
- **Cleaned up** on PR close — managed actions are deactivated

## Error Handling

- If custom rules evaluation fails, it's logged but **doesn't block** the webhook response
- Individual action failures are logged per-action — other actions in the same rule still execute
- Rule evaluation errors (bad expression syntax) skip the rule — other rules continue

## Audit Trail

Every custom rule execution is logged to the `decision_log` table:

```
source: "custom_rules"
decision: "acted"
reason: "Custom rule 'approve_safe' matched — executed 2 action(s)"
conditions: [{ check: "custom_rule(approve_safe)", result: true }]
```

## API

### List custom rules for a repo

```
GET /api/config/{owner}/{repo}/custom-rules
```

Returns resolved rules with conditions and action names:

```json
{
  "rules": [
    {
      "name": "approve_safe",
      "condition": "is.docs",
      "actions": ["approve"]
    }
  ],
  "expressions": {
    "is": {
      "docs": "files | all(extension('.md'))"
    }
  },
  "total": 1
}
```
