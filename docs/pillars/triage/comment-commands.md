# Comment Commands

Trigger GitWire actions by commenting on GitHub issues and pull requests.

## Available Commands

| Command | Where | Action |
|---------|-------|--------|
| `/gitwire triage` | Issues, PRs | Re-run AI classification |
| `/gitwire status` | Issues, PRs | Show context-aware status info |

## `/gitwire status`

When a maintainer comments `/gitwire status` on an issue, GitWire replies with:

**On an issue:**
```
📊 Issue #42 — "Fix login crash on mobile"
Type: bug | Priority: high
Status: open | Labels: bug, priority: high
Repo: owner/repo (3 open issues, 2 open PRs)
```

**On a pull request:**
```
📊 PR #15 — "Add dark mode toggle"
Branch: feature/dark-mode → main
Status: open | Size: size/M | Risk: low
Repo: owner/repo (3 open issues, 2 open PRs)
```

## `/gitwire triage`

Re-runs the AI classification pipeline. Useful when:
- The issue was updated with more information
- The initial triage was incorrect
- New context is available

## Permission Model

Only users with the following GitHub permissions can use commands:

| Role | Can use commands? |
|------|-------------------|
| OWNER | ✅ |
| MEMBER | ✅ |
| COLLABORATOR | ✅ |
| CONTRIBUTOR | ❌ |
| NONE (public) | ❌ |

Bot accounts (logins containing `[bot]`) are always ignored.

## How It Works

1. GitHub sends an `issue_comment` webhook
2. [Webhook Worker](/workers/webhook-worker) routes it to the comment router
3. Comment router checks if the comment starts with `/gitwire`
4. Verifies the commenter's permission level via GitHub API
5. Executes the requested command
6. Posts the result as a reply comment

## Detection

The comment router uses the `issue_comment` event with `action: "created"` (only new comments, not edits or deletes).

→ [Self-Healing CI](/pillars/ci-healing/self-healing-ci)
