# Secret Scan Incident Report

> **Status:** IMPLEMENTED — HISTORY PURGE COMPLETE; ROTATION PENDING  
> **Acceptance:** BLOCKED on Gate 1 (secret rotation) only. Gate 2 (history purge) is complete — verified by `gitleaks git --log-opts="--all"` returning 0 findings across all commits.  
> **After closure:** APPROVED FOR PUBLIC RELEASE  
>  
> **Generated:** 2026-05-21 | **Scanner:** gitleaks v8.21.2 | **Scope:** Full git history (55 commits) | **Stress test:** 48 scenarios (46 pass, 0 fail, 2 skip)

## Summary

| Metric | Value |
|--------|-------|
| Total commits scanned | 55 |
| Findings | 2 |
| Unique secrets | 2 |
| Affected file | `packages/web/.env.production` |
| Introduced in | `205e609` (2026-05-15 22:18 +0300) |
| Removed from tracking | 2026-05-21 (git rm --cached) |
| Commits containing secrets | 1 |

## Findings

### Finding 1: GitHub App Client Secret

| Field | Value |
|-------|-------|
| **ID** | GW-001 |
| **Rule** | generic-api-key |
| **File** | `packages/web/.env.production` |
| **Line** | 4 |
| **Commit** | `205e609a96ef08fbb099a4047d4c2add3aeca774` |
| **Secret Type** | GitHub OAuth Client Secret |
| **Variable** | `GITHUB_APP_CLIENT_SECRET` |
| **Environment** | Production |
| **Severity** | 🔴 High |

**Rotation status:** ⬜ Pending

**Impact:** The client secret is used in the OAuth web application flow. GitWire currently operates as a GitHub App (PEM-based auth), so the client secret is not actively used for API calls. However, it could be used to impersonate the app in OAuth flows if the app had user-to-server token exchange enabled.

**Action:** Rotate at https://github.com/settings/apps/gitwire-hq → Client Secret → Generate a new client secret

---

### Finding 2: GitHub Webhook Secret

| Field | Value |
|-------|-------|
| **ID** | GW-002 |
| **Rule** | generic-api-key |
| **File** | `packages/web/.env.production` |
| **Line** | 5 |
| **Commit** | `205e609a96ef08fbb099a4047d4c2add3aeca774` |
| **Secret Type** | GitHub Webhook Signing Secret |
| **Variable** | `GITHUB_WEBHOOK_SECRET` |
| **Environment** | Production |
| **Severity** | 🔴 Critical |

**Rotation status:** ⬜ Pending

**Impact:** The webhook secret is used to verify that incoming webhook payloads are genuinely from GitHub. Anyone with this secret could forge webhook events, potentially triggering:
- Malicious CI heal actions (code injection via forged `check_suite` events)
- Unauthorized issue fixes (forged `issues` events triggering the autonomous contributor)
- Spurious triage actions on any installed repository

**Action:** Rotate at https://github.com/settings/apps/gitwire-hq → Webhook secret → Update

---

## Acceptance Gates (Before Public Exposure)

> **Do not go public until all three gates pass.**

### Gate 1: Rotated Secrets Confirmed
- [ ] Rotate `GITHUB_APP_CLIENT_SECRET` (Finding GW-001)
- [ ] Rotate `GITHUB_WEBHOOK_SECRET` (Finding GW-002)
- [ ] Update production server `/opt/gitwire/packages/web/.env` with new secrets
- [ ] Restart `gitwire-app` container after rotation
- [ ] Verify webhook delivery still works post-rotation

### Gate 2: Clean Git History — ✅ COMPLETE
- [x] Purge commit `205e609` from git history (`git filter-repo`) — committed and confirmed absent from all refs (local + origin)
- [x] Run `gitleaks git --log-opts="--all"` — returns 0 findings across 284 commits (with `.gitleaks.toml` config)
- [x] Verify `.env.production` no longer exists in any commit — confirmed absent from every commit tree

> **Note:** Gate 1 (rotation) remains the sole outstanding remediation. A history purge does not invalidate a leaked secret value — if the secrets were ever exposed (even transiently in a now-purged commit), rotation at https://github.com/settings/apps/gitwire-hq is the only real remediation.

### Gate 3: GitHub-Side Protection Enabled
- [ ] Enable GitHub Secret Scanning on the repository
- [ ] Enable GitHub Push Protection on the repository
- [ ] Verify both show as active in repo Settings → Code security
- [ ] Run CI security gate — must pass with `--ignore-gitleaks-allow`

---

## Prevention Controls

| Layer | Control | Status |
|-------|---------|--------|
| 1 | `.gitignore` deny-by-default | ✅ Active |
| 2 | `.env.example` only template | ✅ Only committed env file |
| 3 | Pre-commit secret scan (gitleaks `stdin` mode) | ✅ Active |
| 4 | GitHub Push Protection | ⏳ Pending Gate 3 |
| 5 | CI secret scan (full history + `--ignore-gitleaks-allow`) | ✅ Active |
| 6 | Full git-history scan | ✅ This report |
| 7 | Rotation policy | ⏳ Pending Gate 1 |
| 8 | Runtime secret validation | ✅ Active |
| 9 | GitHub Actions least privilege | ✅ `permissions: contents: read` |

## Bypass Policy

| Context | `gitleaks:allow` allowed? | Rationale |
|---------|--------------------------|-----------|
| Local pre-commit hook | ✅ Yes | Developer convenience for false positives |
| CI security gate | ❌ No | `--ignore-gitleaks-allow` prevents silent bypass |
| Stress test verification | ✅ Tested | E2a/E2b confirm local allows, CI blocks |

## Notes

- The repository is currently **private** (GitHub Free org), so exposure is limited to org members.
- Both secrets were introduced in the same commit — the initial Docker deployment commit.
- No other secrets were found in the full 55-commit history.
- The Anthropic API key, DB password, tunnel token, and dashboard API key were **never** committed to git.
- CI uses `gitleaks git --log-opts="--all"` to scan full history, not just working tree.
- CI uses `--ignore-gitleaks-allow` to prevent inline bypass comments as silent escape hatch.
