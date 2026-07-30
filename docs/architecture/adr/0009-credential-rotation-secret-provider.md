# ADR 0009: Credential rotation via deployment-neutral secret provider

> **Status: Proposed.** Not authorized for implementation on any current
> wave. Recorded as a future architecture decision for when administrator/
> service-identity work begins. No implementation changes on Wave 2 or any
> active branch.

## Context

GitWire currently loads its LLM API key (`ANTHROPIC_API_KEY`) and other
secrets from environment variables at process startup. Rotation requires
SSH access to the production container, editing `/opt/gitwire/packages/
web/.env`, and running `docker compose restart`. There is no dashboard
surface, no audit trail, and no rollback path.

This is the standard self-hosted pattern, but it creates a governance gap:
the system that records proof for every GitHub mutation has less
observability over its own credential lifecycle than over the repos it
manages.

ADR 0008 establishes that GitWire must not rotate its own credentials
autonomously — production security authority is retained by humans. Any
credential rotation feature must continue to respect that boundary.

## Decision

### Do NOT implement `.env` editing or Docker restart from the application

An endpoint that edits `.env` files or invokes `docker compose restart`
would:
- couple the application to its deployment mechanism;
- require elevated filesystem or Docker-socket access;
- materially enlarge the compromise blast radius.

### Target architecture: deployment-neutral secret-provider interface

```js
const credential = await secretProvider.get("llm.anthropic");

await secretProvider.rotate("llm.anthropic", {
  secret,
  rotatedByPrincipalId,
});
```

Possible providers:
- environment variables (simple installations);
- Docker or Kubernetes secrets;
- an external secret manager (Vault, AWS Secrets Manager, etc.);
- envelope-encrypted database storage (encryption key held outside PostgreSQL).

The dashboard workflow operates against the configured provider rather
than assuming where or how GitWire is deployed.

### Runtime reload: credential-aware client factory

The Anthropic client should be constructed through a provider factory
instead of once at module import:

```js
const client = await anthropicClientProvider.getClient();
```

The provider invalidates and rebuilds the client after rotation. In-flight
requests finish with the old client; new requests use the new credential.
This avoids giving the application permission to restart its own container.

## Required security properties

A production-grade rotation flow must include:

```
instance-level permission
step-up authentication
write-only secret input (never read back)
candidate-key validation (test call before activation)
atomic activation
rollback to the previous version
server-side audit attribution (principal, decision, timestamp)
rate limiting
CSRF protection
secret-safe logging (metadata only, never the key)
```

### Audit record (metadata only)

```
credential identifier
provider
initiating principal
authorization decision
rotation timestamp
validation outcome
old/new version identifiers or fingerprints (NOT the key)
correlation ID
```

Must never contain: the key, recoverable ciphertext, request body, or
provider response containing sensitive material.

## Sensible interim improvement (before full secret administration)

Before building the secret-provider interface:

1. **Documented rotation and rollback runbook** — the SSH procedure with
   verification steps.
2. **Non-secret status surface** — provider, configured/not-configured
   state, last validated time. No key value.
3. **Operator-entered audit event** — a deployment receipt for externally
   performed rotations (records who, when, why — not the key).
4. **Startup validation** — reports an unusable credential without exposing
   it (test call at boot, log pass/fail only).

This provides observability without moving secret custody into GitWire
prematurely.

## Scope

- **Wave 2:** no implementation changes. SSH-managed env remains the only
  supported path.
- **Future:** bounded feature issue + this ADR promoted to Accepted when
  administrator/service-identity work begins.
- **Operating model:** human authority over credentials and production
  changes is preserved. This feature must continue to respect that.

## References

- [ADR 0008: Production/security authority retained by humans](0008-production-security-authority-retained-by-humans.md)
- `docs/installation/environment-variables.md` — current env var documentation
- `packages/web/config/index.js:185-187` — current key loading (startup only)
