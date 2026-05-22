# Trust & Dependencies API

15 endpoints for flaky test detection, dependency scanning, vulnerability tracking, and policy reconciliation.

## Flaky Tests

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/phase3/flaky/stats` | Flaky test statistics |
| `GET` | `/api/phase3/flaky` | List all flaky tests |
| `GET` | `/api/phase3/flaky/:owner/:repo` | Repo flaky tests |
| `POST` | `/api/phase3/flaky/:id/graduate` | Mark as no longer flaky |
| `POST` | `/api/phase3/flaky/:id/dismiss` | Dismiss flaky detection |

## Policy Reconciler

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/phase3/reconciler/runs` | Reconciliation run history |
| `GET` | `/api/phase3/reconciler/repos` | Repo reconciler configs |
| `POST` | `/api/phase3/reconciler/run` | Trigger reconciliation |
| `PUT` | `/api/phase3/reconciler/repos/:owner/:repo` | Update repo config |

## Dependencies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/phase3/dependencies/stats` | Dependency statistics |
| `GET` | `/api/phase3/dependencies/vulnerabilities` | All vulnerability advisories |
| `GET` | `/api/phase3/dependencies/:owner/:repo` | Repo dependency manifests |
| `POST` | `/api/phase3/dependencies/:owner/:repo/scan` | Trigger dependency scan |
| `POST` | `/api/phase3/dependencies/:owner/:repo/batch-pr` | Create batch update PR |
| `POST` | `/api/phase3/dependencies/vuln/:id/dismiss` | Dismiss a vulnerability |

→ [Intelligence & Audit API](/api/phase4)
