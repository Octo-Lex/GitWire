# Production Infrastructure

> **This document is version-controlled and survives agent memory compaction.**
> If you are an AI agent starting a new session and working on GitWire, read
> this file first — it contains the deployment topology you need.

## Host: Proxmox VE

| Property | Value |
|----------|-------|
| **Address** | `192.168.3.5` |
| **SSH** | `root@192.168.3.5` (key-based) |
| **Web UI** | `https://192.168.3.5:8006` |
| **Version** | PVE 8.4.10 |
| **Kernel** | `6.8.12-13-pve` |
| **Storage** | NVMe with LVM |

### Other Running CTs/VMs on the Same Host

| VMID | Name | Type | Status |
|------|------|------|--------|
| 100 | onestretch | CT | Running |
| 101 | ShadowBroker | CT | Running |
| 114 | openwand-vm | VM | Running |
| 115 | **gitwire** | **CT** | **Running** |
| 150 | clarityit | CT | Running |
| 216 | gat-platform-2 | CT | Running |
| 500 | freqtrade | CT | Running |
| 600 | startup-in-a-box | CT | Running |
| 801 | nodechain | CT | Running |

## Container: CT 115 — `gitwire`

| Property | Value |
|----------|-------|
| **Hostname** | `gitwire` |
| **IP** | `192.168.3.151/24` |
| **Gateway** | `192.168.3.1` |
| **Bridge** | `vmbr0` |
| **OS** | Ubuntu (LXC) |
| **Arch** | amd64 |
| **Features** | `nesting=1` (required for Docker-in-LXC) |
| **AppArmor** | `unconfined` |
| **Boot** | `onboot: 1` |
| **Privileged** | No (`unprivileged: 0`) |

### Resource Allocation

| Resource | Current | Recommended (v0.20+) | Notes |
|----------|---------|----------------------|-------|
| **CPU** | 2 cores | 2 cores | Sufficient for current workload |
| **RAM** | 2 GB | **4 GB** | Swap at 58% under load; validator containers need headroom |
| **Disk** | 16 GB (LVM) | 16 GB | 68% used — monitor Docker image growth |
| **Swap** | 512 MB | 512 MB | Acceptable as safety net |

### Adjusting Resources

```bash
# SSH to Proxmox host
ssh root@192.168.3.5

# Bump RAM to 4 GB (requires restart)
pct set 115 --memory 4096
pct reboot 115

# Verify
pct config 115
```

## Docker Containers (10 services)

> Derived from `docker-compose.yml` service definitions.

| Container | Port | Purpose |
|-----------|------|---------|
| `gitwire-app` | 3000 | Express API + 14 BullMQ worker handles + reconciliation |
| `gitwire-executor-service` | 3003 | Validator container-runtime authority (v0.23.0+) |
| `gitwire-dashboard` | 3001 | Next.js dashboard |
| `gitwire-bot` | 3002 | Telegram bot |
| `gitwire-landing` | 80 | Landing page |
| `gitwire-demo` | 80 | Demo dashboard |
| `gitwire-docs` | 80 | VitePress documentation |
| `gitwire-tunnel` | — | Cloudflare Tunnel (outbound only) |
| `gitwire-postgres` | 5432 | PostgreSQL 16 |
| `gitwire-redis` | 6379 | Redis 7 (BullMQ queues) |

The JSON block below is the **enforced contract** for these identities. It is
parsed at CI time by `scripts/check-source-of-truth.mjs`; prose above is
informational and this block is authoritative on disagreement.

<!-- gitwire:source-of-truth:begin -->
```json
{
  "schemaVersion": 1,
  "version": "0.23.1",
  "services": ["gitwire-app", "gitwire-executor-service", "postgres", "redis", "bot", "landing", "tunnel", "dashboard", "docs", "demo"],
  "workers": ["startWebhookWorker", "startTriageWorker", "startCIHealWorker", "startCIEvidenceWorker", "startDiagnosisWorker", "startPatchWorker", "startVerificationWorker", "startCriticWorker", "startSyncWorker", "startMaintainerWorker", "startIssueFixWorker", "startMergeQueueWorker", "startPhase3Worker", "startPhase4Worker"],
  "migrations": { "first": "001", "last": "037", "count": 37 }
}
```
<!-- gitwire:source-of-truth:end -->

### Deployment Directory

All GitWire files live at `/opt/gitwire` inside CT 115:

```
/opt/gitwire/
├── .env                    # Production environment variables
├── secrets/                # GitHub App private key (PEM)
├── docker-compose.yml      # Service definitions
├── packages/web/.env       # App-level env
├── db/migrations/          # SQL migration files
└── ...                     # Full repo checkout
```

### SSH Access

```bash
# Direct SSH to the container (key-based)
ssh root@192.168.3.151

# Or via Proxmox host
ssh root@192.168.3.5
pct exec 115 -- bash

# With SSH config alias
ssh gitwire
```

### External Access

| Service | URL |
|---------|-----|
| **API** | `https://gitwire.erlab.uk` |
| **Dashboard** | `https://gitwire.erlab.uk/dashboard` |
| **Webhook** | `https://gitwire.erlab.uk/webhooks/github` |
| **Docs** | `https://gitwire.erlab.uk/docs` |

All external access is via Cloudflare Tunnel — no inbound ports are opened on the container or host.

## Database: PostgreSQL 16

