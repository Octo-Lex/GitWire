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
import { fileURLToPath } from "node:url";
import { TESTING_ONLY, loadPolicy } from "../target-policy.js";

// ESM does not define __dirname. Derive it once from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  sanitizeRunId,
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
  it("owner initializes, consumes exactly max slots, then exhausts", () => {
    const runId = "rwtest-" + Math.random();
    const b = new RunWideMutationBudget(2, runId);
    expect(b.role()).toBe("owner");
    expect(b.remaining()).toBe(2);
    b.consume("a");
    b.consume("b");
    expect(b.remaining()).toBe(0);
    expect(() => b.consume("c")).toThrow(/exhausted/);
    b.finalize();
    b.purge();
  });

  it("participant can ATTACH after slots already exist (the run-wide property)", () => {
    // The round-3 design rejected any second constructor as a 'collision'.
    // The fix: a second constructor with matching metadata ATTACHES and
    // shares the existing slots directory, even when slots already exist.
    const runId = "attach-" + Math.random();
    const meta = { fixtureRepo: "fixture-org/fixture-repo", fixtureInstallationId: "999999999" };
    const owner = new RunWideMutationBudget(5, runId, meta);
    expect(owner.role()).toBe("owner");
    owner.consume("first");   // slot-0 now exists
    owner.consume("second");  // slot-1 now exists

    const participant = new RunWideMutationBudget(5, runId, meta);
    expect(participant.role()).toBe("participant");
    expect(participant.remaining()).toBe(3); // 5 - 2 already claimed
    participant.consume("third"); // participant claims slot-2 in the shared dir
    expect(owner.remaining()).toBe(2); // owner sees the participant's claim

    owner.finalize();
    owner.purge();
  });

  it("participant with mismatched fixture metadata is rejected", () => {
    const runId = "mismatch-" + Math.random();
    const meta1 = { fixtureRepo: "fixture-org/fixture-repo", fixtureInstallationId: "999999999" };
    const owner = new RunWideMutationBudget(3, runId, meta1);
    const meta2 = { fixtureRepo: "OTHER/repo", fixtureInstallationId: "999999999" };
    expect(() => new RunWideMutationBudget(3, runId, meta2)).toThrow(/fixture-repo mismatch/);
    owner.finalize();
    owner.purge();
  });

  it("participant with a different max is rejected", () => {
    const runId = "maxmatch-" + Math.random();
    const meta = { fixtureRepo: "f/r", fixtureInstallationId: "1" };
    const owner = new RunWideMutationBudget(5, runId, meta);
    expect(() => new RunWideMutationBudget(10, runId, meta)).toThrow(/max mismatch/);
    owner.finalize();
    owner.purge();
  });

  it("stale (finalized) namespace reuse fails closed", () => {
    const runId = "stale-" + Math.random();
    const meta = { fixtureRepo: "f/r", fixtureInstallationId: "1" };
    const owner = new RunWideMutationBudget(3, runId, meta);
    owner.consume("a");
    owner.finalize();
    expect(() => new RunWideMutationBudget(3, runId, meta)).toThrow(/marked .finalized/);
    owner.purge();
  });

  it("distinct raw run IDs that sanitize to the same dir fail closed (collision)", () => {
    // Two raw runIds that both sanitize to the same token. We embed a unique
    // suffix so this test never collides with a leftover from a prior run.
    const uniq = Math.random().toString(36).slice(2);
    const rawA = `collide ${uniq}`;   // space → _
    const rawB = `collide+${uniq}`;   // + → _
    // Both sanitize to 'collide_<uniq>'.
    expect(sanitizeRunId(rawA)).toBe(sanitizeRunId(rawB));
    const meta = { fixtureRepo: "f/r", fixtureInstallationId: "1" };
    const owner = new RunWideMutationBudget(3, rawA, meta);
    expect(() => new RunWideMutationBudget(3, rawB, meta)).toThrow(/run-ID collision/);
    owner.finalize();
    owner.purge();
  });

  it("budget=0 rejects the first mutation", () => {
    const z = new RunWideMutationBudget(0, "zero-" + Math.random());
    expect(() => z.consume("a")).toThrow(/exhausted/);
    z.finalize();
    z.purge();
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

  // ─── The real concurrent regression the reviewer required ──────────────
  //
  // Spawns N child processes that all WAIT on a stdin barrier, then releases
  // them simultaneously so they genuinely contend on O_EXCL slot creation.
  // Children use the PUBLIC budget API (no internal-path monkey-patching),
  // receive a single JSON argv, and report both their claim count and role.
  //
  // This replaces the round-3 regression which (a) ran sequentially via
  // spawnSync, (b) monkey-patched b.slotsDir, and (c) had shifted argv
  // indices that made every child report CHILD_OK=0, trivially satisfying
  // the ≤ MAX assertion while proving nothing.
  // The concurrency regression runs on Linux CI. On win32 it is genuinely
  // SKIPPED via it.skip (not a silent in-body return that Jest counts as a
  // pass). This is the only platform-conditional test in the file.
  const concurrentTest = process.platform === "win32"
    ? it.skip
    : it;
  concurrentTest("concurrent child processes cannot exceed the cap (genuine parallel contention)", async () => {
    const { spawn } = await import("node:child_process");
    const runId = "concurrency-" + Math.random();
    const WORKERS = 8;
    const PER_WORKER = 10;
    const MAX = (WORKERS * PER_WORKER) / 2; // 40 — half of total demand (80)
    const meta = { fixtureRepo: "fixture-org/fixture-repo", fixtureInstallationId: "999999999" };

    const childPath = path.resolve(__dirname, "..", "fixtures", "budget-child.mjs");
    const cfg = {
      max: MAX,
      runId,
      perWorker: PER_WORKER,
      fixtureRepo: meta.fixtureRepo,
      fixtureInstallationId: meta.fixtureInstallationId,
    };

    // Spawn all children PAUSED (they block on stdin). stdio: pipe so we can
    // write the release byte; the child reads one byte then proceeds.
    const children = [];
    for (let i = 0; i < WORKERS; i++) {
      const child = spawn(process.execPath, [
        // The child is a .mjs file — Node treats .mjs as a module by
        // extension, so --input-type=module must NOT be passed (node rejects
        // --input-type when executing a file rather than eval/stdin).
        childPath,
        JSON.stringify(cfg),
      ], {
        env: { ...process.env, NODE_OPTIONS: "--experimental-vm-modules" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const done = new Promise((resolve) => child.on("close", () => resolve({ stdout, stderr })));
      children.push({ child, done: done.then((r) => ({ ...r, i })) });
    }

    // Release the barrier simultaneously. A tiny tick lets each child's
    // stdin handler install before we write.
    await new Promise((r) => setTimeout(r, 50));
    for (const { child } of children) {
      child.stdin.write("go\n");
      child.stdin.end();
    }

    const results = await Promise.all(children.map((c) => c.done));
    // Surface any child errors rather than silently passing.
    for (const r of results) {
      if (r.stderr && r.stderr.trim()) {
        throw new Error(`child ${r.i} stderr: ${r.stderr}`);
      }
    }

    // Parse claim counts and roles.
    let totalClaimed = 0;
    const roles = { owner: 0, participant: 0 };
    for (const r of results) {
      const okMatch = r.stdout.match(/CHILD_OK=(\d+)/);
      const roleMatch = r.stdout.match(/ROLE=(\w+)/);
      if (!okMatch) {
        throw new Error(`child ${r.i} produced no CHILD_OK: stdout=${JSON.stringify(r.stdout)}`);
      }
      totalClaimed += Number(okMatch[1]);
      if (roleMatch) roles[roleMatch[1]] = (roles[roleMatch[1]] || 0) + 1;
    }

    // INVARIANT 1: exactly MAX claims — never more. Over-claim is the failure
    // mode the budget exists to prevent.
    expect(totalClaimed).toBeLessThanOrEqual(MAX);
    expect(totalClaimed).toBe(MAX);

    // INVARIANT 2: contention actually happened. Exactly one owner won the
    // marker; the rest attached. If roles.owner === WORKERS, no contention
    // occurred and the test proved nothing (the round-3 failure mode).
    expect(roles.owner).toBe(1);
    expect(roles.participant).toBe(WORKERS - 1);

    // Cleanup. The owner's directory — purge it.
    const safe = sanitizeRunId(runId);
    const slotsDir = path.join(os.tmpdir(), `gitwire-stress-budget-${safe}`);
    fs.rmSync(slotsDir, { recursive: true, force: true });
  }, 30000);
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
