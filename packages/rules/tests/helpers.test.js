import {
  isPillarEnabled,
  isDryRun,
  isFileAllowed,
  isFixPathBlocked,
  isFixLabelAllowed,
  getStaleConfig,
  isStaleExempt,
  matchGlob,
  meetsConfidence,
  getMinPatchConfidence,
  getMinFixConfidence,
  scoreCIRisk,
  scoreFixRisk,
  shouldTrigger,
} from "../src/helpers.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/schema.js";

// ── isPillarEnabled ──────────────────────────────────────────────────────────

describe("isPillarEnabled", () => {
  test("triage is enabled by default", () => {
    expect(isPillarEnabled("triage", DEFAULT_CONFIG)).toBe(true);
  });

  test("ci_healing is enabled by default", () => {
    expect(isPillarEnabled("ci_healing", DEFAULT_CONFIG)).toBe(true);
  });

  test("issue_fix is disabled by default", () => {
    expect(isPillarEnabled("issue_fix", DEFAULT_CONFIG)).toBe(false);
  });

  test("returns true for unknown pillar (missing = not false)", () => {
    expect(isPillarEnabled("nonexistent", DEFAULT_CONFIG)).toBe(true);
  });

  test("returns false when explicitly disabled", () => {
    const config = { pillars: { triage: { enabled: false } } };
    expect(isPillarEnabled("triage", config)).toBe(false);
  });

  test("returns true when enabled is undefined (default true)", () => {
    const config = { pillars: { triage: { auto_label: true } } };
    expect(isPillarEnabled("triage", config)).toBe(true);
  });

  test("handles null config", () => {
    expect(isPillarEnabled("triage", null)).toBe(true);
  });

  test("handles undefined config", () => {
    expect(isPillarEnabled("triage", undefined)).toBe(true);
  });
});

// ── isDryRun ─────────────────────────────────────────────────────────────────

describe("isDryRun", () => {
  test("returns false by default", () => {
    expect(isDryRun(DEFAULT_CONFIG)).toBe(false);
  });

  test("returns true when settings.dry_run is true", () => {
    expect(isDryRun({ settings: { dry_run: true } })).toBe(true);
  });

  test("returns false when settings.dry_run is false", () => {
    expect(isDryRun({ settings: { dry_run: false } })).toBe(false);
  });

  test("returns false for null config", () => {
    expect(isDryRun(null)).toBe(false);
  });

  test("returns false for empty object", () => {
    expect(isDryRun({})).toBe(false);
  });
});

// ── isFileAllowed ────────────────────────────────────────────────────────────

describe("isFileAllowed", () => {
  test("normal source file is allowed", () => {
    expect(isFileAllowed("src/app.js", DEFAULT_CONFIG)).toBe(true);
  });

  test(".env files are blocked", () => {
    expect(isFileAllowed(".env", DEFAULT_CONFIG)).toBe(false);
    expect(isFileAllowed(".env.production", DEFAULT_CONFIG)).toBe(false);
    expect(isFileAllowed(".env.local", DEFAULT_CONFIG)).toBe(false);
  });

  test("secrets directory is blocked", () => {
    expect(isFileAllowed("secrets/token.json", DEFAULT_CONFIG)).toBe(false);
  });

  test(".pem files are blocked", () => {
    expect(isFileAllowed("cert.pem", DEFAULT_CONFIG)).toBe(false);
  });

  test(".key files are blocked", () => {
    expect(isFileAllowed("server.key", DEFAULT_CONFIG)).toBe(false);
  });

  test("README is allowed", () => {
    expect(isFileAllowed("README.md", DEFAULT_CONFIG)).toBe(true);
  });

  test("nested source file is allowed", () => {
    expect(isFileAllowed("packages/web/src/app.js", DEFAULT_CONFIG)).toBe(true);
  });

  test("custom blocked patterns work", () => {
    const config = {
      pillars: {
        ci_healing: {
          allowed_file_patterns: ["**"],
          blocked_file_patterns: ["src/legacy/**"],
        },
      },
    };
    expect(isFileAllowed("src/legacy/old.js", config)).toBe(false);
    expect(isFileAllowed("src/new.js", config)).toBe(true);
  });
});

// ── isFixPathBlocked ─────────────────────────────────────────────────────────

