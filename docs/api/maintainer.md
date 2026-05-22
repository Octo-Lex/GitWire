# Maintainer API

17 endpoints for repository maintenance, governance, and stale management.

## Members

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/maintainer/members` | List all org members |
| `POST` | `/api/maintainer/members/sync` | Sync members from GitHub |
| `GET` | `/api/maintainer/members/:login` | Get a specific member |

## Collaborators

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/maintainer/collaborators` | List all collaborators |
| `GET` | `/api/maintainer/collaborators/:owner/:repo` | Repo collaborators |
| `PUT` | `/api/maintainer/collaborators/:owner/:repo/:login` | Update collaborator permission |
| `DELETE` | `/api/maintainer/collaborators/:owner/:repo/:login` | Remove collaborator |

## Branch Rules

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/maintainer/branch-rules` | List all branch rules |
| `GET` | `/api/maintainer/branch-rules/:owner/:repo` | Repo branch rules |
| `PUT` | `/api/maintainer/branch-rules/:owner/:repo/:pattern` | Update branch rule |

## Repository Operations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/maintainer/:owner/:repo/settings` | Get maintainer settings |
| `PATCH` | `/api/maintainer/:owner/:repo/settings` | Update settings |
| `GET` | `/api/maintainer/:owner/:repo/actions` | List maintainer actions |
| `GET` | `/api/maintainer/:owner/:repo/stats` | Repository statistics |
| `POST` | `/api/maintainer/:owner/:repo/stale-scan` | Trigger stale scan |
| `POST` | `/api/maintainer/:owner/:repo/branch-cleanup` | Trigger branch cleanup |

## Audit

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/maintainer/audit` | Governance audit log |

→ [Enforcement API](/api/enforcement)
