# Dashboard Configuration

How to configure and deploy the GitWire dashboard.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | ✅ | Public URL of the GitWire API |
| `HOSTNAME` | ✅ | Set to `0.0.0.0` in Docker (required for standalone mode) |

## Docker Deployment

The dashboard runs as a separate container in `docker-compose.prod.yml`:

```yaml
gitwire-dashboard:
  build:
    context: ../../packages/web-dashboard
    dockerfile: Dockerfile
  environment:
    NEXT_PUBLIC_API_URL: https://gitwire.yourdomain.com
    HOSTNAME: "0.0.0.0"
  ports:
    - "3001:3000"
```

::: warning HOSTNAME must be 0.0.0.0
Next.js standalone mode defaults to binding to `localhost` inside the container. Setting `HOSTNAME: "0.0.0.0"` makes it listen on all interfaces so the tunnel can reach it.
:::

## Standalone Output

The dashboard uses `output: 'standalone'` in `next.config.ts`, which produces a minimal Node.js server. The Docker image copies only the standalone output, keeping the image small.

## Building Locally

```bash
cd packages/web-dashboard
npm run dev
# Dashboard available at http://localhost:3001
```

## Cloudflare Tunnel Routing

To serve both API and dashboard on the same domain:

| Path | Service | Port |
|------|---------|------|
| `/api/*`, `/webhooks/*`, `/health` | gitwire-app | 3000 |
| `/*` (everything else) | gitwire-dashboard | 3001 |

→ [Architecture](/architecture/system-architecture)
