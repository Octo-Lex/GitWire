# First Triage

Get your first issue auto-triaged by GitWire.

## Prerequisites

- GitWire is [deployed and running](/installation/docker-compose)
- GitHub App is [installed on at least one repo](/installation/github-app-setup)

## Step 1: Create a Test Issue

Go to any repo where GitWire is installed and create a new issue:

**Title:** `App crashes when clicking the submit button on empty form`
**Body:** Leave blank or add a short description.
**Labels:** None needed — GitWire will add them.

## Step 2: Wait for the Webhook

Within a few seconds:

1. GitHub sends an `issues` webhook to GitWire
2. The [Webhook Worker](/workers/webhook-worker) routes it to the triage queue
3. The [Triage Worker](/workers/triage-worker) picks it up
4. Claude classifies the issue

## Step 3: Check the Dashboard

Open `https://gitwire.yourdomain.com/issues` and look for your issue. It should now have:

- **Triage Type**: `bug`
- **Priority**: `medium` or `high`
- **Summary**: A one-line AI-generated summary
- **Labels on GitHub**: `bug`, `priority: medium`

## Step 4: Check the API

```bash
curl https://gitwire.yourdomain.com/api/issues \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Look for your issue in the response with `triage_type`, `triage_priority`, and `triage_summary` fields populated.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Issue not triaged | Check webhook deliveries: `GET /api/webhooks` (use dashboard) |
| Triage fields empty | Check worker logs: `docker compose logs gitwire-app` |
| Labels not applied | Verify `issues:write` permission on the GitHub App |

→ [First CI Heal](/guides/first-ci-heal)
