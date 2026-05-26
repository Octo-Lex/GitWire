// Mock data for the GitWire demo dashboard.
// All data is fictional. No real repos, users, or events.

export const REPOS = [
  { github_id: 101, full_name: "acme/api-gateway", owner: "acme", name: "api-gateway", language: "TypeScript", stars: 142, open_issues: 7, open_prs: 3, ci_pass_rate: 92, health_status: "healthy", default_branch: "main", last_synced_at: "2026-05-26T12:30:00Z", private: true },
  { github_id: 102, full_name: "acme/web-frontend", owner: "acme", name: "web-frontend", language: "TypeScript", stars: 89, open_issues: 12, open_prs: 5, ci_pass_rate: 78, health_status: "warning", default_branch: "main", last_synced_at: "2026-05-26T12:28:00Z", private: true },
  { github_id: 103, full_name: "acme/mobile-app", owner: "acme", name: "mobile-app", language: "Kotlin", stars: 34, open_issues: 23, open_prs: 8, ci_pass_rate: 64, health_status: "critical", default_branch: "develop", last_synced_at: "2026-05-26T12:25:00Z", private: true },
  { github_id: 104, full_name: "acme/data-pipeline", owner: "acme", name: "data-pipeline", language: "Python", stars: 56, open_issues: 4, open_prs: 1, ci_pass_rate: 95, health_status: "healthy", default_branch: "main", last_synced_at: "2026-05-26T12:20:00Z", private: true },
  { github_id: 105, full_name: "acme/infrastructure", owner: "acme", name: "infrastructure", language: "Go", stars: 21, open_issues: 2, open_prs: 2, ci_pass_rate: 88, health_status: "healthy", default_branch: "main", last_synced_at: "2026-05-26T10:00:00Z", private: true },
  { github_id: 106, full_name: "acme/auth-service", owner: "acme", name: "auth-service", language: "Rust", stars: 67, open_issues: 9, open_prs: 4, ci_pass_rate: 71, health_status: "warning", default_branch: "main", last_synced_at: "2026-05-26T11:45:00Z", private: true },
  { github_id: 107, full_name: "acme/docs", owner: "acme", name: "docs", language: "TypeScript", stars: 15, open_issues: 1, open_prs: 0, ci_pass_rate: 100, health_status: "healthy", default_branch: "main", last_synced_at: "2026-05-25T18:00:00Z", private: false },
  { github_id: 108, full_name: "acme/ml-models", owner: "acme", name: "ml-models", language: "Python", stars: 203, open_issues: 15, open_prs: 6, ci_pass_rate: 55, health_status: "critical", default_branch: "main", last_synced_at: "2026-05-26T12:32:00Z", private: true },
];

export const ISSUES = [
  { id: 1, number: 412, title: "Memory leak in WebSocket handler after reconnect", state: "open", labels: ["bug", "priority:high"], author: "sarah-chen", created_at: "2026-05-25T09:00:00Z", triage_label: "bug", confidence: 0.94, repo: "acme/api-gateway" },
  { id: 2, number: 203, title: "Add rate limiting to public API endpoints", state: "open", labels: ["enhancement", "good first issue"], author: "marcus-j", created_at: "2026-05-24T14:30:00Z", triage_label: "enhancement", confidence: 0.87, repo: "acme/api-gateway" },
  { id: 3, number: 89, title: "Crash on launch when offline", state: "open", labels: ["bug", "priority:critical"], author: "alex-kim", created_at: "2026-05-26T08:15:00Z", triage_label: "bug", confidence: 0.98, repo: "acme/mobile-app" },
  { id: 4, number: 156, title: "Upgrade to React 19", state: "open", labels: ["dependencies"], author: "dependabot", created_at: "2026-05-23T06:00:00Z", triage_label: "dependencies", confidence: 0.99, repo: "acme/web-frontend" },
  { id: 5, number: 78, title: "NullPointerException in PaymentProcessor.charge()", state: "open", labels: ["bug"], author: "jordan-p", created_at: "2026-05-26T10:00:00Z", triage_label: "bug", confidence: 0.91, repo: "acme/api-gateway" },
  { id: 6, number: 34, title: "Document SSO configuration flow", state: "open", labels: ["documentation"], author: "taylor-r", created_at: "2026-05-22T11:00:00Z", triage_label: "documentation", confidence: 0.85, repo: "acme/docs" },
  { id: 7, number: 567, title: "Slow query on user dashboard aggregation", state: "open", labels: ["performance"], author: "casey-w", created_at: "2026-05-25T16:45:00Z", triage_label: "performance", confidence: 0.82, repo: "acme/data-pipeline" },
  { id: 8, number: 234, title: "Feature flag toggle not updating in real-time", state: "open", labels: ["bug", "priority:medium"], author: "river-s", created_at: "2026-05-24T20:00:00Z", triage_label: "bug", confidence: 0.89, repo: "acme/web-frontend" },
  { id: 9, number: 12, title: "Migrate CI from Jenkins to GitHub Actions", state: "open", labels: ["enhancement", "infrastructure"], author: "dana-l", created_at: "2026-05-20T09:30:00Z", triage_label: "enhancement", confidence: 0.76, repo: "acme/infrastructure" },
  { id: 10, number: 45, title: "Token refresh race condition in concurrent requests", state: "open", labels: ["bug", "priority:high"], author: "sarah-chen", created_at: "2026-05-26T06:00:00Z", triage_label: "bug", confidence: 0.93, repo: "acme/auth-service" },
];

