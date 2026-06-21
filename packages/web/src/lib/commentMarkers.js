// src/lib/commentMarkers.js
// Marker-backed GitHub comment management.
//
// Every durable GitWire comment includes a hidden HTML marker that uniquely
// identifies the logical action it belongs to. When re-posting, the marker
// is used to find and UPDATE the existing comment instead of creating a new
// one. This prevents comment-layer spam independently of action-layer dedup.
//
// Marker format:
//   <!-- gitwire:<type>:<id> -->
//
// Examples:
//   <!-- gitwire:repair-proposal:42 -->
//   <!-- gitwire:verification:abc123 -->
//   <!-- gitwire:triage:99 -->

/**
 * Build a hidden marker for a GitWire comment.
 * @param {string} type — repair-proposal, verification, triage, etc.
 * @param {string|number} id — the entity id
 * @returns {string} the HTML comment marker
 */
export function buildMarker(type, id) {
  return `<!-- gitwire:${type}:${id} -->`;
}

/**
 * Build a comment body that starts with the hidden marker.
 * @param {string} type
 * @param {string|number} id
 * @param {string} body — the visible comment content
 * @returns {string} marker + body
 */
export function buildMarkedComment(type, id, body) {
  return `${buildMarker(type, id)}\n${body}`;
}

/**
 * Find an existing GitWire comment by its marker on an issue or PR.
 *
 * @param {object} octokit — the GitHub client
 * @param {string} owner
 * @param {string} repo
 * @param {string} issueNumber — issue or PR number (string for API path)
 * @param {string} marker — the exact marker string to search for
 * @returns {Promise<object|null>} the existing comment, or null if not found.
 *   Returns { ambiguous: true, comments: [] } if multiple matches found.
 */
export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {
  // List comments — we'll search for the marker in the body
  const { data: comments } = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    }
  );

  // Filter to comments that contain our exact marker
  const matches = comments.filter((c) => c.body && c.body.includes(marker));

  if (matches.length === 0) {
    return null; // No existing comment — create new
  }
  if (matches.length === 1) {
    return matches[0]; // Exactly one — update it
  }
  // Multiple matches — ambiguous state, should be blocked
  return { ambiguous: true, comments: matches };
}

/**
 * Post or update a GitWire comment using marker-based ownership.
 *
 * Behavior:
 *   - If no comment with the marker exists: create a new comment.
 *   - If exactly one exists: update it in place.
 *   - If multiple exist: return { blocked: true, reason: "marker_ambiguous" }.
 *
 * @param {object} octokit — the GitHub client
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber — issue or PR number
 * @param {string} type — marker type (repair-proposal, verification, triage)
 * @param {string|number} id — entity id
 * @param {string} body — the visible comment content (without marker)
 * @returns {Promise<object>} { action: "created"|"updated"|"blocked", comment_id?, reason? }
 */
export async function postMarkedComment(octokit, owner, repo, issueNumber, type, id, body) {
  const marker = buildMarker(type, id);
  const markedBody = buildMarkedComment(type, id, body);

  const existing = await findCommentByMarker(octokit, owner, repo, String(issueNumber), marker);

  if (existing && existing.ambiguous) {
    return {
      action: "blocked",
      reason: "marker_ambiguous",
      detail: { matchCount: existing.comments.length, marker },
    };
  }

  if (existing) {
    // Update in place
    await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: existing.id,
        body: markedBody,
      }
    );
    return { action: "updated", comment_id: existing.id };
  }

  // Create new
  const { data: comment } = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: issueNumber,
      body: markedBody,
    }
  );
  return { action: "created", comment_id: comment.id };
}
