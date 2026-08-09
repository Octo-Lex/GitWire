// tests/evaluation/review-integrity/contract.test.js
// V2 review integrity contract suite.
//
// These tests define the target behavior of the v2 review integrity
// implementation. They are guarded by REVIEW_INTEGRITY_V2 so they do
// not run against the current engine. When the v2 implementation lands,
// set REVIEW_INTEGRITY_V2=1 to activate these tests and they become
// the regression gate.
//
// Broken fixtures must NEVER approve. Fixed fixtures should be approvable.

const REVIEW_INTEGRITY_V2 = process.env.REVIEW_INTEGRITY_V2 === "1";

const describeOrSkip = REVIEW_INTEGRITY_V2 ? describe : describe.skip;

describeOrSkip("RI v2 contract — broken fixtures must never approve", () => {
  // These tests will be implemented when RI-2 through RI-9 land.
  // Each broken fixture asserts verdict !== "approved".
  // Each fixed fixture asserts verdict === "approved" (with complete evidence).

  it("placeholder — v2 contract suite activates under REVIEW_INTEGRITY_V2=1", () => {
    expect(REVIEW_INTEGRITY_V2).toBe(true);
  });
});
