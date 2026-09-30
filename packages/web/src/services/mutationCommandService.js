// src/services/mutationCommandService.js
//
// W3-01 — canonical mutation-command construction service.
//
// Establishes durable mutation INTENT and nothing else: in ONE PostgreSQL
// transaction it persists
//   1. command-bound authorization evidence (auth_decision_log row via the
//      transactional seam; its stable id is retained by the command),
//   2. an immutable mutation command,
//   3. exactly one initial `mutation.command.created` outbox event.
// All three commit together or none commits.
//
// Idempotency is database-enforced: uniqueness on
// (namespace, resource_identity, idempotency_key, operation). Identical
// replay resolves the committed command and creates nothing; conflicting
// replay fails closed and returns existing command id + request hash
// diagnostics (never the prior payload).
//
// This service never calls GitHub or any external provider, never dispatches
// the outbox, never executes a mutation worker, and cuts over no existing
// writer. Executor/dispatcher/receipt machinery belongs to W3-03+.

import { stableStringify, hashCanonical } from "@gitwire/rules";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { authorizeControlled } from "./auth/authorize.js";

const INITIAL_EVENT_TYPE = "mutation.command.created";

export class MutationCommandError extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.name = "MutationCommandError";
    this.reason = reason;
    this.detail = detail;
  }
}

// The ONLY accepted policy/configuration identity shape: the canonical W2-04
// resolution identity (version_vector + effective_hash) as produced by the
// canonical resolver. There is no alternative client-supplied identity field,
// and nothing here re-resolves configuration.
function validatePolicyContext(policyContext) {
  if (policyContext === null || policyContext === undefined) return null;
  const { version_vector: vector, effective_hash: hash } = policyContext || {};
  if (!vector || typeof vector !== "object") {
    throw new MutationCommandError("policy_context_invalid", "version_vector required");
  }
  const expectedKeys = ["defaults", "org", "repo", "governed"];
  for (const key of expectedKeys) {
    if (!(key in vector)) {
      throw new MutationCommandError("policy_context_invalid", `version_vector.${key} missing`);
    }
  }
  if (typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new MutationCommandError("policy_context_invalid", "effective_hash must be sha256:<hex64>");
  }
  // Store exactly the resolver-produced values — never a superset or remix.
  return { version_vector: vector, effective_hash: hash };
}

function validateInputs({ authority, resource, operation, target, request, idempotency }) {
  if (!authority?.principal?.principalId) {
    throw new MutationCommandError("principal_required");
  }
  if (!authority?.permission || typeof authority.permission !== "string") {
    throw new MutationCommandError("permission_required");
  }
  if (!resource?.type || typeof resource.type !== "string") {
    throw new MutationCommandError("resource_type_required");
  }
  if (resource.type === "repository"
      && (resource.repositoryId === undefined
          || resource.installationId === undefined)) {
    // The authority contract requires the server-owned installationId +
    // repositoryId pair for repository-scoped resources.
    throw new MutationCommandError("resource_identity_required");
  }
  if (resource.type !== "repository" && resource.identity === undefined) {
    throw new MutationCommandError("resource_identity_required");
  }
  if (!operation || typeof operation !== "string") {
    throw new MutationCommandError("operation_required");
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new MutationCommandError("target_required");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new MutationCommandError("request_required");
  }
  if (!idempotency?.namespace || typeof idempotency.namespace !== "string") {
    throw new MutationCommandError("namespace_required");
  }
  if (!idempotency?.key || typeof idempotency.key !== "string") {
    throw new MutationCommandError("idempotency_key_required");
  }
}

// Canonical authoritative resource identity: server-derived from the
// authoritative numeric identity (never a caller-supplied display name).
// Callers may not override this string once the authoritative id is present.
function canonicalResourceIdentity(resource) {
  if (resource.repositoryId !== undefined && resource.repositoryId !== null) {
    return `repository:${resource.repositoryId}`;
  }
  if (resource.identity !== undefined && resource.identity !== null) {
    return `${resource.type}:${resource.identity}`;
  }
  throw new MutationCommandError("resource_identity_required");
}

function isUniqueViolation(err) {
  return err?.code === "23505" || err?.constraint === "uq_mutation_commands_idempotency";
}

/**
 * Create (or idempotently resolve) a canonical mutation command.
 *
 * @param {object} params
 * @param {{principal: {principalId, authenticationMethod?}, permission: string}} params.authority
 * @param {{type: string, repositoryId?: number|string, identity?: string}} params.resource
 * @param {string} params.operation
 * @param {object} params.target
 * @param {object} params.request
 * @param {{namespace: string, key: string}} params.idempotency
 * @param {{version_vector: object, effective_hash: string}|null} [params.policyContext]
 * @param {string|null} [params.approval]
 * @param {string|null} [params.correlation]
 * @returns {Promise<{created: boolean, replay: boolean, command: object, initialEvent: object|null}>}
 * @throws {MutationCommandError} reason `idempotency_conflict` with
 *   {existing_command_id, existing_request_hash} on conflicting replay.
 */
