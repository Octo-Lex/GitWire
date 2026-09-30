// tests/unit/policy-diff-risks-regression.test.js
// Behavioral regression for the risks_added/risks_removed computation.
//
// The source-contract test ("compares risks by path") passed for years while
// `risks_removed` compared c.path === c.path — it matched the correct sibling
// expression on the risks_added line. This suite drives diffPolicyImpact
// itself with one retained, one added, and one removed risky setting.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockGetConfigForRepo = jest.fn();
const mockValidatePolicy = jest.fn();
const mockResolveProposed = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: mockGetConfigForRepo,
  resolveProposedConfig: mockResolveProposed,
  isConfigValidationError: () => false,
}));
jest.unstable_mockModule("../../src/services/policyValidationService.js", () => ({
  validatePolicy: mockValidatePolicy,
}));

const { diffPolicyImpact } = await import("../../src/services/policyDiffService.js");

const CURRENT_RISKS = [
  { path: "/pillars/triage/enabled", risk: "retained-risk" },
  { path: "/pillars/maintainer/stale/issues/close_days", risk: "removed-risk" },
];
const PROPOSED_RISKS = [
  { path: "/pillars/triage/enabled", risk: "retained-risk" },
  { path: "/pillars/spam_gate/enabled", risk: "added-risk" },
];

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] }); // no repo row → no simulation pass
  mockGetConfigForRepo.mockReset();
  mockGetConfigForRepo.mockResolvedValue({
    settings: { dry_run: true },
    pillars: {},
  });
  mockResolveProposed.mockReset();
  mockResolveProposed.mockResolvedValue({
    settings: { dry_run: true },
    pillars: {},
  });
  mockValidatePolicy.mockReset();
  // Call order in the service: current validation first, then proposed.
  mockValidatePolicy.mockResolvedValueOnce({
    valid: true,
    warnings: [],
    risky_settings: CURRENT_RISKS,
  }).mockResolvedValueOnce({
    valid: true,
    warnings: [],
    risky_settings: PROPOSED_RISKS,
  });
});

describe("diffPolicyImpact risk delta regression", () => {
  it("reports exactly the removed risk as risks_removed", async () => {
    const result = await diffPolicyImpact({ repo: "acme/app", yaml: "pillars: {}" });
    expect(result.changes.risks_removed.map((r) => r.path))
      .toEqual(["/pillars/maintainer/stale/issues/close_days"]);
  });

  it("reports exactly the added risk as risks_added", async () => {
    const result = await diffPolicyImpact({ repo: "acme/app", yaml: "pillars: {}" });
    expect(result.changes.risks_added.map((r) => r.path))
      .toEqual(["/pillars/spam_gate/enabled"]);
  });

  it("does not report a retained risk in either delta", async () => {
    const result = await diffPolicyImpact({ repo: "acme/app", yaml: "pillars: {}" });
    const paths = [...result.changes.risks_removed, ...result.changes.risks_added].map((r) => r.path);
    expect(paths).not.toContain("/pillars/triage/enabled");
  });
});
