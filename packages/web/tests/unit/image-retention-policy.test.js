// tests/unit/image-retention-policy.test.js
// #425 incident follow-up regressions: the protected image-retention
// policy. The 2026-11-21 incident removed the locally-pinned validator
// image with an unrestricted prune -a; these tests pin that this can never
// happen again through the policy path, plus rollback retention and
// accumulation cleanup.

import { selectImagesToRemove } from "../../src/lib/imageRetentionPolicy.js";

const T = (n) => `2026-11-${String(n).padStart(2, "0")}T00:00:00Z`;
const img = (repository, digest, n, tag) => ({
  repository,
  tag: tag ?? null,
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

  it("running references are always kept regardless of age (by image id)", () => {
    const images = mkImages();
    const { remove } = selectImagesToRemove({
      images,
      protectedRefs: [],
      runningImages: ["gitwire-app-1"], // ancient but running (id form)
      keepPerRepo: 1,
    });
    expect(remove.map((i) => i.id)).not.toContain("gitwire-app-1");
  });

  it("THE ACCUMULATION CLASS: a running repo:tag protects ONLY that exact image — never the whole repository (review HIGH)", () => {
    const images = [];
    for (let n = 1; n <= 40; n += 1) {
      images.push(img("ghcr.io/octo-lex/gitwire-app", `sha256:${String(n % 10).repeat(64)}`, n, "sha-x" + n));
    }
    const running = "ghcr.io/octo-lex/gitwire-app:sha-x40"; // the deployed tag
    const { keep, remove } = selectImagesToRemove({
      images,
      protectedRefs: [],
      runningImages: [running],
      keepPerRepo: 2,
    });
    // Running ref kept (id form would also work); rollback window kept;
    // the other 37 accumulated images ARE removable.
    expect(keep.map((i) => i.id).sort()).toEqual(["gitwire-app-39", "gitwire-app-40"]);
    expect(remove.length).toBe(38);
  });

  it("a running repo@digest reference protects its image (digest-run containers)", () => {
    // Three images, keepPerRepo=1: newest (3) survives recency; image 1
    // survives ONLY via the running repo@digest reference; image 2 is the
    // unprotected remainder — proving the digest-ref match fires.
    const images = [1, 2, 3].map((n) => img("ghcr.io/octo-lex/gitwire-app", `sha256:${String(n).repeat(64)}`, n, "t" + n));
    const { remove } = selectImagesToRemove({
      images,
      protectedRefs: [],
      runningImages: ["ghcr.io/octo-lex/gitwire-app@sha256:" + "1".repeat(64)],
      keepPerRepo: 1,
    });
    expect(remove).toHaveLength(1);
    expect(remove[0].digest).toBe("sha256:" + "2".repeat(64));
  });

  it("a running BARE repository name confers NO protection (the v2 defect asserted dead)", () => {
    const images = [1, 2, 3].map((n) => img("ghcr.io/octo-lex/gitwire-app", `sha256:${String(n).repeat(64)}`, n, "t" + n));
    const { remove } = selectImagesToRemove({
      images,
      protectedRefs: [],
      runningImages: ["ghcr.io/octo-lex/gitwire-app"], // bare repo — NOT a valid exact ref
      keepPerRepo: 1,
    });
    expect(remove.map((i) => i.id)).toContain("gitwire-app-1");
    expect(remove.map((i) => i.id)).toContain("gitwire-app-2");
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

describe("selectImagesToRemove — R1/R2 (bounded revision)", () => {
  const A = "sha256:" + "a".repeat(64);
  const B = "sha256:" + "b".repeat(64);
  const C = "sha256:" + "c".repeat(64);

  it("R1 mixed registries: any registry's digest-qualified pin is protected", () => {
    const images = [
      { repository: "ghcr.io/octo-lex/gitwire-app", tag: null, digest: A, id: "i1", created: "2026-11-20" },
      { repository: "registry.example.com/other/validator", tag: null, digest: B, id: "i2", created: "2026-06-01" },
      { repository: "ghcr.io/octo-lex/gitwire-app", tag: null, digest: C, id: "i3", created: "2026-11-21" },
    ];
    const { remove, keptProtected } = selectImagesToRemove({
      images,
      protectedRefs: [
        "registry.example.com/other/validator@" + B, // non-GHCR registry pin
        "ghcr.io/octo-lex/gitwire-app@" + C,
      ],
      mandatoryRefs: ["registry.example.com/other/validator@" + B],
      managedRepositories: ["ghcr.io/octo-lex/gitwire-app", "registry.example.com/other/validator"],
      runningImages: [],
      keepPerRepo: 1,
    });
    expect(remove.map((i) => i.id)).toEqual(["i1"]); // only the unprotected old app image
    expect(keptProtected.length).toBe(2);
  });

  it("R1 recorded rollback identity: an old image referenced by a release record survives despite age", () => {
    const images = [1, 2, 3, 4].map((n) => ({
      repository: "ghcr.io/octo-lex/gitwire-app",
      tag: null,
      digest: "sha256:" + String(n).repeat(64),
      id: "app-" + n,
      created: `2026-11-1${n}`,
    }));
    const rollbackRef = "ghcr.io/octo-lex/gitwire-app@sha256:" + "1".repeat(64); // oldest, recorded
    const { remove } = selectImagesToRemove({
      images,
      protectedRefs: [rollbackRef, "ghcr.io/octo-lex/gitwire-app@sha256:" + "4".repeat(64)],
      mandatoryRefs: ["ghcr.io/octo-lex/gitwire-app@sha256:" + "4".repeat(64)],
      managedRepositories: ["ghcr.io/octo-lex/gitwire-app"],
      runningImages: [],
      keepPerRepo: 2,
    });
    expect(remove.map((i) => i.id)).toEqual(["app-2"]); // app-1 protected by RECORD not recency; app-3/app-4 within recency window
  });

  it("R2 non-GitWire images are NEVER removable, even unmanaged-old and unreferenced", () => {
    const images = [
      { repository: "docker.io/library/postgres", tag: "16", digest: null, id: "pg", created: "2024-01-01" },
      { repository: "docker.io/someone/other-tool", tag: "old", digest: null, id: "ot", created: "2023-01-01" },
      { repository: "ghcr.io/octo-lex/gitwire-app", tag: null, digest: A, id: "app-old", created: "2026-01-01" },
    ];
    const { remove, keptUnmanaged } = selectImagesToRemove({
      images,
      protectedRefs: [],
      managedRepositories: ["ghcr.io/octo-lex/gitwire-app"], // GitWire owns ONLY this repo
      runningImages: [],
      keepPerRepo: 0,
    });
    expect(remove.map((i) => i.id)).toEqual(["app-old"]); // only owned accumulation
    expect(keptUnmanaged).toBe(2); // postgres + other-tool preserved unconditionally
  });

  it("R1 mandatory gate: an unresolved mandatory ref is fatal evidence, surfaced not swallowed", () => {
    const images = [
      { repository: "ghcr.io/octo-lex/gitwire-app", tag: null, digest: A, id: "i1", created: "2026-11-21" },
    ];
    const { mandatoryResolved, unresolvedMandatory } = selectImagesToRemove({
      images,
      protectedRefs: ["ghcr.io/octo-lex/gitwire-app@" + A],
      mandatoryRefs: [
        "ghcr.io/octo-lex/gitwire-app@" + A,
        "ghcr.io/octo-lex/gitwire-validator@sha256:" + "e".repeat(64), // the incident pin — absent
      ],
      managedRepositories: ["ghcr.io/octo-lex/gitwire-app"],
      runningImages: [],
    });
    expect(mandatoryResolved).toBe(false);
    expect(unresolvedMandatory).toEqual(["ghcr.io/octo-lex/gitwire-validator@sha256:" + "e".repeat(64)]);
  });
});
