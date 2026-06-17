# Audit Bundles

Export bounded evidence packages for compliance, handoff, or external review.

## Overview

Audit bundles collect all GitWire automation evidence within a specified scope — decisions, managed actions, waivers, and dry-run proofs — into a single exportable file.

All secret-like fields are recursively redacted before export.

## Export Endpoint

```
GET /api/audit-bundles/export
```

### Query Parameters

| Parameter       | Type   | Description                              |
| --------------- | ------ | ---------------------------------------- |
| `repo`          | string | Repository full name (owner/repo)        |
| `pillar`        | string | Pillar name (triage, ci_healing, etc.)   |
| `target_type`   | string | `pr` or `issue`                          |
| `target_number` | number | PR or issue number                       |
| `from`          | ISO    | Start date (inclusive)                    |
| `to`            | ISO    | End date (inclusive)                      |
| `format`        | string | `json` (default) or `markdown`           |
| `limit`         | number | Max records per section (default 500, max 1000) |

### Example Request

```
GET /api/audit-bundles/export?repo=Octo-Lex/GitWire&pillar=triage&format=json
```

### JSON Response Shape

```json
{
  "schema_version": "audit-bundle/v1",
  "generated_at": "2026-06-17T00:00:00.000Z",
  "scope": {
    "repo": "Octo-Lex/GitWire",
    "pillar": "triage",
    "target_type": null,
    "target_number": null,
    "from": null,
    "to": null
  },
  "summary": {
    "decisions": 12,
    "managed_actions": 4,
    "waivers": 1,
    "dry_run_decisions": 2
  },
  "decisions": [],
  "managed_actions": [],
  "waivers": [],
  "dry_run_decisions": [],
  "redactions": {
    "enabled": true,
    "fields": ["token", "secret", "password", "private_key", "api_key", "pem", ...],
    "value": "[REDACTED]"
  }
}
```

## Redaction

The following field patterns are recursively redacted in all exported data:

- `token`, `secret`, `password`
- `private_key`, `privateKey`
- `authorization`, `api_key`, `apiKey`
- `pem`, `credential`, `credentials`
- `webhook_secret`, `app_secret`
- `access_token`, `refresh_token`, `session_secret`

Values are replaced with `[REDACTED]`. Key matching is case-insensitive.

String values longer than 10,000 characters are truncated with `...[truncated]`.

## Markdown Format

When `format=markdown`, the response is a Markdown document with:

- Scope and summary tables
- Per-section evidence (Decisions, Managed Actions, Waivers, Dry-Run Proofs)
- Redaction metadata
- Dry-run proofs labeled with safety language ("did not mutate GitHub")

## Dashboard Integration

Export buttons are available on:

- **Decisions** page — exports with current filters
- **Dry-Run Proof** page — exports with `decision=dry_run` pinned
- **Actions** page — exports managed actions for current filters
- **Waivers** page — exports waivers for current filters

## Security

- Authentication required (Bearer token or session cookie)
- All exports include redaction metadata
- Large exports capped at 1000 records per section
- Content-Disposition headers set for file download
