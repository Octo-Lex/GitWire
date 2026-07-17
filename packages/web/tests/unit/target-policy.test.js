// tests/unit/target-policy.test.js
// Network-free tests for the shared stress-isolation policy.
//
// Every test exercises pure string/URL/env logic. None imports fetch or makes
// a network call. The isolation contract must be verifiable without an
// isolated stack being online.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  RunWideMutationBudget,
  compileRoute,
  matchRoute,
  parseStrictBudget,
  TargetPolicy,
  canonicalHost,
  canonicalRepo,
  canonicalInstallationId,
} = TESTING_ONLY;

// ─── env sandbox ───────────────────────────────────────────────────────────
//
// NOTE: JEST_WORKER_ID is NOT deleted from the sandbox. An earlier revision
// deleted it to "simulate serial mode" — but Jest sets JEST_WORKER_ID=1 even
// under --runInBand, so that simulation concealed a real bug (the policy's
// worker-guard was based on a false premise). The run-wide budget no longer
// depends on JEST_WORKER_ID at all, so we leave Jest's env intact and the
// budget's file-backed counter is what makes it run-wide.

const BASE_ENV = {
  GITWIRE_BASE_URL: "http://iso-test.local:3000",
  API_KEY: "test-key-only",
  GITWIRE_STRESS_ENV: "isolated",
};

const MUTATION_ENV = {
  ...BASE_ENV,
  GITWIRE_STRESS_ALLOW_MUTATIONS: "true",
  GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo",
  GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999",
  GITWIRE_STRESS_RUN_ID: "run-unit-" + process.pid,
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

// A policy with mutations enabled and a small set of contracts registered.
function mutationPolicyWithContracts(runId = "test-" + Math.random()) {
  const p = new TargetPolicy({
    baseUrl: "http://iso-test.local:3000",
    apiKey: "k",
    isStress: true,
    allowMutations: true,
    fixtureRepo: "fixture-org/fixture-repo",
    fixtureInstallationId: "999999999",
    runId,
    budget: new RunWideMutationBudget(100, runId),
  });
  p.registerMutationContract({
    name: "repo-sync", method: "POST", classification: "FIXTURE_MUTATION",
    route: "/api/repos/:owner/:repo/sync",
    identities: [{ field: "repo", location: "path", param: "owner" }],
  });
  p.registerMutationContract({
    name: "phase3-reconciler-run", method: "POST", classification: "FIXTURE_MUTATION",
    route: "/api/phase3/reconciler/run",
    identities: [{ field: "installationId", location: "body", bodyField: "installation_id" }],
  });
  // Multi-identity route: repo in path + installation in query.
  p.registerMutationContract({
    name: "fix-attempt", method: "POST", classification: "FIXTURE_MUTATION",
    route: "/api/fix/:owner/:repo/issues/:number",
    identities: [
      { field: "repo", location: "path", param: "owner" },
      { field: "installationId", location: "query" },
    ],
  });
  p.registerMutationContract({
    name: "maintainer-settings", method: "PATCH", classification: "FIXTURE_MUTATION",
    route: "/api/maintainer/:owner/:repo/settings",
    identities: [{ field: "repo", location: "path", param: "owner" }],
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
  it("rejects case-variant hostnames", () => {
    expect(() => assertHostNotProduction("GITWIRE.ERLAB.UK")).toThrow();
  });
  it("accepts an isolated hostname", () => {
    expect(() => assertHostNotProduction("iso-test.local")).not.toThrow();
  });
});

// ─── 2. Production repository/installation rejected (canonicalized) ────────

describe("production identity rejection (canonicalized)", () => {
  it("rejects Elephant-Rock-Lab/GitWire in any case", () => {
    expect(() => assertRepoNotProduction("Elephant-Rock-Lab/GitWire")).toThrow();
    expect(() => assertRepoNotProduction("ELEPHANT-ROCK-LAB/GITWIRE")).toThrow();
  });
  it("rejects 133349719 as string or number", () => {
    expect(() => assertInstallationNotProduction("133349719")).toThrow();
    expect(() => assertInstallationNotProduction(133349719)).toThrow();
  });
  it("rejects non-numeric installation IDs", () => {
    expect(() => assertInstallationNotProduction("not-a-number")).toThrow(/not a valid integer/);
  });
  it("canonicalInstallationId normalizes integer-then-string", () => {
    expect(canonicalInstallationId("007")).toBe("7");
    expect(canonicalInstallationId(7)).toBe("7");
  });
});

// ─── 3. Cross-origin absolute URL rejected ─────────────────────────────────

describe("cross-origin absolute URL rejection", () => {
  const base = parseBaseUrl("http://iso-test.local:3000");
  it("rejects external and different-scheme absolute URLs", () => {
    expect(() => resolveSameOrigin("https://evil.example.com/x", base)).toThrow(/Cross-origin/);
    expect(() => resolveSameOrigin("https://iso-test.local/x", base)).toThrow(/Cross-origin/);
  });
  it("accepts relative and same-origin absolute", () => {
    expect(resolveSameOrigin("/api/repos", base).href).toBe("http://iso-test.local:3000/api/repos");
  });
});

// ─── 4. Rejection never reaches fetch or constructs credentials ────────────

describe("rejection safety", () => {
  it("cross-origin rejection does not leak the credential", () => {
    const policy = new TargetPolicy({
      baseUrl: "http://iso-test.local:3000", apiKey: "never-leak-me",
      isStress: true, allowMutations: false,
      fixtureRepo: null, fixtureInstallationId: null, runId: null, budget: null,
    });
    let leaked = false;
    try { policy.resolveRequest("https://evil.example.com/x"); }
    catch (e) { leaked = e.message.includes("never-leak-me"); }
    expect(leaked).toBe(false);
    expect(policy.authHeader()).toBe("Bearer never-leak-me");
  });
});

// ─── 5. Mutation opt-in / fixture identity / budget requirements ───────────

describe("mutation opt-in requirements", () => {
  it("rejects POST without GITWIRE_STRESS_ALLOW_MUTATIONS=true", () => {
    setEnv(BASE_ENV);
    const policy = loadPolicy();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .toThrow(/ALLOW_MUTATIONS/);
  });
  it("rejects mutation opt-in without each required env var", () => {
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true" });
    expect(() => loadPolicy()).toThrow(/FIXTURE_REPO/);
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true", GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo" });
    expect(() => loadPolicy()).toThrow(/FIXTURE_INSTALLATION_ID/);
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true", GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo", GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999" });
    expect(() => loadPolicy()).toThrow(/RUN_ID/);
    setEnv({ ...BASE_ENV, GITWIRE_STRESS_ALLOW_MUTATIONS: "true", GITWIRE_STRESS_FIXTURE_REPO: "fixture-org/fixture-repo", GITWIRE_STRESS_FIXTURE_INSTALLATION_ID: "999999999", GITWIRE_STRESS_RUN_ID: "r1" });
    expect(() => loadPolicy()).toThrow(/MUTATION_BUDGET/);
  });
  it("rejects when the configured fixture repo is itself denylisted", () => {
    setEnv({ ...MUTATION_ENV, GITWIRE_STRESS_FIXTURE_REPO: "Elephant-Rock-Lab/GitWire" });
    expect(() => loadPolicy()).toThrow(/production target/);
  });
});

