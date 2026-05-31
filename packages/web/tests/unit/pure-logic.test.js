// tests/unit/pure-logic.test.js
// Unit tests for all exported pure-logic functions across services

import { jest } from "@jest/globals";

// Mock config before any imports that use it
jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    port: 3000, nodeEnv: "test",
    database: { url: "postgres://test:test@localhost/test" },
    redis: { url: "redis://localhost:6379" },
    anthropic: { apiKey: "test", baseURL: "https://test.com" },
    github: { appId: "1", privateKey: "test", webhookSecret: "test", clientId: "test", clientSecret: "test" },
    apiKey: "test", telegram: { botToken: "test" }, dashboard: { url: "http://localhost:3001" },
  },
}));

// Mock db to prevent pg connection
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: {} }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({ redis: {}, createWorker: jest.fn(), QUEUES: {} }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule("../../src/lib/github.js", () => ({ getInstallationClient: jest.fn(), forEachInstallation: jest.fn(), getWebhookApp: jest.fn(), forEachRepo: jest.fn() }));

const { similarityLabel } = await import("../../src/services/duplicateDetectionService.js");
const { computeVerdict, confidenceLevel } = await import("../../src/services/aiReviewService.js");
const { formatVal, computeViolations, buildProtectionPayload } = await import("../../src/services/branchEnforcementService.js");
const { inferEcosystem } = await import("../../src/services/dependencyService.js");
const { matchGlob } = await import("../../src/services/feedbackService.js");
const { makeTestId } = await import("../../src/services/flakyTestService.js");
const { getFileType } = await import("../../src/services/configValidationService.js");
const { computeDiff } = await import("../../src/services/policyReconcilerService.js");
const { extractJSON } = await import("../../src/workers/issueFixWorker.js");
const { stripCodeFences, truncate, failing_file_ext } = await import("../../src/workers/ciHealWorker.js");

// ── similarityLabel ─────────────────────────────────────────────────────────

describe('similarityLabel', () => {
  test('0.98 → "almost identical"', () => expect(similarityLabel(0.98)).toBe('almost identical'));
  test('0.97 → "almost identical"', () => expect(similarityLabel(0.97)).toBe('almost identical'));
  test('0.96 → "very high confidence"', () => expect(similarityLabel(0.96)).toBe('very high confidence'));
  test('0.95 → "very high confidence"', () => expect(similarityLabel(0.95)).toBe('very high confidence'));
  test('0.93 → "high confidence"', () => expect(similarityLabel(0.93)).toBe('high confidence'));
  test('0.92 → "high confidence"', () => expect(similarityLabel(0.92)).toBe('high confidence'));
  test('0.80 → "moderate confidence"', () => expect(similarityLabel(0.80)).toBe('moderate confidence'));
  test('0.50 → "moderate confidence"', () => expect(similarityLabel(0.50)).toBe('moderate confidence'));
  test('0.0 → "moderate confidence"', () => expect(similarityLabel(0.0)).toBe('moderate confidence'));
});

// ── computeVerdict ───────────────────────────────────────────────────────────

describe('computeVerdict', () => {
  test('no findings → approved', () => {
    expect(computeVerdict([], { block_on: ['critical'] })).toEqual({ verdict: 'approved', confidence: 'high' });
  });

  test('info finding → approved', () => {
    const findings = [{ severity: 'info', message: 'Note' }];
    expect(computeVerdict(findings, { block_on: ['critical'] })).toEqual({ verdict: 'approved', confidence: 'high' });
  });

  test('1 high finding → needs_discussion', () => {
    const findings = [{ severity: 'high', message: 'Issue' }];
    expect(computeVerdict(findings, {})).toEqual({ verdict: 'needs_discussion', confidence: 'medium' });
  });

  test('3+ high findings → request_changes', () => {
    const findings = [{ severity: 'high', message: 'A' }, { severity: 'high', message: 'B' }, { severity: 'high', message: 'C' }];
    expect(computeVerdict(findings, {})).toEqual({ verdict: 'request_changes', confidence: 'medium' });
  });

  test('critical finding → request_changes', () => {
    const findings = [{ severity: 'critical', message: 'Secret!' }];
    expect(computeVerdict(findings, {})).toEqual({ verdict: 'request_changes', confidence: 'high' });
  });

  test('5+ info findings → needs_discussion low', () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({ severity: 'info', message: `Note ${i}` }));
    expect(computeVerdict(findings, {})).toEqual({ verdict: 'needs_discussion', confidence: 'low' });
  });
});

