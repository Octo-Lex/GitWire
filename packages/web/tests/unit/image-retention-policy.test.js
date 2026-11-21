// tests/unit/image-retention-policy.test.js
// #425 incident follow-up regressions: the protected image-retention
// policy. The 2026-11-21 incident removed the locally-pinned validator
// image with an unrestricted prune -a; these tests pin that this can never
// happen again through the policy path, plus rollback retention and
// accumulation cleanup.

import { selectImagesToRemove } from "../../src/lib/imageRetentionPolicy.js";

const T = (n) => `2026-11-${String(n).padStart(2, "0")}T00:00:00Z`;
const img = (repository, digest, n) => ({
  repository,
  digest,
  id: `${repository.split("/").pop()}-${n}`,
  created: T(n),
});

const VALIDATOR_REF = "ghcr.io/octo-lex/gitwire-validator@sha256:e2c10a619eec086b5b4844e3eeea0d663445fc633cb3d2923aa3aa1769a5ffaa";

describe("selectImagesToRemove — protected refs", () => {
  it("THE INCIDENT CASE: the pinned validator digest survives even though nothing runs it and it is old", () => {
    const images = [
      img("ghcr.io/octo-lex/gitwire-app", "sha256:" + "a".repeat(64), 20),
      img("ghcr.io/octo-lex/gitwire-validator", "sha256:e2c10a619eec086b5b4844e3eeea0d663445fc633cb3d2923aa3aa1769a5ffaa", 1),
    ];
    const { remove, keptProtected } = selectImagesToRemove({
      images,
      protectedRefs: [VALIDATOR_REF, "ghcr.io/octo-lex/gitwire-app@sha256:" + "a".repeat(64)],
      runningImages: ["gitwire-app-20"],
      keepPerRepo: 1,
    });
    expect(remove).toEqual([]); // validator protected; app running
    expect(keptProtected).toContain(VALIDATOR_REF);
  });

  it("a protected ref whose digest is NOT in the inventory is reported as not-kept (deployment pin drift made visible)", () => {
    const images = [img("ghcr.io/octo-lex/gitwire-app", "sha256:" + "a".repeat(64), 20)];
    const { keptProtected } = selectImagesToRemove({
      images,
      protectedRefs: [VALIDATOR_REF],
      runningImages: [],
    });
    expect(keptProtected).toEqual([]); // pin did not resolve — caller must see this
  });

  it("non-digest refs are not treated as protected (fail-visible, not fail-safe)", () => {
    const images = [img("ghcr.io/octo-lex/gitwire-app", "sha256:" + "a".repeat(64), 20)];
    const { remove } = selectImagesToRemove({
      images,
      protectedRefs: ["ghcr.io/octo-lex/gitwire-app:latest"], // tag, not digest
      runningImages: [],
      keepPerRepo: 0,
    });
    expect(remove.map((i) => i.id)).toEqual(["gitwire-app-20"]);
  });
});

describe("selectImagesToRemove — rollback candidates and cleanup", () => {
  const mkImages = () => [
    ...[1, 2, 3, 4, 5, 6].map((n) => img("ghcr.io/octo-lex/gitwire-app", `sha256:${String(n).repeat(64)}`, n)),
    ...[1, 2].map((n) => img("ghcr.io/octo-lex/gitwire-dashboard", `sha256:${String(n).repeat(64, 10)}`, n)),
  ];

  it("keeps the N most recent per repository, removes the accumulation beyond it", () => {
    const { keep, remove } = selectImagesToRemove({
      images: mkImages(),
      protectedRefs: [],
      runningImages: ["gitwire-app-6"],
      keepPerRepo: 3,
    });
    // app: ids 6 (running+recent), 5, 4 kept; 1,2,3 removed
    expect(keep.map((i) => i.id).sort()).toEqual(["gitwire-app-4", "gitwire-app-5", "gitwire-app-6", "gitwire-dashboard-1", "gitwire-dashboard-2"]);
    expect(remove.map((i) => i.id).sort()).toEqual(["gitwire-app-1", "gitwire-app-2", "gitwire-app-3"]);
  });

  it("running references are always kept regardless of age", () => {
    const images = mkImages();
    const { remove } = selectImagesToRemove({
      images,
      protectedRefs: [],
      runningImages: ["gitwire-app-1"], // ancient but running
      keepPerRepo: 1,
    });
    expect(remove.map((i) => i.id)).not.toContain("gitwire-app-1");
  });

  it("the 250-image accumulation class actually shrinks (the disk-incident cure)", () => {
    const images = [];
    for (let n = 1; n <= 60; n += 1) {
      images.push(img("ghcr.io/octo-lex/gitwire-app", `sha256:${String(n % 10).repeat(64)}`, n));
    }
    const { remove, keep } = selectImagesToRemove({
      images,
      protectedRefs: [],
      runningImages: ["gitwire-app-60"],
      keepPerRepo: 3,
    });
    expect(remove.length).toBe(57);
    expect(keep.length).toBe(3);
  });
});
