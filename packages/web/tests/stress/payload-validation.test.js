// tests/stress/payload-validation.test.js
// Stress Test: Malformed payloads — verify graceful handling of bad inputs.
//
// Uses assertion-only contracts (no expectedStatuses) for negation patterns
// like "must not return 500" and "must not return 200". Because expectedStatuses
// is omitted, every transport-completed status is http=expected; the meaningful
// verdict is the semantic assertion.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { runContractedOperation } from "./burst-runner.js";
import { apiContractedOperation } from "./response-contracts.js";
import { httpOperation } from "./burst-runner.js";
import { BASE_URL, API_KEY } from "../helpers.js";
import { sleep } from "./stress-helpers.js";

/** Build a raw POST operation (not via apiContractedOperation, since these
 *  tests send malformed bodies that the policy may reject). */
function rawPostOp(path, body, contentType = "application/json") {
  return {
    kind: "payload-validation",
    method: "POST",
    run: () => httpOperation({
      method: "POST", bodyMode: "auto",
      execute: () => fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    }),
    responseContract: {
      // Assertion-only: no expectedStatuses → all transport-completed are "expected"
      assert: ({ status }) => status !== 500
        ? { passed: true }
        : { passed: false, code: "UNEXPECTED_INTERNAL_ERROR", message: "Malformed input returned HTTP 500" },
    },
  };
}

function rawGetOp(path) {
  return {
    kind: "payload-validation",
    method: "GET",
    run: () => httpOperation({
      method: "GET", bodyMode: "auto",
      execute: () => fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      }),
    }),
    responseContract: {
      assert: ({ status }) => status !== 500
        ? { passed: true }
        : { passed: false, code: "UNEXPECTED_INTERNAL_ERROR", message: "Malformed input returned HTTP 500" },
    },
  };
}

describe("Payload Validation: malformed inputs", () => {
  beforeEach(async () => { await sleep(200); });

  describe("Enforcement policy creation", () => {
    it("Empty body → not 200", async () => {
      const result = await runContractedOperation({
        ...rawPostOp("/api/enforcement/policies", {}),
        responseContract: {
          assert: ({ status }) => status !== 200
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_SUCCESS", message: "Empty body should not return 200" },
        },
      });
      expect(result.assertion).toBe("passed");
    });

    it("Missing required fields → not 200", async () => {
      const result = await runContractedOperation({
        ...rawPostOp("/api/enforcement/policies", { description: "No name or branch_pattern" }),
        responseContract: {
          assert: ({ status }) => status !== 200
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_SUCCESS", message: "Missing fields should not return 200" },
        },
      });
      expect(result.assertion).toBe("passed");
    });

    it("Invalid mode value → not 200", async () => {
      const result = await runContractedOperation({
        ...rawPostOp("/api/enforcement/policies", { name: "stress-invalid-mode", branch_pattern: "main", mode: "DESTROY_EVERYTHING" }),
        responseContract: {
          assert: ({ status }) => status !== 200
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_SUCCESS", message: "Invalid mode should not return 200" },
        },
      });
      expect(result.assertion).toBe("passed");
    });

    it("Very long name → not 500", async () => {
      const result = await runContractedOperation(
        rawPostOp("/api/enforcement/policies", { name: "x".repeat(1000), branch_pattern: "main", mode: "audit" })
      );
      expect(result.assertion).toBe("passed");
    });
  });

  describe("Feedback rule creation", () => {
    it("Invalid event_type → not 200", async () => {
      const result = await runContractedOperation({
        ...rawPostOp("/api/phase2/feedback", { name: "bad-event", event_type: "EXPLODE" }),
        responseContract: {
          assert: ({ status }) => status !== 200
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_SUCCESS", message: "Invalid event_type should not return 200" },
        },
      });
      expect(result.assertion).toBe("passed");
    });

    it("Missing event_type → not 200", async () => {
      const result = await runContractedOperation({
        ...rawPostOp("/api/phase2/feedback", { name: "no-event" }),
        responseContract: {
          assert: ({ status }) => status !== 200
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_SUCCESS", message: "Missing event_type should not return 200" },
        },
      });
      expect(result.assertion).toBe("passed");
    });
  });

  describe("Non-JSON body", () => {
    it("Plain text body → not 200, not 500", async () => {
      const result = await runContractedOperation({
        ...rawPostOp("/api/enforcement/policies", "this is not json", "text/plain"),
        responseContract: {
          assert: ({ status }) => (status !== 200 && status !== 500)
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_RESPONSE", message: `Plain text body returned ${status}` },
        },
      });
      expect(result.assertion).toBe("passed");
    });
  });

  describe("SQL injection attempts", () => {
    it("Repo name with SQL injection → not 500", async () => {
      const result = await runContractedOperation(
        rawGetOp("/api/repos/test'; DROP TABLE repositories;--")
      );
      expect(result.assertion).toBe("passed");
    });

    it("Issue search with SQL injection → not 500", async () => {
      const result = await runContractedOperation(
        rawGetOp("/api/issues?search=' OR 1=1; DROP TABLE issues;--")
      );
      expect(result.assertion).toBe("passed");
    });
  });

  describe("Path traversal attempts", () => {
    it("Path traversal in repo name → not 500", async () => {
      const paths = [
        "/api/repos/../../../etc/passwd",
        "/api/repos/..%2F..%2F..%2Fetc%2Fpasswd",
        "/api/repos/....//....//....//etc/passwd",
      ];
      for (const p of paths) {
        const result = await runContractedOperation(rawGetOp(p));
        expect(result.assertion).toBe("passed");
        await sleep(100);
      }
    });
  });

  describe("Extremely large payloads", () => {
    it("Large JSON body → not 500", async () => {
      const hugeArray = Array.from({ length: 10000 }, (_, i) => `item-${i}`);
      const result = await runContractedOperation(
        rawPostOp("/api/enforcement/policies", { name: "huge-payload", branch_pattern: "main", mode: "audit", required_status_check_contexts: hugeArray })
      );
      expect(result.assertion).toBe("passed");
    });
  });
});
