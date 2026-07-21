# Security Audit Patch — Per-Package Lockfile Explanation

Branch: `security/audit-patch-2026-07-21`
Base: `master@e0a438656fe7edd1d5ef031118c35e8d3faf64dc`
Scope: Smallest deterministic `package-lock.json` correction resolving two
DoS-class advisories failing the `production-dependency-audit` CI job.

## Advisories patched

| GHSA | Package | Installed | Patched | Class |
| --- | --- | --- | --- | --- |
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | `brace-expansion` | 5.0.6 | 5.0.7 | DoS (exponential-time `{}` expansion) |
| [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | `js-yaml` | 4.1.1 | 4.3.0 | DoS (quadratic merge-key chains) |

> Note: bumping `js-yaml` to 4.3.0 also clears the related advisory
> [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68)
> (same package, same affected range `<4.3.0`, same fix), which npm reports
> alongside GHSA-52cp-r559-cp3m for the installed 4.1.1.

`audit-exceptions.json` was **not** modified. Both advisories have
`fixAvailable: true` and clean upstream patch releases, so per policy no
exception is authorized or required.

## Dependency paths traced (production)

### `brace-expansion@5.0.6` (GHSA-3jxr-9vmj-r5cp, range `>=3.0.0 <5.0.7`)

Three installs of the vulnerable 5.0.6 exist in the lockfile; only the
first chain below reaches the **production** dependency set
(`npm audit --omit=dev`); the other two are dev-only but are patched in the
same lockfile bump because they resolve the same `node_modules/.../brace-expansion`
physical install that npm would otherwise leave vulnerable:

1. `@gitwire/web` → `minimatch@10.2.5` (direct prod dep, `^10.2.5`) → `brace-expansion@5.0.6`  **[PROD]**
   - lockfile path: `packages/web/node_modules/brace-expansion`
2. `@gitwire/web` → `nodemon@3.1.14` (dev) → `minimatch@10.2.5` → `brace-expansion@5.0.6`  **[DEV]**
   - lockfile path: `node_modules/nodemon/node_modules/brace-expansion`
3. `web-dashboard` → `eslint-config-next@16.2.6` (dev) → `typescript-eslint@8.59.3` → `@typescript-eslint/typescript-estree@8.59.3` → `minimatch@10.2.5` → `brace-expansion@5.0.6`  **[DEV]**
   - lockfile path: `packages/web-dashboard/node_modules/brace-expansion`

Out-of-range occurrences left untouched:
- `node_modules/brace-expansion@1.1.14` (via `eslint@8.57.1` → `minimatch@3.1.5`) — version `1.1.14 < 3.0.0`, outside the advisory range.

### `js-yaml@4.1.1` (GHSA-52cp-r559-cp3m, range `>=4.0.0 <4.3.0`)

Single vulnerable install, reached by both production and dev consumers
(deduped to one physical install):

1. `@gitwire/rules` → `js-yaml@4.1.1` (direct prod dep, `^4.1.0`)  **[PROD]**
2. `eslint@8.57.1` → `js-yaml@4.1.1` (deduped)  **[DEV]**
3. `eslint@8.57.1` → `@eslint/eslintrc@2.1.4` → `js-yaml@4.1.1` (deduped)  **[DEV]**
4. `web-dashboard` → `eslint@9.39.4` → `@eslint/eslintrc@3.3.5` → `js-yaml@4.1.1` (deduped)  **[DEV]**

Single lockfile entry covers all four chains:
- lockfile path: `node_modules/js-yaml`

Out-of-range occurrences left untouched:
- `node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml@3.14.2` (via `jest` → `@jest/core` → `@jest/transform` → `babel-plugin-istanbul` → `@istanbuljs/load-nyc-config`) — version `3.14.2 < 4.0.0`, outside the advisory range.

## Why manual lockfile edits instead of `npm audit fix --omit=dev`

`npm audit fix --omit=dev` was attempted first but produced an
unacceptably large diff for a security-only PR. Its dry-run proposed:

- 12 package changes including:
  - `next@15.5.20 → 9.3.3` (a SemVer-major downgrade forced by the
    `postcss <8.5.10` advisory chain),
  - `qs`, `body-parser`, `morgan`, `form-data`, `hasown`, `side-channel`,
    `@next/env`, `@next/swc-win32-x64-msvc`,
  - plus `add` of 82 platform-specific binaries
    (`@next/swc-*`, `@tailwindcss/oxide-*`, `lightningcss-*`,
    `@img/sharp-*`, `@unrs/resolver-binding-*`, `@msgpackr-extract/*`,
    `fsevents`) and removal of `on-finished`.
- Net effect: ~94 lockfile entries touched, plus a SemVer-major Next.js
  downgrade that is unrelated to the two assigned advisories and would
  re-introduce Lane-A-style surface area into a security PR.

Per the control-plane authorization (smallest deterministic lockfile
correction; no audit exceptions; do not improvise), this was deemed
out-of-scope and we fell back to **manual surgical edits** targeting only
the four vulnerable resolutions. The remaining advisories that
`npm audit fix` was chasing (`body-parser`, `form-data`, `morgan`, `qs`,
`postcss`, `next`) are all either moderate severity (below the
high/critical enforcement threshold) or already covered by active
entries in `audit-exceptions.json`, and are therefore not blockers for
the `production-dependency-audit` job.

## Per-package lockfile diff

`git diff --stat package-lock.json`:

```
 package-lock.json | 24 ++++++++++++------------
 1 file changed, 12 insertions(+), 12 deletions(-)
```

Four entries were modified, each in exactly three fields
(`version`, `resolved`, `integrity`). No dependencies block changed,
no new entries were added, no entries were removed, and no parent package
was re-resolved — i.e. **zero transitive cascade**. This is because:

- `brace-expansion@5.0.7` keeps the identical manifest
  (`dependencies: { balanced-match: ^4.0.2 }`, `engines: node 18 || 20 || >=22`)
  as 5.0.6, so the existing `balanced-match` install already satisfies it.
- `js-yaml@4.3.0` keeps the identical manifest
  (`dependencies: { argparse: ^2.0.1 }`) as 4.1.1, so the existing
  `argparse` install already satisfies it.

### Entry 1 — `packages/web/node_modules/brace-expansion`  **[PROD]**

| field | before | after |
| --- | --- | --- |
| version | `5.0.6` | `5.0.7` |
| resolved | `.../brace-expansion-5.0.6.tgz` | `.../brace-expansion-5.0.7.tgz` |
| integrity | `sha512-kLpxurY4...3WqbMQ94g==` | `sha512-7oFy703dxfY3/...BUwqCA==` |

Reached by: `@gitwire/web` → `minimatch@10.2.5` → `brace-expansion`.
This is the production chain, so this entry alone is what clears
GHSA-3jxr-9vmj-r5cp for `npm audit --omit=dev`.

### Entry 2 — `node_modules/nodemon/node_modules/brace-expansion`  **[DEV]**

| field | before | after |
| --- | --- | --- |
| version | `5.0.6` | `5.0.7` |
| resolved | `.../brace-expansion-5.0.6.tgz` | `.../brace-expansion-5.0.7.tgz` |
| integrity | `sha512-kLpxurY4...3WqbMQ94g==` | `sha512-7oFy703dxfY3/...BUwqCA==` |

Reached by: `@gitwire/web` → `nodemon@3.1.14` → `minimatch@10.2.5` →
`brace-expansion`. Dev-only chain, but patched in the same bump for
consistency so a later `npm audit` (without `--omit=dev`) does not
re-report the same advisory.

### Entry 3 — `packages/web-dashboard/node_modules/brace-expansion`  **[DEV]**

| field | before | after |
| --- | --- | --- |
| version | `5.0.6` | `5.0.7` |
| resolved | `.../brace-expansion-5.0.6.tgz` | `.../brace-expansion-5.0.7.tgz` |
| integrity | `sha512-kLpxurY4...3WqbMQ94g==` | `sha512-7oFy703dxfY3/...BUwqCA==` |

Reached by: `web-dashboard` → `eslint-config-next@16.2.6` →
`typescript-eslint@8.59.3` → `@typescript-eslint/typescript-estree@8.59.3`
→ `minimatch@10.2.5` → `brace-expansion`. Dev-only chain; patched for
the same reason as Entry 2.

### Entry 4 — `node_modules/js-yaml`  **[PROD + DEV, deduped]**

| field | before | after |
| --- | --- | --- |
| version | `4.1.1` | `4.3.0` |
| resolved | `.../js-yaml-4.1.1.tgz` | `.../js-yaml-4.3.0.tgz` |
| integrity | `sha512-qQKT4zQxXl8lLwBt...myCT5lsA==` | `sha512-1td788aAnnZ5qs7V2Q...BoFHaW9Q==` |

Reached by (all dedupe to this single install):
- `@gitwire/rules` → `js-yaml` (direct prod dep)
- `eslint@8.57.1` → `js-yaml`
- `eslint@8.57.1` → `@eslint/eslintrc@2.1.4` → `js-yaml`
- `web-dashboard` → `eslint@9.39.4` → `@eslint/eslintrc@3.3.5` → `js-yaml`

This single edit clears both GHSA-52cp-r559-cp3m and GHSA-h67p-54hq-rp68
for the entire workspace.

## Verification (run inside `../gitwire-security-audit-patch`)

```
npm ci --ignore-scripts                                                    # PASS (1020 packages)
npm audit --omit=dev --json > production-audit.json                        # exit 1 (vulns found, evaluated below)
node scripts/enforce-production-audit.mjs production-audit.json audit-exceptions.json
# -> ✓ production dependency audit passed
# -> blocking findings: 1 (all excepted)
# -> active exceptions: 1
# -> audit totals — high: 1, critical: 0, moderate: 4, low: 1            # PASS (exit 0)
node scripts/check-stress-isolation.mjs
# -> ✓ No isolation violations in stress tests.                           # PASS (exit 0)
node scripts/check-source-of-truth.mjs
# -> ✓ No source-of-truth drift detected.                                 # PASS (exit 0)
npm test                                                                   # PASS (exit 0)
```

`npm test` totals across all packages:

| package | suites | tests |
| --- | --- | --- |
| root (web unit) | 102 | 2775 passed, 1 skipped (2776 total) |
| executor-service | 9 | 128 passed |
| web-dashboard | 5 | 66 passed |
| (other workspaces) | 3 + 6 + 1 | 40 + 251 + 16 passed |
| **Total** | **126** | **3276 passed, 1 skipped** |

Both `brace-expansion` and `js-yaml` no longer appear in the
`npm audit --omit=dev --json` report — both advisories are resolved by
this patch.

## Out-of-scope / not modified

- `audit-exceptions.json` — **untouched** (policy: no exceptions while
  clean patch releases are available).
- No Lane-A files (nothing under `packages/web/tests/stress/` or
  `packages/web/tests/unit/stress-functional/`) — this PR contains zero
  stress-functional changes.
- No source files (`*.js`, `*.ts`, `*.mjs`, `*.cjs`) were modified —
  this is a lockfile-only security patch.
- No SemVer-major bumps; no `--force`; no merge or rebase.
