// ONE capped paid Pi pilot (RI-9 amendment, Phase 8, Commit 6).
//
// Refuses to run without GITWIRE_PI_PILOT=1 AND provider credentials — CI
// and casual test runs can never spend. Exactly ONE invocation, never a
// retry: a failed pilot is evidence, not something to re-roll.
//
// Frozen configuration (recorded verbatim into the run record):
//   fixture: RI-04 broken @ its immutable GitHub head 624732c
//   harness: Pi (version recorded from the adapter)
//   provider/model: Z.AI anthropic-compatible endpoint, glm-5.3 (pinned)
//   prompt: pi-phase8-v1 (generic objective, no fixture hints)
//   budgets: 480s wall, 60 tool calls, 200K total tokens
//
// After the run, the submission's evidence references are validated through
// the REAL RI-4 path (validateFinding over broker-reconstructed context
// items), and an append-only record is written under runs/.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FROZEN = Object.freeze({
  caseId: "RI-04",
  variant: "broken",
  fixtureHead: "624732c",
  harness: "pi",
  provider: "zai",
  providerApi: "anthropic-messages",
  model: "glm-5.3",
  promptVersion: "pi-phase8-v1",
  deadlineMs: 480000,
  maxToolCalls: 60,
  maxTotalTokens: 200000,
  maxTokensPerTurn: 8192,
});

const OBJECTIVE_PREAMBLE = [
  "You are reviewing one pull request against its repository at the immutable HEAD.",
  "Determine whether the change introduces correctness defects. Correct means:",
  "the repository's own documented contracts hold; cross-file consistency holds",
  "(including status and behavioral documentation); API usage matches the called",
  "code's actual contract; and invariants the surrounding code relies on are",
  "preserved. Documentation contradictions about system state are correctness",
  "material. Cite exact file/line evidence for every material finding.",
].join(" ");

