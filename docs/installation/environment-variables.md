# Environment Variables

Complete reference for all GitWire environment variables.

## GitHub App

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_APP_ID` | ✅ | — | GitHub App ID from app settings |
| `GITHUB_APP_CLIENT_ID` | ✅ | — | Client ID (starts with `Iv1.`) |
| `GITHUB_APP_CLIENT_SECRET` | ✅ | — | Client secret from app settings |
| `GITHUB_WEBHOOK_SECRET` | ✅ | — | Secret used to verify webhook signatures |
| `GITHUB_PRIVATE_KEY` | — | — | Full PEM key content (use `\n` for newlines) |
| `GITHUB_PRIVATE_KEY_PATH` | — | — | Path to PEM file (alternative to above) |

::: tip
Use `GITHUB_PRIVATE_KEY_PATH` when possible — it avoids issues with newlines in environment variables.
:::

## Server

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | — | `3000` | HTTP port for the API server |
| `NODE_ENV` | — | `development` | `production` or `development` |
| `LOG_LEVEL` | — | `info` | `debug`, `info`, `warn`, or `error` |

## Database

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `DB_PASSWORD` | — | `changeme` | Password for Docker Compose PostgreSQL |

**Docker Compose format:**
```
DATABASE_URL=postgresql://gitwire:password@postgres:5432/gitops_hub
```

**Local development format:**
```
DATABASE_URL=postgresql://gitwire:password@localhost:5432/gitops_hub
```

## Redis

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | ✅ | — | Redis connection string |

```
REDIS_URL=redis://redis:6379
```

## AI (Claude)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API key for Claude |
| `ANTHROPIC_BASE_URL` | — | `https://api.anthropic.com` | API base URL (use for proxies) |

**Using a proxy:**
```
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
```

## Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APP_BASE_URL` | ✅ | — | Public URL where GitHub sends webhooks |
| `API_KEY` | — | *(random)* | Single API key for REST API auth |
| `API_KEYS` | — | — | Comma-separated list of API keys |

::: warning
If no `API_KEY` or `API_KEYS` is set, a random key is generated on startup and logged once. Save it immediately.
:::

## Cloudflare Tunnel

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TUNNEL_TOKEN` | — | — | Cloudflare Tunnel token |

## Dashboard

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | ✅ | — | Public API URL for dashboard fetch calls |
| `HOSTNAME` | — | — | Set to `0.0.0.0` in Docker for Next.js standalone |

## Example .env File

```bash
# ─── GitHub App ───────────────────────────────────────────────
GITHUB_APP_ID=your_app_id
GITHUB_APP_CLIENT_ID=Iv1.abc123
GITHUB_APP_CLIENT_SECRET=your-client-secret
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_PRIVATE_KEY_PATH=/opt/gitwire/secrets/gitwire-hq.pem

# ─── Server ───────────────────────────────────────────────────
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# ─── Database ─────────────────────────────────────────────────
DATABASE_URL=postgresql://gitwire:changeme@postgres:5432/gitops_hub
DB_PASSWORD=changeme

# ─── Redis ────────────────────────────────────────────────────
REDIS_URL=redis://redis:6379

# ─── AI ───────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-your-key
ANTHROPIC_BASE_URL=https://api.anthropic.com

# ─── App ──────────────────────────────────────────────────────
APP_BASE_URL=https://gitwire.yourdomain.com
API_KEY=your-secret-api-key

# ─── Tunnel ───────────────────────────────────────────────────
TUNNEL_TOKEN=your-cloudflare-tunnel-token
```

## Next Step

→ [Issue & PR Triage](/pillars/triage/issue-pr-triage)
