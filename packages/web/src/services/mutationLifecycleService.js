// src/services/mutationLifecycleService.js
//
// W3-02 — CAS/versioned mutation lifecycle service (claim-then-advance).
//
// One internal function advances a mutation command's lifecycle:
//   1. claim   — INSERT the journal edge (from_version = expected). The
//                journal's UNIQUE (command_id, from_version) is the CAS
//                arbiter: only one transaction can claim a version.
//   2. advance — UPDATE with the mandatory version predicate; the database
//                transition guard verifies intent immutability, the +1
//                version step, edge legality, and a matching claim whose
//                performer and timestamp agree with the command row.
//   3. couple  — a deferred constraint trigger re-verifies at COMMIT that
//                every new claim corresponds to the resulting command state.
//
// Failure classification (frozen): command_not_found | stale_version (with
// {current_status, current_version}) | illegal_transition.
//
// This service never calls GitHub or any provider, never dispatches the
// outbox, never executes a worker, and is consumed by no route or worker
// (W3-03 owns the executor). Performer identity is server-derived — an
// authenticated principal id or an explicitly defined system identity — and
// never an arbitrary external identifier.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export class MutationTransitionError extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.name = "MutationTransitionError";
    this.reason = reason;
    this.detail = detail;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_IDENTITY_PATTERN = /^system:[a-z0-9][a-z0-9._-]*$/;

// Performer provenance: an authenticated principal (server-derived
// { principalId }) or an explicitly defined system identity string. Anything
// else — arbitrary external identifiers included — is rejected.
function resolvePerformer(performer) {
  if (performer && typeof performer === "object" && !Array.isArray(performer)) {
    const { principalId } = performer;
    if (typeof principalId === "string" && UUID_PATTERN.test(principalId)) {
      return principalId;
    }
    throw new MutationTransitionError("performer_invalid");
  }
  if (typeof performer === "string" && SYSTEM_IDENTITY_PATTERN.test(performer)) {
    return performer;
  }
  throw new MutationTransitionError("performer_invalid");
}

function validateInputs({ commandId, expectedVersion, nextStatus, reason }) {
  if (!commandId || typeof commandId !== "string" || !UUID_PATTERN.test(commandId)) {
    throw new MutationTransitionError("command_id_invalid");
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new MutationTransitionError("expected_version_invalid");
  }
  if (!nextStatus || typeof nextStatus !== "string") {
    throw new MutationTransitionError("next_status_invalid");
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new MutationTransitionError("reason_invalid");
  }
}

async function fetchCommand(queryable, commandId) {
  const { rows: [row] } = await queryable.query(
    `SELECT id, status, version FROM public.mutation_commands
      WHERE id = $1
      LIMIT 1`,
    [commandId],
  );
  if (!row) return null;
  // node-postgres returns BIGINT as string; normalize so the frozen
  // classification compares numbers.
  return { ...row, version: Number(row.version) };
}

// The frozen zero-row/conflict classification: after any claim or advance
// failure, fetch the current command and classify.
async function classifyConflict(commandId, expectedVersion, requestedStatus) {
  const current = await fetchCommand(db, commandId);
  if (!current) {
    throw new MutationTransitionError("command_not_found");
  }
  if (current.version !== expectedVersion) {
    throw new MutationTransitionError("stale_version", {
      current_status: current.status,
      current_version: current.version,
    });
  }
  // Version matches but the operation did not go through: the edge must be
  // illegal (the claim guard rejects non-legal edges at this exact state).
  void requestedStatus;
  throw new MutationTransitionError("illegal_transition");
}

/**
 * Advance a mutation command's lifecycle via claim-then-advance.
 *
 * @param {object} params
 * @param {string} params.commandId
 * @param {number} params.expectedVersion - the version the caller believes the command is at
 * @param {string} params.nextStatus
 * @param {{principalId: string}|string} params.performer - server-derived principal or system identity
 * @param {string|null} [params.reason]
 * @returns {Promise<{commandId: string, status: string, version: number, transitionedAt: string}>}
 * @throws {MutationTransitionError} command_not_found | stale_version |
 *   illegal_transition | performer_invalid | input validation reasons.
 */
export async function transitionMutationCommand({
  commandId,
  expectedVersion,
  nextStatus,
  performer,
  reason = null,
} = {}) {
  validateInputs({ commandId, expectedVersion, nextStatus, reason });
  const performerValue = resolvePerformer(performer);

  // Preflight: classify a missing command before opening a transaction.
  const preflight = await fetchCommand(db, commandId);
  if (!preflight) {
    throw new MutationTransitionError("command_not_found");
  }

  try {
    return await db.transaction(async (tx) => {
      const current = await fetchCommand(tx, commandId);
      if (!current) {
        throw new MutationTransitionError("command_not_found");
      }

      // 1. Claim. The uniqueness constraints arbitrate; the claim guard
      //    validates against the command's current state.
      const { rows: [claim] } = await tx.query(
        `INSERT INTO public.mutation_command_transitions (
           command_id, from_status, to_status,
           from_version, to_version, transitioned_by, reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING transitioned_at`,
        [
          commandId,
          current.status,
          nextStatus,
          expectedVersion,
          expectedVersion + 1,
          performerValue,
          reason ?? null,
        ],
      );

      // 2. Advance. The version predicate is mandatory; the guard trigger
      //    independently re-verifies the entire claim coupling.
      const { rowCount } = await tx.query(
        `UPDATE public.mutation_commands
            SET status = $1,
                version = version + 1,
                last_transition_at = $2,
                last_transitioned_by = $3
          WHERE id = $4
            AND version = $5`,
        [nextStatus, claim.transitioned_at, performerValue, commandId, expectedVersion],
      );
      if (rowCount !== 1) {
        // Cannot commit a claim whose advance did not land; fail the whole
        // transaction (the deferred check would reject it at COMMIT anyway).
        throw new MutationTransitionError("transition_advance_failed");
      }

      logger.info(
        { commandId, from: current.status, to: nextStatus, version: expectedVersion + 1 },
        "Mutation command transition committed",
      );

      return {
        commandId,
        status: nextStatus,
        version: expectedVersion + 1,
        transitionedAt: claim.transitioned_at,
      };
    });
  } catch (err) {
    if (err instanceof MutationTransitionError) {
      if (err.reason === "transition_advance_failed") {
        // The command moved between claim and advance: classify. (Always
        // throws; the fallback rethrow is unreachable in practice.)
        await classifyConflict(commandId, expectedVersion, nextStatus);
      }
      throw err;
    }
    // Claim-guard rejections and unique violations (23505) both mean the
    // claimed state did not hold: classify via the frozen algorithm.
    const pgCode = err?.code;
    const guardRejected = typeof err?.message === "string" && (
      err.message.includes("transition claim")
      || err.message.includes("not legal")
    );
    if (pgCode === "23505" || guardRejected) {
      return classifyConflict(commandId, expectedVersion, nextStatus);
    }
    throw err;
  }
}