describe("isFixPathBlocked", () => {
  test("migrations directory is blocked", () => {
    expect(isFixPathBlocked("migrations/001.sql", DEFAULT_CONFIG)).toBe(true);
  });

  test(".github directory is blocked", () => {
    expect(isFixPathBlocked(".github/workflows/ci.yml", DEFAULT_CONFIG)).toBe(true);
  });

  test("db directory is blocked", () => {
    expect(isFixPathBlocked("db/schema.sql", DEFAULT_CONFIG)).toBe(true);
  });

  test("normal source file is not blocked", () => {
    expect(isFixPathBlocked("src/app.js", DEFAULT_CONFIG)).toBe(false);
  });
});

// ── isFixLabelAllowed ────────────────────────────────────────────────────────

describe("isFixLabelAllowed", () => {
  test("bug is allowed", () => {
    expect(isFixLabelAllowed("bug", DEFAULT_CONFIG)).toBe(true);
  });

  test("good first issue is allowed", () => {
    expect(isFixLabelAllowed("good first issue", DEFAULT_CONFIG)).toBe(true);
  });

  test("random label is not allowed", () => {
    expect(isFixLabelAllowed("wontfix", DEFAULT_CONFIG)).toBe(false);
  });

  test("case-insensitive matching", () => {
    expect(isFixLabelAllowed("Bug", DEFAULT_CONFIG)).toBe(true);
    expect(isFixLabelAllowed("BUG", DEFAULT_CONFIG)).toBe(true);
  });
});

// ── getStaleConfig ───────────────────────────────────────────────────────────

describe("getStaleConfig", () => {
  test("returns issue stale config", () => {
    const cfg = getStaleConfig("issues", DEFAULT_CONFIG);
    expect(cfg.warn_days).toBe(60);
    expect(cfg.exempt_labels).toContain("pinned");
  });

  test("returns PR stale config", () => {
    const cfg = getStaleConfig("prs", DEFAULT_CONFIG);
    expect(cfg.warn_days).toBe(30);
  });

  test("returns empty object for unknown type", () => {
    const cfg = getStaleConfig("unknown", DEFAULT_CONFIG);
    expect(cfg).toEqual({});
  });
});

// ── isStaleExempt ────────────────────────────────────────────────────────────

describe("isStaleExempt", () => {
  test("pinned label is exempt for issues", () => {
    expect(isStaleExempt(["pinned"], "issues", DEFAULT_CONFIG)).toBe(true);
  });

  test("security label is exempt for issues", () => {
    expect(isStaleExempt(["security"], "issues", DEFAULT_CONFIG)).toBe(true);
  });

  test("random label is not exempt", () => {
    expect(isStaleExempt(["enhancement"], "issues", DEFAULT_CONFIG)).toBe(false);
  });

  test("pinned label is exempt for PRs", () => {
    expect(isStaleExempt(["pinned"], "prs", DEFAULT_CONFIG)).toBe(true);
  });

  test("security label is NOT exempt for PRs by default", () => {
    expect(isStaleExempt(["security"], "prs", DEFAULT_CONFIG)).toBe(false);
  });
});

// ── matchGlob ────────────────────────────────────────────────────────────────

describe("matchGlob", () => {
  test("* matches filename", () => {
    expect(matchGlob("file.txt", "*.txt")).toBe(true);
    expect(matchGlob("file.js", "*.txt")).toBe(false);
  });

  test("* does not match /", () => {
    expect(matchGlob("dir/file.txt", "*.txt")).toBe(false);
  });

  test("** matches across directories", () => {
    expect(matchGlob("dir/file.txt", "**/*.txt")).toBe(true);
    expect(matchGlob("a/b/c/file.txt", "**/*.txt")).toBe(true);
  });

  test("** at start matches any prefix", () => {
    expect(matchGlob("secrets/key.pem", "secrets/**")).toBe(true);
    expect(matchGlob("secrets/sub/key.pem", "secrets/**")).toBe(true);
  });

  test(".env* matches .env variants", () => {
    expect(matchGlob(".env", ".env*")).toBe(true);
    expect(matchGlob(".env.production", ".env*")).toBe(true);
    expect(matchGlob(".env.local", ".env*")).toBe(true);
    expect(matchGlob(".environment", ".env*")).toBe(true);
  });

  test("literal match", () => {
    expect(matchGlob("README.md", "README.md")).toBe(true);
    expect(matchGlob("readme.md", "README.md")).toBe(false);
  });

  test("*.pem matches any .pem file", () => {
    expect(matchGlob("cert.pem", "*.pem")).toBe(true);
    expect(matchGlob("key.pem", "*.pem")).toBe(true);
    expect(matchGlob("cert.txt", "*.pem")).toBe(false);
  });
});

