// src/services/repairAuthorityService.js
// Actor-kind based field-level authority for repair proposals.
//
// Defines which actor kinds are allowed to write which evidence fields
// and perform which transitions. The CI evidence collector is the only
// actor that can attach CI-source evidence.
//
// Authority matrix:
// ┌──────────────────────┬─────────┬──────────┬────────────┬──────┬─────────┬───────┐
// │ Actor                │ Create  │ CI Ev.   │ → ev_coll  │ Diag │ Patch   │ Critic│
// ├──────────────────────┼─────────┼──────────┼────────────┼──────┼─────────┼───────┤
// │ ci_evidence_collector│   Yes   │   Yes    │    Yes     │  No  │   No    │  No   │
// │ api_user             │   No    │   No     │    No      │  No* │   No*   │  No*  │
// │ diagnosis_worker     │   No    │   No     │    No      │ Yes  │   No    │  No   │
// │ patch_worker         │   No    │   No     │    No      │  No  │  Yes    │  No   │
// │ verification_worker  │   No    │   No     │    No      │  No  │   No    │  No** │
// │ critic_worker        │   No    │   No     │    No      │  No  │   No    │ Yes   │
// │ operator             │   No    │   No     │    No      │  No  │   No    │  No   │
// └──────────────────────┴─────────┴──────────┴────────────┴──────┴─────────┴───────┘
//
// * api_user may attach these in later items when the worker services exist.
//   For now, the public API evidence endpoint is restricted.
// ** verification_worker writes validation_result, not critic_review.

// ── Actor kinds ──────────────────────────────────────────────────────────────
export const ACTOR_KINDS = Object.freeze({
  CI_EVIDENCE_COLLECTOR: "ci_evidence_collector",
  API_USER:              "api_user",
  DIAGNOSIS_WORKER:      "diagnosis_worker",
  PATCH_WORKER:          "patch_worker",
  VERIFICATION_WORKER:   "verification_worker",
  CRITIC_WORKER:         "critic_worker",
  OPERATOR:              "operator",
});

// ── Evidence field permissions per actor kind ───────────────────────────────
export const FIELD_PERMISSIONS = Object.freeze({
  [ACTOR_KINDS.CI_EVIDENCE_COLLECTOR]: new Set(["evidence_refs"]),
  [ACTOR_KINDS.API_USER]:              new Set(), // restricted for now
  [ACTOR_KINDS.DIAGNOSIS_WORKER]:      new Set(["diagnosis"]),
  [ACTOR_KINDS.PATCH_WORKER]:          new Set(["patch_proposal"]),
  [ACTOR_KINDS.VERIFICATION_WORKER]:   new Set(["validation_result"]),
  [ACTOR_KINDS.CRITIC_WORKER]:         new Set(["critic_review"]),
  [ACTOR_KINDS.OPERATOR]:              new Set(),
});

// ── Transition permissions per actor kind ───────────────────────────────────
export const TRANSITION_PERMISSIONS = Object.freeze({
  [ACTOR_KINDS.CI_EVIDENCE_COLLECTOR]: new Set(["evidence_collected", "failed"]),
  [ACTOR_KINDS.API_USER]:              new Set(),
  [ACTOR_KINDS.DIAGNOSIS_WORKER]:      new Set(),
  [ACTOR_KINDS.PATCH_WORKER]:          new Set(["proposed", "failed"]),
  [ACTOR_KINDS.VERIFICATION_WORKER]:   new Set(["verified", "failed"]),
  [ACTOR_KINDS.CRITIC_WORKER]:         new Set(["review_ready", "failed"]),
  [ACTOR_KINDS.OPERATOR]:              new Set(),
});

// ── Proposal creation permissions ───────────────────────────────────────────
export const CREATE_PROPOSAL_PERMISSIONS = Object.freeze({
  [ACTOR_KINDS.CI_EVIDENCE_COLLECTOR]: true,
  [ACTOR_KINDS.API_USER]:              false,
  [ACTOR_KINDS.DIAGNOSIS_WORKER]:      false,
  [ACTOR_KINDS.PATCH_WORKER]:          false,
  [ACTOR_KINDS.VERIFICATION_WORKER]:   false,
  [ACTOR_KINDS.CRITIC_WORKER]:         false,
  [ACTOR_KINDS.OPERATOR]:              false,
});

// ════════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if an actor kind can create proposals.
 */
export function canCreateProposal(actorKind) {
  return CREATE_PROPOSAL_PERMISSIONS[actorKind] === true;
}

/**
 * Check if an actor kind is allowed to write a specific evidence field.
 */
export function canAttachField(actorKind, fieldName) {
  const allowed = FIELD_PERMISSIONS[actorKind];
  return allowed ? allowed.has(fieldName) : false;
}

/**
 * Check if an actor kind is allowed to transition to a specific status.
 */
export function canTransitionTo(actorKind, targetStatus) {
  const allowed = TRANSITION_PERMISSIONS[actorKind];
  return allowed ? allowed.has(targetStatus) : false;
}

/**
 * Filter evidence fields to only those the actor kind is allowed to write.
 * Returns { allowed: {...}, denied: string[] }.
 */
export function filterAllowedFields(actorKind, evidence) {
  const allowed = {};
  const denied = [];

  for (const [field, value] of Object.entries(evidence)) {
    if (value === undefined) continue;
    if (canAttachField(actorKind, field)) {
      allowed[field] = value;
    } else {
      denied.push(field);
    }
  }

  return { allowed, denied };
}
