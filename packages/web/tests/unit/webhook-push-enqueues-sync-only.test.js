// tests/unit/webhook-push-enqueues-sync-only.test.js
// A push enqueues the repository sync and nothing else. It used to enqueue a
// second job named `validate-configs` as well, and no worker ever consumed
// that name: every push added a job that was stored and never processed.
// Validation of `.gitwire.yml` runs on request (policy preview API and the
// dashboard's playground), not on push.

import { jest } from "@jest/globals";

const mockInvalidateConfigCache = jest.fn(async () => undefined);
jest.unstable_mockModule("../../src/services/configService.js", () => ({
  invalidateConfigCache: mockInvalidateConfigCache,
}));

const { handlePush } = await import("../../src/lib/webhookHandlers/handlePush.js");

const mockWebhookQueueAdd = jest.fn(async () => undefined);
const ctx = () => ({ webhookQueue: { add: mockWebhookQueueAdd } });

function pushPayload({ added = [], modified = [] } = {}) {
  return {
    repository: { id: 7, full_name: "acme/widgets" },
    head_commit: { added, modified },
    sender: { login: "alice" },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("handlePush — jobs enqueued", () => {
  it("enqueues the repository sync once, with the push payload and priority 3", async () => {
    const payload = pushPayload({ modified: ["src/index.js"] });
    await handlePush(payload, "delivery-1", ctx());

    expect(mockWebhookQueueAdd).toHaveBeenCalledTimes(1);
    const [name, jobData, opts] = mockWebhookQueueAdd.mock.calls[0];
    expect(name).toBe("sync-repo");
    expect(jobData.eventName).toBe("push");
    expect(jobData.payload).toBe(payload);
    expect(jobData.deliveryId).toBe("delivery-1");
    expect(jobData.receivedAt).toEqual(expect.any(Number));
    expect(opts).toEqual({ priority: 3 });
  });

  it("does not enqueue a validate-configs job", async () => {
    await handlePush(pushPayload({ modified: [".gitwire.yml"] }), "delivery-2", ctx());

    const jobNames = mockWebhookQueueAdd.mock.calls.map((call) => call[0]);
    expect(jobNames).not.toContain("validate-configs");
    expect(jobNames).toEqual(["sync-repo"]);
  });
});

describe("handlePush — config cache", () => {
  it.each([
    ["modifies the root config", { modified: [".gitwire.yml"] }],
    ["adds the root config", { added: [".gitwire.yml"] }],
    ["modifies the config under .github", { modified: [".github/.gitwire.yml"] }],
  ])("invalidates the config cache when the push %s", async (_label, changed) => {
    await handlePush(pushPayload(changed), "delivery-3", ctx());

    expect(mockInvalidateConfigCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateConfigCache).toHaveBeenCalledWith("acme/widgets");
    expect(mockWebhookQueueAdd).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["other files", { modified: ["src/index.js"], added: ["src/new.js"] }],
    ["a file of the same name in another directory", { modified: ["sub/.gitwire.yml"] }],
    ["no head commit", null],
  ])("leaves the config cache alone when the push changes %s", async (_label, changed) => {
    const payload = changed ? pushPayload(changed) : { repository: { id: 7, full_name: "acme/widgets" } };
    await handlePush(payload, "delivery-4", ctx());

    expect(mockInvalidateConfigCache).not.toHaveBeenCalled();
    expect(mockWebhookQueueAdd).toHaveBeenCalledTimes(1);
  });
});
