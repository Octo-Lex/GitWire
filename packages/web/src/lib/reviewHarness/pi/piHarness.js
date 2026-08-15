// PiHarness — the Pi adapter behind the ReviewHarness boundary (RI-9
// amendment, Phase 8, Commits 2-4).
//
// runReview(task) drives one ephemeral, controlled Pi session:
//
//   ReviewTask → controlled session (no discovery, no builtin tools)
//             → GitWire-qualified read/grep/find/ls + terminal submit_review
//             → deadline + token/tool budget enforcement
//             → ReviewExecution (never a decision; a record)
//
// Failure modes are fail-closed: deadline, budget, provider error, crash,
// or a model that never submits all end status=incomplete|error with NO
// submission — approval stays impossible. No GitHub mutation credential
// exists anywhere in this adapter.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateReviewTask,
  makeReviewExecution,
} from "../reviewHarness.js";
import { createControlledPiSession } from "./piSessionFactory.js";
import { createPiRepositoryTools } from "./piRepositoryTools.js";
import { createSubmitReviewTool } from "./submitReview.js";
import {
  renderReviewSystemPrompt,
  renderReviewUserPrompt,
  PROMPT_VERSION,
} from "./reviewPrompts.js";

/** Best-effort Pi package version for the execution record. Tries the
 *  workspace root and the package-local node_modules (npm hoisting). */
function readPiVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "..", "..", "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    path.join(here, "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  ]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8")).version ?? "unknown";
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
}

function sumUsage(assistantMessages, model) {
  let input = 0;
  let output = 0;
  let totalTokens = 0;
  for (const m of assistantMessages) {
    input += m.usage?.input ?? 0;
    output += m.usage?.output ?? 0;
    totalTokens += m.usage?.totalTokens ?? 0;
  }
  const costUsd =
    typeof model?.cost?.input === "number" && typeof model?.cost?.output === "number"
      ? (input / 1_000_000) * model.cost.input + (output / 1_000_000) * model.cost.output
      : null;
  return { inputTokens: input, outputTokens: output, totalTokens, ...(costUsd !== null ? { costUsd } : {}) };
}

/**
 * Create the Pi ReviewHarness adapter.
 *
 * @param {object} input
 * @param {object} input.model pi-ai Model data object (fake or real provider)
 * @param {string} input.runtimeApiKey provider API key (memory-only)
 * @param {(repositorySessionId: string) => object|null} input.resolveRepositorySession
 * @param {string} [input.thinkingLevel]
 * @returns {{name: string, version: string, promptVersion: string, runReview: Function}}
 */
