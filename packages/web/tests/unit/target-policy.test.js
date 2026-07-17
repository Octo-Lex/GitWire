// tests/unit/target-policy.test.js
// Network-free tests for the shared stress-isolation policy.
//
// Every test exercises pure string/URL/env logic. None imports fetch or makes
// a network call. The isolation contract must be verifiable without an
// isolated stack being online.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { TESTING_ONLY, loadPolicy } from "../target-policy.js";

const {
  parseBaseUrl,
  assertHostNotProduction,
  assertRepoNotProduction,
  assertInstallationNotProduction,
  resolveSameOrigin,
  extractRepoFromPath,
  extractInstallationFromQuery,
  findInstallationInBody,
  findRepoInBody,
  MutationBudget,
  TargetPolicy,
  canonicalHost,
  canonicalRepo,
  canonicalInstallationId,
} = TESTING_ONLY;

// ─── env sandbox ───────────────────────────────────────────────────────────

const BASE_ENV = {
  GITWIRE_BASE_URL: "http://iso-test.local:3000",
  API_KEY: "test-key-only",
  GITWIRE_STRESS_ENV: "isolated",
};

// A full mutation-enabled env. Tests that need mutations set this then
// override as needed. JEST_WORKER_ID is deliberately UNSET (the policy
// refuses mutations inside a Jest worker); these tests run under Jest, so
// we must explicitly delete it in the sandbox to simulate the benchmark
// process or a --runInBand stress run.
const MUTATION_ENV = {
  ...BASE_ENV,
  GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
  GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo",
  GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999",
  GITWIRE_STRESS_RUN_ID: "run-1",
  GITWIRE_STRESS_MUTATION_BUDGET: "100",
};

let savedEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of [
    "GITWIRE_BASE_URL",
    "API_KEY",
    "GITWIRE_STRESS_ENV",
    "GITWIRE_STRESS_ALLOW_MUTATIONS",
    "GITWIRE_STRESS_FIXTURE_REPO",
    "GITWIRE_STRESS_FIXTURE_INSTALLATION_ID",
    "GITWIRE_STRESS_RUN_ID",
    "GITWIRE_STRESS_MUTATION_BUDGET",
    "JEST_WORKER_ID",
  ]) {
    delete process.env[k];
  }
});

afterEach(() => {
  process.env = savedEnv;
});

function setEnv(obj) {
  process.env = { ...process.env, ...obj };
}

// A policy with mutations enabled and the repo-sync contract registered,
// for tests that exercise the mutation gate directly.
function mutationPolicyWithContracts() {
  const p = new TargetPolicy({
    baseUrl: "http://iso-test.local:3000",
    apiKey: "k",
    isStress: true,
    allowMutations: true,
    fixtureRepo: "fixture-org/fixture-repo",
    fixtureInstallationId: "999999999",
    runId: "run-1",
    budget: new MutationBudget(100),
  });
  p.registerMutationContract({
    name: "repo-sync",
    method: "POST",
    classification: "FIXTURE_MUTATION",
    target: { field: "repo", location: "path" },
  });
  p.registerMutationContract({
    name: "phase3-reconciler-run",
    method: "POST",
    classification: "FIXTURE_MUTATION",
    target: { field: "installationId", location: "body", bodyField: "installation_id" },
  });
  p.registerMutationContract({
    name: "fix-attempt",
    method: "POST",
    classification: "FIXTURE_MUTATION",
    target: { field: "installationId", location: "query" },
  });
  return p;
}

// ─── 1. Production hostname rejected (case-insensitive + alias) ────────────

describe("production hostname rejection", () => {
  it("rejects gitwire.erlab.uk", () => {
    setEnv({ ...BASE_ENV, GITWIRE_BASE_URL: "https://gitwire.erlab.uk" });
    expect(() => loadPolicy()).toThrow(/known production target/);
  });

  it("rejects the production CT LAN IP 192.168.3.151", () => {
    setEnv({ ...BASE_ENV, GITWIRE_BASE_URL: "http://192.168.3.151:3000" });
    expect(() => loadPolicy()).toThrow(/known production target/);
  });

  it("rejects case-variant hostnames (GITWIRE.ERLAB.UK)", () => {
    expect(() => assertHostNotProduction("GITWIRE.ERLAB.UK")).toThrow();
    expect(() => assertHostNotProduction("GitWire.Erlab.UK")).toThrow();
  });

  it("accepts an isolated hostname", () => {
    expect(() => assertHostNotProduction("iso-test.local")).not.toThrow();
  });
});

