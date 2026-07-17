// tests/unit/target-policy.test.js
// Network-free tests for the shared stress-isolation policy.
//
// Every test in this file exercises pure string/URL/env logic. None of them
// import `fetch` or make a network call. The isolation contract must be
// verifiable without an isolated stack being online — that is the whole point
// of the contract being self-checking before any traffic is generated.

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
} = TESTING_ONLY;

// ─── env sandbox ───────────────────────────────────────────────────────────

const BASE_ENV = {
  GITWIRE_BASE_URL: "http://iso-test.local:3000",
  API_KEY: "test-key-only",
  GITWIRE_STRESS_ENV: "isolated",
};

let savedEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Wipe every stress-related var so each test starts clean.
  for (const k of [
    "GITWIRE_BASE_URL",
    "API_KEY",
    "GITWIRE_STRESS_ENV",
    "GITWIRE_STRESS_ALLOW_MUTATIONS",
    "GITWIRE_STRESS_FIXTURE_REPO",
    "GITWIRE_STRESS_FIXTURE_INSTALLATION_ID",
    "GITWIRE_STRESS_RUN_ID",
    "GITWIRE_STRESS_MUTATION_BUDGET",
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

// ─── 1. Production hostname rejected ───────────────────────────────────────

describe("production hostname rejection", () => {
  it("rejects gitwire.erlab.uk as a request target at load", () => {
    setEnv({ ...BASE_ENV, GITWIRE_BASE_URL: "https://gitwire.erlab.uk" });
    expect(() => loadPolicy()).toThrow(/known production target/);
  });

  it("rejects a production hostname via assertHostNotProduction", () => {
    expect(() => assertHostNotProduction("gitwire.erlab.uk")).toThrow(/production target/);
  });

  it("accepts an isolated hostname", () => {
    expect(() => assertHostNotProduction("iso-test.local")).not.toThrow();
  });
});

// ─── 2. Production repository rejected ─────────────────────────────────────

describe("production repository rejection", () => {
  it("rejects Elephant-Rock-Lab/GitWire", () => {
    expect(() => assertRepoNotProduction("Elephant-Rock-Lab/GitWire")).toThrow(/production target/);
  });

  it("rejects any repo whose owner is a denylisted org", () => {
    expect(() => assertRepoNotProduction("Elephant-Rock-Lab/Anything")).toThrow(/Organization 'Elephant-Rock-Lab'/);
  });

  it("accepts a fixture repo", () => {
    expect(() => assertRepoNotProduction("fixture-org/fixture-repo")).not.toThrow();
  });
});

// ─── 3. Wrong installation ID rejected ─────────────────────────────────────

describe("production installation ID rejection", () => {
  it("rejects 133349719 whether passed as string or number", () => {
    expect(() => assertInstallationNotProduction("133349719")).toThrow();
    expect(() => assertInstallationNotProduction(133349719)).toThrow();
  });

  it("accepts a fixture installation ID", () => {
    expect(() => assertInstallationNotProduction("999999999")).not.toThrow();
  });
});

// ─── 4. Cross-origin absolute URL rejected ─────────────────────────────────

describe("cross-origin absolute URL rejection", () => {
  const base = parseBaseUrl("http://iso-test.local:3000");

  it("rejects an absolute URL whose origin differs from base", () => {
    expect(() => resolveSameOrigin("https://evil.example.com/x", base)).toThrow(/Cross-origin/);
  });

  it("rejects a same-host different-scheme absolute URL (origin mismatch)", () => {
    // http vs https is a different origin.
    expect(() => resolveSameOrigin("https://iso-test.local/x", base)).toThrow(/Cross-origin/);
  });

  it("accepts a relative path", () => {
    const r = resolveSameOrigin("/api/repos", base);
    expect(r.href).toBe("http://iso-test.local:3000/api/repos");
  });

  it("accepts a same-origin absolute URL", () => {
    const r = resolveSameOrigin("http://iso-test.local:3000/api/repos", base);
    expect(r.href).toBe("http://iso-test.local:3000/api/repos");
  });
});

// ─── 5. Rejected requests never reach fetch ────────────────────────────────
//
// The policy is constructed directly (not via loadPolicy) so we can probe its
// methods without needing the full env. resolveRequest / assertMutationAllowed
// throw synchronously before any fetch could be scheduled by the caller.

describe("rejected requests throw before fetch", () => {
  it("resolveRequest throws on cross-origin, never returns a usable URL silently", () => {
    const policy = new TargetPolicy({
      baseUrl: "http://iso-test.local:3000",
      apiKey: "k",
      isStress: true,
      allowMutations: false,
      fixtureRepo: null,
      fixtureInstallationId: null,
      runId: null,
      budget: null,
    });
    expect(() => policy.resolveRequest("https://evil.example.com/x")).toThrow(/Cross-origin/);
  });
});

// ─── 6. Bearer credentials never constructed for rejected targets ──────────
//
// authHeader() is lazy: it only builds the string when called, and callers
// only call it after resolveRequest + assertMutationAllowed have passed. We
// verify the credential string is never produced as a side effect of a
// rejection by confirming authHeader is a pure function of the apiKey field
// and that the rejection path does not invoke it.

describe("credentials never attached to rejected requests", () => {
  it("authHeader returns the bearer string only from the configured key", () => {
    const policy = new TargetPolicy({
      baseUrl: "http://iso-test.local:3000",
      apiKey: "secret-k",
      isStress: true,
      allowMutations: false,
      fixtureRepo: null,
      fixtureInstallationId: null,
      runId: null,
      budget: null,
    });
    expect(policy.authHeader()).toBe("Bearer secret-k");
  });

  it("a cross-origin rejection does not construct or leak the credential", () => {
    const policy = new TargetPolicy({
      baseUrl: "http://iso-test.local:3000",
      apiKey: "never-leak-me",
      isStress: true,
      allowMutations: false,
      fixtureRepo: null,
      fixtureInstallationId: null,
      runId: null,
      budget: null,
    });
    let threw = false;
    let credentialObserved = false;
    try {
      // The contract: callers resolveRequest THEN build headers via authHeader.
      // If resolveRequest throws, authHeader is never called in api()/apiFetch().
      policy.resolveRequest("https://evil.example.com/x");
    } catch (e) {
      threw = true;
      // Verify the credential does not appear in the rejection message.
      credentialObserved = e.message.includes("never-leak-me");
    }
    expect(threw).toBe(true);
    expect(credentialObserved).toBe(false);
    expect(policy.authHeader()).toBe("Bearer never-leak-me"); // available, but only to same-origin callers
  });
});

// ─── 7. Mutation without explicit opt-in rejected ──────────────────────────

describe("mutation gating", () => {
  it("rejects a POST when GITWIRE_STRESS_ALLOW_MUTATIONS is not true", () => {
    setEnv(BASE_ENV); // no ALLOW_MUTATIONS
    const policy = loadPolicy();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() =>
      policy.assertMutationAllowed({ method: "POST", url })
    ).toThrow(/GITWIRE_STRESS_ALLOW_MUTATIONS=true/);
  });

  it("allows a GET without opt-in", () => {
    setEnv(BASE_ENV);
    const policy = loadPolicy();
    const url = policy.resolveRequest("/api/repos");
    expect(() => policy.assertMutationAllowed({ method: "GET", url })).not.toThrow();
  });
});

// ─── 8. Mutation without fixture identity rejected ─────────────────────────

describe("fixture identity requirement", () => {
  it("rejects mutation opt-in without GITWIRE_STRESS_FIXTURE_REPO", () => {
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true" });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_FIXTURE_REPO/);
  });

  it("rejects mutation opt-in without GITWIRE_STRESS_FIXTURE_INSTALLATION_ID", () => {
    setEnv({
      ...BASE_ENV,
      GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
      GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo",
    });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_FIXTURE_INSTALLATION_ID/);
  });

  it("rejects mutation opt-in without GITWIRE_STRESS_RUN_ID", () => {
    setEnv({
      ...BASE_ENV,
      GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
      GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo",
      GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999",
    });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_RUN_ID/);
  });

  it("rejects mutation opt-in without GITWIRE_STRESS_MUTATION_BUDGET", () => {
    setEnv({
      ...BASE_ENV,
      GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
      GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo",
      GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999",
      GITWIRE_STRESS_RUN_ID: "run-1",
    });
    expect(() => loadPolicy()).toThrow(/GITWIRE_STRESS_MUTATION_BUDGET/);
  });

  it("rejects when the configured fixture repo is itself on the production denylist", () => {
    setEnv({
      ...BASE_ENV,
      GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
      GITWIRE_STRESS_FIXTURE_REPO: "Elephant-Rock-Lab/GitWire",
      GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999",
      GITWIRE_STRESS_RUN_ID: "run-1",
      GITWIRE_STRESS_MUTATION_BUDGET: "10",
    });
    expect(() => loadPolicy()).toThrow(/production target/);
  });
});

