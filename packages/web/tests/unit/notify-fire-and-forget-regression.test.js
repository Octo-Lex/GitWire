// Source-reading regression test for PR #34: all notify* calls must be either
// awaited or .catch()'d. A fire-and-forget async notify call that rejects
// becomes an unhandledRejection, which crashes the app via the shutdown handler.
//
// The original bug: notifyCIFailure() at ciHealWorker.js:696 was called
// without await or .catch. A Telegram API timeout/rejection escaped the
// surrounding try/catch → unhandledRejection → app crash on every CI failure.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

describe("PR #34: no fire-and-forget notify* calls", () => {
  const files = [
    "packages/web/src/workers/ciHealWorker.js",
    "packages/web/src/routes/webhooks.js",
    "packages/web/src/workers/issueFix/submit.js",
    "packages/web/src/workers/triageWorker.js",
  ];

  for (const file of files) {
    it(`${file}: every notify* call has .catch or is awaited`, () => {
      const src = readSource(file);
      // Find all lines that call notify*( but are NOT preceded by await
      // and NOT followed by .catch on the same or next line.
      // Simple heuristic: every notifyCIFailure/notifyCustomRule/notifyGateResult/
      // notifyIssueFix/notifyTriage should have either 'await ' before it
      // or '.catch(' within 5 lines after it.
      const lines = src.split("\n");
      const notifyRegex = /^\s*(?!await\s|\/\/)(notify[A-Z]\w+)\s*\(/;
      let violations = 0;
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(notifyRegex);
        if (!match) continue;
        // Check if this line or the next few lines have .catch(
        const window = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
        // Also check if 'await' is on the same line
        if (lines[i].includes("await ") || window.includes(".catch(")) {
          continue;
        }
        violations++;
      }
      expect(violations).toBe(0);
    });
  }
});

describe("PR #34: unhandledRejection handler serializes reason properly", () => {
  const indexSrc = readSource("packages/web/src/index.js");

  it("serializes Error instances with name + message + stack", () => {
    expect(indexSrc).toMatch(/reason instanceof Error/);
    expect(indexSrc).toMatch(/reason\.name.*reason\.message.*reason\.stack/);
  });

  it("handles string reasons", () => {
    expect(indexSrc).toMatch(/typeof reason === "string"/);
  });

  it("falls back to JSON.stringify for objects", () => {
    expect(indexSrc).toMatch(/JSON\.stringify\(reason\)/);
  });
});