export const PULL_REQUESTS = [
  { id: 1, number: 891, title: "Fix memory leak in WebSocket reconnect", state: "open", author: "sarah-chen", branch: "fix/ws-leak", created_at: "2026-05-25T10:00:00Z", additions: 42, deletions: 18, repo: "acme/api-gateway", merged: false },
  { id: 2, number: 445, title: "Add rate limiter middleware", state: "open", author: "marcus-j", branch: "feat/rate-limit", created_at: "2026-05-24T15:00:00Z", additions: 234, deletions: 12, repo: "acme/api-gateway", merged: false },
  { id: 3, number: 122, title: "Update Next.js to 15.3", state: "open", author: "dependabot", branch: "dependabot/npm_and_yarn/next-15.3.0", created_at: "2026-05-23T06:00:00Z", additions: 156, deletions: 89, repo: "acme/web-frontend", merged: false },
  { id: 4, number: 567, title: "Optimize dashboard aggregation query", state: "merged", author: "casey-w", branch: "perf/dashboard-query", created_at: "2026-05-22T10:00:00Z", additions: 28, deletions: 45, repo: "acme/data-pipeline", merged: true },
  { id: 5, number: 89, title: "Fix offline crash on launch", state: "open", author: "gitwire[bot]", branch: "fix/ci-heal-#89", created_at: "2026-05-26T09:00:00Z", additions: 18, deletions: 4, repo: "acme/mobile-app", merged: false },
  { id: 6, number: 234, title: "Add SSO config documentation", state: "merged", author: "taylor-r", branch: "docs/sso-config", created_at: "2026-05-21T14:00:00Z", additions: 312, deletions: 0, repo: "acme/docs", merged: true },
  { id: 7, number: 178, title: "Refresh token race condition fix", state: "open", author: "gitwire[bot]", branch: "fix/ci-heal-#45", created_at: "2026-05-26T07:30:00Z", additions: 35, deletions: 12, repo: "acme/auth-service", merged: false },
  { id: 8, number: 90, title: "Feature flag real-time updates via SSE", state: "open", author: "river-s", branch: "feat/flag-sse", created_at: "2026-05-25T08:00:00Z", additions: 189, deletions: 23, repo: "acme/web-frontend", merged: false },
];

