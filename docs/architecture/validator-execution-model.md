# Validator Execution Model

## Status

Implemented for the next release after v0.21.0 (Gap 1 Phases 1-4).

This document records the execution-topology decision for Gap 1: production validator image.

Implementation status (post-plan execution):

- **Phase 1 — Validator pass-capability model:** ✅ `executorReachability.js`
  derives `pass_capable` per backend and `selected_pass_capable`; `getValidatorReadiness()`
  surfaces a typed `validator` block on `/health` (`configured` and `pass_capable`
  reported as independent signals).
- **Phase 2 — Validator image identity:** ✅ `validatorImage.js` resolves
  immutable identity from `config.validator` (`GITWIRE_VALIDATOR_IMAGE_REF` /
  `GITWIRE_VALIDATOR_IMAGE_DIGEST`), with cross-check that the ref's embedded
  digest matches the standalone digest.
- **Phase 3 — Receipt binding:** ✅ `buildExecutionReceipt()` carries
  `executor_kind`, `executor_pass_capable`, `validator_image_ref`,
  `validator_image_digest`, `validator_result`, `validator_result_status`.
  `proof_collected_at` is a non-hash sibling (preserves write-once dedup).
  `runSandboxVerification()` derives `executor_pass_capable` from the
  four-condition conjunction (supports_pass AND structural capability AND
  live probe reachability AND validator identity complete), never from
  `supports_pass` alone. Verifier checks 3f-3j (pure helper
  `validateGap1ValidatorBindings`) enforce the new fields on pass receipts;
  non-pass receipts take a separate path and are unaffected.
- **Phase 4 — Delegated-run provider contract:** ✅ `delegatedRunProvider.js`
  defines the vendor-neutral contract + `NullDelegatedRunProvider` placeholder
  (always inconclusive, never pass).

Additional fix beyond the original phases: `getDefaultBackend()` is now
reachability-honest for AUTO-selection (no longer silently returns
docker-executor when container-runtime is unreachable). EXPLICIT configured
selection is still honored as-is; pass-capability is handled downstream.

Post-apply proof (Gap 3) remains future work and will build on this execution model.

## Context

GitWire now exposes executor reachability through `/health`. On CT 115, production currently reports:

```text
container-runtime: unreachable
delegated-run:     unreachable
local-process:     reachable
selected:          local-process
```

This is expected. The app container does not have access to a Docker or Podman socket. Before v0.21.0, that condition would only appear later as an ambiguous executor failure. It is now externally observable.

The next roadmap layer is the production validator image. That layer must not assume that local Docker is available, because production has already proven that assumption false on CT 115.

## Decision

GitWire will use a hybrid validator execution model:

```text
local-process     = diagnostic fallback only, never pass-capable
container-runtime = pass-capable when reachable and explicitly configured
delegated-run     = preferred pass-capable path for environments where container-runtime is unavailable or undesirable
```

For CT 115 specifically:

```text
Do not make local-process pass-capable.
Do not rely on a Docker socket inside the app container.
Use local-process only for inconclusive diagnostics until a pass-capable backend is available.
Prefer delegated-run or a separate sidecar executor over binding host Docker directly into the app container.
```

## Rationale

### 1. Local-process has no isolation boundary

The local-process executor is always reachable because it runs through the Node.js process environment. That makes it valuable as a fallback and diagnostic path, but it does not provide a meaningful isolation boundary.

A validator result produced by local-process must not be treated as production pass evidence.

Allowed outcomes:

```text
local-process result = inconclusive
local-process result = diagnostic-only
local-process result = blocked/non-pass-capable
```

Disallowed outcome:

```text
local-process result = pass-capable validator proof
```

### 2. Container-runtime is valid only when explicitly reachable

A container runtime is pass-capable because it can run a pinned validator image with an inspectable runtime boundary. However, CT 115 currently proves that this backend is not reachable from the app container.

GitWire should support this backend, but it must not assume it.

Required behavior:

```text
If container-runtime is reachable:
  validator image may run there
  receipts must record runtime identity and validator image identity

If container-runtime is unreachable:
  action must be blocked or marked inconclusive
  health and receipts must record the typed reason
```

### 3. Delegated-run avoids the CT 115 Docker-in-LXC constraint

A delegated-run provider avoids binding the host Docker socket into the app container. It also avoids making the app container responsible for provisioning isolated execution directly.

This is the preferred long-term path for CT 115 unless a secure sidecar executor is introduced.

Delegated-run is currently a placeholder. Gap 1 should define its contract before depending on a concrete provider.

## Backend semantics

### local-process

Purpose:

```text
diagnostics
fallback
developer-mode execution
non-pass-capable checks
```

