// src/services/verificationWorkerService.js
// Trusted verification worker service for CI repair proposals.
//
// Resolves the verified patch artifact, constructs a pinned ephemeral
// workspace, applies the patch in an isolated sandbox, runs bounded
// required validations, and records the immutable result through the
// canonical recordVerificationResult() path with actor_kind: verification_worker.
//
// Strict boundaries:
// - Input: existing proposal + durable patch artifact + task envelope only
// - Output: only the validation_result field (via recordVerificationResult)
// - No GitHub API calls, no repository credentials, no network access
// - No branch creation, PR creation, or repository writes
// - Sandbox uses pinned container image with resource limits
// - Commands selected only from task_envelope.required_validation allowlist
// - No shell interpolation from untrusted content

import { logger } from "../lib/logger.js";
import {
  getProposal,
  recordVerificationResult,
  parseJsonb,
} from "./repairProposalService.js";
import { ACTOR_KINDS } from "./repairAuthorityService.js";
import { verifyArtifact } from "../lib/patchArtifactStore.js";
import {
  buildValidationPlan,
  runSandboxVerification,
  computeVerificationFingerprint,
  SANDBOX_IMAGE_DIGEST,
} from "../lib/sandboxRunner.js";

const ACTOR = ACTOR_KINDS.VERIFICATION_WORKER;

// ════════════════════════════════════════════════════════════════════════════
// TRUSTED VERIFICATION PIPELINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Verify a proposal's patch in a sandbox and record the result.
 *
 * Guarantees:
 * - Proposal must be in proposed status with an existing patch_proposal
 * - Durable patch artifact must resolve and re-hash correctly
 * - Artifact base_sha must match proposal head_sha
 * - Validation plan derived only from task_envelope.required_validation
 * - Sandbox runs with resource limits and no network
 * - Result recorded through canonical recordVerificationResult()
 *
 * @param {number} proposalId - repair proposal ID
 * @param {object} [options]
 * @param {string} [options.correlation_id] - correlation ID for audit trail
 * @param {string} [options.source_delivery_id] - source provenance
 * @returns {Promise<object>} updated proposal with validation_result
 */
export async function verifyProposal(proposalId, options = {}) {
  const { correlation_id, source_delivery_id } = options;

  if (!proposalId) throw new Error("proposalId is required");

  // ── 1. Fetch proposal ────────────────────────────────────────────────────
  const proposal = await getProposal(proposalId);
  if (!proposal) {
    throw new Error(`Repair proposal not found: ${proposalId}`);
  }

  // ── 2. Status gate: only proposed ────────────────────────────────────────
  if (proposal.status !== "proposed") {
    throw new Error(
      `Verification requires status 'proposed' (current: '${proposal.status}')`
    );
  }

  // ── 3. Patch proposal prerequisite ───────────────────────────────────────
  const patchProposal = parseJsonb(proposal.patch_proposal);
  if (!patchProposal) {
    throw new Error("Cannot verify: patch_proposal must exist");
  }

  // ── 4. Resolve and verify the durable artifact ───────────────────────────
  let artifactContent;
  try {
    artifactContent = await verifyArtifact(
      patchProposal.artifact_ref,
      patchProposal.artifact_hash
    );
  } catch (artifactErr) {
    throw new Error(`Cannot verify: patch artifact resolution failed: ${artifactErr.message}`);
  }

  // ── 5. Verify artifact base_sha ──────────────────────────────────────────
  const parsedArtifact = JSON.parse(artifactContent);
  if (parsedArtifact.base_sha !== proposal.head_sha) {
    throw new Error(
      `Cannot verify: artifact base_sha does not match proposal head_sha`
    );
  }

  // ── 6. Get task envelope for validation plan ─────────────────────────────
  const envelope = parseJsonb(proposal.task_envelope);
  if (!envelope || !Array.isArray(envelope.required_validation)) {
    throw new Error(
      "Cannot verify: task_envelope.required_validation must exist"
    );
  }

  // ── 7. Build validation plan from envelope ───────────────────────────────
  const { validation_plan_hash } = buildValidationPlan(envelope);

  // ── 8. Run sandbox verification ──────────────────────────────────────────
  const sandboxResult = await runSandboxVerification({
    artifactContent,
    base_sha: proposal.head_sha,
    taskEnvelope: envelope,
  });

  // ── 9. Compute verification fingerprint ──────────────────────────────────
  const verification_fingerprint = computeVerificationFingerprint({
    patch_artifact_hash: patchProposal.artifact_hash,
    base_sha: proposal.head_sha,
    input_bundle_hash: patchProposal.input_bundle_hash,
    sandbox_image_digest: sandboxResult.sandbox_image_digest,
    validation_plan_hash: sandboxResult.validation_plan_hash,
  });

  // ── 10. Build verification input for canonical recording ─────────────────
  const verificationInput = {
    overall: sandboxResult.overall,
    verification_fingerprint,
    patch_artifact_hash: patchProposal.artifact_hash,
    base_sha: proposal.head_sha,
    input_bundle_hash: patchProposal.input_bundle_hash,
    sandbox_image_digest: sandboxResult.sandbox_image_digest,
    validation_plan_hash: sandboxResult.validation_plan_hash,
    commands: sandboxResult.commands,
    exit_status: sandboxResult.exit_status,
    output_refs: sandboxResult.commands.filter((c) => c.output_ref).map((c) => c.output_ref),
    output_hashes: sandboxResult.commands.filter((c) => c.output_hash).map((c) => c.output_hash),
    redacted_summary: sandboxResult.redacted_summary,
    limits_applied: sandboxResult.limits_applied,
    ...(sandboxResult.inconclusive_reason ? { inconclusive_reason: sandboxResult.inconclusive_reason } : {}),
  };

  // ── 11. Record through canonical path ────────────────────────────────────
  const result = await recordVerificationResult(
    proposalId,
    verificationInput,
    {
      actor: ACTOR,
      actor_kind: ACTOR,
      expected_version: proposal.version,
      correlation_id,
      source_delivery_id,
    }
  );

  logger.info(
    { proposal_id: proposalId, correlation_id, status: result.status },
    "Verification completed for repair proposal"
  );

  return result;
}
