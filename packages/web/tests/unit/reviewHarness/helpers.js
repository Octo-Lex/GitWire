// Shared helpers for ReviewHarness tests: a deterministic fake
// OpenAI-compatible SSE provider that drives Pi's REAL provider stack with
// zero paid calls, plus a matching pi-ai model object.

import http from "node:http";

/**
 * Start a fake OpenAI-compatible chat-completions server.
 *
 * @param {object} options
 * @param {Array} options.turns scripted assistant turns, consumed in order;
 *        each turn is one of:
 *          { toolCall: { id, name, arguments } }
 *          { content: string }
 *          { error: { status: number, message: string } }  — HTTP failure
 * @param {string} [options.modelName] reported model id (default "fake-reviewer")
 * @returns {Promise<{port: number, baseUrl: string, model: object,
 *           requests: Array, close: () => Promise<void>}>}
 */
export async function startFakeProvider({ turns, modelName = "fake-reviewer" } = {}) {
  const requests = [];
  const pending = [...turns];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const turn = pending.shift() ?? { content: "(no more scripted turns)" };

      if (turn.error) {
        res.writeHead(turn.error.status ?? 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: turn.error.message ?? "scripted failure" } }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const envelope = () => ({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 0,
        model: modelName,
      });
      chunk({ ...envelope(), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (turn.toolCall) {
        chunk({
          ...envelope(),
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: turn.toolCall.id,
                type: "function",
                function: {
                  name: turn.toolCall.name,
                  arguments: JSON.stringify(turn.toolCall.arguments ?? {}),
                },
              }],
            },
            finish_reason: null,
          }],
        });
        chunk({ ...envelope(), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        chunk({ ...envelope(), choices: [{ index: 0, delta: { content: turn.content ?? "" }, finish_reason: null }] });
        chunk({ ...envelope(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      chunk({
        ...envelope(),
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const model = {
    id: modelName,
    name: "Fake Reviewer",
    api: "openai-completions",
    provider: "faketest",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };

  const close = () => new Promise((resolve) => server.close(() => resolve()));

  return { port, baseUrl: model.baseUrl, model, requests, close };
}
