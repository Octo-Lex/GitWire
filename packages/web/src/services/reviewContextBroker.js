// src/services/reviewContextBroker.js
// Bounded exact-SHA Context Broker for Review Integrity (RI-3).
//
// Provides two capabilities to the primary reviewer and independent verifier:
//   readRepoFile(path, ref)   — read a file at an immutable commit SHA
//   searchRepoText(query, ref) — search repository content at a commit SHA
//
// Security boundary:
//   - Repository contents only (no host filesystem)
//   - Path normalization required (reject ../ traversal)
//   - No shell, no external network, no GitHub mutation
//   - Permitted refs are locked to the review's base/head SHAs
//
// The broker enforces hard resource budgets. The model cannot override them.
// Every result resolves to immutable Git identity for audit.

import { createHash } from "node:crypto";

// ── Budget defaults ──────────────────────────────────────────────────────────

export const DEFAULT_BUDGETS = Object.freeze({
  maxFileReads:        20,    // max readRepoFile calls per review
  maxSearches:         5,     // max searchRepoText calls per review
  maxSearchResults:    10,    // max results returned per search
  maxRetrievedChars:   50000, // max total characters retrieved across all calls
  maxContextRounds:    3,     // max distinct retrieval rounds
});

// ── Path safety ──────────────────────────────────────────────────────────────

/**
 * Normalize and validate a repository path.
 * Rejects path traversal (../), absolute paths, and null bytes.
 *
 * @param {string} path
 * @returns {string|null} normalized path, or null if unsafe
 */
export function normalizePath(path) {
  if (!path || typeof path !== "string") return null;
  if (path.includes("\0")) return null;

  // Reject absolute paths (Unix or Windows)
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;

  // Normalize backslashes to forward slashes
  const normalized = path.replace(/\\/g, "/");

  // Reject path traversal: any segment that is ".."
  const segments = normalized.split("/");
  if (segments.includes("..")) return null;

  // Collapse multiple slashes and trim leading ./
  const cleaned = segments.filter(s => s !== "." && s !== "").join("/");
  if (!cleaned) return null;

  return cleaned;
}

// ── Context Broker ───────────────────────────────────────────────────────────

/**
 * Create a bounded Context Broker for a single review invocation.
 *
 * The broker is stateful: it tracks budget consumption and records every
 * retrieval in its trace. Once a budget is exhausted, further calls return
 * an empty result with a budget_exceeded reason.
 *
 * @param {object} params
 * @param {object} params.octokit - GitHub client
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.baseSha - immutable base commit SHA
 * @param {string} params.headSha - immutable head commit SHA
 * @param {object} [params.budgets] - override defaults
 * @returns {object} { readRepoFile, searchRepoText, getTrace, getBudgetState }
 */
