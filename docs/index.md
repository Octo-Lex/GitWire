---
layout: home

hero:
  name: "GitWire"
  text: "Self-hosted AI that manages your GitHub"
  tagline: 8 pillars of autonomous repository management — triage, CI healing, code fixes, enforcement, and more.
  actions:
    - theme: brand
      text: Get Started
      link: /installation/prerequisites
    - theme: alt
      text: API Reference
      link: /api/rest-api-reference
    - theme: alt
      text: GitHub
      link: https://github.com/Octo-Lex/GitWire

features:
  - title: Issue & PR Triage
    details: Claude classifies issues by type, priority, and duplicates. Labels applied automatically.
    link: /pillars/triage/issue-pr-triage
  - title: Self-Healing CI
    details: Failed CI run? GitWire diagnoses the failure, generates a patch, and opens a PR.
    link: /pillars/ci-healing/self-healing-ci
  - title: Autonomous Contributor
    details: Two-pass AI pipeline analyzes issues and generates full-file code fixes as pull requests.
    link: /pillars/contributor/autonomous-contributor
  - title: Maintainer Tools
    details: Stale issue scanner, branch cleanup, comment commands, and repository settings management.
    link: /pillars/maintainer/maintainer-tools
  - title: Multi-Repo Insights
    details: Real-time dashboard across all your repos. SWR polling, Recharts, fleet-wide health.
    link: /pillars/insights/multi-repo-insights
  - title: Branch Enforcement
    details: Policy-as-code for branch protection, naming conventions, and config drift detection.
    link: /pillars/enforcement/branch-enforcement
  - title: Merge Queue
    details: Batched merge queue with error recovery, rollback events, and configurable feedback rules.
    link: /pillars/merge-queue/merge-queue
  - title: AI Review Gate
    details: Pre-merge AI review with secret detection, SHA-256 audit trail, and SOC2 compliance reports.
    link: /pillars/review-gate/ai-review-gate
---

## What is GitWire?

GitWire is a self-hosted GitHub App that runs on your infrastructure. It connects to your GitHub account via a GitHub App and uses AI (Claude) to automate repository management tasks.

## Quick Numbers

| Metric | Count |
|--------|-------|
| Pillars | 8 |
| API Endpoints | 102 |
| Database Tables | 36 |
| Background Workers | 9 |
| Dashboard Pages | 12 |

## Tech Stack

- **Backend**: Node.js + Express + PostgreSQL 16 + Redis 7 + BullMQ
- **AI**: Claude (Anthropic API)
- **Frontend**: Next.js 16 + Tailwind CSS + SWR + Recharts
- **Deploy**: Docker Compose (5 containers)
- **Expose**: Cloudflare Tunnel (outbound-only, works behind NAT)

## Architecture Overview

```mermaid
graph LR
    GH[GitHub] -->|Webhook| API[GitWire API]
    API --> Q[Redis Queues]
    Q --> W1[Triage Worker]
    Q --> W2[CI Heal Worker]
    Q --> W3[Fix Worker]
    Q --> W4[Maintainer Worker]
    W1 -->|Labels| GH
    W2 -->|Patch PR| GH
    W3 -->|Fix PR| GH
    API --> DB[(PostgreSQL)]
    API --> DASH[Dashboard]
```

## Get Started

Head to the [Installation Guide](/installation/prerequisites) to set up GitWire, or jump straight to a specific pillar from the sidebar.
