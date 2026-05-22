# First CI Heal

Trigger and observe GitWire's self-healing CI pipeline.

## Prerequisites

- GitWire is deployed with a repo that has GitHub Actions workflows
- The `workflow_run` event is subscribed on your GitHub App
- The repo has a CI workflow that can intentionally fail

## Step 1: Create a Failing CI Run

Introduce a deliberate error in your repo (e.g., a lint error):

```javascript
// Add this to a JS file to trigger ESLint
const  x  =  1  // extra spaces → lint error
```

Commit and push. GitHub Actions will run and fail.

## Step 2: Watch the Webhook

GitHub sends a `workflow_run` webhook with `conclusion: "failure"`.

## Step 3: Watch the Diagnosis

The [CI Heal Worker](/workers/ci-heal-worker) will:

1. Fetch the failure logs
2. Send to Claude for diagnosis
3. Classify the failure type (e.g., `lint_error`)
4. If healable → fetch the failing file → generate fix → open PR

## Step 4: Check the PR

If the failure is healable, GitWire will:

1. Create a branch: `gitwire/heal/{run_id}`
2. Commit the fixed file
3. Open a PR with:
   - Title: `fix(ci): resolve lint_error in path/to/file.js`
   - Body: Root cause, fix applied, confidence level

Check `https://gitwire.yourdomain.com/ci` for the healing status.

## Step 5: Review and Merge

1. Review the auto-generated PR on GitHub
2. If the fix looks correct, merge it
3. If not, close the PR and fix manually

## Dashboard Verification

```bash
# Check CI stats
curl https://gitwire.yourdomain.com/api/ci/stats \
  -H "Authorization: Bearer YOUR_API_KEY"

# Check heal history
curl https://gitwire.yourdomain.com/api/heal/stats \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No healing triggered | Verify `workflow_run` event is subscribed |
| Failure not diagnosed | Check ANTHROPIC_API_KEY is valid |
| Fix PR not created | Failure type may not be healable (check `heal_status: skipped`) |
| PR has bad fix | Check `heal_confidence` — low confidence fixes need more review |

→ [First Contributor Fix](/guides/first-contributor-fix)
