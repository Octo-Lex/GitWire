# Compliance Reports

Generate SOC2, ISO 27001, and custom compliance reports from the audit trail.

## Generating a Report

```bash
curl -X POST https://gitwire.yourdomain.com/api/audit/reports \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "report_type": "soc2",
    "period_start": "2026-01-01T00:00:00Z",
    "period_end": "2026-03-31T23:59:59Z"
  }'
```

Response:

```json
{
  "id": 1,
  "report_type": "soc2",
  "period_start": "2026-01-01T00:00:00Z",
  "period_end": "2026-03-31T23:59:59Z",
  "entry_count": 847,
  "controls": [
    {
      "control_id": "CC6.1",
      "description": "Logical and Physical Access Controls",
      "entries": 42,
      "status": "pass"
    }
  ],
  "summary": {
    "total_events": 847,
    "by_category": { "ai_decision": 312, "heal": 89, "review_gate": 156 },
    "chain_intact": true
  }
}
```

## Report Types

| Type | Description |
|------|-------------|
| `soc2` | SOC 2 Type II compliance report |
| `iso27001` | ISO 27001 control mapping |
| `custom` | Custom report with specified controls |

## Viewing Reports

```bash
# List all reports
curl https://gitwire.yourdomain.com/api/audit/reports \
  -H "Authorization: Bearer YOUR_API_KEY"

# Get specific report
curl https://gitwire.yourdomain.com/api/audit/reports/1 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Report Content

Each report includes:

| Section | Description |
|---------|-------------|
| **Summary** | Total events, category breakdown, chain integrity |
| **Controls** | Mapped compliance controls with pass/fail status |
| **Entry Range** | First/last audit sequence numbers covered |
| **Integrity** | SHA-256 hash of the report content |

## Database Tables

- **`compliance_reports`** — Generated reports with content hashes
- **`audit_exports`** — Nightly export records with file hashes

→ [REST API Reference](/api/rest-api-reference)
