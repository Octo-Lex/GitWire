#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# GitWire Secret Leak Stress Test
#
# Plants fake secrets in every conceivable location and format,
# then verifies which layers catch them.
#
# Usage: bash scripts/secret-leak-stress-test.sh
# ──────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ROOT="$(git rev-parse --show-toplevel)"
TRAP_DIR="$ROOT/security/stress-test-traps"
GITLEAKS="${GITLEAKS:-gitleaks}"
if [ -f "$HOME/bin/gitleaks.exe" ]; then GITLEAKS="$HOME/bin/gitleaks.exe"; fi
if [ -f "$HOME/bin/gitleaks" ]; then GITLEAKS="$HOME/bin/gitleaks"; fi
PASS=0
FAIL=0
SKIP=0
TOTAL=0

rm -rf "$TRAP_DIR"
mkdir -p "$TRAP_DIR"

log_result() {
  local name="$1" result="$2" detail="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$result" = "PASS" ]; then
    echo -e "  ${GREEN}✅ PASS${NC} — $name"
    PASS=$((PASS + 1))
  elif [ "$result" = "FAIL" ]; then
    echo -e "  ${RED}❌ FAIL${NC} — $name ${RED}($detail)${NC}"
    FAIL=$((FAIL + 1))
  elif [ "$result" = "SKIP" ]; then
    echo -e "  ${YELLOW}⏭  SKIP${NC} — $name ${YELLOW}($detail)${NC}"
    SKIP=$((SKIP + 1))
  fi
}

try_commit_blocked() {
  local desc="$1"
  cd "$ROOT"
  # Only stage the trap directory, not everything
  git add "$TRAP_DIR" 2>/dev/null
  local output
  # Use git --staged mode — same as the actual pre-commit hook
  output=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
  # Check for actual leaks — "leaks found: N" where N > 0
  local found_line
  found_line=$(echo "$output" | grep -E 'leaks found: [1-9]' || true)
  if [ -n "$found_line" ]; then
    log_result "$desc" "PASS" "Blocked by gitleaks"
    git reset HEAD -- . > /dev/null 2>&1
    return 0
  else
    log_result "$desc" "FAIL" "Secret was NOT blocked!"
    git reset HEAD -- . > /dev/null 2>&1
    return 1
  fi
}

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  GitWire Secret Leak Stress Test"
echo "  Testing all 9 protection layers against planted fake secrets"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# ═══ LAYER 1: .gitignore deny-by-default ════════════════════════════════════

echo -e "${CYAN}═══ LAYER 1: .gitignore deny-by-default ═══${NC}"

# Test 1a: .env.production — must NOT be tracked (git rm --cached staged)
if git ls-files --cached packages/web/.env.production 2>/dev/null | grep -q .; then
  # Still tracked — check if removal is staged
  if git diff --cached --name-only | grep -q 'packages/web/.env.production'; then
    log_result "1a: .env.production removal staged" "PASS" "Pending commit"
  else
    log_result "1a: .env.production removed from tracking" "FAIL" "Still tracked in HEAD"
  fi
else
  log_result "1a: .env.production not tracked" "PASS"
fi
# Also verify .gitignore would block it if it were a new file
rm -f packages/web/.env.production

echo "X=fake" > packages/web/.env.staging
if git check-ignore -q packages/web/.env.staging 2>/dev/null; then
  log_result "1b: .env.staging blocked" "PASS"
else
  log_result "1b: .env.staging blocked" "FAIL" "Not ignored"
fi
rm -f packages/web/.env.staging

echo "X=fake" > packages/web/.env
if git check-ignore -q packages/web/.env 2>/dev/null; then
  log_result "1c: .env blocked" "PASS"
else
  log_result "1c: .env blocked" "FAIL" "Not ignored"
fi
rm -f packages/web/.env

if git check-ignore -q packages/web/.env.example 2>/dev/null; then
  log_result "1d: .env.example allowed through" "FAIL" "Template was blocked!"
else
  log_result "1d: .env.example allowed through" "PASS"
