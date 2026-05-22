# Dashboard

Next.js 16 web dashboard for monitoring and managing GitWire.

## Overview

| Feature | Technology |
|---------|-----------|
| Framework | Next.js 16 (App Router) |
| Styling | Tailwind CSS |
| Data Fetching | SWR (Stale-While-Revalidate) |
| Charts | Recharts |
| Deployment | Docker (standalone output) |

## Pages (12)

| Page | Route | Description |
|------|-------|-------------|
| Overview | `/` | Fleet-wide metrics and recent activity |
| Repos | `/repos` | Repository list with sync status |
| Issues | `/issues` | Issues with triage info |
| Pull Requests | `/pull-requests` | PRs with size/risk ratings |
| CI | `/ci` | CI runs + heal history tabs |
| Insights | `/insights` | Velocity and health charts |
| Maintainer | `/maintainer` | Stale management + governance tabs |
| Fix Attempts | `/fix-attempts` | Autonomous contributor history |
| Duplicates | `/duplicates` | Duplicate detection signals |
| Automation | `/automation` | Merge queue + feedback rules tabs |
| Trust | `/trust` | Flaky tests + deps + policies tabs |
| Intelligence | `/intelligence` | AI review + audit trail tabs |

## Design System

| Element | Value |
|---------|-------|
| Accent color | `#00D97E` (green) |
| Background | `#0F172A` (slate-900) |
| Surface | `#1E293B` (slate-800) |
| Text | `#F8FAFC` (slate-50) |
| Font | Inter (system) |

## Architecture

The dashboard is a separate Docker container (`gitwire-dashboard`) running Next.js in standalone mode.

```
Browser → Cloudflare Tunnel → Dashboard (:3001)
                                ↕
                          API Server (:3000)
```

→ [Pages](/dashboard/pages) | [Configuration](/dashboard/configuration)
