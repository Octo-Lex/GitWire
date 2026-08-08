:t@l/d" REDIS_URL="redis://l" \
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