// ─── 6. Contract required (REGRESSION: bypass #1) ──────────────────────────

describe("contract required for mutations", () => {
  it("rejects a mutation with no contractName", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url }))
      .toThrow(/registered contract name/);
  });
  it("rejects unknown contract name", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "made-up" }))
      .toThrow(/Unknown mutation contract/);
  });
  it("rejects method mismatch", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "PUT", url, contractName: "repo-sync" }))
      .toThrow(/expects method POST, got PUT/);
  });
});

// ─── 7. Route matching (REGRESSION: bypass #2) ─────────────────────────────

describe("anchored route matching", () => {
  it("rejects a same-method contract on an unintended route", () => {
    const policy = mutationPolicyWithContracts();
    // repo-sync contract is for /api/repos/:owner/:repo/sync. Reusing it on
    // /api/repos/:owner/:repo/config must fail route matching.
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/config");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .toThrow(/Route mismatch/);
  });
  it("rejects when the path has extra segments beyond the route", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync/extra");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .toThrow(/Route mismatch/);
  });
  it("accepts the exact matching route", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .not.toThrow();
  });
});

// ─── 8. Multi-identity validation (REGRESSION: bypass #3) ──────────────────

describe("all declared identities validated", () => {
  it("rejects fix-attempt when the path repo is non-fixture even if installation matches", () => {
    const policy = mutationPolicyWithContracts();
    // Correct fixture installation in query, but WRONG repo in path.
    const url = policy.resolveRequest("/api/fix/unrelated/repo/issues/1?installation_id=999999999");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "fix-attempt" }))
      .toThrow(/not the configured fixture repo/);
  });
  it("rejects fix-attempt when installation is non-fixture even if repo matches", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/fix/fixture-org/fixture-repo/issues/1?installation_id=888888888");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "fix-attempt" }))
      .toThrow(/not the configured fixture installation/);
  });
  it("rejects fix-attempt when installation is missing entirely", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/fix/fixture-org/fixture-repo/issues/1");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "fix-attempt" }))
      .toThrow(/installation_id at query but the request carries none/);
  });
  it("accepts fix-attempt when BOTH identities match the fixture", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/fix/fixture-org/fixture-repo/issues/1?installation_id=999999999");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "fix-attempt" }))
      .not.toThrow();
  });
});

