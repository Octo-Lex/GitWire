// 421-C unit contract: the watchdog predicate and grace semantics.
// The four certification cases from the frozen objective are pinned here at
// the pure-function level; live workflow_dispatch proofs run the same code
// against the real API (recorded on #421).
import { describe, it, expect } from "@jest/globals";
import {
  evaluate,
  isGenuinePushCiRun,
} from "../../../../scripts/master-push-ci-watchdog.mjs";

const NOW = Date.parse("2026-10-01T15:00:00Z");
const SHA = "705217c2edfd39b3a37391adecfc0fff21642a6a";

const run = (overrides = {}) => ({
  id: 1,
  event: "push",
  head_branch: "master",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  ...overrides,
});

describe("master push-CI watchdog predicate (421-C)", () => {
  it("case 1: a genuine push CI run on the exact head passes", () => {
    const result = evaluate({
      targetSha: SHA,
      headCommitAtMs: NOW - 3600_000,
      nowMs: NOW,
      runs: [run()],
    });
    expect(result.verdict).toBe("pass");
    expect(result.genuine.id).toBe(1);
  });

  it("case 2: no push CI beyond grace fails with the latest-push evidence", () => {
    const result = evaluate({
      targetSha: SHA,
      headCommitAtMs: NOW - 3600_000,
      nowMs: NOW,
      runs: [],
      latestPushRun: run({ id: 42, head_sha: "b997df75".padEnd(40, "0") }),
    });
    expect(result.verdict).toBe("fail");
    expect(result.latestPushRun.id).toBe(42);
  });

  it("case 3: a workflow_dispatch CI run on the SAME SHA never satisfies", () => {
    expect(isGenuinePushCiRun(run({ event: "workflow_dispatch" }), SHA)).toBe(false);
    const result = evaluate({
      targetSha: SHA,
      headCommitAtMs: NOW - 3600_000,
      nowMs: NOW,
      runs: [run({ event: "workflow_dispatch" })],
      latestPushRun: null,
    });
    expect(result.verdict).toBe("fail");
  });

  it("case 4: a successful push CI run on an OLDER SHA never satisfies a newer head", () => {
    const older = run({ id: 7, head_sha: "da4c64f1125423fe8e3e2e7bcd396ba3a06e68a9" });
    expect(isGenuinePushCiRun(older, SHA)).toBe(false);
    const result = evaluate({
      targetSha: SHA,
      headCommitAtMs: NOW - 3600_000,
      nowMs: NOW,
      runs: [older],
      latestPushRun: older,
    });
    expect(result.verdict).toBe("fail");
    expect(result.latestPushRun.head_sha).not.toBe(SHA);
  });

  it("existence is the criterion: queued, running, and failed push runs all prove liveness", () => {
    for (const overrides of [
      { status: "queued", conclusion: null },
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "failure" },
    ]) {
      const result = evaluate({
        targetSha: SHA,
        headCommitAtMs: NOW - 3600_000,
        nowMs: NOW,
        runs: [run(overrides)],
      });
      expect(result.verdict).toBe("pass");
    }
  });

  it("a head inside the grace window with no run yet reports waiting, not failing", () => {
    const result = evaluate({
      targetSha: SHA,
      headCommitAtMs: NOW - 120_000,
      nowMs: NOW,
      runs: [],
      graceSeconds: 600,
    });
    expect(result.verdict).toBe("waiting");
    expect(result.ageSeconds).toBe(120);
  });

  it("non-master push runs (e.g. a branch head) never satisfy", () => {
    expect(isGenuinePushCiRun(run({ head_branch: "421c/watchdog" }), SHA)).toBe(false);
  });
});
