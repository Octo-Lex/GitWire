# Gap 1 — Validator Execution Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitWire's validator execution topology explicit and externally observable — local-process is never pass-capable, container-runtime is pass-capable only when reachable and pinned, delegated-run gets a documented provider interface, and every execution receipt binds the validator result to the selected backend's pass-capability.

**Architecture:** Extend the v0.21.0 executor reachability layer (`executorReachability.js`) to derive `pass_capable` per backend and surface a new `validator` readiness block on `/health`. Extend the Zod config with validator image identity. Extend `buildExecutionReceipt()` to carry `executor_kind`, `executor_pass_capable`, `validator_image_*`, `validator_result_*`, and a non-hash-bound `proof_collected_at`. Tighten the shared receipt verifier gate (`verifyExecutionReceiptAgainstLockedProposal`) to enforce the new fields. Add a vendor-neutral delegated-run provider contract module.

**Tech Stack:** Node.js ESM, Jest (`@jest/globals`, `--experimental-vm-modules`), Zod config validation, JSDoc types. No TypeScript on the backend. No new database migration required (receipts are content-addressed JSON blobs).

---

## Background — read this before Task 1

The Gap 1 design doc lives at `docs/architecture/validator-execution-model.md`. Read it. Its acceptance criteria (the source of truth for this plan):

```
- The validator image has immutable identity.
- The selected executor backend is recorded in receipts.
- Local-process validator results are explicitly inconclusive/non-pass-capable.
- Container-runtime validator results are pass-capable only when runtime and image identity are proven.
- Delegated-run has a documented provider interface, even if no provider is enabled yet.
- Health/readiness exposes whether the current deployment can produce pass-capable validator evidence.
- CT 115 no longer has an ambiguous "Docker unavailable" failure mode.
```

**Key existing facts** (verified by reading the code, not assumed):

1. `packages/web/src/lib/executorReachability.js` exports `EXECUTOR_KINDS` (`local-process` / `container-runtime` / `delegated-run`), three `probe*()` functions, `probeAllBackends(priorityOrder?)`, and `getReachabilitySummary(priorityOrder?)`. The summary currently returns `{ summary: [{kind, reachable, runtime}], selected_kind, selected_reason }` — it does NOT carry `pass_capable`.
2. The registered backends are `node-executor` (`supports_pass: false`, `container_runtime: "none"`) and `docker-executor` (`supports_pass: true`, `container_runtime: "docker"`). They live in `nodeExecutorBackend.js` and `dockerExecutorBackend.js` and are registered at the bottom of `executorRegistry.js`.
3. `buildExecutionReceipt()` in `sandboxRunner.js` builds a content-addressed JSON object and explicitly comments **"NO timestamps or DB IDs — hash is content-addressed only"** (line 199). The receipt today has `execution_backend_id`, isolation bindings, `image_ref`, `result` — but no `executor_kind`, no `executor_pass_capable`, no `validator_*` fields.
4. `getDeploymentInfo()` in `deploymentInfo.js` spreads an `executor` field into the `/health` body (populated by dynamic import of `executorReachability.js`). The `/health` route is at `packages/web/src/app.js:88`.
5. `dockerExecutorBackend.js` already reads `process.env.GITWIRE_VALIDATOR_IMAGE_REF` (line 71) and `GITWIRE_ALLOW_TEST_FIXTURE`. It parses the digest from the ref but does NOT read a standalone `GITWIRE_VALIDATOR_IMAGE_DIGEST`.
6. The shared receipt verifier `verifyExecutionReceiptAgainstLockedProposal()` lives in `repairProposalService.js:2400`. Its allowlists (`ALLOWED_PASS_EXECUTION_BACKENDS`, etc.) and checks 3a–3e are the enforcement seam. There is a precedent source-reading test at `tests/unit/pass-capable-unlock.test.js`.
7. The Zod config schema is in `packages/web/config/index.js`. The four `GITWIRE_*` executor/validator vars are currently NOT in the schema (read ad-hoc from `process.env`).
8. The test command for the web package:
   ```
   cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage
   ```
   Single test: append `--testPathPattern=<name>`.

**Decision locked in by this plan (record these in commit messages):**

- **Config formalization:** Add `GITWIRE_VALIDATOR_IMAGE_REF`, `GITWIRE_VALIDATOR_IMAGE_DIGEST`, `GITWIRE_ALLOW_TEST_FIXTURE`, and `GITWIRE_EXECUTOR_BACKEND` to the Zod schema as a new `config.validator` group. They stay backward-compatible (still readable via `process.env` where existing modules already read them) but get validated + defaulted. New code uses `config.validator.*`.
- **`proof_collected_at` is NOT part of the receipt hash.** The receipt stays content-addressed over execution inputs only. `proof_collected_at` is returned alongside the receipt (a sibling field), not inside `receipt_content`. This preserves the write-once dedup property. The design doc lists `proof_collected_at` as a receipt requirement — we satisfy it by returning it with the stored receipt, and storing it in a separate non-content-addressed column is explicitly out of scope (would need a migration; receipts table is intentionally minimal).
- **No new DB migration.** The execution receipt stays an opaque JSON blob. New fields ride inside `receipt_content`. `created_at` already exists on `execution_receipts` and serves as the durable proof-collection timestamp.
- **`executor_kind` derivation:** mapped from `execution_backend_id` via a single source-of-truth function in `executorReachability.js` (see Task 1).

---

## File Structure

Files created or modified by this plan:

