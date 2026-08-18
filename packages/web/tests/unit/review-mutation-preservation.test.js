// tests/unit/review-mutation-preservation.test.js
// RI-9 Phase 10 (slice E2): RI-7 mutation semantics are unchanged.
//
// The Phase 10 foundation did not touch reviewMutationService.js. This
// test pins that fact as a source hash: the exactly-one-mutation manager
// is byte-for-byte the RI-7-qualified implementation.
//
// UPDATE PROTOCOL: if a FUTURE, separately-reviewed change intentionally
// modifies reviewMutationService.js, recompute the hash and update this
// constant IN THAT CHANGE with a pointer to its RI-7-equivalence proof
// (unchanged-and-green mutation suite plus demonstrably identical
// exactly-one semantics). The pin exists so no Phase 10-adjacent work can
// drift into the mutation path unnoticed.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned over LF-normalized source: the hash is line-ending independent
// (checkouts differ between CRLF on Windows and LF on CI runners).
const FROZEN_RI7_SOURCE_SHA256 = "19f3a384a309feface77bb8adc0e01e0c7209bc77587410167bab586a8f3ecd0";

describe("RI-7 preservation: exactly-one mutation semantics unchanged", () => {

  it("reviewMutationService.js source hash matches the RI-7-qualified implementation", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "..", "..", "src", "services", "reviewMutationService.js"),
    );
    const normalized = Buffer.from(source.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    const hash = createHash("sha256").update(normalized).digest("hex");
    expect(hash).toBe(FROZEN_RI7_SOURCE_SHA256);
  });
});
