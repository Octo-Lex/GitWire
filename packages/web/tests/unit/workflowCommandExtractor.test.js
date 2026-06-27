// Tests for the repo-aware workflow command extractor (Task 8D).
//
// PURE — no I/O. Asserts that a MyShell-style `npx eslint app.js` step
// compiles to a safe descriptor, while unsafe forms (npm run, globs, absolute
// paths) are rejected as visible shape-invalid artifacts or not extracted.

import { describe, it, expect } from "@jest/globals";
import { extractValidationCommands } from "../../src/lib/workflowCommandExtractor.js";

describe("extractValidationCommands — MyShell proof path", () => {
  const MYSHELL_YAML = `
name: CI
on: [push]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint
        run: npx eslint app.js
`;

  it("derives repo_lint descriptor from `npx eslint app.js`", () => {
    const out = extractValidationCommands(MYSHELL_YAML, { failedJobName: "lint" });
    expect(out).toHaveLength(1);
    const d = out[0];
    expect(d.command_id).toBe("repo_lint");
    expect(d.semantic_id).toBe("lint_result");
    expect(d.argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
    expect(d.target_paths).toEqual(["app.js"]);
    expect(d.requires_shell).toBe(false);
    expect(d.network).toBe("disabled");
    expect(d.source).toBe("ci_workflow");
  });

  it("forces --no-install even when the step omits it", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint app.js
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out[0].argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
  });

  it("strips --yes/-y flags from npx", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx --yes eslint app.js
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out[0].argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
  });

  // The already-safe form must still extract. Without this, a repo that writes
  // `npx --no-install eslint app.js` gets NO descriptor and silently falls back
  // to the legacy `npm run lint --` — defeating the whole repo-aware point.
  it("extracts the already-safe `npx --no-install eslint app.js` form", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx --no-install eslint app.js
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out).toHaveLength(1);
    expect(out[0].argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
    expect(out[0].target_paths).toEqual(["app.js"]);
  });

  it("does not double-add --no-install when already present mid-argv", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx --yes --no-install eslint app.js
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out[0].argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
  });
});

describe("extractValidationCommands — npm run is never a descriptor", () => {
  it("does NOT extract `npm run lint`", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out).toEqual([]);
  });

  it("does NOT extract `npm test`", () => {
    const yaml = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    const out = extractValidationCommands(yaml, { failedJobName: "test" });
    expect(out).toEqual([]);
  });
});

describe("extractValidationCommands — unsafe target paths", () => {
  it("rejects glob `packages/*/src` as shape_invalid (visible, not dropped)", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint packages/*/src
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out).toHaveLength(1);
    const d = out[0];
    expect(d.policy_status).toBe("shape_invalid");
    expect(d.shape_reasons.join("; ")).toMatch(/glob/);
    expect(d.argv).toBeUndefined();
  });

  it("rejects absolute path as shape_invalid", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint /workspace/app.js
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out[0].policy_status).toBe("shape_invalid");
    expect(out[0].shape_reasons.join("; ")).toMatch(/absolute/);
  });

  it("rejects traversal (..) as shape_invalid", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint ../other/app.js
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out[0].policy_status).toBe("shape_invalid");
    expect(out[0].shape_reasons.join("; ")).toMatch(/traversal/);
  });

  it("rejects bare `eslint .` (directory, not explicit file)", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint .
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out[0].policy_status).toBe("shape_invalid");
    expect(out[0].shape_reasons.join("; ")).toMatch(/explicit file/);
  });
});

describe("extractValidationCommands — conservative job matching", () => {
  it("matches by exact job-id", () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: "npx tsc app.ts" }]
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: "npx eslint app.js" }]
`;
    const out = extractValidationCommands(yaml, { failedJobId: "lint" });
    expect(out).toHaveLength(1);
    expect(out[0].command_id).toBe("repo_lint");
  });

  it("matches by exact displayed job name", () => {
    const yaml = `
jobs:
  lint:
    name: Run Linter
    runs-on: ubuntu-latest
    steps: [{ run: "npx eslint app.js" }]
`;
    const out = extractValidationCommands(yaml, { failedJobName: "Run Linter" });
    expect(out).toHaveLength(1);
  });

  it("falls back to single-job workflow", () => {
    const yaml = `
jobs:
  only:
    runs-on: ubuntu-latest
    steps: [{ run: "npx eslint app.js" }]
`;
    const out = extractValidationCommands(yaml, {});
    expect(out).toHaveLength(1);
  });

  it("returns [] for multi-job workflow with no match", () => {
    const yaml = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "npx eslint a.js" }]
  b:
    runs-on: ubuntu-latest
    steps: [{ run: "npx eslint b.js" }]
`;
    const out = extractValidationCommands(yaml, { failedJobName: "nonexistent" });
    expect(out).toEqual([]);
  });
});

describe("extractValidationCommands — robustness", () => {
  it("returns [] on unparseable YAML", () => {
    expect(extractValidationCommands(":::not yaml:::", { failedJobName: "x" })).toEqual([]);
  });

  it("returns [] on empty input", () => {
    expect(extractValidationCommands("", {})).toEqual([]);
    expect(extractValidationCommands(null, {})).toEqual([]);
  });

  it("returns [] on workflow with no jobs", () => {
    expect(extractValidationCommands("name: CI\n", {})).toEqual([]);
  });

  it("rejects shell-chained commands (&&, |)", () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint app.js && echo done
`;
    const out = extractValidationCommands(yaml, { failedJobName: "lint" });
    expect(out).toEqual([]);
  });

  it("extracts multiple safe steps from one job", () => {
    const yaml = `
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: npx eslint app.js
      - run: npx tsc app.ts
`;
    const out = extractValidationCommands(yaml, { failedJobName: "ci" });
    expect(out).toHaveLength(2);
    expect(out.map(d => d.command_id).sort()).toEqual(["repo_lint", "repo_typecheck"]);
  });
});
