# Audit & Compliance

Generate compliance reports from GitWire's audit trail.

## Step 1: Verify Chain Integrity

Before generating reports, verify the audit trail is intact:

```bash
curl https://gitwire.yourdomain.com/api/audit/verify \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Expected response:
```json
{
  "valid": true,
  "entries_checked": 142,
  "gaps": 0,
  "hash_mismatches": 0
}
```

## Step 2: Generate a SOC2 Report

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

## Step 3: Review the Report

```bash
curl https://gitwire.yourdomain.com/api/audit/reports/1 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

The report includes:
- **Summary**: Total events, category breakdown, chain integrity
- **Controls**: Mapped SOC2 controls with pass/fail status
- **Integrity**: SHA-256 hash for tamper-proofing

## Step 4: Browse Audit Entries

```bash
# All entries
curl https://gitwire.yourdomain.com/api/audit/entries \
  -H "Authorization: Bearer YOUR_API_KEY"

# Statistics
curl https://gitwire.yourdomain.com/api/audit/stats \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Step 5: Export Data

```bash
curl -X POST https://gitwire.yourdomain.com/api/audit/export \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Audit Trail Categories

| Category | What's Tracked |
|----------|---------------|
| `ai_decision` | Triage, diagnosis, fix generation |
| `auto_merge` | Queue merges |
| `review_gate` | AI code review findings |
| `heal` | CI healing actions |
| `rollback` | Merge rollbacks |
| `policy_bypass` | Enforcement exceptions |
| `config_change` | Repository setting changes |

## Compliance Frameworks

Each audit entry can tag relevant frameworks:

| Framework | Tag | Common Controls |
|-----------|-----|-----------------|
| SOC 2 | `soc2` | CC6.1, CC7.1, CC7.2 |
| ISO 27001 | `iso27001` | A.12.1, A.14.2 |
| GDPR | `gdpr` | Article 25, Article 32 |

→ [Back to Docs Home](/)
