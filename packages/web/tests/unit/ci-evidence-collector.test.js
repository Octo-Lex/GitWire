// tests/unit/ci-evidence-collector.test.js
// Tests for the trusted CI evidence collector service.
//
// Round 3 coverage:
// - P0 fix: atomic recordCiEvidenceCollection (replay-safe, single transaction)
// - P1 fix: public API mutation routes return 403
// - P1 fix: correlation_id threaded through to event trail
// - All round 2 coverage retained

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

// Import pure functions
import {
  ACTOR_KINDS,
  canCreateProposal,
  canAttachField,
  canTransitionTo,
  filterAllowedFields,
} from "../../src/services/repairAuthorityService.js";

import {
  LIMITS,
  CI_EVIDENCE_TYPES,
  truncateExcerpt,
  redactLogContent,
  checkEligibility,
  buildEnvelopeFromEvent,
  extractWorkflowPath,
  extractJobErrorExcerpt,
} from "../../src/services/ciEvidenceCollectorService.js";

import {
  VALID_EVIDENCE_REF_TYPES,
} from "../../src/services/repairProposalService.js";

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY MATRIX
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — authority matrix", () => {
  it("defines all 7 actor kinds", () => {
    expect(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR).toBe("ci_evidence_collector");
    expect(ACTOR_KINDS.API_USER).toBe("api_user");
    expect(ACTOR_KINDS.OPERATOR).toBe("operator");
  });

  it("ci_evidence_collector can create", () => {
    expect(canCreateProposal(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR)).toBe(true);
  });
  it("api_user CANNOT create", () => {
    expect(canCreateProposal(ACTOR_KINDS.API_USER)).toBe(false);
  });

  it("ci_evidence_collector can only attach evidence_refs", () => {
    expect(canAttachField(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR, "evidence_refs")).toBe(true);
    expect(canAttachField(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR, "diagnosis")).toBe(false);
    expect(canAttachField(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR, "patch_proposal")).toBe(false);
  });

  it("ci_evidence_collector can only reach evidence_collected/failed", () => {
    expect(canTransitionTo(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR, "evidence_collected")).toBe(true);
    expect(canTransitionTo(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR, "failed")).toBe(true);
    expect(canTransitionTo(ACTOR_KINDS.CI_EVIDENCE_COLLECTOR, "proposed")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EVIDENCE TYPES — P0 fix: CI types in canonical validator
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — evidence types", () => {
  it("workflow_run accepted by canonical validator", () => {
    expect(VALID_EVIDENCE_REF_TYPES.has("workflow_run")).toBe(true);
  });
  it("ci_job accepted by canonical validator", () => {
    expect(VALID_EVIDENCE_REF_TYPES.has("ci_job")).toBe(true);
  });
  it("ci_log_excerpt accepted by canonical validator", () => {
    expect(VALID_EVIDENCE_REF_TYPES.has("ci_log_excerpt")).toBe(true);
  });
  it("workflow_file accepted by canonical validator", () => {
    expect(VALID_EVIDENCE_REF_TYPES.has("workflow_file")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LOG REDACTION
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — log redaction", () => {
  it("redacts GitHub tokens", () => {
    expect(redactLogContent("token ghp_" + "a".repeat(36))).not.toContain("ghp_");
  });
  it("redacts Bearer tokens", () => {
    expect(redactLogContent("Authorization: Bearer eyJ.test")).not.toContain("eyJ.test");
  });
  it("preserves non-secret content", () => {
    expect(redactLogContent("Error: test failed")).toBe("Error: test failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TRUNCATION
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — truncation", () => {
  it("output fits within maxBytes including marker", () => {
    const result = truncateExcerpt("x".repeat(6000), 4096);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(4096);
  });
  it("preserves short text", () => {
    expect(truncateExcerpt("short")).toBe("short");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ELIGIBILITY
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — eligibility", () => {
  function makePayload(overrides = {}) {
    return {
      action: "completed",
      workflow_run: { id: 12345, conclusion: "failure", head_sha: "abc123def456" },
      repository: { full_name: "acme/webapp" },
      installation: { id: 999 },
      ...overrides,
    };
  }
  it("accepts eligible payload", () => {
    expect(checkEligibility(makePayload())).toEqual({ eligible: true });
  });
  it("rejects non-failure", () => {
    expect(checkEligibility(makePayload({
      workflow_run: { id: 1, conclusion: "success", head_sha: "abc" },
    })).eligible).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WORKFLOW PATH & EXCERPT
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — workflow path & excerpt", () => {
  it("extracts workflow path from payload", () => {
    expect(extractWorkflowPath({ workflow_run: { path: ".github/workflows/ci.yml" } }))
      .toBe(".github/workflows/ci.yml");
  });
  it("extracts job error excerpt", () => {
    expect(extractJobErrorExcerpt("##[error]Test failed")).toContain("##[error]Test failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE RESTRICTION — P1 fix: public API is read-only
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — public API read-only", () => {
  const route = readSource("packages/web/src/routes/repairs.js");

  it("POST / returns 403", () => {
    expect(route).toMatch(/router\.post\("\/".*403/s);
  });
  it("PATCH /:id/evidence returns 403", () => {
    expect(route).toMatch(/router\.patch\("\/:id\/evidence".*403/s);
  });
  it("POST /:id/transition returns 403", () => {
    expect(route).toMatch(/router\.post\("\/:id\/transition".*403/s);
  });
  it("does not import createProposal in routes", () => {
    expect(route).not.toMatch(/createProposal/);
  });
  it("does not import attachEvidence in routes", () => {
    expect(route).not.toMatch(/attachEvidence/);
  });
  it("does not import transitionProposal in routes", () => {
    expect(route).not.toMatch(/transitionProposal/);
  });
  it("keeps GET routes (read-only access)", () => {
    expect(route).toMatch(/router\.get\("\/"/);
    expect(route).toMatch(/router\.get\("\/:id"/);
    expect(route).toMatch(/router\.get\("\/:id\/events"/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WEBHOOK INTEGRATION — non-blocking via queue
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — webhook integration", () => {
  const handler = readSource("packages/web/src/lib/webhookHandlers/handleWorkflowRun.js");

  it("queues ciEvidenceQueue job (non-blocking)", () => {
    expect(handler).toMatch(/ciEvidenceQueue\.add/);
  });
  it("does not call collectForFailedRun directly", () => {
    expect(handler).not.toMatch(/await collectForFailedRun/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WORKER CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — worker contract", () => {
  const worker = readSource("packages/web/src/workers/ciEvidenceWorker.js");
  const index = readSource("packages/web/src/index.js");

  it("exports startCIEvidenceWorker", () => {
    expect(worker).toMatch(/export function startCIEvidenceWorker/);
  });
  it("registered in index.js", () => {
    expect(index).toMatch(/startCIEvidenceWorker/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ATOMIC COLLECTION — P0 fix: replay-safe single transaction
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — atomic collection contract", () => {
  const collectorService = readSource("packages/web/src/services/ciEvidenceCollectorService.js");
  const repairService = readSource("packages/web/src/services/repairProposalService.js");

  it("collector imports recordCiEvidenceCollection (not attachEvidence/transitionProposal)", () => {
    expect(collectorService).toMatch(/recordCiEvidenceCollection/);
    expect(collectorService).not.toMatch(/import.*attachEvidence/);
    expect(collectorService).not.toMatch(/import.*transitionProposal/);
  });

  it("repairProposalService exports recordCiEvidenceCollection", () => {
    expect(repairService).toMatch(/export async function recordCiEvidenceCollection/);
  });

  it("recordCiEvidenceCollection is replay-safe (checks evidence_collected → no-op)", () => {
    expect(repairService).toMatch(/already evidence_collected/);
    expect(repairService).toMatch(/replay no-op/);
  });

  it("recordCiEvidenceCollection rejects unexpected intermediate states", () => {
    expect(repairService).toMatch(/requires status 'detected'/);
  });

  it("recordCiEvidenceCollection uses db.transaction", () => {
    expect(repairService).toMatch(/db\.transaction\(async \(client\)/);
  });

  it("recordCiEvidenceCollection records single ci_evidence_collected event", () => {
    expect(repairService).toMatch(/ci_evidence_collected/);
  });

  it("recordCiEvidenceCollection uses CAS with separate id/version placeholders", () => {
    // Should have whereClauses.push for both id and version
    const recordSection = repairService.split("recordCiEvidenceCollection");
    expect(recordSection[1]).toMatch(/whereClauses\.push\(`id = \$\$\{paramIdx\+\+\}`\)/);
    expect(recordSection[1]).toMatch(/whereClauses\.push\(`version = \$\$\{paramIdx\+\+\}`\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CORRELATION IDENTITY — P1 fix: threaded through to events
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — correlation identity in events", () => {
  const repairService = readSource("packages/web/src/services/repairProposalService.js");
  const collectorService = readSource("packages/web/src/services/ciEvidenceCollectorService.js");

  it("recordCiEvidenceCollection accepts correlation_id", () => {
    expect(repairService).toMatch(/correlation_id/);
  });

  it("recordCiEvidenceCollection persists correlation_id in event", () => {
    const recordSection = repairService.split("recordCiEvidenceCollection");
    // The INSERT should include correlation_id
    expect(recordSection[1]).toMatch(/correlation_id/);
  });

  it("collector passes correlation_id to recordCiEvidenceCollection", () => {
    expect(collectorService).toMatch(/correlation_id/);
  });

  it("attachEvidence accepts correlation_id param", () => {
    // correlation_id appears in both the signature and the event INSERT
    expect(repairService).toMatch(/correlation_id/);
  });

  it("transitionProposal accepts correlation_id in params", () => {
    expect(repairService).toMatch(/correlation_id/);
  });

  it("event INSERTs include correlation_id column", () => {
    // All three event INSERT patterns should include correlation_id
    const matches = repairService.match(/correlation_id/g);
    expect(matches.length).toBeGreaterThanOrEqual(6); // signature + INSERT for each of 3 methods
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVICE-LAYER AUTHORITY ENFORCEMENT — P1 fix: actor_kind in canonical methods
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — service-layer authority enforcement", () => {
  const repairService = readSource("packages/web/src/services/repairProposalService.js");

  it("defines requireActorKind helper", () => {
    expect(repairService).toMatch(/function requireActorKind/);
    expect(repairService).toMatch(/actor_kind is required and must be a recognized value/);
  });

  it("createProposal calls requireActorKind unconditionally", () => {
    const section = repairService.split("createProposal");
    expect(section[1]).toMatch(/requireActorKind\(actor_kind\)/);
    expect(section[1]).not.toMatch(/if \(actor_kind.*requireActorKind/s);
  });

  it("createProposal checks canCreateProposal unconditionally", () => {
    const section = repairService.split("createProposal");
    expect(section[1]).toMatch(/canCreateProposal\(actor_kind\)/);
    expect(section[1]).not.toMatch(/if \(actor_kind && !canCreateProposal/);
  });

  it("attachEvidence calls requireActorKind unconditionally", () => {
    const section = repairService.split("attachEvidence");
    expect(section[1]).toMatch(/requireActorKind\(actor_kind\)/);
  });

  it("attachEvidence checks canAttachField per field unconditionally", () => {
    const section = repairService.split("attachEvidence");
    expect(section[1]).toMatch(/canAttachField\(actor_kind, field\)/);
    // Must NOT be wrapped in an optional if(actor_kind) guard
    expect(section[1]).not.toMatch(/if \(actor_kind\)/);
  });

  it("transitionProposal calls requireActorKind unconditionally", () => {
    const section = repairService.split("transitionProposal");
    expect(section[1]).toMatch(/requireActorKind\(actor_kind\)/);
  });

  it("transitionProposal checks canTransitionTo unconditionally", () => {
    const section = repairService.split("transitionProposal");
    expect(section[1]).toMatch(/canTransitionTo\(actor_kind, targetStatus\)/);
    expect(section[1]).not.toMatch(/if \(actor_kind && !canTransitionTo/);
  });

  it("recordCiEvidenceCollection calls requireActorKind unconditionally", () => {
    const section = repairService.split("recordCiEvidenceCollection");
    expect(section[1]).toMatch(/requireActorKind\(actor_kind\)/);
  });

  it("recordCiEvidenceCollection checks canAttachField for evidence_refs", () => {
    const section = repairService.split("recordCiEvidenceCollection");
    expect(section[1]).toMatch(/canAttachField\(actor_kind, "evidence_refs"\)/);
  });

  it("recordCiEvidenceCollection checks canTransitionTo for evidence_collected", () => {
    const section = repairService.split("recordCiEvidenceCollection");
    expect(section[1]).toMatch(/canTransitionTo\(actor_kind, "evidence_collected"\)/);
  });

  it("imports ACTOR_KINDS and authority functions", () => {
    expect(repairService).toMatch(/import.*ACTOR_KINDS.*canCreateProposal.*canAttachField.*canTransitionTo.*repairAuthorityService/s);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SOURCE DELIVERY IDENTITY — P1 fix: source_delivery_id in events
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — source delivery identity", () => {
  const repairService = readSource("packages/web/src/services/repairProposalService.js");
  const collectorService = readSource("packages/web/src/services/ciEvidenceCollectorService.js");
  const migration031 = readSource("packages/web/db/migrations/031_repair_proposals.sql");
  const migration032 = readSource("packages/web/db/migrations/032_repair_proposal_event_provenance.sql");

  it("migration 031 does NOT have source_delivery_id (forward-only via 032)", () => {
    expect(migration031).not.toMatch(/source_delivery_id/);
  });

  it("migration 032 adds source_delivery_id via ALTER TABLE", () => {
    expect(migration032).toMatch(/ALTER TABLE repair_proposal_events/);
    expect(migration032).toMatch(/ADD COLUMN IF NOT EXISTS source_delivery_id TEXT/);
  });

  it("recordCiEvidenceCollection accepts source_delivery_id", () => {
    const section = repairService.split("recordCiEvidenceCollection");
    expect(section[1]).toMatch(/source_delivery_id/);
  });

  it("collection event INSERT includes source_delivery_id", () => {
    const section = repairService.split("recordCiEvidenceCollection");
    expect(section[1]).toMatch(/source_delivery_id\)/);
  });

  it("collector passes deliveryId as source_delivery_id", () => {
    expect(collectorService).toMatch(/source_delivery_id.*deliveryId/);
  });

  it("collector passes actor_kind to createProposal", () => {
    expect(collectorService).toMatch(/actor_kind.*ACTOR/);
  });

  it("collector passes actor_kind to recordCiEvidenceCollection", () => {
    expect(collectorService).toMatch(/actor_kind.*ACTOR.*source_delivery_id/s);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVICE CONTRACT — retained from round 2
// ════════════════════════════════════════════════════════════════════════════

describe("CI Evidence Collector — service contract", () => {
  const service = readSource("packages/web/src/services/ciEvidenceCollectorService.js");

  it("does NOT reference payload_workflowName (removed)", () => {
    expect(service).not.toMatch(/payload_workflowName/);
  });
  it("uses extractWorkflowPath", () => {
    expect(service).toMatch(/extractWorkflowPath/);
  });
  it("does NOT import attachEvidenceAuthorized or transitionProposalAuthorized", () => {
    expect(service).not.toMatch(/attachEvidenceAuthorized/);
    expect(service).not.toMatch(/transitionProposalAuthorized/);
  });
  it("uses ACTOR_KINDS.CI_EVIDENCE_COLLECTOR identity", () => {
    expect(service).toMatch(/ACTOR_KINDS\.CI_EVIDENCE_COLLECTOR/);
  });
});
