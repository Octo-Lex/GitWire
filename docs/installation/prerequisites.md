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

## Deployment Topology

GitWire is deployed as an **unprivileged LXC container** on Proxmox VE:

| Layer | Technology | Details |
|-------|-----------|--------|
| **Hypervisor** | Proxmox VE 8.4 | `pve` host, kernel 6.8.12-13-pve |
| **Container** | LXC (CT 115) | Ubuntu, `nesting=1` for Docker-in-LXC |
| **Runtime** | Docker 29.x | 9 containers via Compose |
| **Tunnel** | Cloudflare Tunnel | Outbound-only, no inbound ports |

### Container 115 — `gitwire`

| Resource | Allocated | Notes |
|----------|-----------|-------|
| **CPU** | 2 cores | Sufficient for current workload |
| **RAM** | 2 GB | Recommended: increase to 4 GB for v0.20+ validator |
| **Disk** | 16 GB (LVM) | Monitor — Docker images grow over time |
| **Swap** | 512 MB | 58% utilized under load |
| **Boot** | `onboot: 1` | Starts automatically with PVE host |
| **Network** | `192.168.3.151/24` | Bridge `vmbr0`, gateway `192.168.3.1` |

### Management

```bash
# SSH into the GitWire container via PVE host
ssh root@192.168.3.5        # Proxmox host
pct exec 115 -- bash         # Enter CT 115

# Or with the SSH config alias
ssh gitwire

# Proxmox web UI
# https://192.168.3.5:8006
```

### v0.20 Memory Consideration

The pass-capable Docker executor (v0.20.0) runs isolated validation containers
inside the LXC host. This requires additional memory headroom beyond the
existing 9 containers. **Increase CT 115 memory from 2 GB to 4 GB** before
enabling production pass-capable execution.

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