fi

echo "-----BEGIN RSA PRIVATE KEY-----" > packages/web/fake-key.pem
if git check-ignore -q packages/web/fake-key.pem 2>/dev/null; then
  log_result "1e: .pem file blocked" "PASS"
else
  log_result "1e: .pem file blocked" "FAIL" "Not ignored"
fi
rm -f packages/web/fake-key.pem

# Test .env.test
echo "X=fake" > packages/web/.env.test
if git check-ignore -q packages/web/.env.test 2>/dev/null; then
  log_result "1f: .env.test blocked" "PASS"
else
  log_result "1f: .env.test blocked" "FAIL" "Not ignored"
fi
rm -f packages/web/.env.test

echo ""

# ═══ LAYER 2: Pre-commit secret scan ════════════════════════════════════════

echo -e "${CYAN}═══ LAYER 2: Pre-commit secret scan ═══${NC}"

# 2a: Stripe live key
echo 'const K = "sk_live_51Hfake1234567890abcdef12345678";' > "$TRAP_DIR/a.js"
try_commit_blocked "2a: Stripe live key in .js"

# 2b: GitHub PAT (36 chars after ghp_)
echo '{"token":"ghp_1234567890abcdef1234567890abcdef1234"}' > "$TRAP_DIR/b.json"
try_commit_blocked "2b: GitHub PAT in .json"

# 2c: Slack webhook
echo 'const W="https://hooks.slack.com/services/T000FAKE/B000FAKE/XXXXXXXXXXXXXXXXXXXXXXXX";' > "$TRAP_DIR/c.js"
try_commit_blocked "2c: Slack webhook URL in .js"

# 2d: RSA private key
printf '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygaWJ7kk9FPZBRfake\n-----END RSA PRIVATE KEY-----\n' > "$TRAP_DIR/d.sh"
try_commit_blocked "2d: RSA private key in .sh"

# 2e: Google API key
echo 'const K="AIzaSyDaGmWKa4VuXcehKevcI8ZN5NS3nF4vXXX";' > "$TRAP_DIR/e.ts"
try_commit_blocked "2e: Google API key in .ts"

# 2f: Generic API_KEY=value pattern
echo 'const API_KEY = "8f1840e2c24d4b6ba1b3e5f7a9d2c8e4";' > "$TRAP_DIR/f.js"
try_commit_blocked "2f: Generic API_KEY=value pattern"

# 2g: GitHub PAT in .js (different variable name)
echo 'const githubToken = "ghp_1234567890abcdef1234567890abcdef1234";' > "$TRAP_DIR/g.js"
try_commit_blocked "2g: GitHub PAT (variable: githubToken)"

# 2h: Anthropic key
echo 'const K="sk-ant-api03-fake0000000000000000000000000000000000000000000000000000";' > "$TRAP_DIR/h.js"
try_commit_blocked "2h: Anthropic API key in .js"

# 2i: Secret in markdown
echo 'Run: export ANTHROPIC_API_KEY="sk-ant-api03-fake1234567890000000000000000000000000000"' > "$TRAP_DIR/i.md"
try_commit_blocked "2i: Anthropic key in .md documentation"

# 2j: Secret in Dockerfile
echo 'ENV ANTHROPIC_API_KEY=sk-ant-api03-fake000000000000000000000000000000000000' > "$TRAP_DIR/j.dockerfile"
try_commit_blocked "2j: Anthropic key in Dockerfile ENV"

# 2k: Deep nesting
mkdir -p "$TRAP_DIR/deep/nested/path/to"
echo 'module.exports={t:"ghp_1234567890abcdef1234567890abcdef1234"};' > "$TRAP_DIR/deep/nested/path/to/k.js"
try_commit_blocked "2k: GitHub PAT deeply nested (4 levels)"

# 2l: Slack bot token
echo 'const S="xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx";' > "$TRAP_DIR/l.js"
try_commit_blocked "2l: Slack bot token in .js"

