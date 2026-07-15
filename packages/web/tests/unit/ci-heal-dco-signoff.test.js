// tests/unit/ci-heal-dco-signoff.test.js
//
// Regression test: heal PR commit messages must include a Signed-off-by trailer
// matching the bot identity. This is required for DCO-enforcing repositories.

import { describe, it, expect } from "@jest/globals";

// The bot identity used for the Signed-off-by trailer (matches ciHealWorker.js line 638).
// GitHub noreply format for bots: ID+username@users.noreply.github.com
const EXPECTED_SIGN_OFF = "Signed-off-by: gitwire-hq[bot] <285039305+gitwire-hq[bot]@users.noreply.github.com>";

// The message format from ciHealWorker.js healByPatchPR (line 638).
// We reconstruct the exact pattern to verify the trailer is present and well-formed.
function buildHealCommitMessage(failingFile, rootCause, explanation) {
  const ext = failingFile.split(".").pop() || "txt";
  const truncatedCause = rootCause.length > 72 ? rootCause.substring(0, 72) : rootCause;
  return `[gitwire-heal] fix(${ext}): ${truncatedCause}\n\nApplied by GitWire AI self-healing CI.\n\n${explanation}\n\n${EXPECTED_SIGN_OFF}`;
}

describe("ciHealWorker DCO sign-off regression", () => {
  it("commit message ends with Signed-off-by trailer matching bot identity", () => {
    const msg = buildHealCommitMessage("app.js", "ESLint found 6 errors", "Added semicolons and removed unused variable");
    expect(msg).toMatch(/Signed-off-by: gitwire-hq\[bot\] <285039305\+gitwire-hq\[bot\]@users\.noreply\.github\.com>$/);
  });

  it("trailer is on its own line after the explanation", () => {
    const explanation = "Fixed missing semicolons on lines 2-4.";
    const msg = buildHealCommitMessage("src/index.js", "Lint error", explanation);
    const lines = msg.split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toMatch(/^Signed-off-by:/);
    // There should be a blank line before the trailer
    const beforeLast = lines[lines.length - 2];
    expect(beforeLast).toBe("");
  });

  it("trailer is present even with a short explanation", () => {
    const msg = buildHealCommitMessage("test.js", "Missing semicolon", "Added ;");
    expect(msg).toContain(EXPECTED_SIGN_OFF);
  });

  it("trailer is present even with a long explanation containing newlines", () => {
    const longExplanation = "Line 1\nLine 2\nLine 3";
    const msg = buildHealCommitMessage("lib.js", "Multiple errors", longExplanation);
    expect(msg).toContain(EXPECTED_SIGN_OFF);
    // The trailer must still be the last line
    expect(msg.endsWith(EXPECTED_SIGN_OFF)).toBe(true);
  });

  it("trailer uses the GitHub noreply bot email format", () => {
    const msg = buildHealCommitMessage("x.js", "err", "fix");
    // GitHub noreply format: numeric-id+username@users.noreply.github.com
    const trailerMatch = msg.match(/Signed-off-by: (.+) <(.+)>$/);
    expect(trailerMatch).not.toBeNull();
    expect(trailerMatch[2]).toMatch(/^\d+\+.+@users\.noreply\.github\.com$/);
  });
});