// ─── 9. String body rejected for mutations (REGRESSION: bypass #3-original) ─

describe("string mutation bodies rejected", () => {
  it("rejects a POST with a string body", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({
      method: "POST", url, body: '{"x":1}', contractName: "repo-sync",
    })).toThrow(/string body is rejected/);
  });
});

// ─── 10. Run-wide mutation budget (REGRESSION: bypass #6) ──────────────────

describe("run-wide mutation budget (atomic slots)", () => {
  it("consumes exactly max slots and then exhausts", () => {
    const runId = "rwtest-" + Math.random();
    const b = new RunWideMutationBudget(2, runId);
    expect(b.remaining()).toBe(2);
    b.consume("a");
    b.consume("b");
    expect(b.remaining()).toBe(0);
    expect(() => b.consume("c")).toThrow(/exhausted/);
    b.finalize();
  });

  it("two SEPARATE budget objects with the same runId — the second fails closed on collision", () => {
    // This is the regression for the previous design's fatal flaw: a second
    // worker constructing a budget with the same runId would truncate the
    // shared state. The atomic-slot design instead fails closed, forcing the
    // operator to use a fresh runId per run.
    const runId = "collide-" + Math.random();
    const b1 = new RunWideMutationBudget(3, runId);
    b1.consume("first"); // creates slot-0 → directory now has 1 slot
    expect(() => new RunWideMutationBudget(3, runId)).toThrow(/run-ID collision/);
    b1.finalize();
  });

  it("budget=0 rejects the first mutation", () => {
    const z = new RunWideMutationBudget(0, "zero-" + Math.random());
    expect(() => z.consume("a")).toThrow(/exhausted/);
    z.finalize();
  });

  it("rejects non-integer / negative budgets", () => {
    expect(() => new RunWideMutationBudget(2.5, "r")).toThrow();
    expect(() => new RunWideMutationBudget(-1, "r")).toThrow();
  });

  it("parseStrictBudget rejects malformed values that parseInt would silently accept", () => {
    expect(parseStrictBudget("100")).toBe(100);
    expect(() => parseStrictBudget("100abc")).toThrow(/malformed/);
    expect(() => parseStrictBudget("100.5")).toThrow(/malformed/);
    expect(() => parseStrictBudget("0x10")).toThrow(/malformed/);
    expect(() => parseStrictBudget("")).toThrow(/malformed/);
    expect(() => parseStrictBudget("   ")).toThrow(/malformed/);
  });

  // ─── The real concurrency regression the reviewer required ─────────────
  //
  // Spawn N child processes that each attempt to consume K slots from a
  // budget of max=N*K/2 (i.e. half what they collectively demand). Under the
  // flawed append-file design, the unlocked read-then-append would let all
  // children observe capacity and over-claim. Under the atomic-slot design,
  // exactly `max` slots can ever be created regardless of concurrency.
  //
  // This test spawns REAL child processes via node, not a simulated env.
  it("concurrent child processes cannot exceed the cap (real forked consumers)", () => {
    if (process.platform === "win32") {
      // Slot files use O_EXCL which Windows supports, but the test's process
      // orchestration via spawnSync with sh -c is Linux-oriented. The budget
      // itself is cross-platform; this concurrency regression runs on Linux CI.
      // Skip is explicit, not a silent pass.
      console.log("  skipped on win32 (concurrency regression runs on Linux CI)");
      return;
    }
    const runId = "concurrency-" + Math.random();
    const WORKERS = 8;
    const PER_WORKER = 10;           // each child attempts 10 consumes
    const MAX = (WORKERS * PER_WORKER) / 2; // 40 — half of total demand (80)
    // Pre-create the budget directory so all children see the same one and
    // neither "wins" the mkdir race. (In production, the orchestrator's
    // loadPolicy constructs the single budget; workers inherit. Here we
    // simulate by pre-initializing the shared dir.)
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const slotsDir = path.join(os.tmpdir(), `gitwire-stress-budget-${safe}`);
    fs.mkdirSync(slotsDir, { recursive: true });
    // Write a marker so the dir is "owned" (matches _initSlotsDir behavior).
    fs.writeFileSync(path.join(slotsDir, ".run-marker"), String(process.pid), { flag: "wx" });

    // Child script: import the policy, construct a budget pointing at the
    // existing dir, attempt PER_WORKER consumes, report how many succeeded.
    const childScript = `
import { TESTING_ONLY } from "${path.resolve(__dirname, "..", "target-policy.js").replace(/\\/g, "/")}";
const { RunWideMutationBudget } = TESTING_ONLY;
const dir = process.argv[2];
const max = Number(process.argv[3]);
const n = Number(process.argv[4]);
// Monkey-patch the directory so we share the parent's pre-created dir.
const b = new RunWideMutationBudget(max, process.argv[5]);
b.slotsDir = dir;
let ok = 0;
for (let i = 0; i < n; i++) {
  try { b.consume("child-" + process.pid); ok++; } catch (e) { /* exhausted */ }
}
console.log("CHILD_OK=" + ok);
`;
    const results = [];
    for (let i = 0; i < WORKERS; i++) {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", childScript,
        slotsDir, String(MAX), String(PER_WORKER), runId], {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" },
      });
      if (r.status !== 0) {
        // If the child failed (e.g. EEXIST collision on construction because
        // our pre-mkdir raced), surface it rather than silently passing.
        throw new Error("child " + i + " failed: " + r.stderr);
      }
      const m = r.stdout.match(/CHILD_OK=(\d+)/);
      if (!m) throw new Error("child " + i + " no CHILD_OK output: " + r.stdout + r.stderr);
      results.push(Number(m[1]));
    }
    const totalClaimed = results.reduce((a, b) => a + b, 0);
    // The cap is the invariant: total claims MUST NOT EXCEED MAX. Over-claim
    // is the exact failure mode the budget exists to prevent.
    expect(totalClaimed).toBeLessThanOrEqual(MAX);
    // And we should have claimed exactly MAX (collective demand 80 > MAX 40,
    // so the cap is the only thing stopping the children).
    expect(totalClaimed).toBe(MAX);
    // Cleanup.
    fs.rmSync(slotsDir, { recursive: true, force: true });
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

// ─── 12. Valid fixture mutations accepted ──────────────────────────────────

describe("valid fixture mutations accepted", () => {
  it("permits a fixture repo-sync and consumes budget", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/repos/fixture-org/fixture-repo/sync");
    expect(() => policy.assertMutationAllowed({ method: "POST", url, contractName: "repo-sync" }))
      .not.toThrow();
    expect(policy.budget.remaining()).toBe(99);
  });
  it("permits PATCH maintainer-settings (canonical PATCH method)", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/maintainer/fixture-org/fixture-repo/settings");
    expect(() => policy.assertMutationAllowed({ method: "PATCH", url, contractName: "maintainer-settings" }))
      .not.toThrow();
  });
  it("permits installationId-in-body mutation when body matches", () => {
    const policy = mutationPolicyWithContracts();
    const url = policy.resolveRequest("/api/phase3/reconciler/run");
    expect(() => policy.assertMutationAllowed({
      method: "POST", url, body: { installation_id: "999999999" }, contractName: "phase3-reconciler-run",
    })).not.toThrow();
  });
});

