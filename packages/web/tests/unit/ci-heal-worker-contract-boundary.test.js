// D0-01 — CI-heal jobs are validated again at the worker-consumer boundary.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const captured = [];
const runtimeCreateWorker = jest.fn((name, processor, opts) => {
  const worker = { name, processor, opts };
  captured.push(worker);
  return worker;
});

const queues = {
  WEBHOOK_EVENTS: "webhook-events",
  TRIAGE: "triage",
  CI_HEALING: "ci-healing",
  CI_EVIDENCE: "ci-evidence",
  DIAGNOSIS: "diagnosis",
  PATCH: "patch",
  VERIFICATION: "verification",
  CRITIC: "critic",
  SYNC: "sync",
  MAINTAINER: "maintainer",
  ISSUE_FIX: "issue-fix",
  PHASE2: "phase2",
  PHASE3: "phase3",
  PHASE4: "phase4",
};

jest.unstable_mockModule("@gitwire/runtime/compat/queue", () => ({
  redis: {},
  QUEUES: queues,
  createQueue: jest.fn(),
  createWorker: runtimeCreateWorker,
  webhookQueue: {},
  triageQueue: {},
  ciHealQueue: {},
  ciEvidenceQueue: {},
  diagnosisQueue: {},
  patchQueue: {},
  verificationQueue: {},
  criticQueue: {},
  syncQueue: {},
  maintainerQueue: {},
  issueFixQueue: {},
  phase2Queue: {},
  phase3Queue: {},
  phase4Queue: {},
}));

const { createWorker, QUEUES } = await import("../../src/lib/queue.js");
const { InvalidCIHealJobError } = await import("../../src/services/ciHealJobService.js");

function validHealJob() {
  return {
    schema_version: 1,
    eventName: "workflow_run",
    payload: {
      action: "completed",
      workflow_run: {
        id: 30123456789,
        status: "completed",
        conclusion: "failure",
        head_branch: "main",
        head_sha: "0123456789abcdef0123456789abcdef01234567",
      },
      repository: {
        id: "123456",
        full_name: "owner/repo",
        name: "repo",
        owner: { login: "owner" },
      },
      installation: { id: "987654" },
    },
    trigger: { kind: "manual_api", requested_at: "2026-09-23T12:00:00.000Z" },
    receivedAt: Date.parse("2026-09-23T12:00:00.000Z"),
  };
}

beforeEach(() => {
  runtimeCreateWorker.mockClear();
  captured.length = 0;
});

describe("CI-heal worker consumer contract", () => {
  it("validates a heal-run before invoking the downstream processor", async () => {
    const downstream = jest.fn(async () => "ok");
    const worker = createWorker(QUEUES.CI_HEALING, downstream, { concurrency: 1 });
    const job = { name: "heal-run", data: validHealJob() };

    await expect(worker.processor(job)).resolves.toBe("ok");

    expect(downstream).toHaveBeenCalledTimes(1);
    expect(downstream).toHaveBeenCalledWith(job);
    expect(job.data).toEqual(validHealJob());
    expect(runtimeCreateWorker).toHaveBeenCalledWith(
      QUEUES.CI_HEALING,
      expect.any(Function),
      { concurrency: 1 },
    );
  });

  it("fails the BullMQ job visibly when a heal-run is malformed", async () => {
    const downstream = jest.fn();
    const worker = createWorker(QUEUES.CI_HEALING, downstream);
    const job = { name: "heal-run", data: { schema_version: 1 } };

    await expect(worker.processor(job)).rejects.toBeInstanceOf(InvalidCIHealJobError);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("does not apply the heal-run contract to other jobs on the CI-healing queue", async () => {
    const downstream = jest.fn(async () => "reconciled");
    const worker = createWorker(QUEUES.CI_HEALING, downstream);
    const job = { name: "reconcile-pr", data: { payload: { anything: true } } };

    await expect(worker.processor(job)).resolves.toBe("reconciled");
    expect(downstream).toHaveBeenCalledWith(job);
  });

  it("leaves workers on other queues untouched", async () => {
    const downstream = jest.fn(async () => "triaged");
    const worker = createWorker(QUEUES.TRIAGE, downstream, { concurrency: 2 });
    const job = { name: "triage-issue", data: { arbitrary: true } };

    expect(runtimeCreateWorker).toHaveBeenCalledWith(QUEUES.TRIAGE, downstream, { concurrency: 2 });
    await expect(worker.processor(job)).resolves.toBe("triaged");
  });
});