// ─── 2. Production repository rejected (case-insensitive) ──────────────────

describe("production repository rejection (case-insensitive)", () => {
  it("rejects Elephant-Rock-Lab/GitWire in any case", () => {
    expect(() => assertRepoNotProduction("Elephant-Rock-Lab/GitWire")).toThrow();
    expect(() => assertRepoNotProduction("ELEPHANT-ROCK-LAB/GITWIRE")).toThrow();
    expect(() => assertRepoNotProduction("elephant-rock-lab/gitwire")).toThrow();
    expect(() => assertRepoNotProduction("Elephant-Rock-Lab/gitwire")).toThrow();
  });

  it("rejects any repo whose owner is a denylisted org (case-insensitive)", () => {
    expect(() => assertRepoNotProduction("ELEPHANT-ROCK-LAB/anything")).toThrow();
  });

  it("accepts a fixture repo", () => {
    expect(() => assertRepoNotProduction("fixture-org/fixture-repo")).not.toThrow();
  });
});

// ─── 3. Production installation ID rejected (canonicalized) ────────────────

describe("production installation ID rejection (canonicalized)", () => {
  it("rejects 133349719 as string, number, or leading-zero form", () => {
    expect(() => assertInstallationNotProduction("133349719")).toThrow();
    expect(() => assertInstallationNotProduction(133349719)).toThrow();
    // canonicalInstallationId parses then stringifies, so '0133497719' is NOT
    // the same number — that's correct, leading zeros don't match a different ID.
  });

  it("rejects non-numeric installation IDs (invalid, not silently accepted)", () => {
    expect(() => assertInstallationNotProduction("not-a-number")).toThrow(/not a valid integer/);
  });

  it("accepts a fixture installation ID", () => {
    expect(() => assertInstallationNotProduction("999999999")).not.toThrow();
  });

  it("canonicalInstallationId normalizes integer-then-string", () => {
    expect(canonicalInstallationId("007")).toBe("7");
    expect(canonicalInstallationId(7)).toBe("7");
    expect(canonicalInstallationId("123")).toBe("123");
    expect(canonicalInstallationId(null)).toBeNull();
  });
});

// ─── 4. Cross-origin absolute URL rejected ─────────────────────────────────

describe("cross-origin absolute URL rejection", () => {
  const base = parseBaseUrl("http://iso-test.local:3000");

  it("rejects an external absolute URL", () => {
    expect(() => resolveSameOrigin("https://evil.example.com/x", base)).toThrow(/Cross-origin/);
  });

  it("rejects a different-scheme absolute URL (origin mismatch)", () => {
    expect(() => resolveSameOrigin("https://iso-test.local/x", base)).toThrow(/Cross-origin/);
  });

  it("accepts a relative path and a same-origin absolute URL", () => {
    expect(resolveSameOrigin("/api/repos", base).href).toBe("http://iso-test.local:3000/api/repos");
    expect(resolveSameOrigin("http://iso-test.local:3000/api/repos", base).href)
      .toBe("http://iso-test.local:3000/api/repos");
  });
});

// ─── 5. Rejected requests throw before fetch + never leak credentials ──────

describe("rejection never reaches fetch or constructs credentials", () => {
  it("resolveRequest throws on cross-origin; authHeader is only for same-origin callers", () => {
    const policy = new TargetPolicy({
      baseUrl: "http://iso-test.local:3000", apiKey: "never-leak-me",
      isStress: true, allowMutations: false,
      fixtureRepo: null, fixtureInstallationId: null, runId: null, budget: null,
    });
    let threw = false;
    let leaked = false;
    try {
      policy.resolveRequest("https://evil.example.com/x");
    } catch (e) {
      threw = true;
      leaked = e.message.includes("never-leak-me");
    }
    expect(threw).toBe(true);
    expect(leaked).toBe(false);
    expect(policy.authHeader()).toBe("Bearer never-leak-me");
  });
});