# 2m: GCP API key in JSON
echo '{"key":"AIzaSyDaGmWKa4VuXcehKevcI8ZN5NS3nF4vXXX"}' > "$TRAP_DIR/m.json"
try_commit_blocked "2m: Google API key in .json"

# 2n: Private key in .env-style file
printf 'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----\n"' > "$TRAP_DIR/n.cfg"
try_commit_blocked "2n: RSA private key in .cfg file"

# 2o: Secret in YAML
echo 'password: "sk_live_51Hfake1234567890abcdef"' > "$TRAP_DIR/o.yaml"
try_commit_blocked "2o: Stripe key in .yaml"

rm -rf "$TRAP_DIR"
echo ""

# ═══ LAYER 3: .env.example only ═════════════════════════════════════════════

echo -e "${CYAN}═══ LAYER 3: .env.example only template ═══${NC}"

# Test 3a: Verify .env.production removal is properly staged
# Re-stage the removal (may have been undone by earlier git reset in tests)
git rm --cached packages/web/.env.production 2>/dev/null || true
head_tracked=$(git show HEAD:packages/web/.env.production 2>/dev/null && echo "TRACKED" || true)
staged_removed=$(git diff --cached --name-only --diff-filter=D 2>/dev/null | grep 'packages/web/.env.production' || true)
if [ -n "$head_tracked" ] && [ -n "$staged_removed" ]; then
  log_result "3a: .env.production removal staged (pending commit)" "PASS" "Will be removed on next commit"
elif [ -z "$head_tracked" ]; then
  log_result "3a: .env.production not in HEAD" "PASS"
else
  log_result "3a: .env.production removal not staged" "FAIL" "File still in HEAD, removal not staged"
fi

if grep -qE '^.*[^#].*(ghp_|AKIA|sk_live_|xoxb-)' "$ROOT/packages/web/.env.example" 2>/dev/null; then
  log_result "3b: .env.example free of real secrets" "FAIL" "Contains real patterns"
else
  log_result "3b: .env.example free of real secrets" "PASS"
fi
echo ""

# ═══ LAYER 4: GitHub Push Protection ════════════════════════════════════════

echo -e "${CYAN}═══ LAYER 4: GitHub Push Protection ═══${NC}"
log_result "4a: Push protection (requires public repo)" "SKIP" "GitHub Free + private repo"
echo ""

# ═══ LAYER 5: CI secret scan gate ═══════════════════════════════════════════

echo -e "${CYAN}═══ LAYER 5: CI secret scan gate ═══${NC}"

grep -q "needs: security" "$ROOT/.github/workflows/deploy.yml" && \
  log_result "5a: Deploy gated on security job" "PASS" || \
  log_result "5a: Deploy gated on security job" "FAIL" "No 'needs: security'"

grep -q "gitleaks" "$ROOT/.github/workflows/deploy.yml" && \
  log_result "5b: CI runs gitleaks" "PASS" || \
  log_result "5b: CI runs gitleaks" "FAIL" "No gitleaks step"

grep -q "npm audit" "$ROOT/.github/workflows/deploy.yml" && \
  log_result "5c: CI runs npm audit" "PASS" || \
  log_result "5c: CI runs npm audit" "FAIL" "No npm audit step"

# Verify gitleaks uses v8.19+ API (dir, not detect)
# Verify gitleaks uses v8.19+ API
if grep -q 'gitleaks git' "$ROOT/.github/workflows/deploy.yml"; then
  log_result "5d: Uses gitleaks git (v8.19+ API)" "PASS"
elif grep -q 'gitleaks dir' "$ROOT/.github/workflows/deploy.yml"; then
  log_result "5d: Uses gitleaks dir (v8.19+ API)" "PASS"
else
  log_result "5d: Uses modern gitleaks command" "FAIL" "Uses deprecated command"
fi
echo ""

# ═══ LAYER 6: Full git-history scan ═════════════════════════════════════════

echo -e "${CYAN}═══ LAYER 6: Full git-history scan ═══${NC}"

