# Review Integrity P1 — RI-9 Repository Tooling and Harness Qualification Amendment

**Status:** Client-approved amendment to RI-9  
**Date:** 2026-08-15  
**Applies to:** Review Integrity P1 / RI-9 only  
**Does not create:** RI-10 or any successor work package  
**Does not reopen:** RI-1 through RI-8

---

## 1. Purpose

This amendment records a client-directed correction to the still-open RI-9 implementation strategy.

The frozen Review Integrity P1 objective remains unchanged:

> **GitWire may emit `APPROVE` only when approval evidence is complete, no validated P0/P1/P2 finding remains, an independent approval verifier completes successfully without finding a material defect or unresolved evidence need, and deterministic policy authorizes the GitHub review mutation.**

The amendment changes **how repository truth is exposed to the reviewer and how the evaluation harness is qualified before model suitability is inferred**.

The accumulated RI-9 campaign demonstrated that the model-facing repository harness itself can create false or misleading evidence. In particular, the existing repository search implementation could terminate traversal on an unrelated oversized blob and return a zero-result search despite a real later match. Earlier campaign corrections also exposed fixture-surface, identity, submission, retrieval, budget, and accounting defects.

Therefore:

> **Model suitability may not be inferred from a review run until the repository instrument and agent interaction path used by that run have been deterministically qualified.**

Existing contaminated or subsequently-confounded runs remain preserved as historical observations, but they do not carry forward into fresh cutover arithmetic.

---

## 2. Governing constraints preserved

This amendment preserves all previously frozen Review Integrity invariants that govern approval safety, including:

- complete PR accounting and no silent changed-file omission;
- immutable BASE/HEAD identity;
- evidence-bound material findings;
- bounded execution and explicit partiality;
- fail-closed approval when required evidence is unresolved;
- independent approval verification;
- deterministic review policy;
- P2 never authorizes `APPROVE`;
- exactly-once GitHub mutation;
- terminal check lifecycle;
- reconstructable audit receipts.

This amendment changes no RI-6 severity/decision contract, RI-7 mutation contract, or RI-8 receipt objective.

RI-3 remains closed. Its role is repositioned at the RI-9 integration boundary; it is not reopened.

---

## 3. Problem statement

The prior RI-9 design collapsed two responsibilities into one component:

```text
model-facing repository exploration
+
GitWire approval-evidence integrity
```

This made the Context Broker both:

1. the reviewer's perception of the repository; and
2. part of the evidence authority used to judge whether the reviewer was correct.

A defect in that layer therefore contaminated both the model's reasoning environment and the evaluation of the model.

The corrected design separates these responsibilities.

---

## 4. Target architecture

```text
GitHub PR @ immutable BASE / HEAD
                │
                ▼
        ReviewEvidence / RI-2
                │
                ▼
      Exact repository checkout
          on Linux executor
                │
        ┌───────┴────────┐
        ▼                ▼
 Agent Repository     Integrity Repository
     Tools                 Tools
 read / grep / find    exact-SHA/blob verify
 / ls                  evidence reconstruction
        │               deterministic probes
        ▼                │
 Coding reviewer          │
        │                 │
        └────────┬────────┘
                 ▼
         Evidence-bound findings
                 │
              RI-4
                 │
       Independent reviewer
                 │
              RI-5
                 │
      Evidence completeness
                 │
              RI-6
                 │
        Deterministic policy
                 │
              RI-7
                 │
       Exactly-once mutation
                 │
              RI-8
                 │
              Receipt
```

### Architectural rule

> **Repository tools help the reviewer understand the repository. Integrity machinery proves what immutable repository state the reviewer and its findings refer to.**

The reviewer-facing tools and the integrity-verification tools may share a backend, but they must not share authority semantics.

---

## 5. Repository Tooling Roadmap

The following phases are an implementation sequence inside RI-9. They are not separate work packages and do not create successor audits.

### Phase 0 — Re-freeze RI-9 around a trustworthy instrument

Record this amendment as the current RI-9 implementation authority.

Freeze during repository-instrument work:

- review severity policy;
- approval policy;
- verifier independence;
- finding schema semantics;
- mutation semantics;
- model prompts;
- model selection;
- corpus expected defects;
- corpus thresholds.

Until repository qualification passes:

```text
no paid model calls
no B7 true shadow
no full matrix
no cutover
```

Historical model runs remain diagnostic evidence only where later-discovered harness defects could have affected the result.

**Exit criterion:** this amendment is committed/recorded and accepted as the active RI-9 implementation direction.

---

### Phase 1 — Immutable Linux repository substrate

For each review invocation, the Linux executor must materialize an isolated repository at the exact immutable HEAD while retaining the exact BASE for diff/reference operations.

Required properties:

