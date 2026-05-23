# Comment Commands

Trigger GitWire actions by commenting on GitHub issues and pull requests.

## Available Commands

| Command | Where | Action |
|---------|-------|--------|
| `/gitwire status` | Issues, PRs | Show context-aware status info |
| `/gitwire run` | Issues, PRs | Re-run all applicable workers |
| `/gitwire run <pillar>` | Issues, PRs | Re-run a specific worker |
| `/gitwire fix` | Issues | Start issue fix analysis |
| `/gitwire stale scan` | Issues, PRs | Trigger stale scan |
| `/gitwire clean branches` | Anywhere | Trigger branch cleanup |
| `/gitwire waive <pillar> ...` | Issues, PRs | Grant a policy waiver |
| `/gitwire unwaive <id>` | Issues, PRs | Revoke a policy waiver |
| `/gitwire stop` | Anywhere | Pause maintainer automation |
| `/gitwire settings` | Anywhere | Show current settings |
| `/gitwire settings stale <days>` | Anywhere | Set stale issue threshold |
| `/gitwire settings pr-stale <days>` | Anywhere | Set stale PR threshold |

## `/gitwire run`

Manually re-evaluate a PR or issue. Bypasses the idempotency check.

```
/gitwire run                  # Re-run all applicable workers
/gitwire run triage           # Re-run triage only
/gitwire run review           # Re-run AI review (PRs only)
/gitwire run heal             # Re-attempt CI heal (PRs only)
/gitwire run fix              # Re-attempt issue fix (issues only)
```

## `/gitwire waive`

Grant a time-limited policy exception.

```
/gitwire waive ci_healing for release/* until 2026-06-01 reason "release freeze"
/gitwire waive ai_review for 42 until 2026-05-25 reason "hotfix"
/gitwire waive triage reason "template migration"
```

**Syntax:**

```
/gitwire waive <pillar> [for <scope>] [until <YYYY-MM-DD>] reason "<text>"
```

## `/gitwire unwaive`

Revoke an active waiver.

```
/gitwire unwaive 42
```

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

## `/gitwire fix`

Start AI fix analysis for an issue. GitWire will analyze the codebase and submit a PR if it can fix the issue. Requires `issue_fix` pillar to be enabled.

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
