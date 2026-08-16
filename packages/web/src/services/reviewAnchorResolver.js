// Review inline-comment anchor resolution (NodeChain P1 correction).
//
// GitHub pull-request review comments must anchor to a line that exists on
// the RIGHT side of the unified diff. The production defect serialized the
// model's FILE line directly as `position` (a diff-relative index), so any
// finding whose file line exceeded the patch's line count produced
// `422 Position could not be resolved` — and the swallowed exception made
// the failed delivery look like success.
//
// This module deterministically validates anchors against the
// already-fetched per-file unified patch:
//
//   line present on the RIGHT side (added '+' or context ' ') → anchor as
//     { path, line, side: "RIGHT" }
//   deleted-only, out-of-diff, missing/truncated patch, malformed → NO
//     inline comment; the finding remains in the review body.
//
//   finding valid, anchor valid   → body + inline annotation
//   finding valid, anchor invalid → body only
//
// The finding is never dropped, and `position` is never emitted.

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Resolve the set of new-file line numbers represented on the RIGHT side
 * of one unified diff patch. Handles multiple hunks. Context and added
 * lines anchor; deleted-only lines do not. Returns an empty set for
 * missing/empty/malformed patches (everything degrades to body-only).
 *
 * @param {string} patch unified diff patch text ("" if absent)
 * @returns {Set<number>} anchorable new-file line numbers
 */
export function resolvePatchAnchorLines(patch) {
  const anchors = new Set();
  if (typeof patch !== "string" || patch === "") return anchors;

  let newLine = null; // null = outside any hunk (file headers etc.)
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER_RE);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (newLine === null) continue; // diff --git / index / --- / +++ headers
    const marker = raw[0];
    if (marker === "+" || marker === " ") {
      anchors.add(newLine);
      newLine += 1;
    } else if (marker === "-") {
      // Deleted lines exist only on the LEFT side — never anchorable.
    } else if (marker === "\\") {
      // "\ No newline at end of file" — no line consumed.
    } else {
      // Malformed content inside a hunk: stop trusting the rest of the
      // patch (a truncated patch can cut anywhere). Anchors collected so
      // far are still real.
      break;
    }
  }
  return anchors;
}

/**
 * Partition findings into those emitted as inline comments and those that
 * must carry their full detail in the review body. Body-only findings are
 * exactly the ones NOT emitted inline — because they are unanchorable
 * (unknown file, missing/truncated patch, line absent from the RIGHT side,
 * deleted-only line), have no usable location, or exceed the inline cap.
 * The correction contract: a finding is never dropped; if it cannot be
 * annotated, its description/suggestion/location go to the body.
 *
 * @returns {{anchored: Array, bodyOnly: Array}}
 */
export function partitionAnchored(findings, files, options = {}) {
  const maxComments = options.maxComments ?? 10;
  const anchorsByFile = new Map();
  for (const f of files ?? []) {
    if (!anchorsByFile.has(f.filename)) {
      anchorsByFile.set(f.filename, resolvePatchAnchorLines(f.patch ?? ""));
    }
  }

  const anchored = [];
  const bodyOnly = [];
  for (const f of findings ?? []) {
    const usable = f && f.file && f.line;
    const anchors = usable ? anchorsByFile.get(f.file) : null;
    const anchorable = usable && anchors !== undefined && anchors.has(f.line);
    if (anchorable && anchored.length < maxComments) {
      anchored.push(f);
    } else {
      bodyOnly.push(f);
    }
  }
  return { anchored, bodyOnly };
}

/**
 * Build validated inline review comments from findings. Delegates to
 * partitionAnchored so the inline set and the body-only set can never
 * disagree about which findings were emitted.
 *
 * @param {Array} findings legacy findings ({file, line, severity, title,
 *        description, suggestion}) — findings without file+line are ignored
 * @param {Array} files the fetched changed-file entries
 *        ({filename, patch}) — patch may be "" or missing
 * @param {object} [options] { maxComments = 10 }
 * @returns {Array<{path: string, line: number, side: "RIGHT", body: string}>}
 *          ONLY anchorable comments, capped at maxComments. Every finding
 *          NOT returned here must appear in the review body's detail
 *          section (see partitionAnchored) — never silently dropped.
 */
export function buildInlineComments(findings, files, options = {}) {
  const { anchored } = partitionAnchored(findings, files, options);
  return anchored.map(function (f) {
    return {
      path: f.file,
      line: f.line,
      side: "RIGHT",
      body:
        "**[" + (f.severity || "info").toUpperCase() + "] " + (f.title || "") + "**\n\n" +
        (f.description || "") +
        (f.suggestion ? "\n\n> **Suggestion:** " + f.suggestion : ""),
    };
  });
}

/** Render the body-detail block for findings NOT emitted inline. The
 *  finding is never dropped: description, suggestion, and location (where
 *  available) always reach the review body. */
export function renderBodyOnlyDetails(bodyOnly) {
  const lines = [];
  if (!bodyOnly || bodyOnly.length === 0) return lines;
  lines.push("### Finding details (not annotatable inline)");
  lines.push("");
  for (const f of bodyOnly) {
    if (!f) continue;
    const location = f.file ? " (`" + f.file + (f.line ? ":" + f.line : "") + "`)" : "";
    lines.push("- **[" + (f.severity || "info").toUpperCase() + "] " + (f.title || "untitled finding") + "**" + location);
    if (f.description) lines.push("  \n  " + f.description);
    if (f.suggestion) lines.push("  \n  > **Suggestion:** " + f.suggestion);
    lines.push("");
  }
  return lines;
}