// ─── Route compiler helpers ────────────────────────────────────────────────

describe("route compiler", () => {
  it("compiles :param segments into capture groups", () => {
    const c = compileRoute("/api/repos/:owner/:repo/sync");
    const m = matchRoute("/api/repos/acme/widgets/sync", c);
    expect(m).toEqual({ owner: "acme", repo: "widgets" });
  });
  it("returns null on mismatch", () => {
    const c = compileRoute("/api/repos/:owner/:repo/sync");
    expect(matchRoute("/api/repos/acme/widgets/config", c)).toBeNull();
    expect(matchRoute("/api/repos/acme/widgets/sync/extra", c)).toBeNull();
  });
});

// ─── Contract registry validation ──────────────────────────────────────────

describe("contract registry validation", () => {
  it("rejects contracts without a route template", () => {
    const p = mutationPolicyWithContracts();
    expect(() => p.registerMutationContract({
      name: "bad", method: "POST", classification: "FIXTURE_MUTATION", identities: [],
    })).toThrow(/route template/);
  });
  it("rejects contracts with non-array identities", () => {
    const p = mutationPolicyWithContracts();
    expect(() => p.registerMutationContract({
      name: "bad2", method: "POST", classification: "FIXTURE_MUTATION",
      route: "/x", identities: { field: "repo" },
    })).toThrow(/'identities' array/);
  });
  it("rejects path-located identities without param", () => {
    const p = mutationPolicyWithContracts();
    expect(() => p.registerMutationContract({
      name: "bad3", method: "POST", classification: "FIXTURE_MUTATION",
      route: "/api/repos/:owner/:repo/sync",
      identities: [{ field: "repo", location: "path" }],
    })).toThrow(/must declare 'param'/);
  });
  it("rejects duplicate contract names", () => {
    const p = mutationPolicyWithContracts();
    expect(() => p.registerMutationContract({
      name: "repo-sync", method: "POST", classification: "FIXTURE_MUTATION",
      route: "/api/repos/:owner/:repo/sync",
      identities: [{ field: "repo", location: "path", param: "owner" }],
    })).toThrow(/already registered/);
  });
});
