---
layout: home

hero:
  name: "GitWire"
  text: "Self-hosted AI that manages your GitHub"
  tagline: Self-hosted AI that manages your GitHub — decide, execute, prove. 8 pillars of autonomous repository management with full operator observability.
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
  - title: First-Run Setup Checklist
    details: Dashboard shows what's configured, what's missing, and what to do next — guided operator onboarding.
    link: /guides/first-run-onboarding
  - title: Safe Starter Templates
    details: Five policy templates with explicit safety labels — from dry-run observer to strict governance.
    link: /guides/first-run-onboarding
  - title: Policy Preview & Simulation
    details: Validate, simulate, and compare policy changes before they affect repositories.
    link: /api/policy-preview
  - title: Governed Rollout Controls
    details: Controlled policy lifecycle — draft, validate, approve, promote, and roll back with audit evidence.
    link: /api/rollouts
---

## What is GitWire?

GitWire is a self-hosted GitHub App that runs on your infrastructure. It connects to your GitHub account via a GitHub App and uses AI (Claude) to automate repository management tasks.

## Quick Numbers

| Metric | Count |
|--------|-------|
| Pillars | 8 |
| API Endpoints | 110+ |
| Database Tables | 45 |
| Background Workers | 9 |
| Tests | 1,500+ |
| Starter Templates | 5 |

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
