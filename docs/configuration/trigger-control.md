# Trigger Control

Per-pillar filters that control **when** GitWire activates. Configure branch, author, and path filters in `.gitwire.yml` to limit which events each pillar responds to.

## Overview

By default, every pillar processes all events. Trigger filters let you narrow this down:

- **Branch filters** — only act on specific branches (e.g., heal CI only on `main`)
- **Author ignore** — skip events from bots or specific users (e.g., ignore `dependabot[bot]`)
- **Path filters** — only act when specific files change (e.g., AI review only on `src/**`)

## Configuration

Add a `triggers` section under any pillar in `.gitwire.yml`:

```yaml
pillars:
  ci_healing:
    enabled: true
    triggers:
      branches: ["main", "develop"]          # Only heal CI on these branches
      ignore_authors: ["dependabot[bot]"]    # Skip these authors

  triage:
    enabled: true
    triggers:
      ignore_authors: ["*[bot]", "renovate*"] # Skip all bots (glob patterns)

  ai_review:
    enabled: true
    triggers:
      branches: []                            # Empty = all branches
      ignore_authors: ["dependabot[bot]"]
      paths: ["src/**", "lib/**"]             # Only review PRs touching these paths
```

## Filter Types

### `branches`

Array of glob patterns. If non-empty, the pillar **only** activates when the event's branch matches at least one pattern. Empty array = all branches.

```yaml
triggers:
  branches: ["main", "release/*"]   # main, release/1.0, release/2.0, etc.
```

### `ignore_authors`

Array of glob patterns. If the event's author matches **any** pattern, the pillar is skipped.

```yaml
triggers:
  ignore_authors: ["*[bot]", "renovate*"]
```

### `paths`

Array of glob patterns. If non-empty, the pillar **only** activates when at least one changed file matches. Only applicable to PR-based pillars (`ai_review`, `triage`).

```yaml
triggers:
  paths: ["src/**", "lib/**", "packages/*/src/**"]
```

## Decision Logging

When a trigger filter blocks a pillar, GitWire records a decision log entry:

```json
{
  "source": "ci_healing",
  "decision": "skipped",
  "reason": "Trigger filter: branch/author not matched",
  "conditions": [
    { "check": "trigger_filter(ci_healing)", "result": false, "branch": "feature/foo" }
  ]
}
```

## Defaults

All pillars ship with empty trigger filters (no restrictions):

```yaml
triggers:
  branches: []
  ignore_authors: []
  paths: []
```

No changes needed to existing `.gitwire.yml` files — empty arrays mean "accept everything."