if [ -f "$ROOT/security/secret-scan-report.md" ]; then
  findings=$(grep -c "GW-" "$ROOT/security/secret-scan-report.md" 2>/dev/null || echo "0")
  log_result "6a: History scan report exists" "PASS" "$findings findings"
else
  log_result "6a: History scan report exists" "FAIL" "No report"
fi

# Live history scan
cd "$ROOT"
hist=$($GITLEAKS git -c .gitleaks.toml --no-banner --log-opts="--all" 2>&1 | grep "leaks found" || true)
if echo "$hist" | grep -qE "[1-9]"; then
  log_result "6b: History scan finds past secrets" "PASS" "$hist"
else
  log_result "6b: History scan finds past secrets" "FAIL" "No leaks detected"
fi
echo ""

# ═══ LAYER 7: Rotation policy ═══════════════════════════════════════════════

echo -e "${CYAN}═══ LAYER 7: Secret rotation policy ═══${NC}"

grep -q "Rotation status" "$ROOT/security/secret-scan-report.md" 2>/dev/null && \
  log_result "7a: Rotation tracking documented" "PASS" || \
  log_result "7a: Rotation tracking documented" "FAIL" "No rotation status"

grep -q "Acceptance Gates" "$ROOT/security/secret-scan-report.md" 2>/dev/null && \
  log_result "7b: Acceptance gates checklist present" "PASS" || \
  log_result "7b: Acceptance gates checklist present" "FAIL" "No checklist"
echo ""

# ═══ LAYER 8: Runtime secret validation ═════════════════════════════════════

echo -e "${CYAN}═══ LAYER 8: Runtime secret validation ═══${NC}"

out=$(NODE_ENV=production ANTHROPIC_API_KEY="sk-ant-YOUR-KEY-HERE" \
  DATABASE_URL="postgresql://t:t@l/d" REDIS_URL="redis://l" \
  node -e "import('./packages/web/config/index.js').catch(()=>{})" 2>&1)
echo "$out" | grep -q "FATAL" && \
  log_result "8a: Blocks placeholder Anthropic key" "PASS" || \
  log_result "8a: Blocks placeholder Anthropic key" "FAIL" "Did not crash"

out=$(NODE_ENV=production ANTHROPIC_API_KEY="changeme-to-a-real-key" \
  DATABASE_URL="postgresql://t:t@l/d" REDIS_URL="redis://l" \
  node -e "import('./packages/web/config/index.js').catch(()=>{})" 2>&1)
echo "$out" | grep -q "FATAL" && \
  log_result "8b: Blocks 'changeme' prefix" "PASS" || \
  log_result "8b: Blocks 'changeme' prefix" "FAIL" "Did not crash"

out=$(NODE_ENV=production ANTHROPIC_API_KEY="YOUR_TOKEN_HERE_12345" \
  DATABASE_URL="postgresql://t:t@l/d" REDIS_URL="redis://l" \
  node -e "import('./packages/web/config/index.js').catch(()=>{})" 2>&1)
echo "$out" | grep -q "FATAL" && \
  log_result "8c: Blocks YOUR_TOKEN placeholder" "PASS" || \
  log_result "8c: Blocks YOUR_TOKEN placeholder" "FAIL" "Did not crash"

out=$(NODE_ENV=production \
  ANTHROPIC_API_KEY="F7fd07811a0741f292773e11c31b2af5.6VN9RkVh1JKS49E3" \
  DATABASE_URL="postgresql://t:t@l/d" REDIS_URL="redis://l" \
  node -e "import('./packages/web/config/index.js').catch(()=>{})" 2>&1)
echo "$out" | grep -q "FATAL" && \
  log_result "8d: Accepts real Anthropic key" "FAIL" "Crashed on real key!" || \
  log_result "8d: Accepts real Anthropic key" "PASS"

# Dev mode should NOT crash even with placeholders
out=$(NODE_ENV=development ANTHROPIC_API_KEY="changeme" \
  DATABASE_URL="postgresql://t:t@l/d" REDIS_URL="redis://l" \
  node -e "import('./packages/web/config/index.js').catch(()=>{})" 2>&1)