export function createContextBroker({ octokit, owner, repo, baseSha, headSha, budgets }) {
  if (!octokit || !owner || !repo || !baseSha || !headSha) {
    throw new Error("Context broker requires octokit, owner, repo, baseSha, headSha");
  }

  const effectiveBudgets = { ...DEFAULT_BUDGETS, ...budgets };

  // Permitted refs
  const permittedRefs = new Set([baseSha, headSha]);

  // Budget tracking
  let fileReads = 0;
  let searches = 0;
  let retrievedChars = 0;
  let contextRounds = 0;
  let currentRound = 0;

  // Retrieval trace
  const trace = [];

  /**
   * Check if a budget allows the operation. Returns { allowed, reason }.
   */
  function checkBudget(type) {
    if (type === "fileRead" && fileReads >= effectiveBudgets.maxFileReads) {
      return { allowed: false, reason: "max_file_reads_exceeded" };
    }
    if (type === "search" && searches >= effectiveBudgets.maxSearches) {
      return { allowed: false, reason: "max_searches_exceeded" };
    }
    if (retrievedChars >= effectiveBudgets.maxRetrievedChars) {
      return { allowed: false, reason: "max_retrieved_chars_exceeded" };
    }
    if (contextRounds >= effectiveBudgets.maxContextRounds && currentRound === 0) {
      return { allowed: false, reason: "max_context_rounds_exceeded" };
    }
    return { allowed: true };
  }

  /**
   * Record a budget-denied attempt in the trace for auditability.
   * This ensures that requested-but-denied evidence is traceable.
   */
  function traceBudgetDenied(type, reason, extra = {}) {
    trace.push({
      type,
      result: "budget_exceeded",
      reason,
      round: currentRound > 0 ? currentRound : (contextRounds + 1),
      ...extra,
    });
  }

  /**
   * Resolve a ref to one of the permitted immutable SHAs.
   * Only the review's baseSha and headSha are allowed.
   */
  function resolveRef(ref) {
    if (!ref || !permittedRefs.has(ref)) {
      return null;
    }
    return ref;
  }

  /**
   * Read a file at an immutable commit SHA.
   *
   * @param {string} path - repository file path
   * @param {string} ref - must be baseSha or headSha
   * @param {object} [opts] - { range: { startLine, endLine } }
   * @returns {Promise<object>} context item with immutable identity
   */
  async function readRepoFile(path, ref, opts = {}) {
    const safePath = normalizePath(path);
    if (!safePath) {
      return { error: "invalid_path", path };
    }

    const resolvedRef = resolveRef(ref);
    if (!resolvedRef) {
      return { error: "invalid_ref", ref, permittedRefs: [baseSha, headSha] };
    }

    const budget = checkBudget("fileRead");
    if (!budget.allowed) {
      traceBudgetDenied("file_read", budget.reason, { path: safePath, ref: resolvedRef });
      return { error: "budget_exceeded", reason: budget.reason };
    }

    // Start a new context round if this is the first call in a new round
    if (currentRound === 0) {
      contextRounds++;
      currentRound = contextRounds;
    }

    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner, repo, path: safePath, ref: resolvedRef }
      );

      if (!data || data.type !== "file") {
        fileReads++;
        trace.push({
          type: "file_read",
          path: safePath,
          ref: resolvedRef,
          result: "not_found",
          round: currentRound,
        });
        return { error: "not_found", path: safePath, ref: resolvedRef };
      }

      // Decode content
      const fullContent = data.encoding === "base64"
        ? Buffer.from(data.content, "base64").toString("utf-8")
        : (data.content || "");

      // Apply optional line range
      let content = fullContent;
      let range = null;
      let truncated = false;
      if (opts.range && typeof opts.range.startLine === "number") {
        const lines = fullContent.split("\n");
        const start = Math.max(0, opts.range.startLine - 1);
        const end = opts.range.endLine ? Math.min(lines.length, opts.range.endLine) : lines.length;
        content = lines.slice(start, end).join("\n");
        range = { startLine: start + 1, endLine: end };
      }

      // Check if this content would exceed the char budget.
      // If it would, truncate to fit and mark as bounded-partial.
      // If remaining budget is zero or negative, deny.
      const remaining = effectiveBudgets.maxRetrievedChars - retrievedChars;
      if (content.length > remaining) {
        if (remaining <= 0) {
          fileReads++;
          traceBudgetDenied("file_read", "max_retrieved_chars_exceeded", { path: safePath, ref: resolvedRef });
          return { error: "budget_exceeded", reason: "max_retrieved_chars_exceeded" };
        }
        // Truncate to remaining budget — explicit bounded-partial
        content = content.slice(0, remaining);
        truncated = true;
        if (!range) {
          range = { startLine: 1, endLine: content.split("\n").length };
        }
      }

      fileReads++;
      retrievedChars += content.length;

      const contentDigest = "sha256:" + createHash("sha256").update(fullContent, "utf-8").digest("hex");

      const contextItem = {
        id: "ctx-" + trace.length,
        type: "file_read",
        path: safePath,
        ref: resolvedRef,
        resolvedSha: resolvedRef,
        blobSha: data.sha || null,
        contentDigest,
        range,
        truncated,
        content,
        retrievalReason: opts.reason || null,
      };

      trace.push({
        type: "file_read",
        path: safePath,
        ref: resolvedRef,
        resolvedSha: resolvedRef,
        blobSha: data.sha || null,
        contentDigest,
        range,
        truncated,
        contentLength: content.length,
        result: truncated ? "ok_truncated" : "ok",
        round: currentRound,
      });

      return contextItem;

    } catch (err) {
      fileReads++;
      // GitHub API returns 404 for non-existent files — treat as not_found
      const is404 = err.message?.includes("404") || err.status === 404;
      const result = is404 ? "not_found" : "error";
      const errorType = is404 ? "not_found" : "fetch_failed";
      trace.push({
        type: "file_read", path: safePath, ref: resolvedRef,
        result, error: err.message, round: currentRound,
      });
      return { error: errorType, path: safePath, ref: resolvedRef, message: is404 ? undefined : err.message };
    }
  }

  /**
   * Search repository text at an immutable commit SHA.
   *
   * Fetches the full recursive tree at the exact SHA, then reads and searches
   * blob contents server-side. Each result carries resolvedSha, blobSha,
   * contentDigest, and line information — all bound to the immutable ref.
   *
   * Results are limited to maxSearchResults per query and the total retrieved
   * characters cannot exceed the budget. A search that would exceed the budget
   * returns budget_exceeded.
   *
   * @param {string} query - search query (case-insensitive substring)
   * @param {string} ref - must be baseSha or headSha
   * @returns {Promise<object>} search results with immutable identity
   */
  async function searchRepoText(query, ref) {
    if (!query || typeof query !== "string") {
      return { error: "invalid_query" };
    }

    const resolvedRef = resolveRef(ref);
    if (!resolvedRef) {
      return { error: "invalid_ref", ref, permittedRefs: [baseSha, headSha] };
    }

    const budget = checkBudget("search");
    if (!budget.allowed) {
      traceBudgetDenied("repo_search", budget.reason, { query, ref: resolvedRef });
      return { error: "budget_exceeded", reason: budget.reason };
    }

    if (currentRound === 0) {
      contextRounds++;
      currentRound = contextRounds;
    }

    try {
      // Fetch the recursive tree at the exact SHA
      const { data: treeData } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        { owner, repo, tree_sha: resolvedRef, recursive: "1" }
      );

      if (!treeData || !Array.isArray(treeData.tree)) {
        searches++;
        trace.push({
          type: "repo_search", query, ref: resolvedRef,
          result: "error", error: "tree_not_found", round: currentRound,
        });
        return { error: "search_failed", query, ref: resolvedRef, message: "Tree not found at " + resolvedRef };
      }

      // Filter to blob entries (files only, not submodules or trees)
      const blobs = treeData.tree.filter(e => e.type === "blob" && e.path);
      const queryLower = query.toLowerCase();
      const matches = [];
      let searchCharsConsumed = 0;

      for (const blob of blobs) {
        if (matches.length >= effectiveBudgets.maxSearchResults) break;

        // Check budget before fetching each blob content
        if (retrievedChars + searchCharsConsumed >= effectiveBudgets.maxRetrievedChars) break;

        try {
          const { data: blobData } = await octokit.request(
            "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
            { owner, repo, file_sha: blob.sha }
          );

          if (!blobData || blobData.encoding !== "base64") continue;

          const content = Buffer.from(blobData.content, "base64").toString("utf-8");
          const contentLower = content.toLowerCase();
          const matchIndex = contentLower.indexOf(queryLower);

          if (matchIndex !== -1) {
            // Find the line number of the match
            const beforeMatch = content.substring(0, matchIndex);
            const lineNumber = beforeMatch.split("\n").length;

            // Build a fragment around the match (±200 chars)
            const fragStart = Math.max(0, matchIndex - 200);
            const fragEnd = Math.min(content.length, matchIndex + query.length + 200);
            const fragment = content.substring(fragStart, fragEnd);

            // Hard budget check: stop if this fragment would exceed budget
            if (retrievedChars + searchCharsConsumed + fragment.length > effectiveBudgets.maxRetrievedChars) {
              break;
            }
            searchCharsConsumed += fragment.length;

            const contentDigest = "sha256:" + createHash("sha256").update(content, "utf-8").digest("hex");

            matches.push({
              id: "search-" + trace.length + "-" + matches.length,
              path: blob.path,
              ref: resolvedRef,
              resolvedSha: resolvedRef,
              blobSha: blob.sha,
              contentDigest,
              line: lineNumber,
              fragment,
            });
          }
        } catch (_e) {
          // Skip blobs that can't be fetched (binary, too large, etc.)
        }
      }

      searches++;
      retrievedChars += searchCharsConsumed;

      trace.push({
        type: "repo_search",
        query,
        ref: resolvedRef,
        resolvedSha: resolvedRef,
        resultCount: matches.length,
        charsConsumed: searchCharsConsumed,
        result: "ok",
        round: currentRound,
      });

      return { results: matches, ref: resolvedRef };

    } catch (err) {
      searches++;
      trace.push({
        type: "repo_search", query, ref: resolvedRef,
        result: "error", error: err.message, round: currentRound,
      });
      return { error: "search_failed", query, ref: resolvedRef, message: err.message };
    }
  }

  /**
   * Mark the end of a context round. The next read/search call will start a new round.
   * Called by the review pipeline between model turns.
   */
  function endRound() {
    currentRound = 0;
  }

  /**
   * Get the full retrieval trace for audit.
   */
  function getTrace() {
    return [...trace];
  }

  /**
   * Get current budget consumption state.
   */
  function getBudgetState() {
    return {
      fileReads,
      searches,
      retrievedChars,
      contextRounds,
      currentRound,
      limits: { ...effectiveBudgets },
      exhausted: retrievedChars >= effectiveBudgets.maxRetrievedChars ||
        fileReads >= effectiveBudgets.maxFileReads ||
        searches >= effectiveBudgets.maxSearches ||
        contextRounds >= effectiveBudgets.maxContextRounds,
    };
  }

  return {
    readRepoFile,
    searchRepoText,
    endRound,
    getTrace,
    getBudgetState,
    // Expose for the review pipeline to populate ReviewEvidence
    permittedRefs: [baseSha, headSha],
    budgets: effectiveBudgets,
  };
}
