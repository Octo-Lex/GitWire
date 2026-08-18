// Phase 9 harness A/B runner (RI-9 amendment). ONE bounded matrix:
// 12 predeclared interleaved invocations (3 per arm per variant over RI-04
// broken + fixed), no retries, append-only records. Refuses to run without
// GITWIRE_AB_RUN=1 and provider credentials — CI can never spend.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (process.env.GITWIRE_AB_RUN !== "1") {
    console.error("refusing: set GITWIRE_AB_RUN=1 for the frozen 12-run A/B matrix");
    process.exit(2);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!apiKey || !baseUrl) {
    console.error("refusing: ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL are required");
    process.exit(2);
  }

  const { prepareRepository } = await import("../../../src/lib/repositoryTools/repositorySession.js");
  const { createPiHarness } = await import("../../../src/lib/reviewHarness/pi/piHarness.js");
  const { createCurrentGitWireHarness } = await import("../../../src/lib/reviewHarness/currentGitWire/currentGitWireHarness.js");
  const { CURRENT_PROMPT_VERSION } = await import("../../../src/lib/reviewHarness/currentGitWire/prompts.js");
  const { buildAbManifest, AB_ORDER, AB_BUDGETS, AB_OBJECTIVE_PREAMBLE, RI04_EXPECTED } = await import("../../../src/lib/reviewHarness/abManifest.js");
  const { scoreRun, buildScorecard, applyDecisionRule } = await import("../../../src/lib/reviewHarness/abScoring.js");
  const { verifySubmissionEvidence, brokerReconstruct } = await import("../../../src/services/piSubmissionVerificationService.js");
  const { parseEvidenceRef, validateFinding } = await import("../../../src/services/findingValidator.js");
  const { createContextBroker } = await import("../../../src/services/reviewContextBroker.js");
  const { buildFixtureOctokit } = await import("./fixtureOctokit.js");
  const { loadFixture } = await import("./fixtures/fixtureGitMaterializer.js");

  const gitHead = execSync("git rev-parse HEAD", { cwd: path.join(__dirname, "..", "..", "..") }).toString().trim();

  const model = {
    id: "glm-5.3",
    name: "glm-5.3 (Z.AI, pinned)",
    api: "anthropic-messages",
    provider: "zai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.6, output: 2.2, cacheRead: 0.08, cacheWrite: 0.8 },
    contextWindow: 128000,
    maxTokens: 8192,
  };

  const probeHarness = createPiHarness({ model, runtimeApiKey: apiKey, resolveRepositorySession: () => null });
  const manifest = buildAbManifest({
    gitHead,
    provider: "zai",
    model: "glm-5.3",
    piPromptVersion: probeHarness.promptVersion,
    currentPromptVersion: CURRENT_PROMPT_VERSION,
    piPackageVersion: probeHarness.version,
  });
  if (probeHarness.version === "unknown") {
    throw new Error("Pi package version unreadable — refusing an unversioned paid matrix");
  }
  console.log("=== PHASE 9 A/B (frozen 12-run matrix) ===");
  console.log("head:", gitHead, "| manifest:", manifest.manifestHash);

  const stampDir = path.join(__dirname, "runs", `ab-${new Date().toISOString().slice(0, 10)}-${Date.now()}`);
  fs.mkdirSync(stampDir, { recursive: true });
  fs.writeFileSync(path.join(stampDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const fixtures = { broken: loadFixture("ri04", "broken"), fixed: loadFixture("ri04", "fixed") };
  for (const [variant, fixture] of Object.entries(fixtures)) {
    const expected = manifest.fixtures.find((f) => f.variant === variant).fixtureHead;
    if (!fixture.source.head.startsWith(expected)) {
      throw new Error(`fixture head drifted for ${variant}: ${fixture.source.head} (frozen ${expected})`);
    }
  }

  const reposDir = path.join(__dirname, "fixtures", "snapshots", "repos");
  const blobs = JSON.parse(fs.readFileSync(path.join(reposDir, "gitwire-blobs.json"), "utf8"));
  const tree = (ref) => JSON.parse(fs.readFileSync(path.join(reposDir, `gitwire-${ref}.tree.json`), "utf8"));

  const scored = [];
  let invocation = 0;

  for (const entry of AB_ORDER) {
    invocation += 1;
    const fixture = fixtures[entry.variant];
    const headTree = tree(fixture.source.head);
    const baseTree = tree(fixture.source.base);

    const repositorySession = await prepareRepository({
      invocationId: `ab-${invocation}-${entry.arm}`,
      repository: fixture.source.repo,
      headSha: fixture.source.head,
      baseSha: fixture.source.base,
      acquire: {
        mode: "snapshot",
        baseTree: { ref: fixture.source.base, tree: baseTree.tree },
        headTree: { ref: fixture.source.head, tree: headTree.tree },
        blobs,
      },
    });

    const harness =
      entry.arm === "pi"
        ? createPiHarness({ model, runtimeApiKey: apiKey, resolveRepositorySession: (id) => (id === repositorySession.id ? repositorySession : null) })
        : createCurrentGitWireHarness({
            model,
            runtimeApiKey: apiKey,
            resolveRepositorySession: (id) => (id === repositorySession.id ? repositorySession : null),
            changedFilesProvider: async () => fixture.changedFiles,
          });

    const changedSummary = fixture.changedFiles
      .map((cf) => `--- ${cf.filename} (${cf.status}) ---\n${cf.patch ?? "(no patch text)"}`)
      .join("\n\n");
    const objective = [
      AB_OBJECTIVE_PREAMBLE,
      "",
      `Pull request: ${fixture.prMetadata.title}`,
      "",
      "Changed files (diff vs BASE):",
      changedSummary,
    ].join("\n");

    const task = {
      reviewInvocationId: `rinv-ab-${invocation}`,
      repositorySessionId: repositorySession.id,
      repository: { owner: "Octo-Lex", name: "GitWire" },
      baseSha: fixture.source.base,
      headSha: fixture.source.head,
      reviewRoot: { invocationId: `rinv-ab-${invocation}`, baseSha: fixture.source.base, headSha: fixture.source.head },
      objective,
      findingSchema: { name: "gitwire-findings", version: "2" },
      deadlineMs: AB_BUDGETS.deadlineMs,
      budget: { maxToolCalls: AB_BUDGETS.maxToolCalls, maxCostUsd: AB_BUDGETS.maxCostUsd, maxTotalTokens: AB_BUDGETS.maxTotalTokens },
    };

    const repIndex = Math.floor((AB_ORDER.filter((o) => o.variant === entry.variant && o.arm === entry.arm).findIndex((o) => o === entry)) ?? 0) + 1;
    console.log(`[${invocation}/12] ${entry.variant} ${entry.arm} (rep ${repIndex}) ...`);
    const startedAt = new Date().toISOString();
    const execution = await harness.runReview(task);
    const finishedAt = new Date().toISOString();

    // Same downstream validation for BOTH arms.
    const broker = createContextBroker({
      octokit: buildFixtureOctokit(fixture),
      owner: "org",
      repo: "repo",
      baseSha: fixture.source.base,
      headSha: fixture.source.head,
    });
    let submissionVerification = null;
    const ri4FindingValidation = [];
    if (execution.submission) {
      submissionVerification = await verifySubmissionEvidence({
        submission: execution.submission.payload,
        repositorySession,
        toolTrace: execution.toolTrace,
        reconstruct: brokerReconstruct(broker, fixture.source.head),
      });
      const contextItems = [];
      for (const ref of execution.submission.payload.findings.flatMap((f) => f.evidenceRefs ?? [])) {
        const parsed = parseEvidenceRef(ref);
        if (!parsed || parsed.type !== "repo-read") continue;
        const fileRead = await broker.readRepoFile(parsed.path, fixture.source.head, {
          range: { startLine: parsed.startLine, endLine: parsed.endLine },
        });
        if (fileRead.type === "file_read") contextItems.push(fileRead);
      }
      for (const finding of execution.submission.payload.findings) {
        const v = validateFinding(finding, { review: { headSha: fixture.source.head } }, contextItems);
        ri4FindingValidation.push({ claim: finding.claim, valid: v.valid, errors: v.errors, warnings: v.warnings, downgraded: v.downgraded });
      }
    }

    const record = {
      kind: "phase9-ab-run",
      manifestHash: manifest.manifestHash,
      invocation,
      arm: entry.arm,
      variant: entry.variant,
      repetition: repIndex,
      startedAt,
      finishedAt,
      execution,
      submissionVerification,
      ri4FindingValidation,
      expectedSignature: RI04_EXPECTED[entry.variant],
      mutationOccurred: false,
    };
    fs.writeFileSync(
      path.join(stampDir, `run-${String(invocation).padStart(2, "0")}-${entry.arm}-${entry.variant}.json`),
      JSON.stringify(record, null, 2) + "\n",
      "utf8"
    );
    scored.push(scoreRun(record));
    repositorySession.close();
    console.log(
      `  -> ${execution.status}/${execution.terminationReason} | tools:${execution.toolTrace.length} | tokens:${execution.usage?.totalTokens ?? 0} | $${execution.usage?.costUsd ?? 0}`
    );
  }

  const scorecard = buildScorecard(scored);
  const decision = applyDecisionRule(scorecard);
  fs.writeFileSync(path.join(stampDir, "scorecard.json"), JSON.stringify({ scorecard, decision, scored }, null, 2) + "\n", "utf8");

  console.log("=== SCORECARD ===");
  console.log(JSON.stringify(scorecard, null, 2));
  console.log("=== DECISION (predeclared rule; data for the client) ===");
  console.log(decision.outcome, "—", decision.rationale);
  console.log("records:", stampDir);
}

main().catch((err) => {
  console.error("A/B runner failed:", err);
  process.exit(1);
});