// ─── 9. Mutation outside the declared target contract rejected ─────────────

describe("mutation target contract conformance", () => {
  function mutationPolicy() {
    return new TargetPolicy({
      baseUrl: "http://iso-test.local:3000",
      apiKey: "k",
      isStress: true,
      allowMutations: true,
      fixtureRepo: "fixture-org/fixture-repo",
      fixtureInstallationId: "999999999",
      runId: "run-1",
      budget: new MutationBudget(100),
    });
  }

  it("rejects a contract whose body carries a production installation_id (denylist fires first)", () => {
    const policy = mutationPolicy();
    const url = policy.resolveRequest("/api/phase3/reconciler/run");
    const body = { installation_id: 133349719 }; // production ID in body
    const contract = {
      name: "phase3-reconciliation",
      method: "POST",
      path: "/api/phase3/reconciler/run",
      classification: "FIXTURE_MUTATION",
      target: { field: "installationId", location: "body", bodyField: "installation_id" },
    };
    // The denylist check runs before the contract check, so the production
    // installation ID is rejected as a production target. Either rejection is
    // correct; we assert the request never passes.
    expect(() =>
      policy.assertMutationAllowed({ method: "POST", url, body, contract })
    ).toThrow();
  });

  it("rejects a contract whose body carries a non-fixture, non-production installation_id", () => {
    const policy = mutationPolicy();
    const url = policy.resolveRequest("/api/phase3/reconciler/run");
    const body = { installation_id: "555555555" }; // not denylisted, but not the fixture
    const contract = {
      name: "phase3-reconciliation",
      method: "POST",
      classification: "FIXTURE_MUTATION",
      target: { field: "installationId", location: "body", bodyField: "installation_id" },
    };
    expect(() =>
      policy.assertMutationAllowed({ method: "POST", url, body, contract })
    ).toThrow(/not the configured fixture installation/);
  });

  it("rejects a contract whose path targets a different repo", () => {
    const policy = mutationPolicy();
    const url = policy.resolveRequest("/api/repos/Elephant-Rock-Lab/GitWire/sync");
    const contract = {
      name: "repository-sync",
      method: "POST",
      path: "/api/repos/:owner/:repo/sync",
      classification: "FIXTURE_MUTATION",
      target: { field: "repo", location: "path" },
    };
    expect(() =>
      policy.assertMutationAllowed({ method: "POST", url, contract })
    ).toThrow();
  });

  it("accepts a contract whose body carries the fixture installation_id", () => {
    const policy = mutationPolicy();
    const url = policy.resolveRequest("/api/phase3/reconciler/run");
    const body = { installation_id: "999999999" };
    const contract = {
      name: "phase3-reconciliation",
      method: "POST",
      classification: "FIXTURE_MUTATION",
      target: { field: "installationId", location: "body", bodyField: "installation_id" },
    };
    expect(() =>
      policy.assertMutationAllowed({ method: "POST", url, body, contract })
    ).not.toThrow();
  });
});