// ── confidenceLevel ──────────────────────────────────────────────────────────

describe('confidenceLevel', () => {
  test('high → 3', () => expect(confidenceLevel('high')).toBe(3));
  test('medium → 2', () => expect(confidenceLevel('medium')).toBe(2));
  test('low → 1', () => expect(confidenceLevel('low')).toBe(1));
  test('unknown → 1', () => expect(confidenceLevel('unknown')).toBe(1));
  test('empty → 1', () => expect(confidenceLevel('')).toBe(1));
});

// ── formatVal ────────────────────────────────────────────────────────────────

describe('formatVal', () => {
  test('string → as-is', () => expect(formatVal('hello')).toBe('hello'));
  test('number → string', () => expect(formatVal(42)).toBe('42'));
  test('boolean true → enabled', () => expect(formatVal(true)).toBe('enabled'));
  test('boolean false → disabled', () => expect(formatVal(false)).toBe('disabled'));
  test('null → "null"', () => expect(formatVal(null)).toBe('null'));
  test('undefined → "undefined"', () => expect(formatVal(undefined)).toBe('undefined'));
});

// ── computeViolations ────────────────────────────────────────────────────────

describe('computeViolations', () => {
  const basePolicy = {
    min_reviews: 2,
    require_linear_history: true,
    block_force_pushes: true,
    block_deletions: false,
    enforce_admins: true,
  };

  test('null live state → all fields violated', () => {
    const v = computeViolations(basePolicy, null);
    expect(v.length).toBe(4); // reviews, linear, force_pushes, admins
    expect(v.find(x => x.field === 'required_reviews')).toBeTruthy();
    expect(v.find(x => x.field === 'require_linear_history')).toBeTruthy();
  });

  test('fully compliant live state → no violations', () => {
    const live = {
      required_reviews: 2,
      require_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: true, // not blocked
      enforce_admins: true,
      require_status_checks: false,
    };
    expect(computeViolations(basePolicy, live)).toEqual([]);
  });

  test('missing reviews → violation', () => {
    const live = {
      required_reviews: 1,
      require_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: true,
      enforce_admins: true,
      require_status_checks: false,
    };
    const v = computeViolations(basePolicy, live);
    expect(v.length).toBe(1);
    expect(v[0].field).toBe('required_reviews');
    expect(v[0].expected).toBe(2);
    expect(v[0].actual).toBe(1);
  });

  test('force push allowed → violation', () => {
    const live = {
      required_reviews: 2,
      require_linear_history: true,
      allow_force_pushes: true,
      allow_deletions: true,
      enforce_admins: true,
      require_status_checks: false,
    };
    const v = computeViolations(basePolicy, live);
    expect(v.length).toBe(1);
    expect(v[0].field).toBe('allow_force_pushes');
  });
});

// ── buildProtectionPayload ───────────────────────────────────────────────────

describe('buildProtectionPayload', () => {
  test('builds correct payload from policy', () => {
    const policy = { min_reviews: 2, require_linear_history: true, block_force_pushes: true, block_deletions: false, enforce_admins: false, require_status_checks: false };
    const payload = buildProtectionPayload(policy, null);
    expect(payload.required_pull_request_reviews.required_approving_review_count).toBe(2);
    expect(payload.required_linear_history).toBe(true);
    expect(payload.allow_force_pushes).toBe(false);
    expect(payload.enforce_admins).toBe(false);
  });

  test('preserves existing live state contexts', () => {
    const policy = { min_reviews: 1, require_linear_history: false, block_force_pushes: false, block_deletions: false, enforce_admins: false, require_status_checks: true };
    const live = { required_status_checks: { contexts: ['ci'] }, required_reviews: 0 };
    const payload = buildProtectionPayload(policy, live);
    expect(payload.required_status_checks.contexts).toContain('ci');
  });
});

// ── inferEcosystem ───────────────────────────────────────────────────────────