export const CI_RUNS = [
  { id: 1, github_run_id: 101001, branch: "main", conclusion: "success", event: "push", duration: 142, created_at: "2026-05-26T12:00:00Z", repo: "acme/api-gateway", heal_status: null, commit_message: "chore: update deps" },
  { id: 2, github_run_id: 101002, branch: "main", conclusion: "failure", event: "push", duration: 87, created_at: "2026-05-26T11:00:00Z", repo: "acme/web-frontend", heal_status: "healed", commit_message: "feat: add user avatar component" },
  { id: 3, github_run_id: 101003, branch: "develop", conclusion: "failure", event: "push", duration: 234, created_at: "2026-05-26T10:30:00Z", repo: "acme/mobile-app", heal_status: "failed", commit_message: "feat: add payment flow" },
  { id: 4, github_run_id: 101004, branch: "main", conclusion: "success", event: "push", duration: 56, created_at: "2026-05-26T09:00:00Z", repo: "acme/data-pipeline", heal_status: null, commit_message: "fix: null check in aggregation" },
  { id: 5, github_run_id: 101005, branch: "main", conclusion: "failure", event: "push", duration: 312, created_at: "2026-05-26T08:00:00Z", repo: "acme/ml-models", heal_status: null, commit_message: "feat: add BERT fine-tuning pipeline" },
  { id: 6, github_run_id: 101006, branch: "fix/ws-leak", conclusion: "success", event: "pull_request", duration: 98, created_at: "2026-05-25T10:30:00Z", repo: "acme/api-gateway", heal_status: null, commit_message: "fix: memory leak in WS reconnect" },
  { id: 7, github_run_id: 101007, branch: "main", conclusion: "success", event: "push", duration: 44, created_at: "2026-05-25T08:00:00Z", repo: "acme/infrastructure", heal_status: null, commit_message: "chore: update terraform providers" },
  { id: 8, github_run_id: 101008, branch: "main", conclusion: "failure", event: "push", duration: 178, created_at: "2026-05-24T22:00:00Z", repo: "acme/auth-service", heal_status: "healed", commit_message: "feat: add token rotation" },
  { id: 9, github_run_id: 101009, branch: "main", conclusion: "success", event: "push", duration: 67, created_at: "2026-05-24T16:00:00Z", repo: "acme/docs", heal_status: null, commit_message: "docs: add SSO configuration guide" },
  { id: 10, github_run_id: 101010, branch: "main", conclusion: "failure", event: "push", duration: 95, created_at: "2026-05-24T12:00:00Z", repo: "acme/web-frontend", heal_status: "pending", commit_message: "feat: dark mode support" },
];

export const ACTIONS = [
  { id: 1, repo_full_name: "acme/web-frontend", pillar: "ci_healing", action_type: "create-patch-pr", source: "ci_heal:timeout", status: "succeeded", proposed_at: "2026-05-26T11:02:00Z", resolved_at: "2026-05-26T11:05:00Z", evidence: { run_id: 101002, pr_number: 891, conclusion: "timeout" } },
  { id: 2, repo_full_name: "acme/mobile-app", pillar: "ci_healing", action_type: "create-patch-pr", source: "ci_heal:compilation", status: "failed", proposed_at: "2026-05-26T10:32:00Z", resolved_at: "2026-05-26T10:35:00Z", error_message: "Unable to parse build log", retries: 2 },
  { id: 3, repo_full_name: "acme/api-gateway", pillar: "triage", action_type: "add-label", source: "ai_triage", status: "reconciled", proposed_at: "2026-05-25T09:01:00Z", resolved_at: "2026-05-25T09:01:02Z", reconciliation_status: "confirmed" },
  { id: 4, repo_full_name: "acme/api-gateway", pillar: "issue_fix", action_type: "create-patch-pr", source: "issue_fix:#78", status: "executing", proposed_at: "2026-05-26T10:02:00Z" },
  { id: 5, repo_full_name: "acme/web-frontend", pillar: "custom_rules", action_type: "approve", source: "custom_rule:auto-approve-deps", status: "succeeded", proposed_at: "2026-05-23T06:01:00Z", resolved_at: "2026-05-23T06:01:05Z" },
  { id: 6, repo_full_name: "acme/auth-service", pillar: "ci_healing", action_type: "create-patch-pr", source: "ci_heal:test_failure", status: "retrying", proposed_at: "2026-05-24T22:02:00Z", retries: 1 },
  { id: 7, repo_full_name: "acme/docs", pillar: "maintainer", action_type: "add-comment", source: "stale_reminder", status: "succeeded", proposed_at: "2026-05-22T09:00:00Z", resolved_at: "2026-05-22T09:00:03Z" },
  { id: 8, repo_full_name: "acme/data-pipeline", pillar: "quality_gates", action_type: "create-check", source: "gate:coverage-drop", status: "succeeded", proposed_at: "2026-05-25T10:00:00Z", resolved_at: "2026-05-25T10:00:04Z" },
  { id: 9, repo_full_name: "acme/web-frontend", pillar: "ci_healing", action_type: "create-patch-pr", source: "ci_heal:linter", status: "cancelled", proposed_at: "2026-05-24T12:02:00Z", error_message: "Superseded by manual fix", resolved_at: "2026-05-24T12:05:00Z" },
  { id: 10, repo_full_name: "acme/ml-models", pillar: "triage", action_type: "add-label", source: "ai_triage", status: "proposed", proposed_at: "2026-05-26T08:16:00Z" },
];