// ─── 10. Mutation budget exhaustion rejected ───────────────────────────────

describe("mutation budget", () => {
  it("rejects when exceeded", () => {
    const b = new MutationBudget(2);
    b.consume("a");
    b.consume("b");
    expect(() => b.consume("c")).toThrow(/Mutation budget exhausted/);
  });

  it("rejects a non-integer budget", () => {
    expect(() => new MutationBudget(2.5)).toThrow(/non-negative integer/);
    expect(() => new MutationBudget(-1)).toThrow(/non-negative integer/);
  });

  it("budget=0 rejects the first mutation", () => {
    const b = new MutationBudget(0);
    expect(() => b.consume("a")).toThrow(/exhausted/);
  });

  it("the policy consumes the budget per mutation", () => {
    setEnv({
      ...BASE_ENV,
      GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
      GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo",
      GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999",
      GITWIRE_STRESS_RUN_ID: "run-1",
      GITWIRE_STRESS_MUTATION_BUDGET: "1",
    });
    const policy = loadPolicy();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url })).not.toThrow();
    expect(() => policy.assertMutationAllowed({ method: "POST", url })).toThrow(/exhausted/);
  });
});

// ─── 11. Valid same-origin read accepted ───────────────────────────────────

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
  it("loads a mutation policy and permits a fixture-targeted POST", () => {
    setEnv({
      ...BASE_ENV,
      GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
      GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo",
      GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999",
      GITWIRE_STRESS_RUN_ID: "run-1",
      GITWIRE_STRESS_MUTATION_BUDGET: "10",
    });
    const policy = loadPolicy();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url })).not.toThrow();
    expect(policy.budget.remaining()).toBe(9);
  });
});

