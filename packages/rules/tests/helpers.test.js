import {
  isPillarEnabled,
  isDryRun,
  isFileAllowed,
  isFixPathBlocked,
  isFixLabelAllowed,
  getStaleConfig,
  isStaleExempt,
  matchGlob,
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
