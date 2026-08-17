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

const FROZEN_RI7_SOURCE_SHA256 = "2686389fd3a9ae03a75387489b50c29cb300fd42a619943ace966ea43ebbf129";

describe("RI-7 preservation: exactly-one mutation semantics unchanged", () => {

  it("reviewMutationService.js source hash matches the RI-7-qualified implementation", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "..", "..", "src", "services", "reviewMutationService.js"),
    );
    const hash = createHash("sha256").update(source).digest("hex");
    expect(hash).toBe(FROZEN_RI7_SOURCE_SHA256);
  });
});
