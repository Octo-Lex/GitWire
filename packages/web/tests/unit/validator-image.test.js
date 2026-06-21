// Tests for validator image identity resolution (Gap 1.2).

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  resolveValidatorImage,
  isValidatorIdentityComplete,
  VALIDATOR_IMAGE_REQUIRED_FIELDS,
} from "../../src/lib/validatorImage.js";

describe("resolveValidatorImage — unconfigured", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  it("returns configured=false when no env set", () => {
    const r = resolveValidatorImage();
    expect(r.configured).toBe(false);
    expect(r.identity_complete).toBe(false);
  });

  it("lists ref under missing when unconfigured", () => {
    const r = resolveValidatorImage();
    expect(r.missing).toContain("ref");
  });
});

describe("resolveValidatorImage — fully configured", () => {
  const REF = "registry.example.com/gitwire/validator@sha256:" + "a".repeat(64);
  const DIGEST = "sha256:" + "a".repeat(64);

  beforeEach(() => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  afterEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  it("returns configured=true and identity_complete=true", () => {
    const r = resolveValidatorImage();
    expect(r.configured).toBe(true);
    expect(r.identity_complete).toBe(true);
  });

  it("exposes the ref and digest", () => {
    const r = resolveValidatorImage();
    expect(r.ref).toBe(REF);
    expect(r.digest).toBe(DIGEST);
  });

  it("missing is empty when complete", () => {
    const r = resolveValidatorImage();
    expect(r.missing).toEqual([]);
  });
});

describe("resolveValidatorImage — partial config is NOT identity-complete", () => {
  const REF = "registry.example.com/gitwire/validator@sha256:" + "b".repeat(64);

  beforeEach(() => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  afterEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
  });

  it("configured=true (ref present) but identity_complete=false (digest missing)", () => {
    const r = resolveValidatorImage();
    expect(r.configured).toBe(true);
    expect(r.identity_complete).toBe(false);
    expect(r.missing).toContain("digest");
  });
});

describe("resolveValidatorImage — digest mismatch with ref is rejected", () => {
  const REF = "registry.example.com/gitwire/validator@sha256:" + "c".repeat(64);
  const DIFFERENT_DIGEST = "sha256:" + "d".repeat(64);

  beforeEach(() => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = REF;
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = DIFFERENT_DIGEST;
    delete process.env.GITWIRE_ALLOW_TEST_FIXTURE;
  });

  afterEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  it("identity_complete=false when env digest != ref digest", () => {
    const r = resolveValidatorImage();
    expect(r.identity_complete).toBe(false);
    expect(r.missing).toContain("digest_match");
  });
});

describe("isValidatorIdentityComplete", () => {
  it("true for a complete resolved identity", () => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "r@sha256:" + "e".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "e".repeat(64);
    const r = resolveValidatorImage();
    expect(isValidatorIdentityComplete(r)).toBe(true);
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  it("false for unconfigured", () => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    expect(isValidatorIdentityComplete(resolveValidatorImage())).toBe(false);
  });
});

describe("VALIDATOR_IMAGE_REQUIRED_FIELDS", () => {
  it("lists the immutable-identity fields from the Gap 1 doc", () => {
    expect(VALIDATOR_IMAGE_REQUIRED_FIELDS).toContain("ref");
    expect(VALIDATOR_IMAGE_REQUIRED_FIELDS).toContain("digest");
  });
});