// ─── Identity extraction helpers (network-free) ────────────────────────────

describe("identity extraction helpers", () => {
  it("extracts owner/repo from a GitHub-style path", () => {
    const u = new URL("http://x/api/repos/fixture-org/fixture-repo/sync");
    expect(extractRepoFromPath(u)).toEqual({ owner: "fixture-org", repo: "fixture-repo" });
  });

  it("extracts installation_id from query", () => {
    const u = new URL("http://x/api/fix/o/r/issues/1?installation_id=123");
    expect(extractInstallationFromQuery(u)).toBe("123");
  });

  it("finds installation_id in a body object", () => {
    expect(findInstallationInBody({ installation_id: 7 })).toBe("7");
    expect(findInstallationInBody({ x: { installation_id: 9 } })).toBe("9");
    expect(findInstallationInBody({ foo: "bar" })).toBeNull();
  });

  it("finds repo references in a body object", () => {
    expect(findRepoInBody({ repo: "o/r" })).toBe("o/r");
    expect(findRepoInBody({ full_name: "o/r" })).toBe("o/r");
    expect(findRepoInBody({ foo: "bar" })).toBeNull();
  });
});

// ─── Stress-gate requirement ───────────────────────────────────────────────

describe("stress gate", () => {
  it("requires GITWIRE_STRESS_ENV=isolated when requireStressGate is true", () => {
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ENV: "production" });
    expect(() => loadPolicy({ requireStressGate: true })).toThrow(/must be 'isolated'/);
  });

  it("does not require the stress gate when requireStressGate is false (benchmark read path)", () => {
    setEnv({ GITWIRE_BASE_URL: BASE_ENV.GITWIRE_BASE_URL, API_KEY: "k", GITWIRE_STRESS_ENV: "production" });
    expect(() => loadPolicy({ requireStressGate: false })).not.toThrow();
  });
});