export const DELIVERIES = [
  { id: 1, delivery_id: "d-001", event: "push", repo: "acme/api-gateway", status: "processed", created_at: "2026-05-26T12:00:00Z", duration_ms: 45 },
  { id: 2, delivery_id: "d-002", event: "push", repo: "acme/web-frontend", status: "processed", created_at: "2026-05-26T11:00:00Z", duration_ms: 67 },
  { id: 3, delivery_id: "d-003", event: "issues", repo: "acme/mobile-app", status: "processed", created_at: "2026-05-26T08:15:00Z", duration_ms: 32 },
  { id: 4, delivery_id: "d-004", event: "pull_request", repo: "acme/api-gateway", status: "processed", created_at: "2026-05-25T10:00:00Z", duration_ms: 58 },
  { id: 5, delivery_id: "d-005", event: "push", repo: "acme/data-pipeline", status: "processed", created_at: "2026-05-26T09:00:00Z", duration_ms: 41 },
  { id: 6, delivery_id: "d-006", event: "push", repo: "acme/ml-models", status: "processed", created_at: "2026-05-26T08:00:00Z", duration_ms: 52 },
  { id: 7, delivery_id: "d-007", event: "issue_comment", repo: "acme/web-frontend", status: "processed", created_at: "2026-05-24T20:05:00Z", duration_ms: 28 },
  { id: 8, delivery_id: "d-008", event: "push", repo: "acme/auth-service", status: "processed", created_at: "2026-05-24T22:00:00Z", duration_ms: 63 },
  { id: 9, delivery_id: "d-009", event: "installation", repo: "acme/docs", status: "processed", created_at: "2026-05-20T10:00:00Z", duration_ms: 89 },
  { id: 10, delivery_id: "d-010", event: "check_suite", repo: "acme/infrastructure", status: "processed", created_at: "2026-05-25T08:00:00Z", duration_ms: 37 },
];

export const GATES = [
  { name: "Test Coverage", repo: "acme/api-gateway", passing: true, last_eval: "2026-05-26T12:00:00Z", value: "87%", threshold: "≥80%" },
  { name: "Test Coverage", repo: "acme/web-frontend", passing: false, last_eval: "2026-05-26T11:00:00Z", value: "72%", threshold: "≥80%" },
  { name: "Build Time", repo: "acme/api-gateway", passing: true, last_eval: "2026-05-26T12:00:00Z", value: "142s", threshold: "≤300s" },
  { name: "Flaky Test Ratio", repo: "acme/mobile-app", passing: false, last_eval: "2026-05-26T10:30:00Z", value: "8.2%", threshold: "≤5%" },
  { name: "Dep Vulnerabilities", repo: "acme/web-frontend", passing: false, last_eval: "2026-05-26T11:00:00Z", value: "3 critical", threshold: "0 critical" },
  { name: "Dep Vulnerabilities", repo: "acme/data-pipeline", passing: true, last_eval: "2026-05-26T09:00:00Z", value: "0 critical", threshold: "0 critical" },
  { name: "PR Review Coverage", repo: "acme/api-gateway", passing: true, last_eval: "2026-05-26T12:00:00Z", value: "100%", threshold: "≥90%" },
  { name: "Build Time", repo: "acme/ml-models", passing: false, last_eval: "2026-05-26T08:00:00Z", value: "312s", threshold: "≤300s" },
];

export const DECISIONS = [
  { id: 1, repo: "acme/web-frontend", type: "auto_heal", decision: "approved", confidence: 0.94, reason: "Timeout in CI run #101002. Patch generated for missing error handler.", pillar: "ci_healing", created_at: "2026-05-26T11:02:00Z" },
  { id: 2, repo: "acme/api-gateway", type: "triage", decision: "auto_labeled", confidence: 0.94, reason: "Issue #412 classified as bug with 94% confidence. Label 'priority:high' applied.", pillar: "triage", created_at: "2026-05-25T09:01:00Z" },
  { id: 3, repo: "acme/web-frontend", type: "custom_rule", decision: "auto_approved", confidence: 1.0, reason: "Dependabot PR for Next.js matches auto-approve-deps rule.", pillar: "custom_rules", created_at: "2026-05-23T06:01:00Z" },
  { id: 4, repo: "acme/data-pipeline", type: "quality_gate", decision: "gate_passed", confidence: 1.0, reason: "All quality gate checks passing. Coverage 95%, build time 56s, 0 vulnerabilities.", pillar: "quality_gates", created_at: "2026-05-26T09:00:00Z" },
  { id: 5, repo: "acme/mobile-app", type: "auto_heal", decision: "rejected", confidence: 0.45, reason: "Compilation error in CI run #101003. Confidence below 50% threshold — manual review required.", pillar: "ci_healing", created_at: "2026-05-26T10:32:00Z" },
  { id: 6, repo: "acme/api-gateway", type: "issue_fix", decision: "approved", confidence: 0.88, reason: "NullPointerException in PaymentProcessor. Patch generated adding null check with unit test.", pillar: "issue_fix", created_at: "2026-05-26T10:02:00Z" },
  { id: 7, repo: "acme/docs", type: "maintainer", decision: "auto_comment", confidence: 0.99, reason: "Issue #34 has been open for 30 days with no activity. Stale reminder posted.", pillar: "maintainer", created_at: "2026-05-22T09:00:00Z" },
  { id: 8, repo: "acme/auth-service", type: "auto_heal", decision: "retrying", confidence: 0.82, reason: "Test failure in CI run #101008. First patch attempt partially succeeded. Retrying with expanded scope.", pillar: "ci_healing", created_at: "2026-05-24T22:02:00Z" },
];