```text
expected HEAD == git rev-parse HEAD
expected BASE is recorded
working tree is clean before review
tracked repository state is immutable for the invocation
review execution has no GitHub mutation credential
execution directory/container is ephemeral or invocation-isolated
```

Repository-controlled agent configuration must not silently alter the reviewer runtime.

For any future Pi integration, repository `.pi/*`, project extensions, project skills, prompt templates, and project-controlled agent instruction loading must be disabled or replaced by GitWire-owned resource loading.

**Exit criterion:** deterministic fixture setup recreates every frozen fixture at the exact BASE/HEAD and proves checkout identity.

---

### Phase 2 — Define `RepositoryTools v2`

The model-facing public contract is limited to four read-only primitives:

```text
read
grep
find
ls
```

The stable TypeScript-level contract must contain no provider/model concepts.

Every operation returns one of:

```text
SUCCESS
PARTIAL
ERROR
```

Every result must expose common audit/completeness metadata, including as applicable:

```text
headSha
operation
scope
status
complete
duration
returnedBytes
returnedItems
truncation
continuation
```

Repository evidence additionally carries immutable identity such as path and blob SHA.

### Required negative-evidence invariant

```text
matches = [] && complete = true
    means authoritative absence in the declared scope

matches = [] && complete = false
    must never be represented as authoritative absence
```

A tool error must never be encoded as a successful textual result such as "No matches found."

**Exit criterion:** stable `RepositoryTools v2` contract with explicit completeness semantics.

---

### Phase 3 — Implement Git-native `read / grep / find / ls`

Pi is a design reference for tool ergonomics and truncation semantics. GitWire's backend should use the immutable Git checkout so repository truth is tied to the exact review commit.

#### 3.1 `read`

Input:

```text
path
offset
limit
```

Required result metadata:

```text
headSha
blobSha
startLine
endLine
totalLines
complete
nextOffset
content
```

Requirements:

- repository-relative paths only;
- no absolute paths;
- no `..` escape;
- no symlink escape outside the checkout;
- explicit line/byte truncation;
- continuation when more content exists;
- no shell fallback required to recover ordinary content.

#### 3.2 `grep`

Input should support at least:

```text
pattern
path (optional)
glob (optional)
literal (optional)
ignoreCase (optional)
context (optional)
limit (optional)
```

Search should operate over the immutable tracked tree, using a Git-native/local-search mechanism such as `git grep` or `rg` constrained to the exact checkout.

Search execution budget and model-output budget are separate concerns.

Bound:

- wall-clock/runtime;
- process resources;
- returned match count;
- returned output bytes.

Do **not** define search truth by stopping after an arbitrary number of source bytes has been inspected.

#### 3.3 `find`

Use tracked-path truth, e.g. `git ls-files` plus glob/filter semantics.

Do not search file contents merely to locate filenames.

Return normalized repository-relative paths with explicit result/output truncation.

#### 3.4 `ls`

Provide bounded directory listing over the immutable checkout:

```text
path
limit
sorted entries
explicit truncation
```

**Exit criterion:** all four primitives operate deterministically without an LLM.

---

### Phase 4 — Shared completeness and truncation semantics

One shared library must define repository-tool partiality and output-window behavior.

At minimum distinguish:

```text
complete
result_limit
output_bytes
output_lines
timeout
cancelled
backend_error
```

A partial result must remain partial through:

```text
tool
→ agent transcript
→ ReviewEvidence
→ approval-evidence calculation
→ receipt
```

No downstream layer may silently reinterpret a partial result as exhaustive evidence.

Shared truncation metadata should record at least:

```text
totalLines
totalBytes
outputLines
outputBytes
truncated
truncatedBy
maxLines
maxBytes
continuation (where applicable)
```

**Exit criterion:** all four tools use the common completeness/truncation contract.

---

### Phase 5 — Deterministically qualify the repository instrument

No model evaluation may resume before this phase passes.

Build deterministic truth probes for every frozen historical fixture, broken and fixed.

For each fixture, independently specify known repository facts that the reviewer must be able to retrieve.

For RI-04, the qualification must prove at minimum:

```text
grep("findCommentByMarker")
→ real match in commentMarkers.js

read(commentMarkers.js, relevant range)
→ exact expected implementation

find(relevant tests)
→ expected tracked paths

ls(relevant directory)
→ expected entries
```

Equivalent defect-supporting probes are required for RI-01, RI-02, and RI-03.

The qualification suite must also cover pathological cases including:

- large binary before target source;
- many binaries;
- huge source file;
- UTF-8 multibyte content;
- result overflow;
- output overflow;
- timeout;
- cancellation;
- genuine zero-match search;
- symlink escape;
- `../` traversal;
- absolute path attempt;
- untracked file;
- dirty checkout;
- wrong HEAD.

Required invariant:

