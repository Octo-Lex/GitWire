# Evidence Bundles

Structured evidence attached to audit trail entries, providing full context for every GitWire action.

## Overview

The audit trail is hash-chained and append-only. Evidence bundles extend each entry with a structured `evidence` payload that answers three questions:

1. **What was decided?** — The decision and reason
2. **What was checked?** — Conditions evaluated (pillar enabled, confidence threshold, risk score, etc.)
3. **What was the context?** — Config snapshot, run IDs, branch names

## Structure

```json
{
  "decision": "acted",
  "reason": "CI heal patch PR created",
  "conditions": [
    { "check": "pillar_enabled(ci_healing)", "result": true },
    { "check": "healable_type(lint_error)", "result": true },
    { "check": "confidence(high) >= threshold(medium)", "result": true },
    { "check": "risk_score(15)", "result": true },
    { "check": "is_dry_run()", "result": false }
  ],
  "config_snapshot": {
    "auto_patch": true,
    "pillar_enabled": true
  },
  "context": {
    "run_id": 123456,
    "failing_file": "src/app.js",
    "branch": "main"
  },
  "actions_taken": [
    { "type": "label", "key": "label:ci-heal", "value": "ci-heal" },
    { "type": "branch_ref", "key": "heal_pr", "value": "fix/ci-heal-12345" },
    { "type": "pr_created", "key": "heal_pr", "value": "#42" }
  ]
}
```

## Integration

Evidence bundles are passed to `Trail.*()` methods in the audit trail service:

```javascript
await Trail.ciHeal({
  repoFullName: repository.full_name,
  healType: "patch_pr",
  prNumber: pr.number,
  evidence: {
    decision: "acted",
    conditions: [...],
    config_snapshot: {...},
    context: {...},
    actions_taken: [...]
  }
});
```

## Compliance Mapping

Evidence bundles are tagged with compliance frameworks (SOC 2, ISO 27001) and support:

- **Reconstruction** — Full replay of why any action was taken
- **Attestation** — Prove that risk scoring and confidence checks ran
- **Gap analysis** — Identify decisions where conditions were borderline

## Availability

Evidence bundles are available for:

- **CI Heal** — Full evidence on every patch PR created
- **Triage** — Full evidence on every labeling decision
- **Issue Fix** — Full evidence on every fix PR submitted
