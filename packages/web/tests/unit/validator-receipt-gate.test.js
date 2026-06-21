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
