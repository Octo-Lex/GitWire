// CurrentGitWireHarness — Arm A of the Phase 9 A/B (RI-9 amendment).
//
// The CURRENT GitWire agent orchestration behind the same ReviewHarness
// boundary as the Pi arm, over the SAME RepositoryTools v2 substrate. The
// loop preserves the current production characteristics
// (primaryReviewService.js) rather than imitating Pi:
//
//   1. deterministic first-order dependency seeding before exploration;
//   2. a tool-use exploration loop capped at 8 rounds;
//   3. a SEPARATE structured submission turn exposing only the
//      submit_review_result tool, forced via tool_choice with a
//      no-tool_choice fallback on provider rejection;
//   4. ONE bounded narration-death retry at doubled output room.
//
// Both arms share: identical budgets (480s / 60 tool calls / $0.50
// post-turn crossing threshold / 7M-token runaway guard), identical
// repository-tool semantics (shared/repositoryToolPresenters.js), identical
// downstream submission validation. No GitHub mutation capability exists.

import { completeSimple } from "@earendil-works/pi-ai";
import {
  validateReviewTask,
  makeReviewExecution,
} from "../reviewHarness.js";
import { sessionIdentityMismatch } from "../pi/piHarness.js";
import {
  createRepositoryToolExecutors,
  repositoryToolDescriptors,
} from "../shared/repositoryToolPresenters.js";
import { validateSubmission } from "../pi/submitReview.js";
import { buildFirstOrderSeeds, renderSeeds } from "./seeder.js";
import {
  renderCurrentSystemPrompt,
  SUBMISSION_CLOSING_MESSAGE,
  NARRATION_RETRY_MESSAGE,
  CURRENT_PROMPT_VERSION,
} from "./prompts.js";

export const CURRENT_MAX_TOOL_ROUNDS = 8;
export const CURRENT_SUBMIT_TOOL_NAME = "submit_review_result";
const SUBMISSION_FIRST_MAX_TOKENS = 8192;
const SUBMISSION_RETRY_MAX_TOKENS = 16384;

const SUBMIT_TOOL_DESCRIPTOR = {
  name: CURRENT_SUBMIT_TOOL_NAME,
  description:
    "Submit the complete structured review result. Payload: { findings: [{ severity: 'P0'|'P1'|'P2'|'P3', category?, claim, description?, affectedPaths?, evidenceRefs: [repo-read:<path>@HEAD:L<start>-L<end> | changed:<path>@HEAD:L<start>-L<end>], proof?, confidence? }], unresolvedContextRequests: [], approvalEvidenceComplete: boolean }.",
  parameters: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
            category: { type: "string" },
            claim: { type: "string" },
            description: { type: "string" },
            affectedPaths: { type: "array", items: { type: "string" } },
            evidenceRefs: { type: "array", items: { type: "string" } },
            proof: { type: "object" },
            confidence: { type: "number" },
          },
          required: ["severity", "claim", "evidenceRefs"],
        },
      },
      unresolvedContextRequests: { type: "array" },
      approvalEvidenceComplete: { type: "boolean" },
    },
    required: ["findings", "unresolvedContextRequests", "approvalEvidenceComplete"],
  },
};

function usageCost(usage, model) {
  const c = model?.cost;
  if (!c || [c.input, c.output, c.cacheRead, c.cacheWrite].some((v) => typeof v !== "number")) {
    return null;
  }
  return (
    ((usage.input ?? 0) / 1e6) * c.input +
    ((usage.output ?? 0) / 1e6) * c.output +
    ((usage.cacheRead ?? 0) / 1e6) * c.cacheRead +
    ((usage.cacheWrite ?? 0) / 1e6) * c.cacheWrite
  );
}

/**
 * Create the Arm A harness.
 *
 * @param {object} input
 * @param {object} input.model pi-ai Model (same object as the Pi arm)
 * @param {string} input.runtimeApiKey provider API key (memory-only)
 * @param {(id: string) => object|null} input.resolveRepositorySession
 * @param {(task: object) => Promise<Array>} input.changedFilesProvider
 *        supplies the changed-file list for deterministic seeding
 */