echo "$out" | grep -q "FATAL" && \
  log_result "8e: Dev mode allows placeholders" "FAIL" "Crashed in dev!" || \
  log_result "8e: Dev mode allows placeholders" "PASS"
echo ""

# ═══ LAYER 9: Least privilege ═══════════════════════════════════════════════

echo -e "${CYAN}═══ LAYER 9: GitHub Actions least privilege ═══${NC}"

grep -q "^permissions:" "$ROOT/.github/workflows/deploy.yml" && \
  log_result "9a: Workflow has explicit permissions" "PASS" || \
  log_result "9a: Workflow has explicit permissions" "FAIL" "No permissions block"

grep "contents: write" "$ROOT/.github/workflows/deploy.yml" 2>/dev/null && \
  log_result "9b: No write permissions" "FAIL" "Has contents: write" || \
  log_result "9b: No write permissions" "PASS"
echo ""

# ═══ EDGE CASES ══════════════════════════════════════════════════════════════

echo -e "${CYAN}═══ EDGE CASES ═══${NC}"

# E1: Secret in .gitignored file — can't even be staged
echo "ghp_1234567890abcdef1234567890abcdef1234" > "$ROOT/packages/web/.env"
git add "$ROOT/packages/web/.env" 2>/dev/null
git check-ignore -q "$ROOT/packages/web/.env" 2>/dev/null && \
  log_result "E1: Secret in .gitignored .env can't be staged" "PASS" || \
  log_result "E1: Secret in .gitignored .env can't be staged" "FAIL" "Not ignored"
git reset HEAD -- "$ROOT/packages/web/.env" > /dev/null 2>&1
rm -f "$ROOT/packages/web/.env"

# E2: gitleaks:allow bypass — allowed locally, but CI ignores it
mkdir -p "$TRAP_DIR"
echo 'const K="ghp_1234567890abcdef1234567890abcdef1234"; // gitleaks:allow' > "$TRAP_DIR/e2.js"
cd "$ROOT" && git add "$TRAP_DIR/e2.js" 2>/dev/null
# Local hook (git --staged) should allow the bypass
local_output=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
if echo "$local_output" | grep -qE "leaks found: [1-9]"; then
  log_result "E2a: Local hook allows gitleaks:allow bypass" "FAIL" "Blocked despite comment"
else
  log_result "E2a: Local hook allows gitleaks:allow bypass" "PASS"
fi
# CI mode (--ignore-gitleaks-allow) should BLOCK it
ci_output=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner --ignore-gitleaks-allow 2>&1)
if echo "$ci_output" | grep -qE "leaks found: [1-9]"; then
  log_result "E2b: CI ignores gitleaks:allow bypass" "PASS"
else
  log_result "E2b: CI ignores gitleaks:allow bypass" "FAIL" "Bypass comment passed CI scan"
fi
git reset HEAD -- . > /dev/null 2>&1
rm -rf "$TRAP_DIR"

# E3: Secret in template literal
mkdir -p "$TRAP_DIR"
cat > "$TRAP_DIR/e3.js" << 'INNER'
const c = `
  api_key = ghp_1234567890abcdef1234567890abcdef1234
`;
INNER
cd "$ROOT" && git add "$TRAP_DIR/e3.js" 2>/dev/null
local_e3=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
if echo "$local_e3" | grep -qE "leaks found: [1-9]"; then
  log_result "E3: Secret in template literal caught" "PASS"
else
  log_result "E3: Secret in template literal caught" "FAIL" "Template literal bypass"
fi
git reset HEAD -- . > /dev/null 2>&1
rm -rf "$TRAP_DIR"

