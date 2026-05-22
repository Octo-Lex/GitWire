# CI Heal Worker

Diagnoses failed CI runs and generates patch PRs.

## Queue: `ci-healing`

## Job Flow

1. Receive job with CI run data
2. Fetch failure logs from GitHub Actions API
3. Send logs to Claude for diagnosis
4. Parse: failure type, root cause, healable flag
5. Update `ci_runs` with diagnosis
6. If healable and not already healed:
   - Fetch failing file from GitHub
   - Send file + context to Claude for full-file fix
   - Validate the fix (non-empty, line delta, syntax)
   - Create branch, commit, open PR
   - Record in `heal_prs`

## Claude Diagnosis

Claude receives the last ~100 lines of the failure log and returns:

```json
{
  "failure_type": "lint_error",
  "root_cause": "Missing semicolon on line 42 of src/utils.ts",
  "healable": true,
  "confidence": "high"
}
```

## Full-File Fix Generation

The fix is generated as a complete file replacement:

1. Fetch current file from `GET /repos/:owner/:repo/contents/:path`
2. Send file + error to Claude: "Fix this file to resolve the error"
3. Claude returns the entire corrected file
4. GitWire validates and commits

## Branch Naming

```
gitwire/heal/{github_run_id}
```

## Worker File

`packages/web/src/workers/ciHealWorker.js`

→ [Sync Worker](/workers/sync-worker)