// ─── 6. Mutation without opt-in / fixture identity / budget rejected ───────

describe("mutation opt-in and identity requirements", () => {
  it("rejects a POST when GITWIRE_STRESS_ALLOW_MUTATIONS is not true", () => {
    setEnv(BASE_ENV);
    const policy = loadPolicy();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .toThrow(/GITWIRE_STRESS_ALLOW_MUTATIONS=true/);
  });

  it("rejects mutation opt-in without each required env var", () => {
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true" });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_FIXTURE_REPO/);
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true", GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo" });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_FIXTURE_INSTALLATION_ID/);
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true", GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo", GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999" });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_RUN_ID/);
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true", GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo", GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999", GITWIRE_STRESS_RUN_ID: "r1" });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_MUTATION_BUDGET/);
  });

  it("rejects when the configured fixture repo is itself denylisted", () => {
    setEnv({ ...MUTATION_ENV, GITWIRE_STRESS_FIXTURE_REPO: "Elephant-Rock-Lab/GitWire" });
    expect(() => loadPolicy()).toThrow(/production target/);
  });

  it("rejects mutations inside a Jest worker (budget would be per-process)", () => {
    setEnv({ ...MUTATION_ENV, JEST_WORKER_ID: "1" });
    expect(() => loadPolicy()).toThrow(/not permitted inside a Jest worker/);
  });
});

// ─── 7. Contract required for every mutation (REGRESSION: bypass #1) ───────

describe("contract required for mutations", () => {
  it("rejects a mutation with no contractName", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url }))
      .toThrow(/registered contract name/);
  });

  it("rejects a mutation with an unknown contract name", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "made-up" }))
      .toThrow(/Unknown mutation contract 'made-up'/);
  });

  it("rejects a contract whose method does not match the request", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "PUT", url, contractName: "repo-sync" }))
      .toThrow(/expects method POST, got PUT/);
  });
});

// ─── 8. Missing declared fixture identity rejected (REGRESSION: bypass #2) ─

describe("declared fixture identity must be present (fail-closed)", () => {
  it("rejects a repo-in-path contract when the path carries no repo", () => {
    const policy = mutationPolicyWithContracts();
    // /api/sync has no owner/repo pair — the contract declares repo-in-path.
    const url = policy.resolveRequest("/api/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .toThrow(/declares fixture repo at path but the request carries none|MUST be present/);
  });

  it("rejects an installationId-in-body contract when the body carries none", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/phase3/reconciler/run");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, body: {}, contractName: "phase3-reconciler-run" }))
      .toThrow(/declares fixture installation_id at body but the request carries none|MUST be present/);
  });

  it("rejects an installationId-in-query contract when query carries none", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/fix/o/r/issues/1");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "fix-attempt" }))
      .toThrow(/declares fixture installation_id at query but the request carries none|MUST be present/);
  });
});

// ─── 9. String body rejected for mutations (REGRESSION: bypass #3) ─────────

describe("string mutation bodies rejected", () => {
  it("rejects a POST with a string body", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({
      method: "POST", url, body: '{"installation_id":133349719}', contractName: "repo-sync",
    })).toThrow(/string body is rejected/);
  });
});

// ─── 10. Mutation budget exhaustion rejected ───────────────────────────────

describe("mutation budget", () => {
  it("rejects when exceeded", () => {
    const b = new MutationBudget(2);
    b.consume("a"); b.consume("b");
    expect(() => b.consume("c")).toThrow(/exhausted/);
  });

  it("rejects non-integer / negative budgets", () => {
    expect(() => new MutationBudget(2.5)).toThrow();
    expect(() => new MutationBudget(-1)).toThrow();
  });

  it("budget=0 rejects the first mutation", () => {
    expect(() => new MutationBudget(0).consume("a")).toThrow(/exhausted/);
  });
});

