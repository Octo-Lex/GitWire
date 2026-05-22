# GitHub App Setup

Create and configure the GitHub App that GitWire uses to interact with your repositories.

## Step 1: Create the App

1. Go to **[GitHub Settings → Developer Settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new)**
2. Fill in the basic info:

| Field | Value |
|-------|-------|
| **GitHub App name** | `GitWire HQ` (or your preferred name) |
| **Homepage URL** | `https://gitwire.yourdomain.com` |
| **Webhook URL** | `https://gitwire.yourdomain.com/webhooks/github` |
| **Webhook secret** | A random string (save this for `.env`) |

3. Under **Where can this GitHub App be installed?** choose:
   - **Any account** (if you want to install on multiple orgs)
   - **Only on this account** (for personal use only)

## Step 2: Set Permissions

Under **Permissions → Repository permissions**, set:

| Permission | Access | Why |
|------------|--------|-----|
| Actions | Read & write | Read CI run results, trigger re-runs |
| Administration | Read & write | Manage branch protection, repo settings |
| Checks | Read & write | Create Check Runs on PRs |
| Contents | Read & write | Read files for AI fixes, create branches, commit |
| Issues | Read & write | Triaging, labeling, commenting, closing |
| Metadata | Read-only | Basic repo info (required) |
| Pull requests | Read & write | Review, merge, comment, create PRs |
| Statuses | Read-only | Read commit statuses |
| Workflows | Read & write | Trigger and manage GitHub Actions |

Under **Permissions → Organization permissions**, set:

| Permission | Access | Why |
|------------|--------|-----|
| Members | Read-only | Sync org members |
| Administration | Read & write | Manage org-level settings |

## Step 3: Subscribe to Events

Under **Subscribe to events**, check:

- ✅ **Issue comment** — `/gitwire` commands in comments
- ✅ **Issues** — New issues for triage
- ✅ **Pull request** — PR triage, AI review
- ✅ **Pull request review** — Review feedback
- ✅ **Push** — Config validation on push
- ✅ **Repository** — Detect new/deleted repos
- ✅ **Workflow run** — CI healing on failures

## Step 4: Generate Private Key

After creating the app:

1. Scroll to **Private keys**
2. Click **Generate a private key**
3. Save the `.pem` file — this is your `GITHUB_PRIVATE_KEY_PATH`

## Step 5: Note Your App ID

Copy the **App ID** from the top of the app settings page. This is your `GITHUB_APP_ID`.

## Step 6: Install the App

1. In the left sidebar, click **Install App**
2. Click **Install** on the account or org where you want it
3. Choose **All repositories** or **Only select repositories**
4. After installation, note the **installation ID** from the URL

## Step 7: Configure GitWire

Add these values to your `.env`:

```bash
GITHUB_APP_ID=3727207
GITHUB_APP_CLIENT_ID=Iv1.xxxxxxx
GITHUB_APP_CLIENT_SECRET=your-client-secret
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_PRIVATE_KEY_PATH=/opt/gitwire/secrets/gitwire-hq.private-key.pem
```

## Verifying

After deployment, push a test issue to any installed repo. You should see a webhook delivery in the GitWire dashboard under **Webhooks**.

## Next Step

→ [Environment Variables Reference](/installation/environment-variables)