| File | Action | Responsibility |
|---|---|---|
| `packages/web/src/lib/executorReachability.js` | **Modify** | Add `executorKindForBackendId()`, `isBackendPassCapable()`, extend summary with `pass_capable`/`selected_pass_capable`, add `getValidatorReadiness()`. |
| `packages/web/src/lib/executorRegistry.js` | **Modify** (Task 7.5) | Rewrite `getDefaultBackend()` to probe container-runtime reachability before selecting `docker-executor`; fall back to `node-executor` when Docker is unreachable (fix #4). |
| `packages/web/src/lib/validatorImage.js` | **Create** | Pure config module: reads validator image identity from `config.validator`, returns `{ configured, ref, digest, identity_complete, missing }`. No I/O. |
| `packages/web/src/lib/validatorReceiptGate.js` | **Create** (Task 8) | Pure helper `validateGap1ValidatorBindings(receipt)` — checks 3f–3j, extracted for behavioral testing (fix #5). |
| `packages/web/src/lib/delegatedRunProvider.js` | **Create** | Vendor-neutral provider contract: `DELEGATED_RUN_PROVIDER_CONTRACT` shape, `validateDelegatedRunProvider()`, and a `NullDelegatedRunProvider` placeholder. |
| `packages/web/src/lib/sandboxRunner.js` | **Modify** | Extend `buildExecutionReceipt()` with `executor_kind`, `executor_pass_capable`, `validator_image_ref`, `validator_image_digest`, `validator_result`, `validator_result_status`. Return `proof_collected_at` as sibling. Pass new fields through `runSandboxVerification()` using PROVEN probe reachability (not `supports_pass`). |
| `packages/web/src/lib/deploymentInfo.js` | **Modify** | Surface `selected_pass_capable` and a new `validator` block (from `getValidatorReadiness()`). |
| `packages/web/config/index.js` | **Modify** | Add `config.validator` group + Zod keys. |
| `packages/web/src/services/repairProposalService.js` | **Modify** | Call `validateGap1ValidatorBindings(receipt)` in the pass gate (checks 3f–3j). |
| `packages/web/tests/unit/executor-reachability.test.js` | **Modify** | Tests for pass-capability derivation, extended summary, validator readiness (`configured` independent of `pass_capable`). |
| `packages/web/tests/unit/executor-registry-reachability.test.js` | **Create** (Task 7.5) | Tests that `getDefaultBackend()` is reachability-honest. |
| `packages/web/tests/unit/validator-image.test.js` | **Create** | Tests for `validatorImage.js`. |
| `packages/web/tests/unit/delegated-run-provider.test.js` | **Create** | Tests for contract validation + null provider. |
| `packages/web/tests/unit/execution-receipt-validator-fields.test.js` | **Create** | Tests for new receipt fields in `buildExecutionReceipt()`. |
| `packages/web/tests/unit/validator-receipt-gate.test.js` | **Create** (Task 8) | **Behavioral** tests for `validateGap1ValidatorBindings()` — primary gate guardrail. |
| `packages/web/tests/unit/validator-receipt-gate-wiring.test.js` | **Create** (Task 8) | Source-reading tests confirming the verifier calls the helper — secondary guardrail. |
| `packages/web/tests/unit/deployment-validator-readiness.test.js` | **Create** | Source-reading tests for the `/health` `validator` block + `selected_pass_capable`. |

**Versions:** bump `packages/web/package.json` (and root + every per-package `package.json` per AGENTS.md pre-release checklist) only if a release tag is being cut. This plan ships as code; the release-tag task is explicitly NOT in scope — flag it to the user at the end.

---

## Task 1: Backend pass-capability map + derivation helpers

**Goal of this task:** Establish the single source of truth that maps a backend (by kind or by id) to its `pass_capable` flag, derived from the **registered backends'** `supports_pass` property crossed with reachability — not a new hardcoded constant.

**Files:**
- Modify: `packages/web/src/lib/executorReachability.js`
- Modify: `packages/web/tests/unit/executor-reachability.test.js`

- [ ] **Step 1: Write failing tests for the new exports**

Append to `packages/web/tests/unit/executor-reachability.test.js` (inside the existing file, after the last `describe`):

```js
import {
  isBackendPassCapable,
  executorKindForBackendId,
  getValidatorReadiness,
} from "../../src/lib/executorReachability.js";

describe("Backend pass-capability derivation", () => {
  it("local-process is never pass-capable", () => {
    expect(isBackendPassCapable(EXECUTOR_KINDS.LOCAL_PROCESS, true)).toBe(false);
    expect(isBackendPassCapable(EXECUTOR_KINDS.LOCAL_PROCESS, false)).toBe(false);
  });

  it("container-runtime is pass-capable only when reachable", () => {
    expect(isBackendPassCapable(EXECUTOR_KINDS.CONTAINER_RUNTIME, true)).toBe(true);
    expect(isBackendPassCapable(EXECUTOR_KINDS.CONTAINER_RUNTIME, false)).toBe(false);
  });

  it("delegated-run is pass-capable only when reachable", () => {
    expect(isBackendPassCapable(EXECUTOR_KINDS.DELEGATED_RUN, true)).toBe(true);
    expect(isBackendPassCapable(EXECUTOR_KINDS.DELEGATED_RUN, false)).toBe(false);
  });

  it("unknown kind throws (no silent default to pass)", () => {
    expect(() => isBackendPassCapable("gpu-cluster", true)).toThrow(/unknown executor kind/);
  });
});

describe("executorKindForBackendId", () => {
  it("maps node-executor → local-process", () => {
    expect(executorKindForBackendId("node-executor")).toBe(EXECUTOR_KINDS.LOCAL_PROCESS);
  });

  it("maps docker-executor → container-runtime", () => {
    expect(executorKindForBackendId("docker-executor")).toBe(EXECUTOR_KINDS.CONTAINER_RUNTIME);
  });

  it("throws on unknown backend id (fail-closed)", () => {
    expect(() => executorKindForBackendId("made-up")).toThrow(/unknown backend id/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=executor-reachability
```
Expected: FAIL — `isBackendPassCapable is not a function` / `executorKindForBackendId is not a function` (import errors).

- [ ] **Step 3: Implement the derivation helpers**

In `packages/web/src/lib/executorReachability.js`, immediately after the `EXECUTOR_KINDS` export (after line 41), add:

```js
// ── Backend ID → executor kind mapping ──────────────────────────────────────
// Single source of truth. Adding a new backend = adding one line here.
const BACKEND_ID_TO_KIND = Object.freeze({
  "node-executor":   EXECUTOR_KINDS.LOCAL_PROCESS,
  "docker-executor": EXECUTOR_KINDS.CONTAINER_RUNTIME,
});

/**
 * Map a registered executor backend id to its executor kind.
 * Throws on unknown ids — never silently default (fail-closed).
 *
 * @param {string} backendId - e.g. "node-executor", "docker-executor"
 * @returns {string} one of EXECUTOR_KINDS
 * @throws {Error} if the backend id is not known
 */
export function executorKindForBackendId(backendId) {
  const kind = BACKEND_ID_TO_KIND[backendId];
  if (!kind) {
    throw new Error(`executorKindForBackendId: unknown backend id '${backendId}'`);
  }
  return kind;
}

// ── Pass-capability derivation ───────────────────────────────────────────────
// Per-kind static capability crossed with observed reachability.
// local-process is NEVER pass-capable — it has no isolation boundary.
// container-runtime / delegated-run are pass-capable only when reachable.
const PASS_CAPABLE_KINDS = Object.freeze(new Set([
  EXECUTOR_KINDS.CONTAINER_RUNTIME,
  EXECUTOR_KINDS.DELEGATED_RUN,
]));

/**
 * Derive whether a backend kind is pass-capable given observed reachability.
 *
 * local-process → always false (no isolation boundary, per Gap 1 decision).
 * container-runtime → true only if reachable.
 * delegated-run → true only if reachable.
 *
 * @param {string} kind - one of EXECUTOR_KINDS
 * @param {boolean} reachable - observed reachability from the probe
 * @returns {boolean}
 * @throws {Error} on unknown kind (fail-closed — never silently pass-capable)
 */
export function isBackendPassCapable(kind, reachable) {
  if (!Object.values(EXECUTOR_KINDS).includes(kind)) {
    throw new Error(`isBackendPassCapable: unknown executor kind '${kind}'`);
  }
  if (kind === EXECUTOR_KINDS.LOCAL_PROCESS) return false;
  return Boolean(reachable);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=executor-reachability
```
Expected: PASS — all executor-reachability tests green, including the new `describe` blocks.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/executorReachability.js packages/web/tests/unit/executor-reachability.test.js
git commit -s -m "feat(executor): pass-capability derivation + kind/id mapping (Gap 1.1)"
```

---

## Task 2: Extend reachability summary with pass-capability + add validator readiness

**Goal of this task:** Make `getReachabilitySummary()` carry `pass_capable` per backend and `selected_pass_capable`, and add a new `getValidatorReadiness()` function that produces the `validator` block the design doc specifies (lines 240-254).

**Files:**
- Modify: `packages/web/src/lib/executorReachability.js`
- Modify: `packages/web/tests/unit/executor-reachability.test.js`

- [ ] **Step 1: Write failing tests**

Append to `packages/web/tests/unit/executor-reachability.test.js`:

```js
describe("getReachabilitySummary — pass-capability extension", () => {
  it("summary entries include pass_capable", () => {
    const { summary } = getReachabilitySummary();
    for (const entry of summary) {
      expect(typeof entry.pass_capable).toBe("boolean");
    }
  });

  it("local-process summary entry is never pass_capable", () => {
    const { summary } = getReachabilitySummary();
    const lp = summary.find((s) => s.kind === EXECUTOR_KINDS.LOCAL_PROCESS);
    expect(lp.pass_capable).toBe(false);
  });

  it("returns selected_pass_capable boolean", () => {
    const result = getReachabilitySummary();
    expect(typeof result.selected_pass_capable).toBe("boolean");
  });

  it("selected_pass_capable is false when local-process is selected", () => {
    // In CI/test envs Docker is unavailable, so local-process is selected
    const { selected_kind, selected_pass_capable } = getReachabilitySummary();
    if (selected_kind === EXECUTOR_KINDS.LOCAL_PROCESS) {
      expect(selected_pass_capable).toBe(false);
    }
  });
});

describe("getValidatorReadiness", () => {
  it("returns the doc-specified validator block shape", () => {
    const v = getValidatorReadiness();
    expect(v).toHaveProperty("configured");
    expect(v).toHaveProperty("pass_capable");
    expect(v).toHaveProperty("reason");
    expect(typeof v.pass_capable).toBe("boolean");
  });

  it("pass_capable is false when selected backend is local-process", () => {
    const v = getValidatorReadiness();
    // Test env has no Docker → local-process selected → not pass-capable
    expect(v.pass_capable).toBe(false);
  });

  it("reason is a typed string (not ambiguous)", () => {
    const v = getValidatorReadiness();
    expect(typeof v.reason).toBe("string");
    expect(v.reason.length).toBeGreaterThan(0);
    // Must be one of the typed reasons, never a bare empty string
    expect(v.reason).toMatch(
      /^(configured_and_pass_capable|selected_backend_not_pass_capable|validator_image_not_configured|no_reachable_backend)$/
    );
  });

  // FIX #2 lock-in: `configured` and `pass_capable` are INDEPENDENT.
  // Even when the selected backend is not pass-capable, `configured` must
  // still reflect whether the operator set the validator image env vars.
  // (Test env: no Docker → local-process selected → pass_capable=false.
  //  We set the env vars here to prove `configured` tracks them, not the
  //  backend capability.)
  it("configured is independent of pass_capable (set image, still not pass-capable)", () => {
    const REF = "registry.example.com/v@sha256:" + "a".repeat(64);
    const DIGEST = "sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIGEST;
    try {
      const v = getValidatorReadiness();
      expect(v.configured).toBe(true);          // image IS set
      expect(v.pass_capable).toBe(false);        // but local-process can't pass
      expect(v.reason).toBe("selected_backend_not_pass_capable");
    } finally {
      delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
      delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=executor-reachability
```
Expected: FAIL — summary entries have no `pass_capable`; `getValidatorReadiness is not a function`.

- [ ] **Step 3: Extend `getReachabilitySummary()` and add `getValidatorReadiness()`**

> **Cross-task dependency:** `getValidatorReadiness()` calls `resolveValidatorImage()` from Task 4. **Implement Task 4 first**, then come back to this step. If executing task-by-task out of order, add the import line now but expect `getValidatorReadiness` to throw until Task 4 lands — the Step 4 test run for THIS task should use `--testNamePattern="getReachabilitySummary"` to scope to the summary-only assertions, then re-run the full file after Task 4.

In `packages/web/src/lib/executorReachability.js`, first add this import at the top of the file (after the existing `import { execSync } from "node:child_process";` line):

```js
import { resolveValidatorImage } from "./validatorImage.js";
```

Then replace the existing `getReachabilitySummary` function (lines 166-178) with:

```js
/**
 * Get a compact reachability summary for /health or /readiness.
 * Includes per-backend pass-capability and the selected backend's
 * pass-capability so operators can tell whether the current deployment
 * can produce production-grade validator proof.
 *
 * @param {string[]} [priorityOrder]
 * @returns {{
 *   summary: Array<{kind: string, reachable: boolean, runtime: string|null, pass_capable: boolean}>,
 *   selected_kind: string|null,
 *   selected_reason: string,
 *   selected_pass_capable: boolean,
 * }}
 */
export function getReachabilitySummary(priorityOrder) {
  const { backends, selected, selected_reason } = probeAllBackends(priorityOrder);

  const summary = backends.map((b) => ({
    kind: b.kind,
    reachable: b.reachable,
    runtime: b.runtime,
    pass_capable: isBackendPassCapable(b.kind, b.reachable),
  }));

  const selected_pass_capable = selected
    ? isBackendPassCapable(selected.kind, selected.reachable)
    : false;

  return {
    summary,
    selected_kind: selected?.kind || null,
    selected_reason,
    selected_pass_capable,
  };
}

// ── Validator readiness ─────────────────────────────────────────────────────
// Typed reasons (never ambiguous empty strings). These are the externally
// observable answers to "can this deployment produce pass-capable validator
// evidence right now?"
export const VALIDATOR_READINESS_REASONS = Object.freeze({
  CONFIGURED_AND_PASS_CAPABLE:     "configured_and_pass_capable",
  SELECTED_BACKEND_NOT_PASS_CAPABLE: "selected_backend_not_pass_capable",
  VALIDATOR_IMAGE_NOT_CONFIGURED:  "validator_image_not_configured",
  NO_REACHABLE_BACKEND:            "no_reachable_backend",
});

/**
 * Produce the validator readiness block for /health.
 *
 * Composes the executor pass-capability view with validator image
 * configuration. The result answers: "Can this deployment produce
 * production-grade validator proof?"
 *
 * IMPORTANT — `configured` and `pass_capable` are INDEPENDENT signals:
 *   configured   = "is the validator image identity set in config?"
 *   pass_capable = "can the currently-selected backend actually produce pass proof?"
 * A deployment can be configured=true but pass_capable=false (image set, but
 * local-process selected). Operators need both signals; collapsing them hides
 * the "you configured it, but the runtime can't honor it" case.
 *
 * @returns {{ configured: boolean, pass_capable: boolean, reason: string }}
 */
export function getValidatorReadiness() {
  // FIX: getReachabilitySummary returns `selected_kind` (string|null), NOT
  // `selected` (object). Destructure the actual field name.
  const { selected_kind, selected_pass_capable } = getReachabilitySummary();

  // Read validator image config via the dedicated resolver (Task 4) so the
  // "is it configured?" signal is the SAME definition used by the receipt
  // path. Top-of-file static import (see Step 3 import line).
  const validatorImage = resolveValidatorImage();
  const configured = Boolean(validatorImage.configured);

  // No reachable backend at all → not pass-capable. configured is still
  // reported independently (operator may have set the image even though
  // nothing is reachable).
  if (!selected_kind) {
    return {
      configured,
      pass_capable: false,
      reason: VALIDATOR_READINESS_REASONS.NO_REACHABLE_BACKEND,
    };
  }

  // Backend reachable but not pass-capable (e.g. local-process on CT 115).
  // Report configured independently — this is the key operator signal.
  if (!selected_pass_capable) {
    return {
      configured,
      pass_capable: false,
      reason: VALIDATOR_READINESS_REASONS.SELECTED_BACKEND_NOT_PASS_CAPABLE,
    };
  }

  // Backend IS pass-capable. Now the deciding factor is validator image
  // identity. If it's not configured, we're reachable-and-isolated but
  // have nothing pinned to run.
  if (!configured) {
    return {
      configured: false,
      pass_capable: false,
      reason: VALIDATOR_READINESS_REASONS.VALIDATOR_IMAGE_NOT_CONFIGURED,
    };
  }

  return {
    configured: true,
    pass_capable: true,
    reason: VALIDATOR_READINESS_REASONS.CONFIGURED_AND_PASS_CAPABLE,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=executor-reachability
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/executorReachability.js packages/web/tests/unit/executor-reachability.test.js
git commit -s -m "feat(executor): pass-capability in health summary + validator readiness (Gap 1.1)"
```

---

## Task 3: Surface validator readiness on `/health`

**Goal of this task:** Wire `selected_pass_capable` and the new `validator` block into the `/health` response so CT 115's "Docker unavailable but healthy" condition is externally unambiguous. Satisfies acceptance criterion #6.

**Files:**
- Modify: `packages/web/src/lib/deploymentInfo.js`
- Create: `packages/web/tests/unit/deployment-validator-readiness.test.js`

- [ ] **Step 1: Write a failing source-reading acceptance test**

Create `packages/web/tests/unit/deployment-validator-readiness.test.js`:

```js
// Source-reading acceptance test: the /health response must surface
// selected_pass_capable and a validator block so CT 115's
// "healthy but not pass-capable" state is externally observable.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const deploymentInfo = readSource("packages/web/src/lib/deploymentInfo.js");
const reachability = readSource("packages/web/src/lib/executorReachability.js");

describe("/health validator readiness wiring", () => {
  it("deploymentInfo calls getValidatorReadiness", () => {
    expect(deploymentInfo).toMatch(/getValidatorReadiness/);
  });

  it("deploymentInfo returns a top-level validator field", () => {
    expect(deploymentInfo).toMatch(/validator:/);
  });

  it("executorReachability exports getValidatorReadiness", () => {
    expect(reachability).toMatch(/export function getValidatorReadiness/);
  });

  it("executorReachability exports getReachabilitySummary", () => {
    expect(reachability).toMatch(/export function getReachabilitySummary/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=deployment-validator-readiness
```
Expected: FAIL — `deploymentInfo` does not yet reference `getValidatorReadiness` / return a `validator:` field.

- [ ] **Step 3: Modify `deploymentInfo.js` to surface the validator block**

In `packages/web/src/lib/deploymentInfo.js`, replace the executor reachability try/catch block (lines 75-82):

```js
  // Probe executor reachability (v0.21.0 — externally observable without SSH)
  let executor = {};
  try {
    const { getReachabilitySummary } = await import("./executorReachability.js");
    executor = getReachabilitySummary();
  } catch {
    // Reachability module unavailable — health still works
  }
```

with:

```js
  // Probe executor reachability + validator readiness (Gap 1).
  // executor.selected_pass_capable + the validator block make CT 115's
  // "healthy but not pass-capable" state externally unambiguous.
  let executor = {};
  let validator = {};
  try {
    const {
      getReachabilitySummary,
      getValidatorReadiness,
    } = await import("./executorReachability.js");
    executor = getReachabilitySummary();
    validator = getValidatorReadiness();
  } catch {
    // Reachability module unavailable — health still works, but report
    // validator as explicitly not ready (fail-safe, not silent).
    validator = { configured: false, pass_capable: false, reason: "module_unavailable" };
  }
```

Then add `validator,` to the returned object (after the `executor,` line, currently line 90). The final returned object should read:

```js
  return {
    version: VERSION,
    git_sha: GIT_SHA,
    db_migrations_applied: applied,
    db_migrations_available: available,
    db_migration_status: dbMigrationStatus,
    executor,
    validator,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=deployment-validator-readiness
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/deploymentInfo.js packages/web/tests/unit/deployment-validator-readiness.test.js
git commit -s -m "feat(health): expose selected_pass_capable + validator readiness block (Gap 1.1)"
```

---

## Task 4: Validator image identity config module

**Goal of this task:** Introduce a pure module that resolves validator image identity (`ref`, `digest`, `identity_complete`) from config. This is the seam Phase 3 receipts will call. Satisfies acceptance criterion #1 ("validator image has immutable identity") at the resolution layer.

**Files:**
- Create: `packages/web/src/lib/validatorImage.js`
- Create: `packages/web/tests/unit/validator-image.test.js`

- [ ] **Step 1: Write failing tests**

Create `packages/web/tests/unit/validator-image.test.js`:

```js
// Tests for validator image identity resolution (Gap 1.2).

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  resolveValidatorImage,
  isValidatorIdentityComplete,
  VALIDATOR_IMAGE_REQUIRED_FIELDS,
} from "../../src/lib/validatorImage.js";

describe("resolveValidatorImage — unconfigured", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  it("returns configured=false when no env set", () => {
    const r = resolveValidatorImage();
    expect(r.configured).toBe(false);
    expect(r.identity_complete).toBe(false);
  });

  it("lists ref under missing when unconfigured", () => {
    const r = resolveValidatorImage();
    expect(r.missing).toContain("ref");
  });
});

describe("resolveValidatorImage — fully configured", () => {
  const REF = "registry.example.com/gitwire/validator@sha256:" + "a".repeat(64);
  const DIGEST = "sha256:" + "a".repeat(64);

  beforeEach(() => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  afterEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  it("returns configured=true and identity_complete=true", () => {
    const r = resolveValidatorImage();
    expect(r.configured).toBe(true);
    expect(r.identity_complete).toBe(true);
  });

  it("exposes the ref and digest", () => {
    const r = resolveValidatorImage();
    expect(r.ref).toBe(REF);
    expect(r.digest).toBe(DIGEST);
  });

  it("missing is empty when complete", () => {
    const r = resolveValidatorImage();
    expect(r.missing).toEqual([]);
  });
});

describe("resolveValidatorImage — partial config is NOT identity-complete", () => {
  const REF = "registry.example.com/gitwire/validator@sha256:" + "b".repeat(64);

  beforeEach(() => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  afterEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
  });

  it("configured=true (ref present) but identity_complete=false (digest missing)", () => {
    const r = resolveValidatorImage();
    expect(r.configured).toBe(true);
    expect(r.identity_complete).toBe(false);
    expect(r.missing).toContain("digest");
  });
});

describe("resolveValidatorImage — digest mismatch with ref is rejected", () => {
  const REF = "registry.example.com/gitwire/validator@sha256:" + "c".repeat(64);
  const DIFFERENT_DIGEST = "sha256:" + "d".repeat(64);

  beforeEach(() => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIFFERENT_DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  afterEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  it("identity_complete=false when env digest != ref digest", () => {
    const r = resolveValidatorImage();
    expect(r.identity_complete).toBe(false);
    expect(r.missing).toContain("digest_match");
  });
});

describe("isValidatorIdentityComplete", () => {
  it("true for a complete resolved identity", () => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "r@sha256:" + "e".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "e".repeat(64);
    const r = resolveValidatorImage();
    expect(isValidatorIdentityComplete(r)).toBe(true);
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  it("false for unconfigured", () => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    expect(isValidatorIdentityComplete(resolveValidatorImage())).toBe(false);
  });
});

describe("VALIDATOR_IMAGE_REQUIRED_FIELDS", () => {
  it("lists the immutable-identity fields from the Gap 1 doc", () => {
    expect(VALIDATOR_IMAGE_REQUIRED_FIELDS).toContain("ref");
    expect(VALIDATOR_IMAGE_REQUIRED_FIELDS).toContain("digest");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=validator-image
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `validatorImage.js`**

Create `packages/web/src/lib/validatorImage.js`:

```js
// src/lib/validatorImage.js
// Validator image identity resolution (Gap 1 Phase 2).
//
// The production validator image must have IMMUTABLE identity. This module
// resolves that identity from configuration and reports whether it is
// complete enough to authorize pass-capable validator execution.
//
// Required identity fields (per docs/architecture/validator-execution-model.md):
//   validator_image_ref     — full registry/repo/image@sha256:<hex64>
//   validator_image_digest  — sha256:<hex64>, must match the ref's digest
//
// Design notes:
// - Reads process.env directly (lazy, import-safe). The Zod config layer
//   (config/index.js) ALSO validates these keys at boot; this module is the
//   runtime read site used by the sandbox runner + receipt builder.
// - A ref whose embedded digest does not match the standalone
//   GITWIRE_VALIDATOR_IMAGE_DIGEST is treated as identity-incomplete.
//   Two different digests for "the same" image is a config error, not pass proof.
// - The test-fixture ref (used by dockerExecutorBackend in non-production) is
//   NOT a complete production identity and is never identity-complete here
//   unless GITWIRE_ALLOW_TEST_FIXTURE=1.

import { parseImageReference } from "./imageReference.js";

// Required identity fields. Exported so tests + receipts can reference the
// single source of truth for what "immutable identity" means.
export const VALIDATOR_IMAGE_REQUIRED_FIELDS = Object.freeze(["ref", "digest"]);

/**
 * Resolve the configured validator image identity.
 *
 * @returns {{
 *   configured: boolean,
 *   ref: string|null,
 *   digest: string|null,
 *   identity_complete: boolean,
 *   missing: string[],
 * }}
 */
export function resolveValidatorImage() {
  const ref = process.env.GITWIRE_VALIDATOR_IMAGE_REF || null;
  const envDigest = process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST || null;

  const missing = [];
  if (!ref) missing.push("ref");
  if (!envDigest) missing.push("digest");

  const configured = Boolean(ref);

  // Cross-check: if a ref is set, its embedded digest must equal the
  // standalone GITWIRE_VALIDATOR_IMAGE_DIGEST. A mismatch is a config error
  // and means identity is not proven.
  let refDigest = null;
  if (ref) {
    try {
      refDigest = parseImageReference(ref).image_digest;
    } catch {
      // ref is not parseable as digest-pinned — record as missing field
      missing.push("ref_digest_pinned");
      refDigest = null;
    }
  }

  let digestMatch = true;
  if (refDigest && envDigest && refDigest !== envDigest) {
    digestMatch = false;
    missing.push("digest_match");
  }

  const identity_complete =
    configured &&
    Boolean(envDigest) &&
    Boolean(refDigest) &&
    digestMatch;

  return {
    configured,
    ref,
    digest: envDigest,
    identity_complete,
    missing,
  };
}

/**
 * Convenience predicate.
 * @param {ReturnType<resolveValidatorImage>} [resolved]
 * @returns {boolean}
 */
export function isValidatorIdentityComplete(resolved) {
  return Boolean((resolved || resolveValidatorImage()).identity_complete);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=validator-image
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/validatorImage.js packages/web/tests/unit/validator-image.test.js
git commit -s -m "feat(validator): image identity resolution module (Gap 1.2)"
```

---

## Task 5: Formalize validator config in the Zod schema

**Goal of this task:** Add `GITWIRE_VALIDATOR_IMAGE_REF`, `GITWIRE_VALIDATOR_IMAGE_DIGEST`, `GITWIRE_ALLOW_TEST_FIXTURE`, and `GITWIRE_EXECUTOR_BACKEND` to the Zod schema as a new `config.validator` group. This does not change existing ad-hoc reads (they keep working) but gives boot-time validation and a typed accessor.

**Files:**
- Modify: `packages/web/config/index.js`

- [ ] **Step 1: Write a failing test**

Create `packages/web/tests/unit/config-validator.test.js`:

```js
// Verifies the Zod config exposes a `validator` group (Gap 1.2).

import { describe, it, expect } from "@jest/globals";

describe("config.validator group", () => {
  it("is present on the config export", async () => {
    // config/index.js validates at import time — must have valid env for boot.
    // Provide minimal required vars so the schema parses.
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@localhost:5432/db";
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
    const { config } = await import("../../config/index.js");
    expect(config).toHaveProperty("validator");
  });

  it("exposes ref, digest, allowTestFixture, executorBackend", async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@localhost:5432/db";
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
    const { config } = await import("../../config/index.js");
    expect(config.validator).toHaveProperty("ref");
    expect(config.validator).toHaveProperty("digest");
    expect(config.validator).toHaveProperty("allowTestFixture");
    expect(config.validator).toHaveProperty("executorBackend");
  });
});
```

> **Note on test isolation:** `config/index.js` runs `setConfig()` at import. Other test suites also import it transitively. Importing it here is safe because the schema `.optional()`s make every validator key optional. The two required keys (`DATABASE_URL`, `REDIS_URL`) are given safe local defaults if unset.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=config-validator
```
Expected: FAIL — `config.validator` is undefined.

- [ ] **Step 3: Add the schema keys and config group**

In `packages/web/config/index.js`, add to the `schema = z.object({...})` (after the `APP_BASE_URL` line, before the closing `});`):

```js
  // Validator (Gap 1.2) — production validator image identity + executor selection.
  // All optional: local dev and CI run without them. Production pass-capable
  // validation requires ref + digest to be set; getValidatorReadiness() reports
  // the gap explicitly rather than failing boot.
  GITWIRE_VALIDATOR_IMAGE_REF: z.string().optional(),
  GITWIRE_VALIDATOR_IMAGE_DIGEST: z.string().optional(),
  GITWIRE_ALLOW_TEST_FIXTURE: z.string().optional(),
  GITWIRE_EXECUTOR_BACKEND: z.string().optional(),
```

Then add a new group to the `export const config = {...}` object (after the `anthropic:` group, before the closing `};`):

```js
  validator: {
    ref:              parsed.data.GITWIRE_VALIDATOR_IMAGE_REF || null,
    digest:           parsed.data.GITWIRE_VALIDATOR_IMAGE_DIGEST || null,
    allowTestFixture: parsed.data.GITWIRE_ALLOW_TEST_FIXTURE === "1",
    executorBackend:  parsed.data.GITWIRE_EXECUTOR_BACKEND || null,
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=config-validator
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/config/index.js packages/web/tests/unit/config-validator.test.js
git commit -s -m "feat(config): validator image identity + executor backend config group (Gap 1.2)"
```

---

## Task 6: Bind validator fields into execution receipts

**Goal of this task:** Extend `buildExecutionReceipt()` to carry `executor_kind`, `executor_pass_capable`, `validator_image_ref`, `validator_image_digest`, `validator_result`, `validator_result_status` inside the content-addressed receipt, and return `proof_collected_at` as a sibling (NOT inside the hash, preserving write-once dedup). Satisfies acceptance criterion #2.

**Files:**
- Modify: `packages/web/src/lib/sandboxRunner.js`
- Create: `packages/web/tests/unit/execution-receipt-validator-fields.test.js`

- [ ] **Step 1: Write failing tests**

Create `packages/web/tests/unit/execution-receipt-validator-fields.test.js`:

```js
// Tests that buildExecutionReceipt() binds the Gap 1 validator fields.

import { describe, it, expect } from "@jest/globals";
import { buildExecutionReceipt } from "../../src/lib/sandboxRunner.js";

const BASE_PARAMS = {
  execution_backend_id: "docker-executor",
  executor_version: "1.0.0",
  source_snapshot_hash: "sha256:src",
  patch_artifact_hash: "sha256:patch",
  base_sha: "abc",
  input_bundle_hash: "sha256:bundle",
  sandbox_image_digest: "sha256:" + "a".repeat(64),
  validation_plan_hash: "sha256:plan",
  commands_executed: ["npm-test"],
  per_command_exit_statuses: [0],
  aggregate_exit_status: 0,
  output_refs: ["output:1"],
  output_hashes: ["sha256:1"],
  limits_applied: {},
  result: "pass",
  container_runtime: "docker",
  runtime_version: "24.0.7",
  network_disabled: true,
  non_root: true,
  read_only_rootfs: true,
  resource_limits: {},
  image_ref: "registry.example.com/gitwire/validator@sha256:" + "a".repeat(64),
  // Gap 1 new fields:
  executor_kind: "container-runtime",
  executor_pass_capable: true,
  validator_image_ref: "registry.example.com/gitwire/validator@sha256:" + "a".repeat(64),
  validator_image_digest: "sha256:" + "a".repeat(64),
  validator_result: "pass",
  validator_result_status: "pass",
};

describe("buildExecutionReceipt — validator fields bound", () => {
  it("receipt content contains executor_kind", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.executor_kind).toBe("container-runtime");
  });

  it("receipt content contains executor_pass_capable", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.executor_pass_capable).toBe(true);
  });

  it("receipt content contains validator_image_ref + digest", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.validator_image_ref).toContain("sha256:");
    expect(parsed.validator_image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("receipt content contains validator_result + validator_result_status", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.validator_result).toBe("pass");
    expect(parsed.validator_result_status).toBe("pass");
  });

  it("receipt content does NOT contain proof_collected_at (stays content-addressed)", () => {
    const { receipt_content } = buildExecutionReceipt(BASE_PARAMS);
    const parsed = JSON.parse(receipt_content);
    expect(parsed.proof_collected_at).toBeUndefined();
  });

  it("proof_collected_at is returned as a SIBLING, not inside the hash", () => {
    const result = buildExecutionReceipt(BASE_PARAMS);
    expect(result.proof_collected_at).toBeDefined();
    expect(typeof result.proof_collected_at).toBe("string");
  });
});

describe("buildExecutionReceipt — local-process is never pass-capable in receipt", () => {
  it("node-executor receipt carries executor_pass_capable=false", () => {
    const { receipt_content } = buildExecutionReceipt({
      ...BASE_PARAMS,
      execution_backend_id: "node-executor",
      executor_kind: "local-process",
      executor_pass_capable: false,
      result: "inconclusive",
      validator_result: "inconclusive",
      validator_result_status: "inconclusive",
      inconclusive_reason: "host_spawn_not_isolated",
      image_ref: null,
      validator_image_ref: null,
      validator_image_digest: null,
    });
    const parsed = JSON.parse(receipt_content);
    expect(parsed.executor_pass_capable).toBe(false);
    expect(parsed.validator_result_status).toBe("inconclusive");
  });
});

describe("buildExecutionReceipt — hash determinism preserved", () => {
  it("identical inputs produce identical receipt_hash", () => {
    const a = buildExecutionReceipt(BASE_PARAMS);
    const b = buildExecutionReceipt(BASE_PARAMS);
    expect(a.receipt_hash).toBe(b.receipt_hash);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=execution-receipt-validator-fields
```
Expected: FAIL — `executor_kind` undefined in parsed receipt; `proof_collected_at` undefined on result.

- [ ] **Step 3: Extend `buildExecutionReceipt()`**

In `packages/web/src/lib/sandboxRunner.js`, modify the destructure at the top of `buildExecutionReceipt()` (currently lines 146-172) to add the new fields. After the `image_ref,` line in the destructure (currently line 171), add:

```js
    // Gap 1 validator bindings — bound into the receipt so the verifier
    // can confirm the validator result came from a pass-capable backend
    // with proven image identity.
    executor_kind,
    executor_pass_capable,
    validator_image_ref,
    validator_image_digest,
    validator_result,
    validator_result_status,
```

Then, inside the `receiptObject = { ... }` (after the `image_ref: image_ref || null,` line, currently line 197), add:

```js
    // Gap 1 validator bindings — part of the content-addressed hash.
    executor_kind: executor_kind || null,
    executor_pass_capable: Boolean(executor_pass_capable),
    validator_image_ref: validator_image_ref || null,
    validator_image_digest: validator_image_digest || null,
    validator_result: validator_result || result,
    validator_result_status: validator_result_status || result,
```

(The `validator_result || result` fallback means a caller that doesn't pass the new fields still gets a receipt whose validator_result mirrors the legacy `result` — backward-compatible.)

Finally, change the function's return statement (currently lines 202-206) to return `proof_collected_at` as a sibling:

```js
  const receiptContent = JSON.stringify(receiptObject);
  const receiptHash = "sha256:" + crypto.createHash("sha256").update(receiptContent).digest("hex");
  const receiptRef = `receipt:${receiptHash}`;

  // proof_collected_at is a sibling, NOT inside receipt_content. Keeping it
  // out of the hash preserves the content-addressed write-once dedup
  // property (two identical executions stay the same receipt even if run
  // at different times). The durable store's created_at is the canonical
  // persisted timestamp; this sibling is the in-memory observed time.
  return {
    receipt_content: receiptContent,
    receipt_hash: receiptHash,
    receipt_ref: receiptRef,
    proof_collected_at: new Date().toISOString(),
  };
```

- [ ] **Step 4: Run the new test to verify it passes**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=execution-receipt-validator-fields
```
Expected: PASS.

- [ ] **Step 5: Run the FULL existing receipt + verification suites to catch regressions**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern="execution-receipt|verification|pass-capable|repair-proposal"
```
Expected: All PASS. The new fields default sensibly (`executor_kind: null` etc. when a caller doesn't pass them) so existing callers that don't yet pass the new fields keep producing valid receipts. **If any existing test asserts an exact receipt object shape with a fixed hash, it will need its expected hash updated** — in that case, update the expected value in the existing test (the hash legitimately changed because we added fields to the content). Document this in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/sandboxRunner.js packages/web/tests/unit/execution-receipt-validator-fields.test.js
git commit -s -m "feat(receipts): bind validator fields + executor_kind/pass_capable (Gap 1.3)"
```

---

## Task 7: Thread validator fields through `runSandboxVerification()`

**Goal of this task:** Make the sandbox runner actually populate the new receipt fields (Task 6 added the field plumbing; this task feeds them real values from the selected backend and the validator image config).

**Files:**
- Modify: `packages/web/src/lib/sandboxRunner.js`

- [ ] **Step 1: Write a failing test**

Create `packages/web/tests/unit/sandbox-runner-validator-fields.test.js`:

```js
// Verifies runSandboxVerification() threads executor_kind + validator identity
// into the produced receipt.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { runSandboxVerification } from "../../src/lib/sandboxRunner.js";

// Minimal artifact + envelope that will fail at apply time, producing an
// inconclusive receipt — we only care that the receipt carries the new fields.
const ARTIFACT = JSON.stringify({
  base_sha: "abc",
  files: [{ path: "x.txt", content: "hi" }],
  operations: [],
});

const ENVELOPE = {
  required_validation: ["noop"],
};

const SOURCE = [{ path: "x.txt", content: "old" }];

describe("runSandboxVerification — validator fields threaded into receipt", () => {
  beforeEach(() => {
    // Force node-executor (always-reachable) so the test is deterministic.
    process.env.GITWIRE_EXECUTOR_BACKEND = "node-executor";
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  afterEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
  });

  it("receipt carries executor_kind derived from the backend", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    const parsed = JSON.parse(result.receipt.receipt_content);
    expect(parsed.executor_kind).toBe("local-process");
  });

  it("receipt carries executor_pass_capable=false for node-executor", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    const parsed = JSON.parse(result.receipt.receipt_content);
    expect(parsed.executor_pass_capable).toBe(false);
    // local-process validator results are explicitly inconclusive/non-pass
    expect(parsed.validator_result_status).toBe("inconclusive");
  });

  it("receipt carries proof_collected_at sibling", async () => {
    const result = await runSandboxVerification({
      artifactContent: ARTIFACT,
      base_sha: "abc",
      taskEnvelope: ENVELOPE,
      sourceFiles: SOURCE,
      source_snapshot_hash: "sha256:src",
      input_bundle_hash: "sha256:bundle",
      patch_artifact_hash: "sha256:patch",
    });
    expect(result.receipt.proof_collected_at).toBeDefined();
  });

  // FIX #3 + #4 lock-in: even if getDefaultBackend() returns docker-executor
  // (which it does when registered, regardless of reachability), the receipt
  // MUST record executor_pass_capable=false when Docker is not actually
  // reachable. supports_pass=true on the backend object is NOT proof.
  it("docker-executor receipt is NOT pass-capable when Docker is unreachable", async () => {
    // Force docker-executor selection (simulates getDefaultBackend returning it).
    // In the test env, Docker is not installed, so the live probe will report
    // container-runtime as unreachable → executor_pass_capable must be false.
    process.env.GITWIRE_EXECUTOR_BACKEND = "docker-executor";
    // And supply a complete validator image identity so the ONLY reason for
    // not-pass-capable is the unreachable runtime (isolates fix #3/#4).
    const REF = "registry.example.com/v@sha256:" + "a".repeat(64);
    const DIGEST = "sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIGEST;

    try {
      const result = await runSandboxVerification({
        artifactContent: ARTIFACT,
        base_sha: "abc",
        taskEnvelope: ENVELOPE,
        sourceFiles: SOURCE,
        source_snapshot_hash: "sha256:src",
        input_bundle_hash: "sha256:bundle",
        patch_artifact_hash: "sha256:patch",
      });
      const parsed = JSON.parse(result.receipt.receipt_content);
      // Kind is container-runtime (from docker-executor id), but pass-capable
      // is false because Docker is unreachable in this env.
      expect(parsed.executor_kind).toBe("container-runtime");
      expect(parsed.executor_pass_capable).toBe(false);
      expect(parsed.validator_result_status).toBe("inconclusive");
    } finally {
      delete process.env.GITWIRE_EXECUTOR_BACKEND;
      delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
      delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    }
  });
});
```

> **Note:** The envelope uses `required_validation: ["noop"]`. If `"noop"` is not in the allowlisted command templates (`validationCommandTemplates.js`), the node-executor will produce a per-command error result and overall `inconclusive` — which is fine for this test since we only assert on the receipt fields, not on pass. If the test fails because `noop` is rejected at plan-build time (before the receipt is built), switch to a known-allowlisted command from the templates file.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=sandbox-runner-validator-fields
```
Expected: FAIL — `parsed.executor_kind` is `null` (the field exists from Task 6 but isn't populated by the runner).

- [ ] **Step 3: Thread the fields through `runSandboxVerification()`**

> **FIX #3 + #4 (review feedback):** Pass-capability is NOT derived from `backend.supports_pass` alone. `dockerExecutorBackend.supports_pass` is a static `true` that says nothing about whether Docker is actually reachable on this host (it is not, on CT 115). The receipt's `executor_pass_capable` must reflect **proven reachability at execution time**. The check is:
> ```
> backend.supports_pass === true
>   AND kind is pass-capable (not local-process)
>   AND a live reachability probe says this backend's kind IS reachable
>   AND validator image identity is complete
> ```
> Additionally, `getDefaultBackend()` (fix #4) may return `docker-executor` even when Docker is unreachable — its docblock admits this. So the runner must **cross-check** that the selected backend's kind is the actually-reachable kind; if `getDefaultBackend()` returned `docker-executor` but the probe says container-runtime is unreachable, the receipt MUST record `executor_pass_capable: false`. This prevents the runner from inheriting `getDefaultBackend()`'s false confidence.

In `packages/web/src/lib/sandboxRunner.js`, first add the imports at the top (after the existing `import { getDefaultBackend, getBackend } from "./executorRegistry.js";`):

```js
import {
  executorKindForBackendId,
  isBackendPassCapable,
  probeAllBackends,
  EXECUTOR_KINDS,
} from "./executorReachability.js";
import { resolveValidatorImage } from "./validatorImage.js";
```

Then, inside `runSandboxVerification()`, right after `const isolation = backend.describe();` (currently line 251), add a block that derives the validator bindings ONCE from real probe data and reuses them in both `buildExecutionReceipt()` call sites:

```js
  // Gap 1 — derive validator bindings for the receipt from PROVEN reachability.
  //
  // executor_kind comes from the backend id. But executor_pass_capable is NOT
  // just backend.supports_pass — it requires a live probe to confirm the
  // backend's kind is actually reachable right now. getDefaultBackend() may
  // return docker-executor even when Docker is unreachable (its selection is
  // not probe-driven); the receipt must not inherit that false confidence.
  const validatorImage = resolveValidatorImage();
  const executorKind = executorKindForBackendId(backend.id);

  // Live probe: which kinds are actually reachable at this moment?
  const probe = probeAllBackends();
  const reachableKinds = new Set(
    probe.backends.filter((b) => b.reachable).map((b) => b.kind)
  );
  const kindActuallyReachable = reachableKinds.has(executorKind);

  // Pass-capability requires ALL FOUR conditions (fix #3):
  //   1. backend advertises supports_pass
  //   2. kind is structurally pass-capable (not local-process)
  //   3. a live probe confirms this kind is reachable
  //   4. validator image identity is complete (ref + digest + match)
  const executorPassCapable =
    backend.supports_pass === true &&
    isBackendPassCapable(executorKind, kindActuallyReachable) &&
    validatorImage.identity_complete;
```

Note: `isBackendPassCapable(kind, reachable)` already encodes conditions (2) and (3) — it returns `false` for `local-process` regardless of `reachable`, and `false` for the pass-capable kinds when `reachable` is false. The `backend.supports_pass` and `validatorImage.identity_complete` checks add conditions (1) and (4) on top.

Then update BOTH `buildExecutionReceipt({...})` calls inside `runSandboxVerification()` to pass the new fields. Add these arguments right after the existing `image_ref: isolation.image_ref,` argument in each call.

**Artifact-apply-failed path** (first `buildExecutionReceipt` call, ~line 277) — this path is always inconclusive regardless of backend capability (the patch never ran), so validator_result is explicitly inconclusive:

```js
      executor_kind: executorKind,
      executor_pass_capable: executorPassCapable,
      validator_image_ref: validatorImage.ref,
      validator_image_digest: validatorImage.digest,
      validator_result: "inconclusive",
      validator_result_status: "inconclusive",
```

**Success path** (second `buildExecutionReceipt` call, ~line 339) — the validator result mirrors the execution overall, but is downgraded to `inconclusive` when the backend isn't pass-capable. This guarantees the design doc's invariant: a local-process (or unreachable-Docker) receipt's `validator_result_status` is always `inconclusive`, never `pass`:

```js
      executor_kind: executorKind,
      executor_pass_capable: executorPassCapable,
      validator_image_ref: validatorImage.ref,
      validator_image_digest: validatorImage.digest,
      validator_result: executorPassCapable ? execResult.overall : "inconclusive",
      validator_result_status: executorPassCapable ? execResult.overall : "inconclusive",
```

`proof_collected_at` is already returned by `buildExecutionReceipt()` (Task 6) and flows through the existing `receipt` object spread in both return statements — no extra change needed. Verify with the Step 4 test.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=sandbox-runner-validator-fields
```
Expected: PASS.

- [ ] **Step 5: Run the broader verification suite to catch regressions**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern="verification|sandbox|execution-receipt|repair-proposal|pass-capable"
```
Expected: All PASS. Any test that hardcoded a receipt hash will need its expected hash updated — do so and note it in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/sandboxRunner.js packages/web/tests/unit/sandbox-runner-validator-fields.test.js
git commit -s -m "feat(sandbox): thread executor_kind + validator identity into receipts (Gap 1.3)"
```

---

## Task 7.5: Make `getDefaultBackend()` reachability-honest

**Goal of this task:** Fix the root cause surfaced by Task 7's consistency guard (fix #4). `getDefaultBackend()` in `executorRegistry.js` currently returns `docker-executor` whenever it is registered, *regardless of whether Docker is reachable* — its own docblock (lines 67-80) claims reachability-aware selection but the body (lines 82-106) just returns the backend. This is why CT 115's app container would silently select a backend it cannot actually use. Task 7's runner now defends against this at receipt-build time; this task fixes it at the selection source so the *selected* backend is the *reachable* backend, and selection is externally observable.

**Scope guard:** This task changes **selection behavior**, not the backend contract. It does not change `describe()` or `run()` shapes. The change is: before returning `docker-executor`, probe container-runtime reachability; if unreachable, fall back to `node-executor` and record a typed selection reason.

**Files:**
- Modify: `packages/web/src/lib/executorRegistry.js`
- Create: `packages/web/tests/unit/executor-registry-reachability.test.js`

- [ ] **Step 1: Write failing tests**

Create `packages/web/tests/unit/executor-registry-reachability.test.js`:

```js
// Tests that getDefaultBackend() is reachability-honest (fix #4).
// docker-executor must NOT be returned when container-runtime is unreachable.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { getDefaultBackend, getBackend } from "../../src/lib/executorRegistry.js";

describe("getDefaultBackend — reachability-honest selection", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_BACKEND;
  });

  it("returns node-executor when container-runtime is unreachable (test env)", () => {
    // In the test environment Docker/Podman are not installed, so
    // container-runtime is unreachable. getDefaultBackend() must NOT
    // return docker-executor.
    const backend = getDefaultBackend();
    expect(backend.id).toBe("node-executor");
  });

  it("getBackend('docker-executor') still works for explicit selection", () => {
    // Explicit selection by id is unchanged — callers who KNOW they want
    // docker-executor can still get it. Reachability honesty applies to
    // DEFAULT selection, not explicit selection.
    const backend = getBackend("docker-executor");
    expect(backend.id).toBe("docker-executor");
  });

  it("honors GITWIRE_EXECUTOR_BACKEND=node-executor", () => {
    process.env.GITWIRE_EXECUTOR_BACKEND = "node-executor";
    expect(getDefaultBackend().id).toBe("node-executor");
  });

  it("falls back to node-executor when GITWIRE_EXECUTOR_BACKEND=docker-executor but Docker is unreachable", () => {
    // This is the CT 115 case: operator configured docker-executor, but the
    // app container has no Docker socket. getDefaultBackend() must NOT
    // honor the unreachable preference — it must fall back.
    process.env.GITWIRE_EXECUTOR_BACKEND = "docker-executor";
    expect(getDefaultBackend().id).toBe("node-executor");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=executor-registry-reachability
```
Expected: FAIL — `getDefaultBackend()` currently returns `docker-executor` (it's registered and the body doesn't probe), so the first and fourth tests fail.

- [ ] **Step 3: Rewrite `getDefaultBackend()` to probe reachability**

In `packages/web/src/lib/executorRegistry.js`, replace the entire `getDefaultBackend()` function (currently lines 82-106) with a reachability-honest version. Add a probe import at the top of the file (after the existing imports):

```js
import { probeContainerRuntime, EXECUTOR_KINDS } from "./executorReachability.js";
```

Then the new `getDefaultBackend()`:

```js
/**
 * Get the default backend, reachability-honest (Gap 1 fix #4).
 *
 * v0.21.0 claimed reachability-aware selection but the body just returned
 * the configured/registered backend without probing. On CT 115 that meant
 * docker-executor was silently selected even though the app container has
 * no Docker socket — the failure only surfaced later as an ambiguous
 * executor error.
 *
 * New behavior:
 *   1. If GITWIRE_EXECUTOR_BACKEND is set AND the backend is reachable
 *      (node-executor always is; docker-executor only if a runtime probe
 *      succeeds), return it.
 *   2. Otherwise auto-select: docker-executor if container-runtime probes
 *      reachable, else node-executor (always reachable fallback).
 *
 * node-executor is the guaranteed fallback — this function never throws
 * because node-executor is always available.
 *
 * Explicit getBackend(id) is unchanged; callers who know they want a
 * specific backend can still request it directly. Reachability honesty
 * applies to DEFAULT selection only.
 *
 * @returns {object}
 */
export function getDefaultBackend() {
  const configuredId = process.env.GITWIRE_EXECUTOR_BACKEND;

  // Resolve container-runtime reachability ONCE. node-executor is always
  // reachable by definition (it's just child_process.spawn).
  const containerReachable = probeContainerRuntime().reachable;

  const isReachable = (id) => {
    if (id === "node-executor") return true;
    if (id === "docker-executor") return containerReachable;
    return false; // unknown backends treated as unreachable (fail-closed)
  };

  // 1. Honor explicit config, but only if the configured backend is reachable.
  if (configuredId && registry.has(configuredId) && isReachable(configuredId)) {
    return registry.get(configuredId);
  }

  // 2. Auto-select: prefer docker-executor when reachable, else node-executor.
  if (containerReachable && registry.has("docker-executor")) {
    return registry.get("docker-executor");
  }
  return registry.get("node-executor");
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=executor-registry-reachability
```
Expected: PASS.

- [ ] **Step 5: Run the full verification + sandbox + reachability suites for regressions**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern="verification|sandbox|executor|execution-receipt|repair-proposal|pass-capable"
```
Expected: All PASS.

  **Watch for:** any existing test that relied on `getDefaultBackend()` returning `docker-executor` in a no-Docker environment. Those tests were previously relying on the buggy behavior; they must be updated to either (a) use explicit `getBackend("docker-executor")` if they genuinely want that backend, or (b) assert on `node-executor` as the honest default. Note the count in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/executorRegistry.js packages/web/tests/unit/executor-registry-reachability.test.js
git commit -s -m "fix(executor): getDefaultBackend() probes reachability before selecting docker (Gap 1 #4)"
```

---

## Task 8: Enforce validator receipt fields in the verifier gate

**Goal of this task:** Tighten `verifyExecutionReceiptAgainstLockedProposal()` in `repairProposalService.js` so a pass receipt is rejected unless it carries `executor_kind`, `executor_pass_capable=true`, `validator_image_ref` (digest-pinned), `validator_image_digest`, and `validator_result_status="pass"`. Satisfies acceptance criteria #3 and #4 (local-process can't pass; container-runtime pass only when proven).

> **FIX #5 (review feedback):** Source-reading regex tests alone are not a strong enough guardrail for the pass gate — they confirm a string exists in the source, not that the logic actually rejects bad receipts. We extract checks 3f–3j into a **pure, exported helper** `validateGap1ValidatorBindings(receipt)` that takes a parsed receipt object and throws on violation. This makes the gate behaviorally testable without a DB, and the verifier just calls the helper. The source-reading test stays as a secondary guardrail confirming the helper is wired in.

**Files:**
- Create: `packages/web/src/lib/validatorReceiptGate.js`
- Modify: `packages/web/src/services/repairProposalService.js`
- Create: `packages/web/tests/unit/validator-receipt-gate.test.js` (behavioral — primary)
- Create: `packages/web/tests/unit/validator-receipt-gate-wiring.test.js` (source-reading — secondary)

- [ ] **Step 1: Write failing behavioral tests for the pure helper**

Create `packages/web/tests/unit/validator-receipt-gate.test.js`:

```js
// Behavioral tests for the Gap 1 validator receipt gate (fix #5).
// Exercises validateGap1ValidatorBindings() directly — no DB, no mocks.
// This is the PRIMARY guardrail for the stricter pass gate.

import { describe, it, expect } from "@jest/globals";
import { validateGap1ValidatorBindings } from "../../src/lib/validatorReceiptGate.js";

const DIGEST = "sha256:" + "a".repeat(64);
const REF = "registry.example.com/v@" + DIGEST;

const VALID_PASS_RECEIPT = Object.freeze({
  executor_kind: "container-runtime",
  executor_pass_capable: true,
  validator_image_ref: REF,
  validator_image_digest: DIGEST,
  validator_result_status: "pass",
});

describe("validateGap1ValidatorBindings — accepts a valid pass receipt", () => {
  it("does not throw for a fully valid receipt", () => {
    expect(() => validateGap1ValidatorBindings({ ...VALID_PASS_RECEIPT })).not.toThrow();
  });
});

describe("validateGap1ValidatorBindings — rejects missing executor_kind", () => {
  it("throws when executor_kind is absent", () => {
    const r = { ...VALID_PASS_RECEIPT, executor_kind: undefined };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(/missing executor_kind/);
  });
});

describe("validateGap1ValidatorBindings — rejects local-process", () => {
  it("throws when executor_kind is local-process (cannot authorize pass)", () => {
    const r = { ...VALID_PASS_RECEIPT, executor_kind: "local-process" };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(
      /executor_kind is local-process.*cannot authorize pass/
    );
  });
});

describe("validateGap1ValidatorBindings — rejects non-pass-capable", () => {
  it("throws when executor_pass_capable is false", () => {
    const r = { ...VALID_PASS_RECEIPT, executor_pass_capable: false };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(
      /executor_pass_capable must be true/
    );
  });

  it("throws when executor_pass_capable is missing", () => {
    const r = { ...VALID_PASS_RECEIPT, executor_pass_capable: undefined };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(/executor_pass_capable must be true/);
  });
});

describe("validateGap1ValidatorBindings — rejects bad validator image identity", () => {
  it("throws when validator_image_ref is missing", () => {
    const r = { ...VALID_PASS_RECEIPT, validator_image_ref: undefined };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(/missing validator_image_ref/);
  });

  it("throws when validator_image_ref is not digest-pinned", () => {
    const r = { ...VALID_PASS_RECEIPT, validator_image_ref: "registry.example.com/v:latest" };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(/not digest-pinned|is invalid/);
  });

  it("throws when validator_image_digest is missing", () => {
    const r = { ...VALID_PASS_RECEIPT, validator_image_digest: undefined };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(/missing validator_image_digest/);
  });
});

describe("validateGap1ValidatorBindings — rejects non-pass validator_result_status", () => {
  it("throws when validator_result_status is inconclusive", () => {
    const r = { ...VALID_PASS_RECEIPT, validator_result_status: "inconclusive" };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(/validator_result_status.*must be 'pass'/);
  });

  it("throws when validator_result_status is fail", () => {
    const r = { ...VALID_PASS_RECEIPT, validator_result_status: "fail" };
    expect(() => validateGap1ValidatorBindings(r)).toThrow(/validator_result_status.*must be 'pass'/);
  });
});
```

- [ ] **Step 2: Run the behavioral test to verify it fails**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=validator-receipt-gate.test
```
Expected: FAIL — module `validatorReceiptGate.js` not found.

- [ ] **Step 3: Create the pure helper module**

Create `packages/web/src/lib/validatorReceiptGate.js`:

```js
// src/lib/validatorReceiptGate.js
// Pure Gap 1 validator receipt gate checks (checks 3f-3j).
//
// Extracted from verifyExecutionReceiptAgainstLockedProposal() so the pass
// gate's Gap 1 logic is unit-testable without a DB. The verifier imports and
// calls validateGap1ValidatorBindings(receipt); this module owns the rules.
//
// A pass receipt is accepted only when ALL of:
//   3f. executor_kind is present and NOT local-process
//   3g. executor_pass_capable === true
//   3h. validator_image_ref is present and digest-pinned
//   3i. validator_image_digest is present
//   3j. validator_result_status === "pass"

import { isDigestPinned } from "./imageReference.js";

/**
 * Validate the Gap 1 validator bindings on a pass receipt.
 * Throws on any violation; returns nothing on success.
 *
 * @param {object} receipt - parsed execution receipt object
 * @throws {Error} on any Gap 1 binding violation
 */
export function validateGap1ValidatorBindings(receipt) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("validateGap1ValidatorBindings: receipt must be an object");
  }

  // 3f. executor_kind present and not local-process.
  if (!receipt.executor_kind) {
    throw new Error(
      "Execution receipt missing executor_kind — pass requires Gap 1 executor binding"
    );
  }
  if (receipt.executor_kind === "local-process") {
    throw new Error(
      "Execution receipt executor_kind is local-process — local-process cannot authorize pass"
    );
  }

  // 3g. executor_pass_capable must be exactly true.
  if (receipt.executor_pass_capable !== true) {
    throw new Error(
      "Execution receipt executor_pass_capable must be true for a pass receipt"
    );
  }

  // 3h. validator_image_ref present and digest-pinned.
  if (!receipt.validator_image_ref) {
    throw new Error(
      "Execution receipt missing validator_image_ref — pass requires immutable validator image identity"
    );
  }
  if (!isDigestPinned(receipt.validator_image_ref)) {
    throw new Error(
      `Execution receipt validator_image_ref '${receipt.validator_image_ref}' is invalid: not digest-pinned`
    );
  }

  // 3i. validator_image_digest present.
  if (!receipt.validator_image_digest) {
    throw new Error(
      "Execution receipt missing validator_image_digest — pass requires immutable validator image identity"
    );
  }

  // 3j. validator_result_status must be 'pass'.
  if (receipt.validator_result_status !== "pass") {
    throw new Error(
      `Execution receipt validator_result_status is '${receipt.validator_result_status}', must be 'pass'`
    );
  }
}
```

- [ ] **Step 4: Run the behavioral test to verify it passes**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=validator-receipt-gate.test
```
Expected: PASS.

- [ ] **Step 5: Wire the helper into the verifier**

In `packages/web/src/services/repairProposalService.js`, locate `verifyExecutionReceiptAgainstLockedProposal()`. After the existing check 3e block (the `verifyBackendEvidence` try/catch that ends around line 2551) and **before** check 4 (`executor_version must be allowlisted`), insert a single call to the helper:

```js
  // ── Gap 1 checks 3f-3j — executor_kind, pass-capability, validator identity.
  // Logic lives in the pure helper so it is unit-testable without a DB.
  try {
    const { validateGap1ValidatorBindings } = await import("../lib/validatorReceiptGate.js");
    validateGap1ValidatorBindings(receipt);
  } catch (gap1Err) {
    throw new Error(`Gap 1 validator binding check failed: ${gap1Err.message}`);
  }
```

(Use a dynamic import to match the existing verifier's style — it already dynamically imports `verifyBackendEvidence` and `isDigestPinned` at the call site.)

- [ ] **Step 6: Add the secondary source-reading wiring test**

Create `packages/web/tests/unit/validator-receipt-gate-wiring.test.js`:

```js
// Secondary guardrail: confirms the verifier actually CALLS the helper.
// Behavioral coverage is in validator-receipt-gate.test.js; this just locks
// in the cross-file wiring (mirrors pass-capable-unlock.test.js pattern).

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const repairService = readSource("packages/web/src/services/repairProposalService.js");

describe("Gap 1 verifier gate — helper wiring", () => {
  it("imports validateGap1ValidatorBindings", () => {
    expect(repairService).toMatch(/validateGap1ValidatorBindings/);
  });

  it("wraps failures in a Gap 1 error prefix", () => {
    expect(repairService).toMatch(/Gap 1 validator binding check failed/);
  });

  it("check 3f-3j documented in the verifier", () => {
    expect(repairService).toMatch(/3f-3j/);
  });
});
```

- [ ] **Step 7: Run both gate tests + the full repair-proposal / verification suites**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern="validator-receipt-gate|repair-proposal|verification|pass-capable|execution-receipt"
```
Expected: All PASS.

  **If existing tests fail because they construct pass receipts without the new fields:** those tests need their fixture receipts updated to include `executor_kind: "container-runtime"`, `executor_pass_capable: true`, `validator_image_ref`, `validator_image_digest`, and `validator_result_status: "pass"`. This is expected — the gate got stricter. Update the fixtures and note the count of updated fixtures in the commit message.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/lib/validatorReceiptGate.js packages/web/src/services/repairProposalService.js packages/web/tests/unit/validator-receipt-gate.test.js packages/web/tests/unit/validator-receipt-gate-wiring.test.js
git commit -s -m "feat(governance): pure Gap 1 validator receipt gate (3f-3j) + behavioral tests"
```

---

## Task 9: Delegated-run provider contract module

**Goal of this task:** Land the vendor-neutral delegated-run provider interface from the design doc (Phase 4). No real provider is enabled — this is the contract + a null placeholder. Satisfies acceptance criterion #5.

**Files:**
- Create: `packages/web/src/lib/delegatedRunProvider.js`
- Create: `packages/web/tests/unit/delegated-run-provider.test.js`

- [ ] **Step 1: Write failing tests**

Create `packages/web/tests/unit/delegated-run-provider.test.js`:

```js
// Tests for the delegated-run provider contract (Gap 1 Phase 4).

import { describe, it, expect } from "@jest/globals";
import {
  DELEGATED_RUN_PROVIDER_CONTRACT,
  validateDelegatedRunProvider,
  NullDelegatedRunProvider,
} from "../../src/lib/delegatedRunProvider.js";

describe("DELEGATED_RUN_PROVIDER_CONTRACT", () => {
  it("lists the minimum contract operations from the Gap 1 doc", () => {
    expect(DELEGATED_RUN_PROVIDER_CONTRACT).toContain("id");
    expect(DELEGATED_RUN_PROVIDER_CONTRACT).toContain("submitValidationJob");
    expect(DELEGATED_RUN_PROVIDER_CONTRACT).toContain("retrieveRun");
    expect(DELEGATED_RUN_PROVIDER_CONTRACT).toContain("verifyReceiptHash");
    expect(DELEGATED_RUN_PROVIDER_CONTRACT).toContain("mapResult");
  });
});

describe("validateDelegatedRunProvider", () => {
  it("accepts a provider that implements the full contract", () => {
    const good = {
      id: "test-provider",
      async submitValidationJob() { return { provider_run_id: "run-1" }; },
      async retrieveRun() { return { logs: "", artifacts: [] }; },
      async verifyReceiptHash() { return true; },
      mapResult() { return "pass"; },
    };
    expect(() => validateDelegatedRunProvider(good)).not.toThrow();
  });

  it("rejects a provider missing id", () => {
    const bad = { async submitValidationJob() {}, async retrieveRun() {}, async verifyReceiptHash() {}, mapResult() {} };
    expect(() => validateDelegatedRunProvider(bad)).toThrow(/missing required field: id/);
  });

  it("rejects a provider missing submitValidationJob", () => {
    const bad = { id: "x", async retrieveRun() {}, async verifyReceiptHash() {}, mapResult() {} };
    expect(() => validateDelegatedRunProvider(bad)).toThrow(/submitValidationJob/);
  });

  it("rejects a provider whose mapResult returns an invalid value", () => {
    const bad = {
      id: "x",
      async submitValidationJob() {},
      async retrieveRun() {},
      async verifyReceiptHash() {},
      mapResult() { return "maybe"; },
    };
    expect(() => validateDelegatedRunProvider(bad)).toThrow(/mapResult.*pass|fail|inconclusive/);
  });
});

describe("NullDelegatedRunProvider", () => {
  it("is the placeholder used when no provider is configured", () => {
    expect(NullDelegatedRunProvider.id).toBe("null-delegated-run-provider");
  });

  it("passes contract validation", () => {
    expect(() => validateDelegatedRunProvider(NullDelegatedRunProvider)).not.toThrow();
  });

  it("submitValidationJob returns an unreachable/inconclusive result", async () => {
    const result = await NullDelegatedRunProvider.submitValidationJob({});
    expect(result.overall).toBe("inconclusive");
    expect(result.inconclusive_reason).toBe("no_delegated_run_provider_configured");
  });

  it("mapResult always returns inconclusive", () => {
    expect(NullDelegatedRunProvider.mapResult({})).toBe("inconclusive");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=delegated-run-provider
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `delegatedRunProvider.js`**

Create `packages/web/src/lib/delegatedRunProvider.js`:

```js
// src/lib/delegatedRunProvider.js
// Vendor-neutral delegated-run provider contract (Gap 1 Phase 4).
//
// A delegated-run provider executes validator jobs OUTSIDE the app container,
// avoiding the CT 115 Docker-in-LXC constraint. The provider returns a
// receipt-bound run that GitWire maps to pass/fail/inconclusive.
//
// This module defines the CONTRACT only. No concrete provider is enabled.
// NullDelegatedRunProvider is the placeholder used when no provider is
// configured — it always produces inconclusive results with a typed reason.
//
// Per docs/architecture/validator-execution-model.md (Phase 4), the minimum
// contract is:
//   submit validation job   → receive provider run id
//   retrieve logs/artifacts
//   verify receipt hash
//   map provider result to pass/fail/inconclusive

// Required provider operations + the id field.
export const DELEGATED_RUN_PROVIDER_CONTRACT = Object.freeze([
  "id",
  "submitValidationJob",
  "retrieveRun",
  "verifyReceiptHash",
  "mapResult",
]);

// Valid mapped results (mirrors the executor result vocabulary).
const VALID_MAPPED_RESULTS = new Set(["pass", "fail", "inconclusive"]);

/**
 * Validate that an object satisfies the delegated-run provider contract.
 * Throws on any missing field or invalid mapResult output.
 *
 * @param {object} provider
 * @throws {Error} on contract violation
 */
export function validateDelegatedRunProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("validateDelegatedRunProvider: provider must be an object");
  }

  for (const field of DELEGATED_RUN_PROVIDER_CONTRACT) {
    if (provider[field] === undefined) {
      throw new Error(`validateDelegatedRunProvider: missing required field: ${field}`);
    }
  }

  if (typeof provider.id !== "string" || provider.id.length === 0) {
    throw new Error("validateDelegatedRunProvider: id must be a non-empty string");
  }
  for (const fn of ["submitValidationJob", "retrieveRun", "verifyReceiptHash", "mapResult"]) {
    if (typeof provider[fn] !== "function") {
      throw new Error(`validateDelegatedRunProvider: ${fn} must be a function`);
    }
  }

  // mapResult must return one of the valid mapped values for a representative
  // input — this catches providers that return arbitrary strings.
  const sample = provider.mapResult({});
  if (!VALID_MAPPED_RESULTS.has(sample)) {
    throw new Error(
      `validateDelegatedRunProvider: mapResult must return pass|fail|inconclusive (got '${sample}')`
    );
  }
}

/**
 * The null/placeholder provider. Used when no concrete delegated-run provider
 * is configured. Always produces inconclusive results with a typed reason —
 * never pass, never fail, never an ambiguous error.
 */
export const NullDelegatedRunProvider = Object.freeze({
  id: "null-delegated-run-provider",

  /**
   * @returns {Promise<{ overall: "inconclusive", inconclusive_reason: string }>}
   */
  async submitValidationJob(_job) {
    return {
      overall: "inconclusive",
      inconclusive_reason: "no_delegated_run_provider_configured",
    };
  },

  /**
   * @returns {Promise<{ logs: null, artifacts: [] }>}
   */
  async retrieveRun(_runId) {
    return { logs: null, artifacts: [] };
  },

  /**
   * @returns {Promise<boolean>}
   */
  async verifyReceiptHash(_run) {
    return false;
  },

  /**
   * @returns {"inconclusive"}
   */
  mapResult(_providerResult) {
    return "inconclusive";
  },
});

// Self-validate at module load — catches contract drift immediately.
validateDelegatedRunProvider(NullDelegatedRunProvider);
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage --testPathPattern=delegated-run-provider
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/delegatedRunProvider.js packages/web/tests/unit/delegated-run-provider.test.js
git commit -s -m "feat(executor): delegated-run provider contract + null placeholder (Gap 1.4)"
```

---

## Task 10: Update the design doc with implementation status + full test sweep

**Goal of this task:** Mark the design doc's phases as implemented, then run the entire web test suite to confirm nothing regressed.

**Files:**
- Modify: `docs/architecture/validator-execution-model.md`

- [ ] **Step 1: Update the design doc Status section**

In `docs/architecture/validator-execution-model.md`, replace the `## Status` block (lines 3-7) with:

```markdown
## Status

Implemented for the next release after v0.21.0 (Gap 1 Phases 1-4).

This document records the execution-topology decision for Gap 1: production validator image.

Implementation status (post-plan execution):

- **Phase 1 — Validator pass-capability model:** ✅ `executorReachability.js`
  derives `pass_capable` per backend and `selected_pass_capable`; `getValidatorReadiness()`
  surfaces a typed `validator` block on `/health`.
- **Phase 2 — Validator image identity:** ✅ `validatorImage.js` resolves
  immutable identity from `config.validator` (`GITWIRE_VALIDATOR_IMAGE_REF` /
  `GITWIRE_VALIDATOR_IMAGE_DIGEST`).
- **Phase 3 — Receipt binding:** ✅ `buildExecutionReceipt()` carries
  `executor_kind`, `executor_pass_capable`, `validator_image_ref`,
  `validator_image_digest`, `validator_result`, `validator_result_status`.
  `proof_collected_at` is a non-hash sibling (preserves write-once dedup).
  Verifier checks 3f-3j enforce the new fields on pass receipts.
- **Phase 4 — Delegated-run provider contract:** ✅ `delegatedRunProvider.js`
  defines the vendor-neutral contract + `NullDelegatedRunProvider` placeholder.

Post-apply proof (Gap 3) remains future work and will build on this execution model.
```

- [ ] **Step 2: Run the full web test suite**

Run:
```
cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage
```
Expected: ALL suites PASS. If any fail, do NOT proceed — diagnose with `superpowers:systematic-debugging`. Common expected failures and their fixes:
- **A test with a hardcoded receipt hash:** the hash legitimately changed (new fields in content). Update the expected hash in that test.
- **A test that builds a pass-receipt fixture without the new fields:** add `executor_kind: "container-runtime"`, `executor_pass_capable: true`, `validator_image_ref`, `validator_image_digest`, `validator_result_status: "pass"` to the fixture.
- **Anything else:** unexpected — investigate before changing anything.

- [ ] **Step 3: Run the rules + runtime suites to confirm no cross-package breakage**

Run:
```
cd packages/rules && npm test
cd packages/runtime && npm test
```
Expected: PASS (these packages are untouched by this plan, but confirm).

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/validator-execution-model.md
git commit -s -m "docs(validator): mark Gap 1 Phases 1-4 as implemented"
```

---

## Self-Review (filled in by plan author)

**1. Spec coverage — every Gap 1 acceptance criterion mapped to a task:**

| Acceptance criterion | Task(s) |
|---|---|
| Validator image has immutable identity | Task 4 (`validatorImage.js`), Task 5 (config) |
| Selected executor backend is recorded in receipts | Task 6 (`executor_kind` in receipt), Task 7 (threaded by runner) |
| Local-process validator results are explicitly inconclusive/non-pass-capable | Task 1 (`isBackendPassCapable` returns false for local-process), Task 7 (runner forces `validator_result_status="inconclusive"`), Task 8 (gate check 3f rejects local-process pass) |
| Container-runtime pass-capable only when runtime and image identity proven | Task 7 (runner derives `executor_pass_capable` from PROVEN probe reachability × `supports_pass` × image identity — fix #3), Task 7.5 (`getDefaultBackend()` no longer hands out docker-executor when Docker is unreachable — fix #4), Task 8 (gate checks 3g/3h/3i enforce it at verify time) — layered on pre-existing 3a-3e |
| Delegated-run has a documented provider interface | Task 9 (`delegatedRunProvider.js` + contract) |
| Health/readiness exposes pass-capable validator evidence | Task 2 (`getValidatorReadiness` with `configured` independent of `pass_capable` — fix #2), Task 3 (`/health` validator block) |
| CT 115 no longer has ambiguous "Docker unavailable" failure | Tasks 2 + 3 — `/health` reports `selected_pass_capable: false` + typed `validator.reason`; Task 7.5 makes selection itself honest so the failure mode is gone at the source, not just observable |

**2. Placeholder scan:** No `TBD`, `TODO`, `implement later`, "add error handling", or "similar to Task N" in any step. (The earlier `"<set below>"` placeholder in Task 7 was removed in the review patch — both receipt call sites now show concrete code.) Every code step shows the actual code. Test steps show actual assertions.

**3. Type/name consistency:**
- `executorKindForBackendId(backendId)` — defined Task 1, used Task 7. ✓
- `isBackendPassCapable(kind, reachable)` — defined Task 1, used Task 2 + Task 7. ✓
- `getValidatorReadiness()` — defined Task 2 (now correctly destructures `selected_kind`, fix #1), used Task 3. Returns `configured` independent of `pass_capable` (fix #2). ✓
- `resolveValidatorImage()` returns `{ configured, ref, digest, identity_complete, missing }` — defined Task 4, consumed Task 2 + Task 7. ✓
- `buildExecutionReceipt()` new params: `executor_kind, executor_pass_capable, validator_image_ref, validator_image_digest, validator_result, validator_result_status` — added Task 6, fed Task 7, checked Task 8. ✓
- `validateGap1ValidatorBindings(receipt)` — defined Task 8 (`validatorReceiptGate.js`), called by verifier, behaviorally tested (fix #5). ✓
- `validateDelegatedRunProvider(provider)`, `NullDelegatedRunProvider` — defined Task 9, self-validated at module load. ✓
- `getDefaultBackend()` — rewritten Task 7.5 to be reachability-honest; imports `probeContainerRuntime` + `EXECUTOR_KINDS` from `executorReachability.js`. ✓
- Gate error strings (`missing executor_kind`, `executor_kind is local-process.*cannot authorize pass`, `executor_pass_capable must be true`, `missing validator_image_ref`, `missing validator_image_digest`, `validator_result_status.*must be 'pass'`) — defined in `validatorReceiptGate.js` (Task 8) and match BOTH the behavioral test assertions and the wiring source-reading test. ✓

**4. Review-feedback fixes incorporated (this revision):**
- Fix #1: `getValidatorReadiness()` destructures `selected_kind` (not the non-existent `selected`). [Task 2]
- Fix #2: `configured` and `pass_capable` are independent signals; a configured-but-local-process deployment reports `configured: true, pass_capable: false`. Locked in by a dedicated test. [Task 2]
- Fix #3: `executor_pass_capable` in receipts is derived from a live `probeAllBackends()` reachability result × `supports_pass` × `identity_complete` — NOT from `supports_pass` alone. [Task 7]
- Fix #4: `getDefaultBackend()` now probes container-runtime before selecting docker-executor; falls back to node-executor when Docker is unreachable. [Task 7.5 — new task]
- Fix #5: Gate checks 3f–3j extracted into pure `validateGap1ValidatorBindings()` with behavioral unit tests; source-reading test kept as secondary wiring guardrail. [Task 8]

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-21-gap1-validator-execution-model.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because Tasks 6, 7, 7.5, and 8 carry non-trivial regression risk (receipt hash changes, stricter pass gate, selection-behavior change) and benefit from per-task review checkpoints.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Mandatory review pauses (per review feedback):**
- **Pause after Task 6** — first receipt-hash-changing commit; confirm no unexpected fixture breakage before proceeding.
- **Pause after Task 7** — runner now derives pass-capability from live probes; confirm the unreachable-Docker receipt test passes.
- **Pause after Task 7.5** — `getDefaultBackend()` selection behavior changed; confirm no existing test depended on the old silent-docker-selection behavior.
- **Pause after Task 8** — pass gate is now stricter; confirm every pre-existing pass-receipt fixture has been updated (count them in the commit message).
- **Only then** run the full web suite (Task 10 Step 2).

**Task ordering note:** Task 2's `getValidatorReadiness()` imports `resolveValidatorImage` from Task 4. If executing strictly in order, either (a) implement Task 4 before Task 2, or (b) implement Task 2's summary extension first, defer the `getValidatorReadiness` body + its test until after Task 4, then complete Task 2. The plan's Task 2 Step 3 callout documents this.

**Which approach?**

> **Note on release tagging:** This plan ships code only. Per `AGENTS.md` Pre-Release Checklist, tagging a release also requires bumping versions in every `package.json`, running the full 2,196-test sweep, tagging, pushing, AND following `docs/installation/deployment-runbook.md` to deploy to CT 115 with smoke-test verification at `https://gitwire.erlab.uk/health`. That is a separate, explicitly user-authorized step — do NOT tag a release without explicit confirmation. This should land as a Gap 1 implementation PR first.