export function createPiHarness({ model, runtimeApiKey, resolveRepositorySession, thinkingLevel = "off" }) {
  if (typeof resolveRepositorySession !== "function") {
    throw new Error("createPiHarness requires resolveRepositorySession");
  }
  const piVersion = readPiVersion();

  return {
    name: "pi",
    version: piVersion,
    promptVersion: PROMPT_VERSION,

    async runReview(task) {
      const requested = { requestedHarness: "pi", requestedProvider: model.provider, requestedModel: model.id };

      const validation = validateReviewTask(task);
      if (!validation.ok) {
        return makeReviewExecution({
          ...requested,
          actualHarness: "pi",
          actualProvider: model.provider,
          actualModel: model.id,
          status: "error",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          toolTrace: [],
          usage: null,
          terminationReason: "session_error",
          error: { code: "E_INVALID_TASK", message: validation.errors.join("; ") },
        });
      }

      const repositorySession = resolveRepositorySession(task.repositorySessionId);
      if (!repositorySession) {
        return makeReviewExecution({
          ...requested,
          actualHarness: "pi",
          actualProvider: model.provider,
          actualModel: model.id,
          status: "error",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          toolTrace: [],
          usage: null,
          terminationReason: "session_error",
          error: { code: "E_SESSION_UNAVAILABLE", message: `repository session not found: ${task.repositorySessionId}` },
        });
      }

      const startedAtMs = performance.now();
      const startedAt = new Date().toISOString();

      const runContext = { submission: undefined, submitAttempts: 0, terminationRequested: false };
      const { tools: repoTools } = createPiRepositoryTools({ repositorySession });
      const submitTool = createSubmitReviewTool(runContext);
      const customTools = [...repoTools, submitTool];

      let controlled;
      try {
        controlled = await createControlledPiSession({
          model,
          runtimeApiKey,
          systemPrompt: renderReviewSystemPrompt(task),
          customTools,
          thinkingLevel,
        });
      } catch (err) {
        return makeReviewExecution({
          ...requested,
          actualHarness: "pi",
          actualProvider: model.provider,
          actualModel: model.id,
          status: "error",
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAtMs),
          toolTrace: repositorySession.auditTrace(),
          usage: null,
          terminationReason: "session_error",
          error: { code: "E_SESSION_START", message: err?.message ?? String(err) },
        });
      }
      const { session, dispose } = controlled;

      let deadlineFired = false;
      let budgetFired = false;
      let providerError = null;
      let toolCallCount = 0;
      let tokenCount = 0;

      const finish = (extra = {}) => {
        const assistantMessages = session.agent.state.messages.filter((m) => m.role === "assistant");
        const last = assistantMessages.at(-1);
        const actual = {
          actualHarness: "pi",
          actualProvider: last?.provider ?? model.provider,
          actualModel: last?.responseModel ?? last?.model ?? model.id,
        };
        const usage = sumUsage(assistantMessages, model);
        let status = "incomplete";
        let terminationReason = "no_submission";
        let submission;
        let error;
        if (runContext.submission !== undefined) {
          status = "completed";
          terminationReason = "submitted";
          submission = {
            ...runContext.submission,
            submitAttempts: runContext.submitAttempts,
          };
        } else if (providerError) {
          status = "error";
          terminationReason = "provider_error";
          error = providerError;
        } else if (deadlineFired) {
          terminationReason = "deadline_exceeded";
        } else if (budgetFired) {
          terminationReason = "budget_exceeded";
        } else if (extra.error) {
          status = "error";
          terminationReason = "session_error";
          error = extra.error;
        }
        return makeReviewExecution({
          ...requested,
          ...actual,
          status,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - startedAtMs),
          toolTrace: repositorySession.auditTrace(),
          ...(submission !== undefined ? { submission } : {}),
          usage,
          terminationReason,
          ...(error ? { error } : {}),
        });
      };

      let unsubscribe = null;
      let disposed = false;
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        if (unsubscribe) unsubscribe();
        clearTimeout(deadlineTimer);
        dispose();
      };

      const deadlineTimer = setTimeout(() => {
        deadlineFired = true;
        try {
          session.agent.abort();
        } catch {
          // aborting an already-settled run is a no-op; the flags decide the record
        }
      }, task.deadlineMs);

      try {
        unsubscribe = session.subscribe((event) => {
          if (event.type === "message_end" && event.message?.role === "assistant") {
            if (event.message.stopReason === "error" && !providerError) {
              providerError = {
                code: "E_PROVIDER",
                message: event.message.errorMessage ?? "provider stream error",
              };
            }
            tokenCount += event.message.usage?.totalTokens ?? 0;
            const maxTotalTokens = task.budget?.maxTotalTokens;
            if (maxTotalTokens !== undefined && tokenCount > maxTotalTokens) {
              budgetFired = true;
              try {
                session.agent.abort();
              } catch {
                // flags decide the record
              }
            }
          }
          if (event.type === "tool_execution_start") {
            toolCallCount += 1;
            const maxToolCalls = task.budget?.maxToolCalls;
            if (maxToolCalls !== undefined && toolCallCount > maxToolCalls) {
              budgetFired = true;
              try {
                session.agent.abort();
              } catch {
                // flags decide the record
              }
            }
          }
          if (event.type === "tool_execution_end" && event.toolName === "submit_review" && runContext.terminationRequested) {
            // Backstop only: the primary termination is the tool result's
            // terminate:true flag (Pi's first-class loop-stop contract).
            try {
              session.agent.abort();
            } catch {
              // flags decide the record
            }
          }
        });

        try {
          await session.prompt(renderReviewUserPrompt(task));
        } catch (err) {
          providerError = providerError ?? {
            code: "E_PROVIDER",
            message: err?.message ?? String(err),
          };
        }

        cleanup();
        return finish();
      } catch (err) {
        cleanup();
        return finish({ error: { code: "E_HARNESS", message: err?.message ?? String(err) } });
      }
    },
  };
}
