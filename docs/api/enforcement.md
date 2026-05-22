# Enforcement API

11 endpoints for branch enforcement policies and violations.

## Statistics

```
GET /api/enforcement/stats
```

## Policies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/enforcement/policies` | List all policies |
| `POST` | `/api/enforcement/policies` | Create a policy |
| `PUT` | `/api/enforcement/policies/:id` | Update a policy |
| `DELETE` | `/api/enforcement/policies/:id` | Delete a policy |

## Violations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/enforcement/violations` | List all violations |
| `GET` | `/api/enforcement/violations/:owner/:repo` | Repo violations |
| `POST` | `/api/enforcement/violations/:id/suppress` | Suppress a violation |

## Reconciliation

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/enforcement/run` | Trigger reconciliation run |

## Config Validation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/enforcement/config-results` | All config validation results |
| `GET` | `/api/enforcement/config-results/:owner/:repo` | Repo config results |

→ [Merge Queue API](/api/phase2)
