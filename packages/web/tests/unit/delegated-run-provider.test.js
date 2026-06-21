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

  // CRITICAL safety invariant (per Task 9 review): the null provider must
  // NEVER map anything to "pass". Pass-capable delegated-run execution
  // requires a real, configured provider with receipt-bound evidence.
  it("NEVER maps to pass", () => {
    // mapResult is the only result-mapping surface; assert it never returns pass
    // across a range of inputs.
    expect(NullDelegatedRunProvider.mapResult({})).not.toBe("pass");
    expect(NullDelegatedRunProvider.mapResult({ overall: "pass" })).not.toBe("pass");
    expect(NullDelegatedRunProvider.mapResult({ overall: "success" })).not.toBe("pass");
    expect(NullDelegatedRunProvider.mapResult(null)).not.toBe("pass");
  });

  it("submitValidationJob never returns pass-capable evidence", async () => {
    const result = await NullDelegatedRunProvider.submitValidationJob({});
    expect(result.overall).not.toBe("pass");
  });

  it("verifyReceiptHash always returns false (no receipt to verify)", async () => {
    expect(await NullDelegatedRunProvider.verifyReceiptHash({})).toBe(false);
  });
});