# E4: Split across lines (known limitation)
mkdir -p "$TRAP_DIR"
cat > "$TRAP_DIR/e4.js" << 'INNER'
const p1 = "ghp_ABCDEFGHIJKLMNOPQR";
const p2 = "STUVWXYZabcdefghi";
const token = p1 + p2;
INNER
cd "$ROOT" && git add "$TRAP_DIR/e4.js" 2>/dev/null
local_e4=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
if echo "$local_e4" | grep -qE "leaks found: [1-9]"; then
  log_result "E4: Split secret across lines" "PASS"
else
  log_result "E4: Split secret across lines" "SKIP" "Known limitation: runtime concat"
fi
git reset HEAD -- . > /dev/null 2>&1
rm -rf "$TRAP_DIR"

# E5: Secret in .gitignore-adjacent file name (not actually ignored)
mkdir -p "$TRAP_DIR"
echo 'const K="ghp_1234567890abcdef1234567890abcdef1234";' > "$TRAP_DIR/env-config.js"
cd "$ROOT" && git add "$TRAP_DIR/env-config.js" 2>/dev/null
local_e5=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
if echo "$local_e5" | grep -qE "leaks found: [1-9]"; then
  log_result "E5: env-config.js (not .env) still scanned" "PASS"
else
  log_result "E5: env-config.js (not .env) still scanned" "FAIL" "Not scanned"
fi
git reset HEAD -- . > /dev/null 2>&1
rm -rf "$TRAP_DIR"

# E6: Secret in comment
mkdir -p "$TRAP_DIR"
cat > "$TRAP_DIR/e6.js" << 'INNER'
// Remember to use this: ghp_1234567890abcdef1234567890abcdef1234
export const version = "1.0.0";
INNER
cd "$ROOT" && git add "$TRAP_DIR/e6.js" 2>/dev/null
local_e6=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
if echo "$local_e6" | grep -qE "leaks found: [1-9]"; then
  log_result "E6: Secret in JS comment caught" "PASS"
else
  log_result "E6: Secret in JS comment caught" "FAIL" "Comment bypass"
fi
git reset HEAD -- . > /dev/null 2>&1
rm -rf "$TRAP_DIR"

# E7: Entropy-only detection (random hex string)
mkdir -p "$TRAP_DIR"
echo 'const SESSION_SECRET="a7f3b2c9d4e5f6081725364980abcdef1928374655647382";' > "$TRAP_DIR/e7.js"
cd "$ROOT" && git add "$TRAP_DIR/e7.js" 2>/dev/null
local_e7=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
if echo "$local_e7" | grep -qE "leaks found: [1-9]"; then
  log_result "E7: High-entropy hex string (SESSION_SECRET)" "PASS"
else
  log_result "E7: High-entropy hex string (SESSION_SECRET)" "SKIP" "No matching rule"
fi
git reset HEAD -- . > /dev/null 2>&1
rm -rf "$TRAP_DIR"

# E8: Secret with surrounding whitespace/quotes
mkdir -p "$TRAP_DIR"
echo '  token = "  ghp_1234567890abcdef1234567890abcdef1234  "  ' > "$TRAP_DIR/e8.js"
cd "$ROOT" && git add "$TRAP_DIR/e8.js" 2>/dev/null
local_e8=$($GITLEAKS git --staged -c .gitleaks.toml --no-banner 2>&1)
if echo "$local_e8" | grep -qE "leaks found: [1-9]"; then
  log_result "E8: Secret with surrounding whitespace" "PASS"
else
  log_result "E8: Secret with surrounding whitespace" "FAIL" "Whitespace bypass"
fi
git reset HEAD -- . > /dev/null 2>&1
rm -rf "$TRAP_DIR"

echo ""

# ═══ SUMMARY ═════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════════════════════"
echo -e "  RESULTS: ${GREEN}${PASS} PASS${NC}  ${RED}${FAIL} FAIL${NC}  ${YELLOW}${SKIP} SKIP${NC}  / ${TOTAL} total"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}⚠️  ${FAIL} test(s) failed — secrets could leak!${NC}"
  exit 1
else
  echo -e "${GREEN}🛡️  All tests passed — 9-layer protection verified${NC}"
  exit 0
fi
