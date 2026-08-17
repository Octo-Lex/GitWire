// RepositoryTools v2 contract (RI-9 amendment, Phase 2) — envelope shape and
// the frozen negative-evidence invariant.

import {
  makeResult,
  assertResultInvariants,
  isAuthoritativeAbsence,
  describeCompleteness,
  utf8Bytes,
  ContractViolation,
  ERROR_CODES,
} from "../../../src/lib/repositoryTools/contract.js";

const SESSION = { id: "sess-test", headSha: "a".repeat(40), snapshotRefs: { head: "ref-h" } };

function base(overrides = {}) {
  return {
    operation: "grep",
    session: SESSION,
    status: "success",
    startedAt: performance.now(),
    data: { matches: [] },
    ...overrides,
  };
}

describe("makeResult envelope", () => {
  it("produces a frozen success envelope that is complete", () => {
    const result = makeResult(base());
    expect(result.status).toBe("success");
    expect(result.complete).toBe(true);
    expect(result.repositorySessionId).toBe("sess-test");
    expect(result.headSha).toBe("a".repeat(40));
    expect(result.snapshotRef).toBe("ref-h");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.partialReasons)).toBe(true);
  });

  it("omits returnedItems when not provided and includes it when provided", () => {
    expect(makeResult(base())).not.toHaveProperty("returnedItems");
    expect(makeResult(base({ returnedItems: 0 }))).toHaveProperty("returnedItems", 0);
  });
});

describe("assertResultInvariants — misrepresentation is impossible", () => {
  it("rejects success that is incomplete or carries partial reasons", () => {
    expect(() =>
      makeResult(base({ status: "success", data: { matches: [] }, partialReasons: ["timeout"] }))
    ).toThrow(ContractViolation);
  });

  it("rejects partial without a reason", () => {
    expect(() => makeResult(base({ status: "partial", partialReasons: [] }))).toThrow(ContractViolation);
  });

  it("rejects an unknown partial reason", () => {
    expect(() =>
      makeResult(base({ status: "partial", partialReasons: ["kind_of_tired"] }))
    ).toThrow(ContractViolation);
  });

  it("rejects an error that carries data, or a non-error that carries error", () => {
    expect(() =>
      makeResult(base({ status: "error", data: { matches: [] }, error: { code: ERROR_CODES.BACKEND_FAILED, message: "x" } }))
    ).toThrow(ContractViolation);
    expect(() =>
      makeResult(base({ error: { code: ERROR_CODES.BACKEND_FAILED, message: "x" } }))
    ).toThrow(ContractViolation);
  });

  it("rejects an error without a code", () => {
    expect(() => makeResult(base({ status: "error", error: { message: "x" } }))).toThrow(ContractViolation);
  });

  it("rejects unknown operations and statuses", () => {
    expect(() => makeResult(base({ operation: "rm" }))).toThrow(ContractViolation);
    expect(() => makeResult(base({ status: "maybe" }))).toThrow(ContractViolation);
  });
});

describe("negative-evidence invariant", () => {
  it("[] && complete=true is authoritative absence for enumerable ops", () => {
    for (const [operation, data] of [
      ["grep", { matches: [] }],
      ["find", { paths: [] }],
      ["ls", { entries: [] }],
    ]) {
      const result = makeResult(base({ operation, data }));
      expect(isAuthoritativeAbsence(result)).toBe(true);
    }
  });

  it("[] with partial or error is NEVER authoritative absence", () => {
    const partial = makeResult(base({ status: "partial", partialReasons: ["timeout"], data: { matches: [] } }));
    const error = makeResult(base({ status: "error", data: undefined, error: { code: ERROR_CODES.BACKEND_FAILED, message: "x" } }));
    expect(isAuthoritativeAbsence(partial)).toBe(false);
    expect(isAuthoritativeAbsence(error)).toBe(false);
  });

  it("non-empty results are not absence", () => {
    const result = makeResult(base({ data: { matches: [{ path: "a" }] } }));
    expect(isAuthoritativeAbsence(result)).toBe(false);
  });

  it("read never claims absence semantics", () => {
    const result = makeResult(base({ operation: "read", data: { content: "" } }));
    expect(isAuthoritativeAbsence(result)).toBe(false);
  });
});

describe("describeCompleteness — receipt-facing partiality string", () => {
  it("describes complete, partial (sorted, joined), and error states", () => {
    expect(describeCompleteness(makeResult(base()))).toBe("complete");
    expect(
      describeCompleteness(
        makeResult(base({ status: "partial", partialReasons: ["output_bytes", "result_limit"], data: { matches: [] } }))
      )
    ).toBe("partial:output_bytes+result_limit");
    expect(
      describeCompleteness(
        makeResult(base({ status: "error", data: undefined, error: { code: ERROR_CODES.BACKEND_FAILED, message: "x" } }))
      )
    ).toBe("error:E_BACKEND_FAILED");
  });
});

describe("utf8Bytes", () => {
  it("counts UTF-8 bytes, not code units or code points", () => {
    expect(utf8Bytes("a")).toBe(1);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("汉")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
    expect(utf8Bytes("héllo汉😀")).toBe(13);
  });
});
