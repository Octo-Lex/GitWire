// Source-reading test for the placeholder-secret guard (v0.23.0 Task 3, P2 #2).
//
// checkPlaceholders() in config/index.js runs in production and rejects
// placeholder secret values (changeme, YOUR_TOKEN, etc.). The shared bearer
// token for the executor-service private API MUST be in the SECRET_KEYS list
// or production could start with GITWIRE_EXECUTOR_SERVICE_TOKEN=changeme,
// defeating the auth layer.
//
// Source-reading is the right level here: checkPlaceholders is a private
// function not worth exporting just for a test, and the assertion is about
// the SECRET_KEYS array contents, not runtime behavior.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const configSource = readSource("packages/web/config/index.js");

describe("production placeholder guard — GITWIRE_EXECUTOR_SERVICE_TOKEN (P2 #2)", () => {
  it("SECRET_KEYS includes GITWIRE_EXECUTOR_SERVICE_TOKEN", () => {
    // Extract the SECRET_KEYS array body and assert the token is present.
    // This guards against drift: if the token is removed from SECRET_KEYS,
    // production could boot with a placeholder value.
    const secretKeysSection = configSource.split("SECRET_KEYS")[1].split("];")[0];
    expect(secretKeysSection).toMatch(/GITWIRE_EXECUTOR_SERVICE_TOKEN/);
  });

  it("the placeholder patterns catch token-like placeholder values", () => {
    // Sanity: the source defines placeholder patterns that would catch a
    // placeholder executor-service token value. We match the LITERAL source
    // text (the regex source contains 'YOUR[_-]TOKEN' as a literal pattern
    // definition); escaped brackets \[_-\] match the literal '[' and ']'
    // characters in the source rather than being interpreted as a character
    // class in THIS test's regex.
    expect(configSource).toMatch(/YOUR\[_-\]TOKEN/i);
    expect(configSource).toMatch(/YOUR\[_-\]SECRET/i);
    expect(configSource).toMatch(/\^changeme/i);
  });
});