export async function createMutationCommand(params) {
  validateInputs(params);

  const { authority, resource, operation, target, request, idempotency } = params;
  const policyContext = validatePolicyContext(params.policyContext ?? null);
  const resourceIdentity = canonicalResourceIdentity(resource);

  // Canonical request + deterministic hash (single repository-wide
  // canonicalization: @gitwire/rules stableStringify/hashCanonical). The
  // hash covers the full requested-mutation tuple — operation, authoritative
  // resource, target, and request body — so materially different intents
  // under one idempotency key can never be conflated as a replay.
  const canonicalRequest = JSON.parse(stableStringify(request));
  const requestHash = hashCanonical({
    operation,
    resource_type: resource.type,
    resource_identity: resourceIdentity,
    target,
    request,
  });

  // Replay ordering: resolve a committed command BEFORE authorizing, so an
  // ordinary retry never mints redundant command-bound evidence.
  const committed = await findByIdentity(idempotency.namespace, resourceIdentity, idempotency.key, operation);
  if (committed) {
    // Replay resolution is principal-bound: a different principal reusing
    // another principal's idempotency identity gets a closed failure with NO
    // disclosure of the committed command (no id, no hash, no payload).
    if (String(committed.principal_id) !== String(authority.principal.principalId)) {
      throw new MutationCommandError("idempotency_principal_mismatch");
    }
    if (committed.request_hash === requestHash) {
      return { created: false, replay: true, command: committed, initialEvent: null };
    }
    throw new MutationCommandError("idempotency_conflict", {
      existing_command_id: committed.id,
      existing_request_hash: committed.request_hash,
    });
  }

  try {
    return await db.transaction(async (tx) => {
      // Authorization read shares the command transaction's client for read
      // consistency; authority-row locking is NOT required here. The
      // evidenceClient routes authorize's own decision persistence INTO this
      // transaction: exactly one evidence row, committed with the command,
      // stable id returned (throws on failure — nothing downstream survives).
      const outcome = await authorizeControlled({
        principal: authority.principal,
        permission: authority.permission,
        resource,
        mode: "enforced",
        queryable: tx,
        evidenceClient: tx,
      });
      const decision = outcome.decision;
      if (!decision.allowed) {
        throw new MutationCommandError("authorization_denied", {
          code: decision.code,
        });
      }
      const evidenceId = outcome.evidenceId;
      if (!evidenceId) {
        throw new MutationCommandError("authorization_evidence_missing");
      }

      const { rows: [command] } = await tx.query(
        `INSERT INTO public.mutation_commands (
           namespace, idempotency_key, operation,
           resource_type, resource_identity, target,
           request, request_hash, principal_id,
           authorization_evidence_id, policy_context,
           approval_ref, correlation_id
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13)
         RETURNING *`,
        [
          idempotency.namespace,
          idempotency.key,
          operation,
          resource.type,
          resourceIdentity,
          JSON.stringify(target),
          JSON.stringify(canonicalRequest),
          requestHash,
          authority.principal.principalId,
          evidenceId,
          policyContext ? JSON.stringify(policyContext) : null,
          params.approval ?? null,
          params.correlation ?? null,
        ],
      );

      const { rows: [event] } = await tx.query(
        `INSERT INTO public.mutation_outbox (
           command_id, event_type, request_hash
         ) VALUES ($1,$2,$3)
         RETURNING seq, event_id, created_at`,
        [command.id, INITIAL_EVENT_TYPE, requestHash],
      );

      logger.info(
        { command_id: command.id, namespace: idempotency.namespace, operation },
        "Canonical mutation command created",
      );

      return {
        created: true,
        replay: false,
        command,
        initialEvent: { seq: event.seq, event_id: event.event_id, created_at: event.created_at },
      };
    });
  } catch (err) {
    // A concurrent creator may have committed the same identity between our
    // pre-check and insert. Resolve deterministically from the database.
    if (isUniqueViolation(err)) {
      const winner = await findByIdentity(idempotency.namespace, resourceIdentity, idempotency.key, operation);
      if (winner && String(winner.principal_id) !== String(authority.principal.principalId)) {
        throw new MutationCommandError("idempotency_principal_mismatch");
      }
      if (winner && winner.request_hash === requestHash) {
        return { created: false, replay: true, command: winner, initialEvent: null };
      }
      if (winner) {
        throw new MutationCommandError("idempotency_conflict", {
          existing_command_id: winner.id,
          existing_request_hash: winner.request_hash,
        });
      }
    }
    throw err;
  }
}

async function findByIdentity(namespace, resourceIdentity, key, operation) {
  const { rows: [row] } = await db.query(
    `SELECT * FROM public.mutation_commands
      WHERE namespace = $1
        AND resource_identity = $2
        AND idempotency_key = $3
        AND operation = $4
      LIMIT 1`,
    [namespace, resourceIdentity, key, operation],
  );
  return row ?? null;
}