> **If the harness tells the reviewer something about the repository, that statement is mechanically trustworthy within its declared scope/completeness state.**

**Exit criterion:** 100% deterministic repository-tool qualification suite green.

---

### Phase 6 — Reposition RI-3 as integrity verification

RI-3 remains closed and is not rewritten as a new package.

At the RI-9 integration boundary, RI-3 is used for:

- GitHub-side immutable acquisition;
- exact-SHA verification;
- evidence reconstruction;
- audit validation;
- deterministic fixture/oracle verification;
- finding evidence verification.

It is no longer required to be the coding reviewer's only repository-perception mechanism.

Deliberate redundancy is allowed and desirable:

```text
Linux checkout reports evidence X at HEAD
+
RI-3 exact-SHA verification reconstructs X at HEAD
→ evidence identity is trustworthy
```

If the two disagree:

```text
approvalEvidenceComplete = false
APPROVE forbidden
```

**Exit criterion:** reviewer navigation and integrity verification are separated without reopening RI-3.

---

### Phase 7 — Connect RI-4 evidence validation

The reviewer may submit repository-native evidence references such as:

```json
{
  "path": "packages/web/src/lib/commentMarkers.js",
  "startLine": 40,
  "endLine": 58
}
```

GitWire independently determines:

- whether the path exists at exact HEAD;
- the immutable blob identity;
- whether the cited lines exist;
- whether the cited range supports the finding;
- whether review execution was bound to the same HEAD.

The reviewer's filesystem is not the final authority.

**Exit criterion:** no material finding survives validation unless GitWire independently reconstructs its evidence at the immutable review commit.

---

### Phase 8 — Small Pi harness pilot

Only after repository qualification passes, evaluate Pi as a replaceable coding-agent runtime.

Do not rewrite RI-9 around Pi before this proof.

Prototype configuration:

```text
Pi
├── GitWire-controlled system prompt
├── in-memory ephemeral session
├── selected provider/model
├── RepositoryTools v2
│   ├── read
│   ├── grep
│   ├── find
│   └── ls
└── submit_review
```

Initial Pi pilot should expose GitWire's already-qualified repository tools through Pi's custom-tool mechanism rather than changing repository semantics again.

This allows the current orchestration and Pi orchestration to be compared against the same repository instrument.

**Exit criterion:** one Pi session reviews an immutable fixture using the qualified tools and produces the existing RI-4-compatible structured finding result.

---

### Phase 9 — Harness A/B before model A/B

Use one model/provider while changing only the agent orchestration layer.

Example:

```text
Arm A
current GitWire agent orchestration
+
RepositoryTools v2

Arm B
Pi agent orchestration
+
RepositoryTools v2
```

Keep constant:

```text
model
provider
fixture
BASE/HEAD
repository tool semantics
review objective
finding schema
invocation-level budgets
```

This experiment answers:

> **Does the current GitWire agent loop itself cause material review degradation relative to an open-source coding-agent harness over the same truthful repository interface?**

**Exit criterion:** explicit evidence-based decision whether Pi replaces the current model-loop layer.

---

### Phase 10 — Model qualification

Only after repository and harness qualification may model/provider suitability be evaluated again.

Candidate comparisons must use the same:

```text
repository tools
agent contract
policy
validation
corpus
approval thresholds
```

Only model/provider identity changes.

Separate two product concepts:

```text
supported
= operationally compatible with the harness

qualified for APPROVE
= passes the frozen Review Integrity acceptance gates
```

Existing contaminated model counts do not carry into the qualified-candidate arithmetic.

**Exit criterion:** at least one candidate is qualified under the frozen broken/fixed acceptance gates without harness contamination.

---

### Phase 11 — Complete the original RI-9 exit path

Only after a qualified candidate exists:

```text
B7 true shadow
↓
frozen full matrix
↓
clean calibration
↓
shadow operational acceptance
↓
cutover
↓
production proof
↓
dependency audit green
↓
RI-9 closure
```

No RI-10 is created.

The existing production dependency audit must be green at the eventual closure head.

---

## 6. Evaluation evidence policy

### Historical evidence

Previously recorded runs remain immutable historical observations.

They may continue to establish facts such as:

- a configuration emitted or did not emit `APPROVE`;
- a model produced a specific finding;
- a verifier returned a specific state;
- a runtime consumed a measured amount of budget.

They may **not** be reused as clean model-suitability evidence where later-discovered harness defects could have materially influenced the result.

### Blind controls

Blind or alternate-envelope controls remain diagnostic capability probes only.

They can establish that a model is capable of recognizing or reasoning about a defect under another interaction path, but they do not replace the production cutover harness and do not themselves pass/fail the frozen live gate.

### Fresh candidate arithmetic

Any runtime change that alters repository truth, agent orchestration, model identity, prompt semantics, or other cutover-relevant behavior creates a fresh candidate.

