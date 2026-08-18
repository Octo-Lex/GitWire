# Phase B Attempt 3 — Execution Manifest and Evidence Index

Immutable evidence for the third Phase B matrix execution. Evidence-only
branch: never merged; the candidate tree (9c02b71 / 5a866f0) is untouched.

## Identity (pinned)

```yaml
attempt_id: attempt-2026-08-18T12-01-06-738Z
candidate_sha: 9c02b71c4ee89f08dd2a63c51c06c86e5ce0b9aa
candidate_tree: 5a866f0a493f2db6ceaf7e2e711b17b44e5b0c68
requested_model: glm-5.3
matrix_size: 24
fixture_count: 8
runs_per_variant: 3
retries: 0
configuration_changes_during_run: 0
```

Quota authorization: PR #167 review `4960090002` (Alajmah, 2026-08-18
10:42 UTC) — exactly one fresh 24-invocation matrix at this candidate,
`ABLATION_MODEL=glm-5.3`, no retries or configuration changes. Verified
before spend. The grant is consumed by this attempt.

## Execution environment

| Field | Value |
| --- | --- |
| Host | Windows dev host, Docker Desktop (linux/amd64 daemon 27.3.1) |
| Container image | `docker.io/library/node:20` (image ID `33ed5ef90e83`, Node `v20.20.2`) |
| Source acquisition | `git clone --no-hardlinks /src /wt` (read-only mount of the local repository objects), then `git checkout --detach 9c02b71…` |
| Preflight (asserted in-container, fail-closed, before any provider call) | candidate SHA equal; candidate tree equal; `ANTHROPIC_API_KEY` present; `ANTHROPIC_BASE_URL` = `https://api.z.ai/api/anthropic`; `ABLATION_MODEL` = `glm-5.3` — all asserted and passed (banner records sha/tree/model) |
| Install | `npm ci --ignore-scripts` at the worktree root (inside container) |
| Sanitized environment | `REVIEW_INTEGRITY_LIVE=1`, `NODE_ENV=test`, `NODE_OPTIONS=--experimental-vm-modules`, `--runInBand`, `--testTimeout=3600000` (process-level CLI parameter; the frozen config's 60 s default cannot host three paid invocations per test); credentials via `--env-file` from the production container env — the key is never present in any file of this branch (secret-scanned) |
| Window | 2026-08-18 12:01:06 UTC → 12:20:28 UTC |
| Source locations | `C:/tmp/phase-b-records-3/` and `C:/Next-Era/GitWire/.tmp/phase-b-attempt-2026-08-18T12-01-06-738Z/` — verified byte-identical (records, aggregate, log) before canonicalization |

## Invocation-level reconciliation (from raw records; see RECONCILIATION.json)

24 unique fixture × variant × run coordinates; none missing; none
duplicated. Execution classes (A3-A1 scheme):

| Class | Meaning | Count | Coordinates |
| --- | --- | --- | --- |
| A | provider reached, primary + verifier completed | **0** | — |
| B | provider reached, verifier structurally rejected | 8 | RI-01 broken 2,3; RI-01 fixed 1–3; RI-02 broken 1,3; RI-02 fixed 1 |
| C | provider reached, other review failure | 3 | RI-01 broken 1; RI-02 broken 2; RI-02 fixed 2 |
| E | provider not reached, unclassified pre-receipt failure | 13 | RI-02 fixed 3; all RI-03; all RI-04 |

Provider-reached: 11. Zero-token: 13. Receipt-present: 10; receipt-absent:
14. The single provider-reached/receipt-absent invocation is RI-02 fixed
run 2 (3,951 recorded tokens, 34.6 s, no v2 receipt persisted) — a partial
primary failure at the transition into the zero-token sequence. No receipt
was fabricated for it or for any class-E invocation.

Every class-B verifier rejection carries the same named error in its
receipt: `Risk-ledger validation failed: … evidence_cleared requires at
least one valid repository evidence reference (parsed and bounds-checked
against ReviewEvidence and verifier context)`.

## Token accounting (two scopes, preserved separately — not coerced)

**Scope 1 — console `tokensUsed`** (the value the live suite extracts from
the service's final `UPDATE ai_reviews` per review; covers the invocation
as the service totals it): **187,674** across the 11 provider-reached
invocations (13 rows contribute 0).

**Scope 2 — per-role execution-profile usage** (summed from the four
additive profiles embedded in each persisted receipt; covers only the 10
receipt-present invocations):

| Role | Input | Output | Cached | Total |
| --- | --- | --- | --- | --- |
| primary | 117,149 | 18,792 | 0 | 135,941 |
| verifier | 95,675 | 19,888 | 0 | 115,563 |
| adversarial | 6,593 | 5,706 | 2,048 | 14,347 |
| defense | 8,050 | 3,542 | 1,280 | 12,872 |
| **all roles** | **227,467** | **47,928** | **3,328** | **278,723** |

The two scopes differ because they cover different populations and
different accounting points (service-level single total vs per-role
receipt profiles; 11 vs 10 invocations; the service total's treatment of
verifier tokens is not separately recorded). Both are preserved as
measured; neither is derived from the other.

Quota-unit derivation (GLM-5.3 Coding Plan multipliers, per provider
correspondence recorded on #160): input × 6.9 + cached × 1.7 + output × 24
= **2,725,452 quota units** (profile scope).

## Outcome (suite-enforced, frozen thresholds — unchanged)

0 of 8 fixture thresholds passed; suite rc=1. Zero approvals anywhere in
the attempt (no false approval on any broken run; no approval of any fixed
run). Detection 0/12; fixed-approve 0/12.

## Forensic capture gaps (scope established for A3-A3)

- **F1 (pre-receipt failures):** class-E invocations preserve only the
  per-invocation record shell (verdict `needs_discussion`, checkState
  `review_incomplete`, 0 tokens, ~4.1–4.6 s latency, candidate identity).
  No execution profile, no receipt, no error text survives — the primary
  fails before `persistIntegrityReceipt`, and the live suite mocks the
  logger. Corroborating account-level evidence (production timeline):
  12:19:10 UTC production review succeeded (7,880 tokens); 12:24–12:43
  five consecutive production reviews errored with null tokens, 4.7–6.4 s;
  13:13 onward production recovered — recorded in the programme thread.
- **F2 (rejected verifier submissions):** on ledger-validation failure the
  receipt preserves `status: incomplete`, the joined error string (first
  ~300 characters), and `riskLedger: null`. The raw submitted payload is
  NOT persisted (the structured-submission path stores no raw text, and
  `rawTextSnippet` is empty on these receipts — verified per record in
  RECONCILIATION.json). Sub-classification of WHY each reference failed
  (parse vs path vs side vs range vs context) is therefore not recoverable
  from preserved evidence; it requires the F2 correction before any
  attempt 4.

## Evidence integrity (SHA-256, per file in this directory)

0957e33c253e1cf954c03a93d585e1a225a0a984afa2bc0e5db8fb098cbfdc76 *9c02b71c4ee8-RI-01-broken-run1.json
855bd506a79fec61d8cf3734caa37a1bf40391cfcc715aedade966614812bbe0 *9c02b71c4ee8-RI-01-broken-run2.json
1b903517f4d15d1c71ef22afe556bbd2b25eb8e1ffcfaa4a109b89d7abd436af *9c02b71c4ee8-RI-01-broken-run3.json
424efb02560d5b8f11a626230765cf1240ca4b99a25d256b74d13138a939968e *9c02b71c4ee8-RI-01-fixed-run1.json
6632040bc882988054d1a9c1f66bc7d9096f0f7321a1d4ee41b2f978ebe01a76 *9c02b71c4ee8-RI-01-fixed-run2.json
ee242525881a112cc856631d0d98326c849a2fb3d4cb0e5800ccb5946de18016 *9c02b71c4ee8-RI-01-fixed-run3.json
5846a1ab89567d6ecbbde4cd1bfd6760f82ac5526e3ea326c7205a935fc264e9 *9c02b71c4ee8-RI-02-broken-run1.json
aa2ff0391c015bf36abb2c0a23492fc6042fc536e07ca4e69ae06ebee4c268ce *9c02b71c4ee8-RI-02-broken-run2.json
49d283fb533d221157b0ffd708f53a0548ea64b54a9c3ac3317e38abadda946b *9c02b71c4ee8-RI-02-broken-run3.json
96b16e172e5e5273bf3e6760f0f325ef053356bc73584b9385bee7ca0eb17ea7 *9c02b71c4ee8-RI-02-fixed-run1.json
49d2550b2e47f37460def22b3ea10a97e5bd9cdb08c7b19699b58ab5505e3b25 *9c02b71c4ee8-RI-02-fixed-run2.json
2003e6adb2ee3643f6a8142e0597061fd9f84d8f98555893be8a652ea0002c5a *9c02b71c4ee8-RI-02-fixed-run3.json
de477b01396872208843af8aad85ec8a15e148c2d5c2e40219c1fc6d0451df6d *9c02b71c4ee8-RI-03-broken-run1.json
688a1626cf9ceb50b0efeabd85ca0d0aff58944a99bedf20784a72a7e42670b6 *9c02b71c4ee8-RI-03-broken-run2.json
b0aa399a522ea7e56352bdbe5d329b22ee60e9c22b2e4bf280775c751039c9a3 *9c02b71c4ee8-RI-03-broken-run3.json
e9757efb8e3077fb4ffef04fcc05498074af95e1dcda87d04764191be886bfc2 *9c02b71c4ee8-RI-03-fixed-run1.json
c0149fe4a9f31da8afb9838ad51ee46ae9437c74153aeab78911df14f9c7606a *9c02b71c4ee8-RI-03-fixed-run2.json
c45abcad2ccd8b3b8c64f68188e4ae19f23743edbc0d18eee3b6e073ab0c4447 *9c02b71c4ee8-RI-03-fixed-run3.json
7e9c9f372ffcf0ba28bb1740842aaa65a422cdb1e421237af6a5b84cbfdf0d67 *9c02b71c4ee8-RI-04-broken-run1.json
dd25b0f866e60d758a3debb8f09a43fda1128fb2be5e02e731340a37846c866f *9c02b71c4ee8-RI-04-broken-run2.json
000076da3d0fc102fd77e395a5fff0eb05e94b16470879241c2396334e552db9 *9c02b71c4ee8-RI-04-broken-run3.json
8bd42ddd8708653b18e88cf188d998dcdefb07264c8f60c4bd704fac38a4ff3a *9c02b71c4ee8-RI-04-fixed-run1.json
bcd6dc5658d0734efe4aba84d96f3f0e53422a3fc89b0ce1e9662669f4fc3d30 *9c02b71c4ee8-RI-04-fixed-run2.json
51b8c236c81f06dddafb2ef0f5d59c7e2e3375babd63548efb2f64164ec043c9 *9c02b71c4ee8-RI-04-fixed-run3.json
4284d1fd38d8e1eebb3f016b44c0a5186e24e20fa1f87ed2112de6c5e0ddf4fa *live-after-results.json
18f43efb61c9dbd0bb495b9793854b7e860e5b015890bc0d8c6dda6b6c275b09 *execution-console.log
RECONCILIATION.json and this file are indexed in SHA256SUMS