// ─── 11. Valid reads accepted ──────────────────────────────────────────────

describe("valid reads accepted", () => {
  it("loads a read-only policy and resolves a read path", () => {
    setEnv(BASE_ENV);
    const policy = loadPolicy();
    const url = policy.resolveRequest("/api/repos");
    expect(url.href).toBe("http://iso-test.local:3000/api/repos");
    expect(() => policy.assertMutationAllowed({ method: "GET", url })).not.toThrow();
  });
});

// ─── 12. Valid allowlisted fixture mutation accepted ───────────────────────

describe("valid fixture mutation accepted", () => {
  it("permits a fixture-targeted repo-sync POST and consumes budget", () => {
    setEnv(MUTATION_ENV);
    const policy = loadPolicy();
    policy.registerMutationContract({
      name: "repo-sync", method: "POST", classification: "FIXTURE_MUTATION",
      target: { field: "repo", location: "path" },
    });
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .not.toThrow();
    expect(policy.budget.remaining()).toBe(99);
  });

  it("permits an installationId-in-body mutation when body carries the fixture id", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/phase3/reconciler/run");
    expect(() => policy.assertMutationAllowed({
      method: "POST", url, body: { installation_id: "999999999" }, contractName: "phase3-reconciler-run",
    })).not.toThrow();
  });

  it("permits an installationId-in-query mutation when query carries the fixture id", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/fix/fixture-org/fixture-repo/issues/1?installation_id=999999999");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "fix-attempt" }))
      .not.toThrow();
  });
});

// ─── Identity extraction helpers ───────────────────────────────────────────

describe("identity extraction helpers", () => {
  it("extracts owner/repo from a GitHub-style path", () => {
    const u = new URL("http://x/api/repos/fixture-org/fixture-repo/sync");
    expect(extractRepoFromPath(u)).toEqual({ owner: "fixture-org", repo: "fixture-repo" });
  });

  it("extracts installation_id from query and body", () => {
    expect(extractInstallationFromQuery(new URL("http://x/api/fix/o/r/issues/1?installation_id=123"))).toBe("123");
    expect(findInstallationInBody({ installation_id: 7 })).toBe("7");
    expect(findInstallationInBody({ x: { installation_id: 9 } })).toBe("9");
  });

  it("finds repo references in a body object", () => {
    expect(findRepoInBody({ repo: "o/r" })).toBe("o/r");
    expect(findRepoInBody({ foo: "bar" })).toBeNull();
  });
});

// ─── Canonicalization helpers ──────────────────────────────────────────────

describe("canonicalization helpers", () => {
  it("canonicalHost lowercases", () => {
    expect(canonicalHost("GitWire.Erlab.UK")).toBe("gitwire.erlab.uk");
  });
  it("canonicalRepo lowercases owner/repo", () => {
    expect(canonicalRepo("OWNER/REPO")).toBe("owner/repo");
  });
});

// ─── Contract registry validation ──────────────────────────────────────────

describe("contract registry", () => {
  it("rejects duplicate contract names", () => {
    const p = mutationPolicyWithContracts();
    expect(() => p.registerMutationContract({
      name: "repo-sync", method: "POST", classification: "FIXTURE_MUTATION",
      target: { field: "repo", location: "path" },
    })).toThrow(/already registered/);
  });

  it("rejects contracts with non-FIXTURE_MUTATION classification", () => {
    const p = mutationPolicyWithContracts();
    expect(() => p.registerMutationContract({
      name: "bad", method: "POST", classification: "DESTRUCTIVE_CHAOS",
      target: { field: "repo", location: "path" },
    })).toThrow(/must be 'FIXTURE_MUTATION'/);
  });

  it("rejects contracts with missing target.field or target.location", () => {
    const p = mutationPolicyWithContracts();
    expect(() => p.registerMutationContract({
      name: "bad2", method: "POST", classification: "FIXTURE_MUTATION", target: { field: "repo" },
    })).toThrow(/target.field and target.location/);
  });
});
