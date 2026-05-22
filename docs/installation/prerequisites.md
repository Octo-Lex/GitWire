# Prerequisites

Before installing GitWire, make sure you have the following.

## Server Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **OS** | Any Linux with Docker | Ubuntu 24.04 LTS |
| **CPU** | 2 cores | 4 cores |
| **RAM** | 2 GB | 4 GB |
| **Disk** | 16 GB | 32 GB |
| **Docker** | 24.0+ | 29.x |
| **Docker Compose** | v2.0+ | v2.30+ |

## Account Requirements

| Requirement | Why |
|-------------|-----|
| **GitHub account** | To create the GitHub App and install it on repos |
| **Anthropic API key** | GitWire uses Claude for AI triage, CI healing, and code fixes |
| **Domain name** | For the webhook callback URL (via Cloudflare Tunnel) |
| **Cloudflare account** | To create the tunnel (free tier works) |

## Network Requirements

GitWire uses **Cloudflare Tunnel** for inbound connectivity. This means:

- **No inbound ports** need to be opened
- **No static IP** required
- Works behind **NAT, firewalls, and home networks**
- Only outbound HTTPS connections to Cloudflare

## Software Stack

GitWire runs as Docker containers — no host-level software needed beyond Docker:

| Component | Version | Purpose |
|-----------|---------|---------|
| Node.js | 20 LTS | API server + workers (inside container) |
| PostgreSQL | 16 | Database (36 tables) |
| Redis | 7 | Job queues (9 workers via BullMQ) |
| Cloudflared | latest | Tunnel to Cloudflare |

## Next Step

→ [Docker Compose Deployment](/installation/docker-compose)