describe('inferEcosystem', () => {
  test('package.json → npm', () => expect(inferEcosystem('package.json')).toBe('npm'));
  test('dir/package.json → npm', () => expect(inferEcosystem('sub/package.json')).toBe('npm'));
  test('requirements.txt → pip', () => expect(inferEcosystem('requirements.txt')).toBe('pip'));
  test('requirements-dev.txt → pip', () => expect(inferEcosystem('requirements-dev.txt')).toBe('pip'));
  test('Pipfile.lock → pip', () => expect(inferEcosystem('Pipfile.lock')).toBe('pip'));
  test('Gemfile.lock → rubygems', () => expect(inferEcosystem('Gemfile.lock')).toBe('rubygems'));
  test('go.sum → go', () => expect(inferEcosystem('go.sum')).toBe('go'));
  test('Cargo.toml → cargo', () => expect(inferEcosystem('Cargo.toml')).toBe('cargo'));
  test('pom.xml → maven', () => expect(inferEcosystem('pom.xml')).toBe('maven'));
  test('random.txt → unknown', () => expect(inferEcosystem('random.txt')).toBe('unknown'));
  test('README.md → unknown', () => expect(inferEcosystem('README.md')).toBe('unknown'));
});

// ── matchGlob ────────────────────────────────────────────────────────────────

describe('matchGlob', () => {
  test('exact match', () => expect(matchGlob('hello', 'hello')).toBe(true));
  test('no match', () => expect(matchGlob('hello', 'world')).toBe(false));
  test('single wildcard *', () => expect(matchGlob('hel*', 'hello')).toBe(true));
  test('single wildcard * does not cross /', () => expect(matchGlob('src/*', 'src/lib/file.js')).toBe(false));
  test('double wildcard ** crosses /', () => expect(matchGlob('src/**', 'src/lib/file.js')).toBe(true));
  test('** matches everything', () => expect(matchGlob('**', 'any/path/here')).toBe(true));
  test('prefix + wildcard', () => expect(matchGlob('feat/*', 'feat/add-login')).toBe(true));
  test('prefix + wildcard no match', () => expect(matchGlob('feat/*', 'fix/bug')).toBe(false));
});

// ── makeTestId ───────────────────────────────────────────────────────────────