Old success/failure counts do not combine with the fresh candidate.

Adaptive arithmetic may still stop a candidate early when the frozen threshold becomes mathematically impossible.

---

## 7. Budget policy under RepositoryTools v2

The following concepts must be separated:

### Repository execution budget

Bounds the cost of executing repository operations:

- wall-clock time;
- process CPU/memory;
- operation count where needed for abuse control.

### Repository output budget

Bounds what is returned to the reviewer:

- maximum matches;
- maximum output bytes/lines;
- bounded continuation windows.

### Review invocation budget

Bounds the full coding-review execution:

- total primary duration;
- total verifier duration;
- total model tokens/cost;
- total invocation cost/latency.

A repository search must not manufacture false negative evidence merely because an earlier unrelated file consumed an inspection-byte allowance.

Hitting an output/result limit makes the result partial unless the operation can still prove exhaustiveness inside the declared scope.

The previously frozen approval-safety invariant remains:

> **If required material evidence cannot be resolved within the authorized review budget, `approvalEvidenceComplete=false` and `APPROVE` is forbidden.**

---

## 8. Pi design reference

Pi is a design reference and a candidate harness, not an authority layer.

Relevant ideas adopted from Pi include:

- a small read-only coding tool surface: `read`, `grep`, `find`, `ls`;
- explicit line/byte/result truncation;
- continuation for large reads;
- separation of tool errors from successful negative results;
- reusable repository-tool operations;
- a provider-independent agent core;
- direct SDK embedding;
- custom typed tools;
- external OS/container isolation rather than pretending an in-process agent runtime is a security sandbox.

GitWire adds stronger requirements that Pi does not need for its local developer use case:

- immutable BASE/HEAD binding;
- tracked-file-only repository truth for review;
- repository-root path confinement;
- exact blob/evidence identity;
- independent evidence reconstruction;
- approval-evidence completeness;
- independent verifier;
- deterministic GitHub decision policy;
- exactly-once mutation;
- integrity receipts.

Pi must remain replaceable behind a GitWire-owned harness interface if adopted.

---

## 9. Security boundary

The coding reviewer and repository contents are untrusted/stochastic.

```text
UNTRUSTED / STOCHASTIC
────────────────────────────
repository contents
coding-agent runtime
selected model
model reasoning
repository exploration
────────────────────────────
TRUST BOUNDARY
────────────────────────────
GitWire exact-SHA identity
changed-file accounting
repository-tool completeness semantics
finding evidence validation
independent verification requirement
deterministic decision policy
idempotent mutation
GitHub mutation credentials
receipts
────────────────────────────
AUTHORIZED
```

The coding-agent execution environment must never receive the GitHub mutation credential used to approve/comment/request changes.

---

## 10. Stop conditions

During repository-instrument implementation, stop and report before broadening scope when a newly observed defect requires changing a frozen contract outside the repository-tool boundary.

Examples:

- the deterministic fixture oracle proves a frozen fixture itself is wrong;
- exact checkout cannot reproduce GitHub immutable state;
- RI-4 evidence validation cannot represent repository-native evidence without changing its accepted material-finding contract;
- a proposed correction requires changing RI-6 decision semantics;
- a proposed correction requires reopening RI-7 mutation identity semantics.

Ordinary implementation issues, tool bugs, path normalization, test fixture construction, and reversible Linux execution choices remain execution-mode decisions and do not require reauthorization.

---

## 11. Closure remains unchanged

This amendment does not itself close RI-9.

RI-9 remains open until the original Review Integrity P1 operational exit is satisfied under a qualified instrument and qualified candidate, including:

- zero false `APPROVE` on the broken corpus;
- practical approval of fixed/clean cases;
- partial evidence never approving;
- material findings evidence-bound;
- verifier independent and fail-closed;
- exactly-once mutation;
- terminal check lifecycle;
- shadow proof;
- cutover proof;
- production proof;
- final required CI, including production dependency audit, green.

When those frozen criteria pass, RI-9 closes immediately. No successor audit is created automatically.

---

## 12. Authorized execution sequence

The active RI-9 sequence is now:

```text
Record amendment
→ materialize exact Linux checkout
→ define RepositoryTools v2
→ implement Git-native read/grep/find/ls
→ qualify repository instrument deterministically
→ separate RI-3 integrity verification from reviewer navigation
→ reconnect RI-4 evidence validation
→ run small Pi pilot
→ harness A/B
→ model qualification
→ B7 / shadow / full frozen exit path
→ RI-9 close
```

This sequence replaces the now-invalid assumption that the existing model-facing Context Broker is already a qualified evaluation instrument.

---

## Decision

**Client-approved RI-9 amendment. Proceed with the repository-instrument correction and qualification sequence above.**
