# Cloudflare Tunnel

Expose GitWire to the internet without opening any inbound ports.

## Why Cloudflare Tunnel?

- **Free** on Cloudflare's plan
- **Outbound-only** — your server makes a connection to Cloudflare, no ports to open
- **Works behind NAT** — perfect for home servers, Proxmox, homelabs
- **HTTPS automatically** — Cloudflare handles TLS termination
- **Permanent** — the tunnel stays connected via token, not a temporary URL

## Step 1: Install cloudflared

On your server:

```bash
# Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared
```

## Step 2: Login to Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser window to authorize cloudflared with your Cloudflare account.

## Step 3: Create a Tunnel

```bash
cloudflared tunnel create gitwire
```

Note the **tunnel ID** from the output (e.g. `36835d1a-9576-49b5-bd2b-2506372d2d2d`).

## Step 4: Route DNS

```bash
cloudflared tunnel route dns gitwire gitwire.yourdomain.com
```

This creates a CNAME record pointing `gitwire.yourdomain.com` to your tunnel.

## Step 5: Get the Tunnel Token

From the Cloudflare dashboard:

1. Go to **Zero Trust** → **Networks** → **Tunnels**
2. Find your `gitwire` tunnel
3. Click **Install** → copy the tunnel token

Or via CLI:

```bash
cloudflared tunnel token gitwire
```

## Step 6: Configure GitWire

Add the tunnel token to your `.env`:

```bash
TUNNEL_TOKEN=your-tunnel-token-here
```

The `cloudflared` container in `docker-compose.prod.yml` automatically uses this token.

## Routing: API + Dashboard

If you want the dashboard on the same domain, configure Cloudflare Tunnel rules:

| Path Pattern | Service | Port |
|-------------|---------|------|
| `api/*` | gitwire-app | 3000 |
| `webhooks/*` | gitwire-app | 3000 |
| `health` | gitwire-app | 3000 |
| `*` (everything else) | gitwire-dashboard | 3001 |

This is configured in the Cloudflare dashboard under **Public Hostname** → **Service** for your tunnel.

## Verifying

```bash
curl https://gitwire.yourdomain.com/health
```

Should return `{"status":"ok",...}`.

## Next Step

→ [GitHub App Setup](/installation/github-app-setup)
