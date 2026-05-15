# GitOps Hub — GitHub Account Management Platform

Backend API + background workers for managing GitHub accounts at scale.
Covers: Maintainer tools, Issue & PR triage, Self-healing CI, Multi-repo insights.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| Docker + Compose | any recent |
| A public URL | VPS / Cloudflare Tunnel / ngrok (for webhooks) |

---

## Step 1 — Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:
   - **App name:** `GitOps Hub` (or your own)
   - **Homepage URL:** your VPS URL
   - **Webhook URL:** `https://your-domain.com/webhooks/github`
   - **Webhook secret:** generate with `openssl rand -hex 32`, save it
3. **Permissions** (Repository):
   - Actions: Read & Write
   - Contents: Read & Write
   - Issues: Read & Write
   - Metadata: Read-only
   - Pull requests: Read & Write
   - Workflows: Read & Write
4. **Subscribe to events:**
   - Installation, Installation repositories
   - Issues, Pull request
   - Push, Workflow run
5. Create the app, then:
   - Note your **App ID** and **Client ID**
   - Generate a **Client secret**
   - Generate and download the **private key** (`.pem` file)

---

## Step 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all values. For the private key either:

**Option A** — paste the key inline:
```
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----"
```

**Option B** — save the `.pem` file and point to it:
```
GITHUB_PRIVATE_KEY_PATH=./config/private-key.pem
```

---

## Step 3 — Start dependencies

```bash
cd docker && docker compose up -d
cd ..
```

This starts PostgreSQL (port 5432) and Redis (port 6379).
The migrations in `db/migrations/` run automatically on first start.

---

## Step 4 — Install & run

```bash
npm install
npm run dev          # development (auto-restarts on changes)
```

You should see:
```
GitOps Hub server started  port=3000
Webhook endpoint: https://your-domain.com/webhooks/github
3 background workers started
Redis connected
```

---

## Step 5 — Expose your webhook URL

GitHub needs to reach your server. During development:

**Cloudflare Tunnel (free, persistent URL):**
```bash
cloudflared tunnel --url http://localhost:3000
```

**ngrok (temporary URL, free tier):**
```bash
ngrok http 3000
```

Copy the public URL and update the Webhook URL in your GitHub App settings.

---

## Step 6 — Install the App on your org

Go to `https://github.com/apps/<your-app-name>` and install it on the
organisation(s) or repositories you want to manage.

You should see a webhook delivery appear in GitHub → App settings → Advanced,
and a log line in your server:

```
Webhook received  event=installation action=created
Installation synced  installationId=12345 org=acme-corp
```

---

## Production deployment (VPS)

```bash
# 1. Install PM2 globally
npm install -g pm2

# 2. Copy nginx config
sudo cp docker/nginx.conf /etc/nginx/sites-available/gitops-hub
sudo ln -s /etc/nginx/sites-available/gitops-hub /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 3. Get SSL certificate
sudo certbot --nginx -d your-domain.com

# 4. Start with PM2
NODE_ENV=production pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to enable auto-start
```

---

## Project structure

```
gitops-hub/
├── config/
│   └── index.js              # Env validation (fails fast on missing vars)
├── db/
│   └── migrations/
│       └── 001_initial_schema.sql
├── docker/
│   ├── docker-compose.yml    # PostgreSQL + Redis
│   └── nginx.conf            # Reverse proxy
├── src/
│   ├── app.js                # Express app factory
│   ├── index.js              # Entry point (server + workers)
│   ├── lib/
│   │   ├── db.js             # PostgreSQL pool
│   │   ├── github.js         # Octokit / GitHub App helpers
│   │   ├── logger.js         # Pino logger
│   │   └── queue.js          # BullMQ queues + Redis
│   ├── routes/
│   │   └── webhooks.js       # POST /webhooks/github
│   └── workers/
│       ├── webhookWorker.js  # Installation + repo sync
│       ├── triageWorker.js   # AI issue/PR triage
│       └── ciHealWorker.js   # AI CI root-cause + healing
├── .env.example
├── ecosystem.config.cjs      # PM2 production config
└── package.json
```

---

## What's next

| Step | Module |
|------|--------|
| 2 | Sync worker — periodic full repo/issue sync |
| 3 | REST API + Next.js dashboard |
| 4 | Multi-repo insights |
| 5 | Full CI healing with auto-patch PRs |
