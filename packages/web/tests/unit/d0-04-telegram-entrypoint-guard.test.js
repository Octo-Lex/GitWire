// D0-04: Telegram mutation discovery currently segments API wrappers using
// scanner-supported `export function name(...)` declarations. Fail closed if
// function export syntax changes so a mutating wrapper cannot be silently
// absorbed into a neighboring segment.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const BOT_API_PATH = path.resolve(WEB_ROOT, "../bot/src/api.js");

const EXPORTED_FUNCTION_CANDIDATE_RE = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
const SCANNER_SUPPORTED_EXPORT_RE = /\bexport\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g;
const FUNCTION_VALUED_EXPORT_RE = /\bexport\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;

function assertScannerCompatibleApiExports(source) {
  const candidates = [...source.matchAll(EXPORTED_FUNCTION_CANDIDATE_RE)].map((match) => match[1]);
  const supported = [...source.matchAll(SCANNER_SUPPORTED_EXPORT_RE)].map((match) => match[1]);
  const functionValuedAssignments = [...source.matchAll(FUNCTION_VALUED_EXPORT_RE)];

  if (
    functionValuedAssignments.length > 0 ||
    candidates.length !== supported.length ||
    candidates.some((name, index) => name !== supported[index])
  ) {
    throw new Error(
      `Scanner-incompatible Telegram API wrapper export syntax: candidates [${candidates.join(", ")}], supported [${supported.join(", ")}], function-valued assignments ${functionValuedAssignments.length}`,
    );
  }
}

describe("D0-04 Telegram API entrypoint guard", () => {
  const apiSource = fs.readFileSync(BOT_API_PATH, "utf8");

  test("all exported API wrapper functions remain scanner-compatible", () => {
    expect(() => assertScannerCompatibleApiExports(apiSource)).not.toThrow();
  });

  test("async function exports fail closed until mutation discovery explicitly supports them", () => {
    expect(() =>
      assertScannerCompatibleApiExports(
        'export async function mutate(apiKey) { return callApi(apiKey, "/x", { method: "POST" }); }',
      ),
    ).toThrow(/Scanner-incompatible Telegram API wrapper export syntax/);
  });

  test("function-valued exported bindings also fail closed", () => {
    expect(() =>
      assertScannerCompatibleApiExports(
        'export const mutate = async (apiKey) => callApi(apiKey, "/x", { method: "POST" });',
      ),
    ).toThrow(/Scanner-incompatible Telegram API wrapper export syntax/);
  });
});
