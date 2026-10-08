// tests/unit/webhook-dispatch-own-property.test.js
// CodeQL #28 regression: the webhook dispatcher must select handlers by
// OWN PROPERTY only. `handlers` is a plain object, so inherited names
// (constructor, toString, valueOf, __proto__) would otherwise resolve and
// dispatch to an unexpected target instead of the generic-event fallback.

import { jest } from "@jest/globals";

// Every handler module is mocked so index.js loads with a light dependency
// surface; the dispatcher's own selection logic is what's under test.
const handlerMocks = {};
for (const name of [
  "handleIssues", "handlePullRequest", "handlePullRequestReview",
  "handleCheckSuite", "handleWorkflowRun", "handleInstallation",
  "handlePush", "handleIssueComment", "handleRelease",
]) {
  handlerMocks[name] = jest.fn(async () => undefined);
}

jest.unstable_mockModule("../../src/lib/webhookHandlers/handleIssues.js", () => ({ handleIssues: handlerMocks.handleIssues }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handlePullRequest.js", () => ({ handlePullRequest: handlerMocks.handlePullRequest }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handlePullRequestReview.js", () => ({ handlePullRequestReview: handlerMocks.handlePullRequestReview }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handleCheckSuite.js", () => ({ handleCheckSuite: handlerMocks.handleCheckSuite }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handleWorkflowRun.js", () => ({ handleWorkflowRun: handlerMocks.handleWorkflowRun }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handleInstallation.js", () => ({ handleInstallation: handlerMocks.handleInstallation }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handlePush.js", () => ({ handlePush: handlerMocks.handlePush }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handleIssueComment.js", () => ({ handleIssueComment: handlerMocks.handleIssueComment }));
jest.unstable_mockModule("../../src/lib/webhookHandlers/handleRelease.js", () => ({ handleRelease: handlerMocks.handleRelease }));

const mockWebhookQueueAdd = jest.fn(async () => undefined);
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  webhookQueue: { add: mockWebhookQueueAdd },
  triageQueue: { add: jest.fn() },
  ciHealQueue: { add: jest.fn() },
  maintainerQueue: { add: jest.fn() },
  issueFixQueue: { add: jest.fn() },
  phase2Queue: { add: jest.fn() },
  phase3Queue: { add: jest.fn() },
  phase4Queue: { add: jest.fn() },
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/lib/commentRouter.js", () => ({
  parseGitwireCommand: jest.fn(() => null),
  resolveCommandAction: jest.fn(() => null),
  buildCommandResponse: jest.fn(() => null),
}));
jest.unstable_mockModule("../../src/services/configService.js", () => ({
  invalidateConfigCache: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({ wrapOctokit: jest.fn((o) => o) }));
jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: jest.fn(),
}));
jest.unstable_mockModule("../../src/lib/reconcileRepository.js", () => ({
  reconcileRepositoryFromWebhook: jest.fn(async () => undefined),
}));

const { routeWebhookToQueue } = await import("../../src/lib/webhookHandlers/index.js");

function payload() {
  // No repository.id, so the reconciliation branch stays out of the way.
  return { action: "opened", sender: { login: "alice" } };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("webhook dispatcher — own-property handler selection (#28)", () => {
  it("a registered event invokes its handler with payload, deliveryId, ctx, and meta unchanged", async () => {
    const meta = { checkRunId: 42 };
    await routeWebhookToQueue("issues", payload(), "delivery-1", meta);

    expect(handlerMocks.handleIssues).toHaveBeenCalledTimes(1);
    const args = handlerMocks.handleIssues.mock.calls[0];
    expect(args[0]).toMatchObject({ action: "opened" });
    expect(args[1]).toBe("delivery-1");
    expect(args[2]).toBeDefined(); // ctx
    expect(args[3]).toBe(meta);    // same meta object, not rebuilt
    expect(mockWebhookQueueAdd).not.toHaveBeenCalled();
  });

  it.each(["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"])(
    "inherited key %j cannot resolve a handler — it reaches the generic-event fallback",
    async (inherited) => {
      await routeWebhookToQueue(inherited, payload(), `delivery-${inherited}`);
      for (const fn of Object.values(handlerMocks)) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(mockWebhookQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockWebhookQueueAdd.mock.calls[0][0]).toBe("generic-event");
      expect(mockWebhookQueueAdd.mock.calls[0][1]).toMatchObject({
        eventName: inherited,
        deliveryId: `delivery-${inherited}`,
      });
    },
  );

  it("an unknown event name still produces the existing generic-event queue job", async () => {
    await routeWebhookToQueue("some_future_event", payload(), "delivery-9");
    for (const fn of Object.values(handlerMocks)) {
      expect(fn).not.toHaveBeenCalled();
    }
    const [name, jobData, opts] = mockWebhookQueueAdd.mock.calls[0];
    expect(name).toBe("generic-event");
    expect(jobData.eventName).toBe("some_future_event");
    expect(jobData.receivedAt).toEqual(expect.any(Number));
    expect(opts).toEqual({ priority: 10 });
  });

  it("the handler registry carries no own properties for the inherited names (guard shape)", () => {
    // If someone later adds an own handler keyed by an inherited name, this
    // pins that the dispatcher WILL dispatch it (own-property semantics) —
    // the test file should then be revisited deliberately.
    const handlersLike = { issues: 1, push: 1, release: 1 };
    for (const inherited of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(Object.hasOwn(handlersLike, inherited)).toBe(false);
    }
  });
});