// ── validateConfig ───────────────────────────────────────────────────────────

describe("validateConfig", () => {
  test("accepts DEFAULT_CONFIG", () => {
    expect(validateConfig(DEFAULT_CONFIG).valid).toBe(true);
  });

  test("accepts empty object", () => {
    expect(validateConfig({}).valid).toBe(true);
  });

  test("accepts valid partial config", () => {
    expect(validateConfig({ version: 1, pillars: { triage: { enabled: true } } }).valid).toBe(true);
  });

  test("rejects non-object", () => {
    const result = validateConfig("not an object");
    expect(result.valid).toBe(false);
  });

  test("rejects non-boolean enabled", () => {
    const result = validateConfig({ pillars: { triage: { enabled: "yes" } } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("enabled must be a boolean");
  });

  test("rejects non-boolean dry_run", () => {
    const result = validateConfig({ settings: { dry_run: "yes" } });
    expect(result.valid).toBe(false);
  });

  test("rejects array pillars", () => {
    const result = validateConfig({ pillars: [1, 2, 3] });
    expect(result.valid).toBe(false);
  });
});

// ── meetsConfidence ──────────────────────────────────────────────────────────

describe("meetsConfidence", () => {
  test("high >= medium", () => { expect(meetsConfidence("high", "medium")).toBe(true); });
  test("high >= high", () => { expect(meetsConfidence("high", "high")).toBe(true); });
  test("medium >= medium", () => { expect(meetsConfidence("medium", "medium")).toBe(true); });
  test("low >= medium", () => { expect(meetsConfidence("low", "medium")).toBe(false); });
  test("low >= low", () => { expect(meetsConfidence("low", "low")).toBe(true); });
  test("medium >= high", () => { expect(meetsConfidence("medium", "high")).toBe(false); });
  test("unknown >= low", () => { expect(meetsConfidence("garbage", "low")).toBe(false); });
});

// ── getMinPatchConfidence / getMinFixConfidence ──────────────────────────────

describe("confidence thresholds", () => {
  test("default patch threshold is medium", () => {
    expect(getMinPatchConfidence(DEFAULT_CONFIG)).toBe("medium");
  });

  test("default fix threshold is medium", () => {
    expect(getMinFixConfidence(DEFAULT_CONFIG)).toBe("medium");
  });

  test("reads custom patch threshold", () => {
    const config = { pillars: { ci_healing: { min_confidence_to_patch: "high" } } };
    expect(getMinPatchConfidence(config)).toBe("high");
  });

  test("reads custom fix threshold", () => {
    const config = { pillars: { issue_fix: { min_confidence_to_submit: "low" } } };
    expect(getMinFixConfidence(config)).toBe("low");
  });
});

// ── scoreCIRisk ──────────────────────────────────────────────────────────────

describe("scoreCIRisk", () => {
  test("safe lint error with high confidence = low risk", () => {
    const result = scoreCIRisk({
      failure_type: "lint_error", confidence: "high", auto_fixable: true, failing_file: "src/app.js",
    });
    expect(result.level).toBe("low");
    expect(result.score).toBeLessThan(25);
  });

  test("infra error with low confidence = high risk", () => {
    const result = scoreCIRisk({
      failure_type: "infra_error", confidence: "low", auto_fixable: false, failing_file: null,
    });
    expect(result.level).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  test("flaky test with medium confidence = medium risk", () => {
    const result = scoreCIRisk({
      failure_type: "test_flaky", confidence: "medium", auto_fixable: true, failing_file: "test/app.test.js",
    });
    expect(result.level).toBe("medium");
    expect(result.score).toBeGreaterThanOrEqual(25);
  });

  test("unknown failure without file = high risk", () => {
    const result = scoreCIRisk({
      failure_type: "unknown", confidence: "medium", auto_fixable: false, failing_file: null,
    });
    expect(result.level).toBe("high");
  });

  test("reasons list is populated", () => {
    const result = scoreCIRisk({ failure_type: "lint_error", confidence: "high", failing_file: "a.js" });
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

// ── scoreFixRisk ─────────────────────────────────────────────────────────────

describe("scoreFixRisk", () => {
  const origFiles = [
    { path: "src/app.js", content: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n" },
  ];

  test("trivial single-file fix = low risk", () => {
    const result = scoreFixRisk(
      { complexity: "trivial" },
      [{ path: "src/app.js", fixed_content: "line1\nFIXED\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n" }],
      origFiles
    );
    expect(result.level).toBe("low");
    expect(result.score).toBeLessThan(25);
  });

  test("complex multi-file fix = high risk", () => {
    const fixes = [
      { path: "src/app.js", fixed_content: "totally different" },
      { path: "src/util.js", fixed_content: "new" },
      { path: "src/db.js", fixed_content: "new" },
      { path: "src/routes.js", fixed_content: "new" },
    ];
    const result = scoreFixRisk({ complexity: "complex" }, fixes, origFiles);
    expect(result.level).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  test("moderate fix with large delta = medium risk", () => {
    const result = scoreFixRisk(
      { complexity: "moderate" },
      [{ path: "src/app.js", fixed_content: "only 2 lines" }],
      origFiles
    );
    expect(result.level).toBe("medium");
  });
});

// ── shouldTrigger ─────────────────────────────────────────────────────────────

describe("shouldTrigger", () => {
  test("returns true when no triggers config", () => {
    expect(shouldTrigger("ci_healing", { branch: "feature/foo" }, {})).toBe(true);
  });

  test("returns true when triggers are empty arrays", () => {
    const config = { pillars: { ci_healing: { triggers: { branches: [], ignore_authors: [] } } } };
    expect(shouldTrigger("ci_healing", { branch: "anything" }, config)).toBe(true);
  });

  test("returns true when branch matches", () => {
    const config = { pillars: { ci_healing: { triggers: { branches: ["main", "develop"] } } } };
    expect(shouldTrigger("ci_healing", { branch: "main" }, config)).toBe(true);
  });

  test("returns false when branch does not match", () => {
    const config = { pillars: { ci_healing: { triggers: { branches: ["main", "develop"] } } } };
    expect(shouldTrigger("ci_healing", { branch: "feature/foo" }, config)).toBe(false);
  });

  test("returns false when author is in ignore list", () => {
    const config = { pillars: { triage: { triggers: { ignore_authors: ["*[bot]", "renovate*"] } } } };
    expect(shouldTrigger("triage", { author: "dependabot[bot]" }, config)).toBe(false);
  });

  test("returns true when author is not in ignore list", () => {
    const config = { pillars: { triage: { triggers: { ignore_authors: ["*[bot]"] } } } };
    expect(shouldTrigger("triage", { author: "john" }, config)).toBe(true);
  });

  test("returns true when path matches", () => {
    const config = { pillars: { ai_review: { triggers: { paths: ["src/**", "lib/**"] } } } };
    expect(shouldTrigger("ai_review", { paths: ["src/app.js", "docs/readme.md"] }, config)).toBe(true);
  });

  test("returns false when no paths match", () => {
    const config = { pillars: { ai_review: { triggers: { paths: ["src/**"] } } } };
    expect(shouldTrigger("ai_review", { paths: ["docs/readme.md", "assets/logo.png"] }, config)).toBe(false);
  });

  test("returns true when no paths provided but paths filter set", () => {
    const config = { pillars: { ai_review: { triggers: { paths: ["src/**"] } } } };
    expect(shouldTrigger("ai_review", {}, config)).toBe(true);
  });

  test("combined: branch matches but author ignored", () => {
    const config = {
      pillars: {
        ci_healing: {
          triggers: {
            branches: ["main"],
            ignore_authors: ["dependabot[bot]"],
          },
        },
      },
    };
    expect(shouldTrigger("ci_healing", { branch: "main", author: "dependabot[bot]" }, config)).toBe(false);
  });
});