Properties:

```text
reachable: usually true
isolation: none
pass_capable: false
receipt_outcome: inconclusive or blocked
```

### container-runtime

Purpose:

```text
pass-capable validator execution when Docker/Podman is reachable
```

Properties:

```text
reachable: environment-dependent
isolation: container runtime
pass_capable: true when validator image identity is pinned and inspected
receipt_outcome: pass/fail/inconclusive
```

Required evidence:

```text
executor_kind
executor_backend_id
runtime
runtime_version
validator_image_ref
validator_image_digest
inspection_hash
execution_receipt_id
```

### delegated-run

Purpose:

```text
pass-capable validator execution without local container runtime access
```

Properties:

```text
reachable: provider-dependent
isolation: provider boundary
pass_capable: true only after provider identity and execution receipt semantics are implemented
receipt_outcome: pass/fail/inconclusive
```

Required evidence:

```text
executor_kind
executor_backend_id
provider
provider_run_id
validator_image_ref or validator_bundle_ref
validator_identity
execution_receipt_id
provider_receipt_hash
```

## Validator image contract

The production validator image must have immutable identity.

Required fields:

```text
validator_image_ref
validator_image_digest
inspected_image_digest
inspection_hash
validator_version
```

The validator image may only produce pass evidence when:

```text
1. The selected backend is pass-capable.
2. The validator image identity is pinned.
3. The runtime or provider identity is recorded.
4. The execution receipt binds the validator result to the selected backend.
5. The repository target state still matches the expected pre-execution snapshot.
```

If any of these are missing, the result is inconclusive or blocked, not passing.

## Receipt requirements

Every validator execution receipt must include:

```text
executor_kind
executor_backend_id
executor_reachable
executor_selected_reason
executor_pass_capable
validator_image_ref
validator_image_digest
validator_result
validator_result_status
proof_collected_at
```

For local-process:

```text
executor_pass_capable = false
validator_result_status = inconclusive
```

For container-runtime:

```text
executor_pass_capable = true only if runtime and image identity are proven
```

For delegated-run:

```text
executor_pass_capable = true only if provider receipt and validator identity are proven
```

## Health and readiness requirements

The `/health` executor summary is sufficient for topology visibility, but validator readiness needs a pass-capability view.

Future health/readiness should expose:

```json
{
  "executor": {
    "selected_kind": "local-process",
    "selected_reason": "selected:local-process",
    "selected_pass_capable": false
  },
  "validator": {
    "configured": true,
    "pass_capable": false,
    "reason": "selected_backend_not_pass_capable"
  }
}
```

This makes it clear when GitWire is healthy but cannot produce production-grade validator proof.

## Implementation sequence

### Phase 1 — Validator pass-capability model

Add backend metadata:

```text
kind
id
reachable
pass_capable
runtime
selection_reason
```

Expose pass-capability in health/readiness.

### Phase 2 — Production validator image identity

Add validator image configuration:

```text
GITWIRE_VALIDATOR_IMAGE_REF
GITWIRE_VALIDATOR_IMAGE_DIGEST
```

Add image inspection evidence where container-runtime is reachable.

### Phase 3 — Receipt binding

Bind validator evidence to:

```text
executor selection
runtime/provider identity
validator image identity
target repository snapshot
```

### Phase 4 — Delegated-run provider contract

Define the provider interface without committing to a vendor-specific implementation.

Minimum contract:

```text
submit validation job
receive provider run id
retrieve logs/artifacts
verify receipt hash
map provider result to pass/fail/inconclusive
```

## Non-goals

This decision does not require:

```text
making local-process pass-capable
binding the host Docker socket into the app container
shipping a delegated-run provider immediately
performing post-apply proof
changing repair proposal lifecycle semantics
```

Post-apply proof remains Gap 3 and should build on this execution model.

## Acceptance criteria for Gap 1

Gap 1 is complete when:

```text
- The validator image has immutable identity.
- The selected executor backend is recorded in receipts.
- Local-process validator results are explicitly inconclusive/non-pass-capable.
- Container-runtime validator results are pass-capable only when runtime and image identity are proven.
- Delegated-run has a documented provider interface, even if no provider is enabled yet.
- Health/readiness exposes whether the current deployment can produce pass-capable validator evidence.
- CT 115 no longer has an ambiguous "Docker unavailable" failure mode.
```

## Final decision

GitWire will not treat local-process execution as production validator proof.

For CT 115, pass-capable validation requires either:

```text
1. a secure container-runtime executor outside the app container, or
2. a delegated-run provider with receipt-bound execution evidence.
```

Until then, local-process remains a safe fallback for diagnostics and an explicit non-pass-capable state.