describe('makeTestId', () => {
  test('deterministic', () => {
    const a = makeTestId(1, 'suite', 'test');
    const b = makeTestId(1, 'suite', 'test');
    expect(a).toBe(b);
  });

  test('different inputs → different IDs', () => {
    const a = makeTestId(1, 'suite', 'testA');
    const b = makeTestId(1, 'suite', 'testB');
    expect(a).not.toBe(b);
  });

  test('16 chars long (hex)', () => {
    const id = makeTestId(42, 'my-suite', 'my-test');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── getFileType ──────────────────────────────────────────────────────────────

describe('getFileType', () => {
  test('.github/workflows/ci.yml → github_actions', () => {
    expect(getFileType('.github/workflows/ci.yml')).toBe('github_actions');
  });
  test('.github/workflows/ci.yaml → github_actions', () => {
    expect(getFileType('.github/workflows/ci.yaml')).toBe('github_actions');
  });
  test('.github/dependabot.yml → github_config', () => {
    expect(getFileType('.github/dependabot.yml')).toBe('github_config');
  });
  test('main.tf → terraform', () => {
    expect(getFileType('main.tf')).toBe('terraform');
  });
  test('docker-compose.yml → docker_compose', () => {
    expect(getFileType('docker-compose.yml')).toBe('docker_compose');
  });
  test('compose.yaml → docker_compose', () => {
    expect(getFileType('compose.yaml')).toBe('docker_compose');
  });
  test('package.json → package_json', () => {
    expect(getFileType('package.json')).toBe('package_json');
  });
  test('tsconfig.json → tsconfig', () => {
    expect(getFileType('tsconfig.json')).toBe('tsconfig');
  });
  test('random.txt → null', () => {
    expect(getFileType('random.txt')).toBeNull();
  });
  test('config.yml → yaml', () => {
    expect(getFileType('config.yml')).toBe('yaml');
  });
});

// ── computeDiff ──────────────────────────────────────────────────────────────

describe('computeDiff', () => {
  const base = {
    branch_protection: { required_reviews: 2, require_linear_history: true },
    required_labels: [{ name: 'bug' }],
    settings: { allow_squash_merge: true },
  };

  test('identical → inSync', () => {
    const result = computeDiff(base, {
      branch_protection: { required_reviews: 2, require_linear_history: true },
      required_labels: [{ name: 'bug' }],
      settings: { allow_squash_merge: true },
    });
    expect(result.inSync).toBe(true);
    expect(result.driftFields).toEqual([]);
  });

  test('missing branch protection → drift', () => {
    const result = computeDiff(base, {
      branch_protection: null,
      required_labels: [{ name: 'bug' }],
      settings: { allow_squash_merge: true },
    });
    expect(result.inSync).toBe(false);
    expect(result.driftFields).toContain('branch_protection.missing');
  });

  test('different settings → drift', () => {
    const result = computeDiff(base, {
      branch_protection: { required_reviews: 2, require_linear_history: true },
      required_labels: [{ name: 'bug' }],
      settings: { allow_squash_merge: false },
    });
    expect(result.inSync).toBe(false);
    expect(result.driftFields).toContain('settings.allow_squash_merge');
  });

  test('missing label → drift', () => {
    const result = computeDiff(base, {
      branch_protection: { required_reviews: 2, require_linear_history: true },
      required_labels: [],
      settings: { allow_squash_merge: true },
    });
    expect(result.inSync).toBe(false);
    expect(result.driftFields).toContain('label.missing.bug');
  });
});

// ── extractJSON ──────────────────────────────────────────────────────────────

describe('extractJSON', () => {
  test('raw JSON object', () => {
    const result = extractJSON('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  test('JSON in code fences', () => {
    const result = extractJSON('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  test('JSON in plain code fences', () => {
    const result = extractJSON('```\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  test('JSON with surrounding text', () => {
    const result = extractJSON('Here is the result:\n```json\n{"ok": true}\n```\nDone.');
    expect(result).toEqual({ ok: true });
  });

  test('invalid JSON → null', () => {
    expect(extractJSON('not json at all')).toBeNull();
  });

  test('nested code fences → tries innermost', () => {
    const result = extractJSON('```\n```json\n{"deep": true}\n```\n```');
    expect(result).toEqual({ deep: true });
  });

  test('empty string → null', () => {
    expect(extractJSON('')).toBeNull();
  });
});

// ── stripCodeFences ──────────────────────────────────────────────────────────

describe('stripCodeFences', () => {
  test('removes ```json...```', () => {
    expect(stripCodeFences('```json\nhello\n```')).toBe('hello');
  });

  test('removes ```...```', () => {
    expect(stripCodeFences('```\nhello\n```')).toBe('hello');
  });

  test('no fences → as-is', () => {
    expect(stripCodeFences('hello world')).toBe('hello world');
  });

  test('empty → empty', () => {
    expect(stripCodeFences('')).toBe('');
  });

  test('trims whitespace', () => {
    expect(stripCodeFences('```json\n  hello  \n```')).toBe('hello');
  });
});

// ── truncate ─────────────────────────────────────────────────────────────────

describe('truncate', () => {
  test('short string → as-is', () => expect(truncate('hello', 10)).toBe('hello'));
  test('exact length → as-is', () => expect(truncate('hello', 5)).toBe('hello'));
  test('too long → truncated with …', () => {
    expect(truncate('hello world', 10)).toBe('hello wor…');
  });
  test('very short max → still works', () => {
    expect(truncate('hello', 3)).toBe('he…');
  });
});

// ── failing_file_ext ─────────────────────────────────────────────────────────

describe('failing_file_ext', () => {
  test('file.js → js', () => expect(failing_file_ext('app.js')).toBe('js'));
  test('file.ts → ts', () => expect(failing_file_ext('utils.ts')).toBe('ts'));
  test('file.py → py', () => expect(failing_file_ext('main.py')).toBe('py'));
  test('no extension → misc', () => expect(failing_file_ext('Makefile')).toBe('misc'));
  test('path with dirs → last ext', () => expect(failing_file_ext('src/lib/app.tsx')).toBe('tsx'));
  test('dotfile → misc', () => expect(failing_file_ext('.env')).toBe('env'));
});