export const LANDING_STATS = {
  repos: 8,
  issues_tracked: 73,
  prs_managed: 29,
  actions_taken: 156,
  ci_healed: 23,
  decisions_made: 412,
  avg_confidence: 0.89,
  deliveries_processed: 1247,
  uptime: "99.7%",
};

export const ACTIVITY_FEED = [
  { id: 1, source: "ci_healing", repo: "acme/web-frontend", message: "Healed CI timeout — patch PR #891 created", ts: "2026-05-26T11:05:00Z", type: "success" },
  { id: 2, source: "triage", repo: "acme/api-gateway", message: "Issue #412 triaged as bug (94% confidence)", ts: "2026-05-25T09:01:00Z", type: "info" },
  { id: 3, source: "custom_rules", repo: "acme/web-frontend", message: "Dependabot PR auto-approved via rule", ts: "2026-05-23T06:01:00Z", type: "info" },
  { id: 4, source: "quality_gates", repo: "acme/data-pipeline", message: "All quality gates passing ✅", ts: "2026-05-26T09:00:00Z", type: "success" },
  { id: 5, source: "ci_healing", repo: "acme/mobile-app", message: "CI heal failed — compilation error, retrying", ts: "2026-05-26T10:35:00Z", type: "warning" },
  { id: 6, source: "issue_fix", repo: "acme/api-gateway", message: "Generating patch for NullPointerException", ts: "2026-05-26T10:02:00Z", type: "info" },
  { id: 7, source: "maintainer", repo: "acme/docs", message: "Stale reminder posted on issue #34", ts: "2026-05-22T09:00:00Z", type: "info" },
  { id: 8, source: "ci_healing", repo: "acme/auth-service", message: "CI heal retrying (attempt 2 of 3)", ts: "2026-05-24T22:02:00Z", type: "warning" },
  { id: 9, source: "triage", repo: "acme/ml-models", message: "Issue triaged — awaiting approval", ts: "2026-05-26T08:16:00Z", type: "info" },
  { id: 10, source: "ci_healing", repo: "acme/web-frontend", message: "CI heal cancelled — superseded by manual fix", ts: "2026-05-24T12:05:00Z", type: "muted" },
];

export const READINESS = [
  { repo: "acme/api-gateway", score: 92, pillars: { ci_healing: 95, triage: 90, enforcement: 88, quality_gates: 95, maintainer: 92 } },
  { repo: "acme/web-frontend", score: 74, pillars: { ci_healing: 80, triage: 85, enforcement: 70, quality_gates: 55, maintainer: 80 } },
  { repo: "acme/mobile-app", score: 58, pillars: { ci_healing: 45, triage: 75, enforcement: 60, quality_gates: 40, maintainer: 70 } },
  { repo: "acme/data-pipeline", score: 89, pillars: { ci_healing: 90, triage: 85, enforcement: 92, quality_gates: 90, maintainer: 88 } },
  { repo: "acme/infrastructure", score: 85, pillars: { ci_healing: 82, triage: 78, enforcement: 90, quality_gates: 88, maintainer: 87 } },
  { repo: "acme/auth-service", score: 72, pillars: { ci_healing: 68, triage: 82, enforcement: 75, quality_gates: 60, maintainer: 75 } },
  { repo: "acme/docs", score: 95, pillars: { ci_healing: 98, triage: 90, enforcement: 95, quality_gates: 98, maintainer: 94 } },
  { repo: "acme/ml-models", score: 48, pillars: { ci_healing: 35, triage: 65, enforcement: 50, quality_gates: 38, maintainer: 52 } },
];