async function main() {
  if (process.env.GITWIRE_PI_PILOT !== "1") {
    console.error("refusing: set GITWIRE_PI_PILOT=1 for the one capped paid run");
    process.exit(2);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!apiKey || !baseUrl) {
    console.error("refusing: ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL are required");
    process.exit(2);
  }

  const { prepareRepository } = await import("../../src/lib/repositoryTools/repositorySession.js");
  const { createPiHarness } = await import("../../src/lib/reviewHarness/pi/piHarness.js");
  const { parseEvidenceRef, validateFinding, PROOF_TYPES } = await import("../../src/services/findingValidator.js");
  const { verifyEvidenceReconciliation, normalizeFileRead } = await import("../../src/services/evidenceReconciliationService.js");
  const { createContextBroker } = await import("../../src/services/reviewContextBroker.js");
  const { buildFixtureOctokit } = await import("./fixtureOctokit.js");
  const { loadFixture } = await import("./fixtures/fixtureGitMaterializer.js");

  const gitHead = execSync("git rev-parse HEAD", { cwd: path.join(__dirname, "..", "..", "..") }).toString().trim();

  const fixture = loadFixture("ri04", "broken");
  if (!fixture.source.head.startsWith(FROZEN.fixtureHead)) {
    throw new Error(`fixture head drifted: ${fixture.source.head} (frozen ${FROZEN.fixtureHead})`);
  }

  // Immutable repository session for the review.
  const treeFile = path.join(__dirname, "fixtures", "snapshots", "repos", `gitwire-${fixture.source.head}.tree.json`);
  const blobs = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "snapshots", "repos", "gitwire-blobs.json"), "utf8"));
  const headTree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
  const baseTreePath = path.join(__dirname, "fixtures", "snapshots", "repos", `gitwire-${fixture.source.base}.tree.json`);
  const baseTree = JSON.parse(fs.readFileSync(baseTreePath, "utf8"));
  const repositorySession = await prepareRepository({
    invocationId: `pi-pilot-${Date.now()}`,
    repository: fixture.source.repo,
    headSha: fixture.source.head,
    baseSha: fixture.source.base,
    acquire: { mode: "snapshot", baseTree: { ref: fixture.source.base, tree: baseTree.tree }, headTree: { ref: fixture.source.head, tree: headTree.tree }, blobs },
  });

  const model = {
    id: FROZEN.model,
    name: `${FROZEN.model} (Z.AI, pinned)`,
    api: FROZEN.providerApi,
    provider: FROZEN.provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.6, output: 2.2, cacheRead: 0.08, cacheWrite: 0.8 },
    contextWindow: 128000,
    maxTokens: FROZEN.maxTokensPerTurn,
  };

  const harness = createPiHarness({
    model,
    runtimeApiKey: apiKey,
    resolveRepositorySession: (id) => (id === repositorySession.id ? repositorySession : null),
  });

  // The review objective: generic framing + the PR's own title and diff
  // (the review SUBJECT, not a fixture hint).
  const changedSummary = fixture.changedFiles
    .map((cf) => `--- ${cf.filename} (${cf.status}) ---\n${cf.patch ?? "(no patch text)"}`)
    .join("\n\n");
  const objective = [
    OBJECTIVE_PREAMBLE,
    "",
    `Pull request: ${fixture.prMetadata.title}`,
    "",
    "Changed files (diff vs BASE):",
    changedSummary,
  ].join("\n");

  const task = {
    reviewInvocationId: `rinv-pi-pilot-${Date.now()}`,
    repositorySessionId: repositorySession.id,
    repository: { owner: "Octo-Lex", name: "GitWire" },
    baseSha: fixture.source.base,
    headSha: fixture.source.head,
    reviewRoot: { invocationId: `rinv-pi-pilot-${Date.now()}`, baseSha: fixture.source.base, headSha: fixture.source.head },
    objective,
    findingSchema: { name: "gitwire-findings", version: "2" },
    deadlineMs: FROZEN.deadlineMs,
    budget: { maxToolCalls: FROZEN.maxToolCalls, maxTotalTokens: FROZEN.maxTotalTokens },
  };

  console.log("=== PI PAID PILOT (one capped invocation) ===");
  console.log("frozen:", JSON.stringify(FROZEN, null, 2));
  console.log("git HEAD:", gitHead, "| harness version:", harness.version);

  const startedAt = new Date().toISOString();
  const execution = await harness.runReview(task);
  const finishedAt = new Date().toISOString();

  // RI-4 validation of every submitted finding through the REAL path.
  const octokit = buildFixtureOctokit(fixture);
  const broker = createContextBroker({ octokit, owner: "org", repo: "repo", baseSha: fixture.source.base, headSha: fixture.source.head });
  const contextItems = [];
  const validationResults = [];
  if (execution.submission) {
    for (const finding of execution.submission.payload.findings) {
      const perFinding = { claim: finding.claim, severity: finding.severity, refs: [], validation: null };
      for (const ref of finding.evidenceRefs ?? []) {
        const parsed = parseEvidenceRef(ref);
        if (!parsed) {
          perFinding.refs.push({ ref, parsed: false });
          continue;
        }
        const fileRead = await broker.readRepoFile(parsed.path, fixture.source.head, {
          range: { startLine: parsed.startLine, endLine: parsed.endLine },
        });
        if (fileRead.type === "file_read") contextItems.push(fileRead);
        const verdict = verifyEvidenceReconciliation({
          reviewerEvidence: {
            repositorySessionId: repositorySession.id,
            sessionHeadSha: repositorySession.headSha,
            snapshotRef: repositorySession.snapshotRefs?.head ?? null,
            path: parsed.path,
            blobSha: fileRead.type === "file_read" ? fileRead.blobSha : null,
            startLine: parsed.startLine,
            endLine: parsed.endLine,
            content: fileRead.type === "file_read" ? fileRead.content : null,
            faithful: repositorySession.identityReport.faithful.includes(parsed.path),
          },
          reconstruction: normalizeFileRead(fileRead),
        });
        perFinding.refs.push({ ref, parsed: true, reconciliation: verdict });
      }
      validationResults.push(perFinding);
    }
    // Whole-submission RI-4 validation with the reconstructed context items.
    for (const [index, finding] of execution.submission.payload.findings.entries()) {
      const v = validateFinding(finding, { review: { headSha: fixture.source.head } }, contextItems);
      validationResults[index].validation = {
        valid: v.valid,
        errors: v.errors,
        warnings: v.warnings,
        downgraded: v.downgraded,
      };
    }
  }

  const record = {
    kind: "pi-paid-pilot",
    frozen: FROZEN,
    gitHead,
    harnessVersion: harness.version,
    promptVersion: harness.promptVersion,
    startedAt,
    finishedAt,
    execution,
    ri4Validation: validationResults,
    mutationOccurred: false,
    notes: "submit_review is data submission only; no GitHub mutation credential exists in the adapter",
  };

  const runsDir = path.join(__dirname, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const outFile = path.join(runsDir, `pi-pilot-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2), "utf8");

  repositorySession.close();

  console.log("=== SUMMARY ===");
  console.log("status:", execution.status, "| termination:", execution.terminationReason);
  console.log("requested:", execution.requestedProvider, execution.requestedModel, "| actual:", execution.actualProvider, execution.actualModel);
  console.log("usage:", JSON.stringify(execution.usage));
  console.log("durationMs:", execution.durationMs, "| tool calls:", execution.toolTrace.length);
  if (execution.submission) {
    console.log("findings:", execution.submission.payload.findings.length, "| approvalEvidenceComplete:", execution.submission.payload.approvalEvidenceComplete);
    for (const f of execution.submission.payload.findings) {
      console.log(`  [${f.severity}] ${f.claim}`);
      for (const r of f.evidenceRefs ?? []) console.log("    ref:", r);
    }
  }
  console.log("record:", outFile);
}

main().catch((err) => {
  console.error("pilot failed:", err);
  process.exit(1);
});
