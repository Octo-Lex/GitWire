// src/services/embeddingService.js
// Generates text embeddings for GitHub issues and persists them to Postgres.
//
// Embedding model: Voyage AI voyage-3-lite via the Anthropic proxy
// (voyage-3-lite: 512 dims, fast, cheap — ideal for issue similarity)
//
// Cosine similarity is computed in JS over float32 arrays.
// At 10k issues x 512 dims that's ~20MB in memory — fine for now.
// Migration path to pgvector is a one-liner if the corpus grows.

import Anthropic from "@anthropic-ai/sdk";
import { db } from "../lib/db.js";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";

// Use the same Anthropic client as the rest of GitWire (respects ANTHROPIC_BASE_URL)
const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

// Model to use for embeddings — voyage-3-lite via Anthropic's embedding API
const EMBED_MODEL = "voyage-3-lite";
// Similarity threshold above which we flag a duplicate
export const DUPLICATE_THRESHOLD = 0.92;
// Soft threshold — surface as "possibly related" but don't flag as duplicate
export const RELATED_THRESHOLD = 0.82;
// Maximum issues to compare against (most recent open ones in the repo)
const CANDIDATE_LIMIT = 500;

// ── Generate a single embedding ───────────────────────────────────────────────

/**
 * Embed the title + body of a GitHub issue.
 * Returns a Float32Array of the embedding vector.
 *
 * @param {{ title: string, body?: string }} issue
 * @returns {Promise<Float32Array>}
 */
export async function embedIssue(issue) {
  const text = buildEmbedText(issue);
  return embedText(text);
}

/**
 * Embed a raw string via the Anthropic embeddings endpoint.
 * Uses the z.ai proxy — POST /v1/embeddings goes through the same base URL.
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text) {
  // Voyage AI embeddings are available through the Anthropic proxy at /v1/embeddings
  // If the proxy doesn't support embeddings, we fall back to a Claude-based semantic hash
  try {
    const response = await anthropic.post("/v1/embeddings", {
      body: {
        model: EMBED_MODEL,
        input: text.slice(0, 4000), // voyage-3-lite context window
      },
    });

    const vector = response.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new Error(`Unexpected embedding response shape`);
    }

    return new Float32Array(vector);
  } catch (err) {
    // If the proxy doesn't support /v1/embeddings, use a fallback approach:
    // Generate a deterministic hash-based pseudo-embedding for basic similarity.
    // This is less accurate but keeps the system functional.
    logger.warn({ err: err.message }, "Voyage embeddings unavailable, using fallback");
    return fallbackEmbed(text);
  }
}

// ── Fallback embedding when Voyage API is unavailable ────────────────────────
// Generates a 512-dim vector based on character n-gram hashing.
// Good enough for basic title similarity, but less accurate than real embeddings.

export function fallbackEmbed(text) {
  const DIMS = 512;
  const vec = new Float32Array(DIMS);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  // Hash character trigrams into the vector space
  for (let i = 0; i < normalized.length - 2; i++) {
    const trigram = normalized.slice(i, i + 3);
    let hash = 0;
    for (let j = 0; j < trigram.length; j++) {
      hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0;
    }
    const idx = Math.abs(hash) % DIMS;
    vec[idx] += 1;
  }

  // Also hash words for unigram signal
  const words = normalized.split(" ");
  for (const word of words) {
    let hash = 0;
    for (let j = 0; j < word.length; j++) {
      hash = ((hash << 5) - hash + word.charCodeAt(j)) | 0;
    }
    const idx = Math.abs(hash) % DIMS;
    vec[idx] += 2; // words weighted more than trigrams
  }

  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIMS; i++) vec[i] /= norm;
  }

  return vec;
}

// ── Persist embedding ─────────────────────────────────────────────────────────

/**
 * Generate and store an embedding for an issue.
 * Upserts so re-processing a changed issue updates the vector.
 *
 * @param {{ github_id: number, repo_id: number, title: string, body?: string }} issue
 * @returns {Promise<{ embeddingId: number, vector: Float32Array }>}
 */
export async function upsertIssueEmbedding(issue) {
  const text = buildEmbedText(issue);
  const vector = await embedText(text);

  // Postgres REAL[] expects a plain JS array of numbers
  const pgArray = Array.from(vector);

  const { rows: [row] } = await db.query(
    `INSERT INTO issue_embeddings
       (issue_id, repo_id, embedding, embedded_text, model, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (issue_id) DO UPDATE SET
       embedding     = EXCLUDED.embedding,
       embedded_text = EXCLUDED.embedded_text,
       model         = EXCLUDED.model,
       updated_at    = NOW()
     RETURNING id`,
    [issue.github_id, issue.repo_id, pgArray, text.slice(0, 2000), EMBED_MODEL]
  );

  // Back-link on the issues table
  await db.query(
    `UPDATE issues SET embedding_id = $1, dup_check_at = NOW() WHERE github_id = $2`,
    [row.id, issue.github_id]
  );

  logger.debug({ issueId: issue.github_id, embeddingId: row.id }, "Embedding upserted");
  return { embeddingId: row.id, vector };
}

// ── Fetch candidate embeddings from Postgres ──────────────────────────────────

/**
 * Load the most recent CANDIDATE_LIMIT open issue embeddings for a repo,
 * excluding the issue we're checking.
 *
 * @param {number} repoId
 * @param {number} excludeIssueId
 * @returns {Promise<Array<{ issueId: number, number: number, title: string, vector: Float32Array }>>}
 */
export async function fetchCandidateEmbeddings(repoId, excludeIssueId) {
  const { rows } = await db.query(
    `SELECT ie.issue_id, ie.embedding, ie.embedded_text,
            i.number, i.title, i.state
     FROM issue_embeddings ie
     JOIN issues i ON i.github_id = ie.issue_id
     WHERE ie.repo_id   = $1
       AND ie.issue_id != $2
       AND i.state      = 'open'
     ORDER BY i.created_at DESC
     LIMIT $3`,
    [repoId, excludeIssueId, CANDIDATE_LIMIT]
  );

  return rows.map((r) => ({
    issueId: r.issue_id,
    number: r.number,
    title: r.title,
    state: r.state,
    vector: new Float32Array(r.embedding),
  }));
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

/**
 * Cosine similarity between two Float32Arrays.
 * Returns a value in [-1, 1]; for normalized embeddings always [0, 1].
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Score all candidates against a query vector.
 * Returns candidates sorted by similarity descending, above RELATED_THRESHOLD.
 *
 * @param {Float32Array} queryVector
 * @param {Array} candidates  — from fetchCandidateEmbeddings
 * @returns {Array<{ issueId, number, title, similarity }>}
 */
export function rankBySimilarity(queryVector, candidates) {
  return candidates
    .map((c) => ({
      issueId: c.issueId,
      number: c.number,
      title: c.title,
      similarity: cosineSimilarity(queryVector, c.vector),
    }))
    .filter((c) => c.similarity >= RELATED_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the text to embed for an issue.
 * Title is weighted more heavily by repeating it.
 */
export function buildEmbedText(issue) {
  const title = (issue.title ?? "").trim();
  const body = (issue.body ?? "").trim().slice(0, 500);
  // Repeat title twice to give it ~2x weight over body
  return body ? `${title}\n${title}\n${body}` : `${title}\n${title}`;
}
