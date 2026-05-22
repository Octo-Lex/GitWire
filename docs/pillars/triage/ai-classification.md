# AI Classification

How GitWire uses Claude to classify issues and pull requests.

## The Pipeline

When a triage job is picked up by the [Triage Worker](/workers/triage-worker):

1. **Fetch issue data** from the database (title, labels, existing metadata)
2. **Build prompt** with classification instructions and the issue context
3. **Send to Claude** via the Anthropic API
4. **Parse response** — extract type, priority, and summary
5. **Upsert triage fields** in the `issues` table
6. **Apply labels** on GitHub via the API

## Classification Types

Claude assigns one of these types:

| Type | Description | GitHub Label |
|------|-------------|--------------|
| `bug` | Something isn't working | `bug` |
| `feature` | New feature or request | `enhancement` |
| `question` | Further information requested | `question` |
| `documentation` | Improvements or additions to docs | `documentation` |
| `enhancement` | Improvement to existing feature | `improvement` |
| `performance` | Performance issue or optimization | `performance` |
| `security` | Security vulnerability or concern | `security` |
| `other` | Doesn't fit other categories | — |

## Priority Levels

| Priority | Criteria | GitHub Label |
|----------|----------|--------------|
| `critical` | Security vulnerabilities, data loss, production outages | `priority: critical` |
| `high` | Breaking functionality, significant user impact | `priority: high` |
| `medium` | Non-critical bugs, feature requests with clear value | `priority: medium` |
| `low` | Minor issues, nice-to-have features | `priority: low` |

## Summary Generation

Claude generates a one-line summary of the issue, stored in `triage_summary`. This is used in:
- Dashboard issue lists (quick scan)
- `/gitwire status` command output
- Duplicate detection embedding text

## Confidence

The triage worker does not currently assign a confidence score. All classifications are applied directly. Future versions may add a confidence threshold below which triage is skipped.

## Re-triage

Issuing `/gitwire triage` on an issue triggers a re-classification. The previous triage fields are overwritten.

## Worker Reference

See [Triage Worker](/workers/triage-worker) for implementation details.

→ [Duplicate Detection](/pillars/triage/duplicate-detection)
