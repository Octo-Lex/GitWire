// Tests for the authoritative command-descriptor policy gate (Task 8D).
//
// This is the SINGLE security boundary. Web validates shape only; this module
// enforces allowlist/metachar/path rules. All violations reject fail-closed.

import { describe, it, expect } from "@jest/globals";
import { enforceDescriptorPolicy } from "../src/commandDescriptorPolicy.js";

const VALID = {
  command_id: "repo_lint",
  semantic_id: "lint_result",
  source: "ci_workflow",
  argv: ["npx", "--no-install", "eslint", "app.js"],
  target_paths: ["app.js"],
  network: "disabled",
  requires_shell: false,
};

describe("enforceDescriptorPolicy — valid descriptor", () => {
  it("accepts the MyShell proof descriptor", () => {
    expect(enforceDescriptorPolicy(VALID)).toEqual({ ok: true, reasons: [] });
  });

  it("accepts node <script>", () => {
    const d = { ...VALID, argv: ["node", "test.js"], target_paths: ["test.js"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(true);
  });

  it("accepts tsc", () => {
    const d = { ...VALID, argv: ["tsc", "app.ts"], target_paths: ["app.ts"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(true);
  });
});

describe("enforceDescriptorPolicy — binary allowlist", () => {
  it("rejects npm run (not a descriptor path)", () => {
    const d = { ...VALID, argv: ["npm", "run", "lint"], target_paths: ["app.js"] };
    const r = enforceDescriptorPolicy(d);
    expect(r.ok).toBe(false);
    expect(r.reasons.join("; ")).toMatch(/not allowlisted/);
  });

  it("rejects an unknown binary", () => {
    const d = { ...VALID, argv: ["curl", "http://evil"], target_paths: ["app.js"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });
});

describe("enforceDescriptorPolicy — npx requires --no-install", () => {
  it("rejects npx without --no-install", () => {
    const d = { ...VALID, argv: ["npx", "eslint", "app.js"] };
    const r = enforceDescriptorPolicy(d);
    expect(r.ok).toBe(false);
    expect(r.reasons.join("; ")).toMatch(/--no-install/);
  });

  it("rejects npx --yes (wrong flag) without --no-install", () => {
    const d = { ...VALID, argv: ["npx", "--yes", "eslint", "app.js"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });
});

describe("enforceDescriptorPolicy — shell metacharacters", () => {
  it("rejects shell metacharacters in argv", () => {
    const d = { ...VALID, argv: ["npx", "--no-install", "eslint; rm -rf /", "app.js"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });

  it("rejects backticks", () => {
    const d = { ...VALID, argv: ["npx", "--no-install", "eslint", "`whoami`"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });
});

describe("enforceDescriptorPolicy — target path safety", () => {
  it("rejects absolute path", () => {
    const d = { ...VALID, target_paths: ["/etc/passwd"] };
    const r = enforceDescriptorPolicy(d);
    expect(r.ok).toBe(false);
    expect(r.reasons.join("; ")).toMatch(/absolute/);
  });

  it("rejects traversal (..)", () => {
    const d = { ...VALID, target_paths: ["../secret.js"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });

  it("rejects glob *", () => {
    const d = { ...VALID, target_paths: ["packages/*/src"] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });

  it("rejects bare '.'", () => {
    const d = { ...VALID, target_paths: ["."] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });

  it("rejects empty target_paths", () => {
    const d = { ...VALID, target_paths: [] };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });
});

describe("enforceDescriptorPolicy — isolation flags", () => {
  it("rejects requires_shell=true", () => {
    const d = { ...VALID, requires_shell: true };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });

  it("rejects network != disabled", () => {
    const d = { ...VALID, network: "enabled" };
    expect(enforceDescriptorPolicy(d).ok).toBe(false);
  });
});

describe("enforceDescriptorPolicy — shape-invalid", () => {
  it("rejects when argv is missing (shape-invalid)", () => {
    const d = { ...VALID, argv: undefined };
    const r = enforceDescriptorPolicy(d);
    expect(r.ok).toBe(false);
    expect(r.reasons.join("; ")).toMatch(/shape invalid/);
  });
});