| Property | Value |
|----------|-------|
| **Container** | `gitwire-postgres-1` |
| **Database** | `gitops_hub` |
| **User** | `gitwire` |
| **Volume** | `gitwire_postgres_data` (named volume) |
| **Size** | ~17 MB (light — early deployment) |

### Connecting

```bash
# Inside CT 115
docker exec -it gitwire-postgres-1 psql -U gitwire -d gitops_hub
```

### Schema Migration Status

Migrations are applied **automatically on every container start** via the
root `docker-entrypoint.sh`, which runs `node scripts/migrate.js` fail-closed
before starting the app. If a migration fails, the container exits non-zero.

PostgreSQL's `docker-entrypoint-initdb.d` mechanism only runs on first
database creation; the app's own entrypoint covers subsequent starts.

See the [Deployment Runbook](/installation/deployment-runbook) for
the manual migration procedure (override or one-off reconciliation).

## Redis 7

| Property | Value |
|----------|-------|
| **Container** | `gitwire-redis-1` |
| **Volume** | `gitwire_redis_data` |
| **Keys** | ~4,500 (BullMQ job data) |
| **Memory** | ~75 MB used |

> **Redis memory policy:** `maxmemory 256mb` with `maxmemory-policy noeviction`
> is configured durably in `docker-compose.yml` via the Compose `command:` block.
> The `noeviction` policy is correct for BullMQ: evicting queue keys with
> `allkeys-lru` would silently drop active/delayed jobs. Write failures under
> `noeviction` are loud and recoverable.

## Active Deployments

GitWire is installed on **4 GitHub App installations** covering **32 repositories**.

| Installation | Repos |
|--------------|-------|
| Alajmah (personal) | 14 repos |
| Octo-Lex (org) | 10 repos |
| Tech-Innovate (org) | 7 repos |
| Startup-White-Box (org) | 1 repo |

### Real Activity (as of v0.20.0)

| Metric | Value |
|--------|-------|
| CI runs tracked | 1,239 |
| CI failures healed | 36 |
| CI heal attempts | 32 |
| AI reviews | 88 |
| Webhooks processed | 392 |
| Issue embeddings | 10 |

## LLM Provider

| Property | Value |
|----------|-------|
| **Provider** | Z.AI (Anthropic-compatible) |
| **Base URL** | `https://api.z.ai/api/anthropic` |
| **Model** | Claude (via Z.AI gateway) |

GitWire uses the Anthropic SDK pointed at Z.AI's compatibility endpoint. No
direct Anthropic API key is required — the Z.AI key works with the SDK's
`baseURL` override.

## GitHub App

| Property | Value |
|----------|-------|
| **App Name** | GitWire-HQ |
| **App ID** | `3727207` |
| **Client ID** | `Iv23liznUpaw9BDzmYBp` |
| **Webhook Secret** | Set in `/opt/gitwire/packages/web/.env` |
| **Client Secret** | Set in `/opt/gitwire/packages/web/.env` |
| **Private Key File** | `Gitwire-hq.2026-05-15.private-key.pem` (original download name) |
| **Deployed Key Path** | `/opt/gitwire/secrets/gitwire-hq.pem` |
| **Container Key Path** | Volume-mounted to `gitwire-hq.private-key.pem` |
| **Env Var** | `GITHUB_PRIVATE_KEY_PATH=./gitwire-hq.2026-05-15.private-key.pem` |

### ⚠️ PEM Key Security Note

The `.dockerignore` was missing `*.pem`, so the private key was baked into
the Docker image via `COPY . .`. This has been fixed — `.dockerignore` now
excludes `*.pem` and `secrets/`. The key should ONLY be available via the
volume mount in `docker-compose.yml`.

After the next rebuild, verify the key is NOT in the image:
```bash
docker exec gitwire-gitwire-app-1 ls -la /app/packages/web/gitwire-hq.2026-05-15.private-key.pem
# Should return: No such file or directory
```

## Cloudflare Tunnel

| Property | Value |
|----------|-------|
| **Domain** | `gitwire.erlab.uk` |
| **Zone** | `erlab.uk` |
| **Tunnel Type** | Token-based (remotely managed via Cloudflare dashboard) |
| **Protocol** | QUIC |
| **Connections** | 4 active (connIndex 0–3) |
| **Edge Locations** | `jed02` (Jeddah), `mrs06` (Marseille) |
| **Token** | Set as `TUNNEL_TOKEN` in `/opt/gitwire/.env` |
| **Container** | `cloudflare/cloudflared:latest` |

### Public Hostname Routing

All routing is configured remotely in the Cloudflare Zero Trust dashboard.
No local config file exists.

| URL Path | Service | Port |
|----------|---------|------|
| `/health` | gitwire-app | 3000 |
| `/webhooks/*` | gitwire-app | 3000 |
| `/dashboard` | gitwire-dashboard | 3001 |
| `/docs` | gitwire-docs | 80 |
| `/` (landing) | gitwire-landing | 80 |

### Verifying Tunnel Health

```bash
# From inside CT 115
curl -s https://gitwire.erlab.uk/health
# Expected: {"status":"ok"}

# Tunnel container logs
docker logs gitwire-tunnel-1 --tail 20
# Look for "Registered tunnel connection" — 4 connections = healthy

# Intermittent QUIC timeouts are normal (edge rebalancing)
```