export function createCurrentGitWireHarness({ model, runtimeApiKey, resolveRepositorySession, changedFilesProvider }) {
  if (typeof resolveRepositorySession !== "function") {
    throw new Error("createCurrentGitWireHarness requires resolveRepositorySession");
  }
  if (typeof changedFilesProvider !== "function") {
    throw new Error("createCurrentGitWireHarness requires changedFilesProvider");
  }

  return {
    name: "current-gitwire",
    version: CURRENT_PROMPT_VERSION,
    promptVersion: CURRENT_PROMPT_VERSION,

    async runReview(task) {
      const requested = { requestedHarness: "current-gitwire", requestedProvider: model.provider, requestedModel: model.id };
      const preError = (code, message) =>
        makeReviewExecution({
          ...requested,
          actualHarness: "current-gitwire",
          actualProvider: model.provider,
          actualModel: model.id,
          status: "error",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          toolTrace: [],
          usage: null,
          terminationReason: "session_error",
          error: { code, message },
        });

      const validation = validateReviewTask(task);
      if (!validation.ok) {
        return preError("E_INVALID_TASK", validation.errors.join("; "));
      }
      const repositorySession = resolveRepositorySession(task.repositorySessionId);
      if (!repositorySession) {
        return preError("E_SESSION_UNAVAILABLE", `repository session not found: ${task.repositorySessionId}`);
      }
      const mismatch = sessionIdentityMismatch(task, repositorySession);
      if (mismatch) {
        return preError("E_IDENTITY_MISMATCH", mismatch);
      }

      const startedAtMs = performance.now();
      const startedAt = new Date().toISOString();
      const { executors } = createRepositoryToolExecutors(repositorySession);

      let deadlineFired = false;
      let budgetFired = false;
      let providerError = null;
      let toolCallCount = 0;
      let tokenCount = 0;
      let costAccruedUsd = 0;
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
      const assistantMessages = [];

      const abortController = new AbortController();
      const deadlineTimer = setTimeout(() => {
        deadlineFired = true;
        abortController.abort();
      }, task.deadlineMs);

      const callModel = async (context, options = {}) => {
        const message = await completeSimple(model, context, {
          apiKey: runtimeApiKey,
          maxTokens: options.maxTokens ?? model.maxTokens,
          signal: abortController.signal,
          ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        });
        assistantMessages.push(message);
        usage.input += message.usage?.input ?? 0;
        usage.output += message.usage?.output ?? 0;
        usage.cacheRead += message.usage?.cacheRead ?? 0;
        usage.cacheWrite += message.usage?.cacheWrite ?? 0;
        usage.totalTokens += message.usage?.totalTokens ?? 0;
        tokenCount = usage.totalTokens;
        const turnCost = usageCost(message.usage, model);
        if (turnCost !== null) costAccruedUsd += turnCost;
        if (message.stopReason === "error" && !providerError) {
          providerError = { code: "E_PROVIDER", message: message.errorMessage ?? "provider error" };
        }
        return message;
      };

      const budgetExceeded = () => {
        const maxTokens = task.budget?.maxTotalTokens;
        const maxCost = task.budget?.maxCostUsd;
        const maxTools = task.budget?.maxToolCalls;
        if (maxTokens !== undefined && tokenCount > maxTokens) return true;
        if (maxCost !== undefined && costAccruedUsd > maxCost) return true;
        if (maxTools !== undefined && toolCallCount > maxTools) return true;
        return false;
      };

      let submission;
      let submitAttempts = 0;
      let submissionDiagnostics = null;
      let terminationOverride = null;

      try {
        // 1. Deterministic first-order seeding (the current loop's
        //    context-selection characteristic; these reads run through the
        //    same audited RepositoryTools substrate).
        let seeds = [];
        try {
          const changedFiles = await changedFilesProvider(task);
          seeds = await buildFirstOrderSeeds({ repositorySession, changedFiles });
        } catch {
          seeds = []; // seeding is best-effort context, never a failure mode
        }

        const messages = [
          { role: "user", content: [{ type: "text", text: task.objective + renderSeeds(seeds) }] },
        ];
        const systemPrompt = renderCurrentSystemPrompt(task);
        const repoTools = repositoryToolDescriptors();

        // 2. Exploration loop (EXACTLY at most 8 rounds — round 0..7;
        //    retrieval closes on natural tool-stop or budget exhaustion,
        //    exactly like the current loop).
        let retrievalClosed = false;
        for (let round = 0; round < CURRENT_MAX_TOOL_ROUNDS && !retrievalClosed; round++) {
          if (budgetExceeded()) { budgetFired = true; break; }
          const message = await callModel({ systemPrompt, messages, tools: repoTools });
          if (message.stopReason === "error" || message.stopReason === "aborted") break;
          const toolCalls = message.content.filter((c) => c.type === "toolCall");
          if (toolCalls.length === 0) { retrievalClosed = true; break; }
          messages.push(message);
          for (const call of toolCalls) {
            toolCallCount += 1;
            const executor = executors[call.name];
            let text;
            if (!executor) {
              text = JSON.stringify({ operation: call.name, status: "error", complete: false, error: { code: "E_UNKNOWN_TOOL", message: `unknown tool: ${call.name}` } });
            } else {
              const presented = await executor(call.arguments ?? {});
              text = typeof presented === "string" ? presented : JSON.stringify(presented);
            }
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text }],
              isError: false,
              timestamp: Date.now(),
            });
          }
          if (budgetExceeded()) { budgetFired = true; break; }
        }

        // 3. Structured submission turn (forced tool_choice, provider-reject
        //    fallback, one narration-death retry — the current loop's
        //    convergence mechanism). Budget already crossed → NO additional
        //    provider call; a submission captured on a turn that crosses the
        //    budget never counts as completed.
        if (!providerError && !deadlineFired && !budgetFired) {
          submitAttempts += 1;
          messages.push({ role: "user", content: [{ type: "text", text: SUBMISSION_CLOSING_MESSAGE }] });
          const callSubmission = async (maxTokens, force) => {
            try {
              return await callModel(
                { systemPrompt, messages, tools: [SUBMIT_TOOL_DESCRIPTOR] },
                force
                  ? { maxTokens, toolChoice: { type: "tool", name: CURRENT_SUBMIT_TOOL_NAME } }
                  : { maxTokens }
              );
            } catch (err) {
              if (force) {
                // Provider rejected the force — the current loop's fallback.
                return await callModel(
                  { systemPrompt, messages, tools: [SUBMIT_TOOL_DESCRIPTOR] },
                  { maxTokens }
                );
              }
              throw err;
            }
          };

          let finalMsg = await callSubmission(SUBMISSION_FIRST_MAX_TOKENS, true);
          messages.push(finalMsg);
          let submissionRetried = false;
          const extractSubmit = (msg) =>
            msg.content.filter((c) => c.type === "toolCall" && c.name === CURRENT_SUBMIT_TOOL_NAME);
          if (
            finalMsg.stopReason === "length" &&
            extractSubmit(finalMsg).length === 0 &&
            !budgetExceeded()
          ) {
            submissionRetried = true;
            messages.push({ role: "user", content: [{ type: "text", text: NARRATION_RETRY_MESSAGE }] });
            finalMsg = await callSubmission(SUBMISSION_RETRY_MAX_TOKENS, true);
            messages.push(finalMsg);
          }

          const submitBlocks = extractSubmit(finalMsg);
          const finalText = finalMsg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
          // A submission turn that crosses the budget makes the run
          // budget_exceeded — a captured payload is preserved for audit but
          // NEVER counts as completed.
          if (budgetExceeded()) {
            budgetFired = true;
            if (submitBlocks.length > 0) {
              const payload = submitBlocks[submitBlocks.length - 1].arguments;
              const check = validateSubmission(payload);
              if (check.ok) {
                submission = {
                  payload: JSON.parse(JSON.stringify(payload)),
                  submittedAt: new Date().toISOString(),
                  submitAttempts,
                  capturedOnBudgetCrossing: true,
                };
              }
            }
          } else if (submitBlocks.length > 0) {
            const payload = submitBlocks[submitBlocks.length - 1].arguments;
            const check = validateSubmission(payload);
            if (check.ok) {
              submission = {
                payload: JSON.parse(JSON.stringify(payload)),
                submittedAt: new Date().toISOString(),
                submitAttempts,
              };
            } else {
              terminationOverride = "invalid_submission";
              submissionDiagnostics = { invalidPayloadErrors: check.errors };
            }
          }
          submissionDiagnostics = {
            ...(submissionDiagnostics ?? {}),
            stopReason: finalMsg.stopReason ?? null,
            usedSubmitTool: submitBlocks.length > 0,
            submissionRetried,
            textTail: finalText ? finalText.slice(-300) : null,
          };
        }
      } catch (err) {
        providerError = providerError ?? { code: "E_PROVIDER", message: err?.message ?? String(err) };
      } finally {
        clearTimeout(deadlineTimer);
      }

      const last = assistantMessages.at(-1);
      const costUsd = usageCost(usage, model);
      const usageRecord = {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        ...(costUsd !== null ? { costUsd } : {}),
      };

      let status = "incomplete";
      let terminationReason = "no_submission";
      let error;
      if (budgetFired) {
        // Budget precedence: a crossing (whenever detected) means the run
        // ended budget_exceeded — even if a submission payload was captured
        // on the crossing turn (kept for audit, never counted completed).
        terminationReason = "budget_exceeded";
      } else if (submission !== undefined) {
        status = "completed";
        terminationReason = "submitted";
      } else if (providerError) {
        status = "error";
        terminationReason = "provider_error";
        error = providerError;
      } else if (deadlineFired) {
        terminationReason = "deadline_exceeded";
      } else if (terminationOverride === "invalid_submission") {
        terminationReason = "invalid_submission";
      }

      return makeReviewExecution({
        ...requested,
        actualHarness: "current-gitwire",
        actualProvider: last?.provider ?? model.provider,
        actualModel: last?.responseModel ?? last?.model ?? model.id,
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startedAtMs),
        toolTrace: repositorySession.auditTrace(),
        ...(submission !== undefined ? { submission } : {}),
        usage: usageRecord,
        terminationReason,
        ...(error ? { error } : {}),
        ...(submissionDiagnostics ? { submissionDiagnostics } : {}),
      });
    },
  };
}
