# Docker Compose Deployment

Deploy GitWire with a single `docker compose up -d`.

## Architecture

GitWire runs 5 containers:

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| `gitwire-app` | Built from source | 3000 | Express API + 9 background workers |
| `gitwire-dashboard` | Built from source | 3001 | Next.js 16 dashboard |
| `postgres` | `postgres:16-alpine` | 5432 | PostgreSQL database |
| `redis` | `redis:7-alpine` | 6379 | BullMQ job queues |
| `cloudflared` | `cloudflare/cloudflared` | — | Cloudflare Tunnel |

## Step 1: Clone the Repository

```bash
git clone https://github.com/Octo-Lex/GitWire.git
cd GitWire
```

## Step 2: Configure Environment

```bash
cp packages/web/.env.example packages/web/.env
```

Edit `.env` and fill in all required values. See the [Environment Variables](/installation/environment-variables) page for the full reference.

**Minimum required variables:**

```bash
GITHUB_APP_ID=your_app_id
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_PRIVATE_KEY_PATH=./gitwire-hq.private-key.pem
DATABASE_URL=postgresql://gitwire:changeme@postgres:5432/gitops_hub
REDIS_URL=redis://redis:6379
ANTHROPIC_API_KEY=your-anthropic-key
APP_BASE_URL=https://gitwire.yourdomain.com
```

## Step 3: Place the PEM Key

Copy your GitHub App private key to the secrets directory:

```bash
mkdir -p /opt/gitwire/secrets
cp gitwire-hq.private-key.pem /opt/gitwire/secrets/
```

The PEM key is mounted as a read-only Docker volume and survives container rebuilds.

## Step 4: Start the Stack

```bash
cd packages/web
docker compose -f docker-compose.prod.yml up -d
```

PostgreSQL automatically runs all migrations from `db/migrations/` on first start (36 tables across 11 migrations).

## Step 5: Verify

```bash
# Check container health
docker compose ps

# Check API health
curl https://gitwire.yourdomain.com/health

# Check logs
docker compose logs -f gitwire-app
```

The health endpoint returns:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 12345,
  "workers": 9,
  "queues": ["webhook-events", "triage", "ci-healing", "sync", "maintainer", "issue-fix", "phase2", "phase3", "phase4"]
}
```

## Updating

```bash
git pull origin master
docker compose -f docker-compose.prod.yml up -d --build
```

The app container is rebuilt from source. Database and Redis data persist in named volumes.

## Troubleshooting

### Container won't start
```bash
docker compose logs gitwire-app
```

### Database connection failed
Ensure `DATABASE_URL` uses the Docker service name `postgres`, not `localhost`:
```
DATABASE_URL=postgresql://gitwire:password@postgres:5432/gitops_hub
```

### Dashboard shows connection error
The dashboard needs `NEXT_PUBLIC_API_URL` set to the public URL:
```
NEXT_PUBLIC_API_URL=https://gitwire.yourdomain.com
```

## Next Step

→ [Cloudflare Tunnel Setup](/installation/cloudflare-tunnel)
