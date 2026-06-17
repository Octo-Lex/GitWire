# Policy Preview API

The policy preview API provides non-mutating endpoints for validating, simulating, comparing, and recommending guardrails for `.gitwire.yml` policy files.

**All endpoints are non-mutating**: they do not save config, enqueue jobs, or write to GitHub.

## Authentication

All endpoints require `Authorization: Bearer <API_KEY>` header or `gitwire-session` cookie.

---

## POST /api/config/validate

Validate a proposed `.gitwire.yml` and return structured analysis.

### Request

```json
{
  "yaml": "dry_run: true\npillars:\n  triage:\n    enabled: true"
}
```

Or pass a pre-parsed config object:

```json
{
  "config": { "dry_run": true, "pillars": { "triage": { "enabled": true } } }
}
```

### Response (200)

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    {
      "path": "dry_run",
      "message": "Policy enables multiple mutating pillars without dry-run",
      "severity": "medium"
    }
  ],
  "enabled_pillars": ["triage"],
  "dry_run": true,
  "risky_settings": [
    {
      "path": "pillars.triage.enabled",
      "severity": "medium",
      "reason": "Triage applies labels and comments automatically",
      "mitigated_by_dry_run": true
    }
  ],
  "normalized_config": { "...": "redacted" },
  "parsed_at": "2026-06-17T12:00:00.000Z"
}
```

### Risk categories

| Path | Severity | Mitigated by dry-run |
|---|---|---|
| `issue_fix.enabled` | high | yes |
| `auto_patch` enabled | medium | yes |
| `spam_gate` enabled | high | yes |
| stale `close_days` set | medium | no |
| `merge_queue` without checks | medium | no |
| `adversarial_review` off | low | no |

---

## POST /api/config/simulate

Replay a proposed policy against historical `decision_log` events.

### Request

```json
{
  "repo": "Octo-Lex/GitWire",
  "yaml": "dry_run: false\npillars:\n  triage:\n    enabled: true",
  "from": "2026-06-03T00:00:00.000Z",
  "to": "2026-06-17T00:00:00.000Z",
  "limit": 50
}
```

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `repo` | string | *required* | `owner/repo` format |
| `yaml` | string | *required* | Proposed `.gitwire.yml` content |
| `from` | ISO date | 14 days ago | Simulation window start |
| `to` | ISO date | now | Simulation window end |
| `limit` | number | 50 | Max events (capped at 200) |

### Response (200)

```json
{
  "simulated_at": "2026-06-17T12:00:00.000Z",
  "scope": {
    "repo": "Octo-Lex/GitWire",
    "from": "2026-06-03T00:00:00.000Z",
    "to": "2026-06-17T00:00:00.000Z"
  },
  "policy": {
    "valid": true,
    "dry_run": false,
    "enabled_pillars": ["triage"]
  },
  "summary": {
    "events_considered": 25,
    "would_act": 4,
    "would_skip": 1,
    "would_block": 0,
    "dry_run": 0,
    "unsupported": 20
  },
  "results": [
    {
      "event_id": "123",
      "event_type": "pull_request.opened",
      "source": "triage",
      "target_type": "pr",
      "target_number": 26,
      "original_decision": "dry_run",
      "simulated_decision": "would_act",
      "would_do": ["label:triage", "label:needs-review"],
      "reason": "Dry-run is disabled in proposed policy",
      "conditions": [
        { "check": "pillar_enabled(triage)", "result": true },
        { "check": "trigger_filter(triage)", "result": true },
        { "check": "is_dry_run()", "result": false }
      ]
    }
  ]
}
```

### Simulated decisions

| Decision | Meaning |
|---|---|
| `would_act` | Policy would execute mutation |
| `would_skip` | Policy would skip (pillar disabled or trigger mismatch) |
| `dry_run` | Policy would dry-run (no mutation) |
| `would_block` | Policy would block action |
| `would_require_ai` | AI-dependent source — cannot deterministically replay |

### AI-dependent sources

Sources `triage`, `ai_review`, and `issue_fix` depend on AI model output. Simulation marks these as `would_require_ai` rather than fabricating model responses.

---

## POST /api/config/diff-impact

Compare a repo's current policy against a proposed policy and show behavioral changes.

### Request

```json
{
  "repo": "Octo-Lex/GitWire",
  "yaml": "dry_run: false\npillars:\n  triage:\n    enabled: true\n  ci_healing:\n    enabled: true",
  "from": "2026-06-03T00:00:00.000Z",
  "to": "2026-06-17T00:00:00.000Z",
  "limit": 50
}
```

### Response (200)

```json
{
  "compared_at": "2026-06-17T12:00:00.000Z",
  "repo": "Octo-Lex/GitWire",
  "current": {
    "valid": true,
    "dry_run": true,
    "enabled_pillars": ["triage"]
  },
  "proposed": {
    "valid": true,
    "dry_run": false,
    "enabled_pillars": ["triage", "ci_healing"]
  },
  "changes": {
    "dry_run": {
      "from": true,
      "to": false,
      "risk": "increased"
    },
    "pillars_enabled": ["ci_healing"],
    "pillars_disabled": [],
    "risks_added": [
      {
        "path": "pillars.ci_healing.auto_patch",
        "severity": "medium",
        "reason": "Auto-patch modifies files automatically"
      }
    ],
    "risks_removed": [],
    "warnings_added": [],
    "warnings_removed": []
  },
  "simulation_impact": {
    "events_considered": 25,
    "newly_would_act": 4,
    "newly_would_skip": 1,
    "unchanged": 20,
    "unsupported": 0
  },
  "results": [
    {
      "event_id": "123",
      "event_type": "pull_request.opened",
      "source": "triage",
      "target_type": "pr",
      "target_number": 26,
      "current_decision": "dry_run",
      "proposed_decision": "would_act",
      "impact": "removes_dry_run",
      "reason": "Proposed policy removes dry-run protection — would mutate where current policy does not."
    }
  ]
}
```

### Impact labels

| Label | Meaning |
|---|---|
| `more_permissive` | Would act where current skips |
| `more_restrictive` | Would skip where current acts |
| `unchanged` | Same outcome |
| `new_dry_run` | Adds dry-run protection |
| `removes_dry_run` | Removes dry-run protection |
| `unsupported` | AI-dependent or missing data |

---

## POST /api/config/recommendations

Generate deterministic, rule-based guardrail recommendations for a proposed policy.

### Request

```json
{
  "yaml": "dry_run: false\npillars:\n  triage:\n    enabled: true\n  ci_healing:\n    enabled: true\n    auto_patch: true",
  "repo": "Octo-Lex/GitWire"
}
```

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `yaml` | string | *required* | Proposed `.gitwire.yml` content |
| `repo` | string | null | Optional — enables diff-aware recommendations |

When `repo` is provided, the endpoint computes diff impact internally and passes it to the recommendation engine for diff-aware guidance.

### Response (200)

```json
{
  "generated_at": "2026-06-17T12:00:00.000Z",
  "repo": "Octo-Lex/GitWire",
  "summary": {
    "critical": 1,
    "warning": 3,
    "info": 0
  },
  "recommendations": [
    {
      "id": "enable-dry-run-for-risky-policy",
      "severity": "critical",
      "category": "dry_run",
      "path": "dry_run",
      "title": "Enable dry-run before applying risky policy",
      "reason": "Policy has 2 risky setting(s) and dry_run is disabled.",
      "suggested_change": "Set dry_run: true for the first rollout.",
      "evidence": {
        "dry_run": false,
        "risk_count": 2,
        "risks": ["pillars.triage.enabled", "pillars.ci_healing.auto_patch"]
      }
    }
  ]
}
```

### Recommendation rules

| Rule ID | Severity | Category | Trigger |
|---|---|---|---|
| `enable-dry-run-for-risky-policy` | critical/warning | dry_run | dry_run=false + risks exist |
| `enable-dry-run-for-new-risky-policy` | critical | dry_run | newly enabled pillars + no dry-run |
| `keep-dry-run-during-rollout` | critical | dry_run | diff shows dry_run true→false |
| `narrow-triggers-or-dry-run-for-newly-permissive` | warning | scope | diff has newly_would_act > 0 |
| `add-trigger-filters-for-mutating-pillar` | warning | triggers | mutating pillar with empty triggers |
| `lower-issue-fix-limits` | warning | limits | issue_fix limits above threshold |
| `lower-ci-heal-limits` | warning | limits | ci_healing limits above threshold |
| `constrain-auto-patch-paths` | warning/info | scope | auto_patch=true, no paths |
| `constrain-issue-fix-scope` | warning/info | scope | issue_fix enabled, no labels/paths |
| `require-branch-protection-for-merge-queue` | warning | safety | merge_queue enabled, no required checks |
| `no-recommendations` | info | safety | safe policy (explicit positive state) |

### Severity levels

| Severity | Meaning |
|---|---|
| `critical` | Action needed before rollout |
| `warning` | Review recommended |
| `info` | Acknowledgment / positive state |

All recommendations are deterministic and rule-based. No AI-generated advice in this release.

---

## Dashboard

The `/policy-preview` dashboard page provides a visual interface for all four endpoints:

1. **Validation panel** — YAML editor with risk/warning analysis
2. **Simulation panel** — Repo selector, date range, per-event results
3. **Impact comparison panel** — Current vs proposed policy changes
4. **Recommendations panel** — Severity-grouped cards with evidence

---

## Safety model

All policy preview endpoints are **non-mutating**:

- No config files saved
- No queue jobs enqueued
- No GitHub API writes
- No database mutations
- Secret-like fields redacted in all responses

AI-dependent outcomes are labeled honestly as `would_require_ai` — simulation never fabricates model outputs.
