# Phase B Attempt 1 — Execution Manifest and Evidence Index

Immutable evidence for the first Phase B matrix execution. Evidence-only
branch: never merged; the candidate tree (9586a68 / e6b2b53a) is untouched.

## Identity

| Field | Value |
| --- | --- |
| Attempt ID | `attempt-2026-08-18T01-30-34-386Z` |
| Candidate commit | `9586a68512d8b3e072c0b47c7f1726c482a84df6` (PR #160, unmerged) |
| Candidate tree | `e6b2b53a0bf9c46b37073667750e2d6e6f79ade5` (asserted equal inside the execution container before the first invocation) |
| Window | 2026-08-18 01:30:00 UTC → 02:10:27 UTC |
| Invocations | 24/24 completed (fixture-major, frozen order), no retries |
| Recorded usage | 524,556 tokens total (avg 21,856/invocation); avg ~100 s/invocation |

## Execution environment

| Field | Value |
| --- | --- |
| Host | Windows dev host, Docker Desktop (linux/amd64 daemon 27.3.1) |
| Container image | `docker.io/library/node:20` (image ID `33ed5ef90e83`, Node `v20.20.2`) |
| Source acquisition | `git clone --no-hardlinks /src /wt` (read-only mount of the local repository objects), then `git checkout --detach 9586a68…`; SHA and tree asserted equal to the frozen values inside the container before any provider call |
| Install | `npm ci --ignore-scripts` at the worktree root (inside container) |
| Credentials | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` sourced from the production container env via SSH into an env file passed with `--env-file`; the key is never present in any file of this branch (secret-scanned) |
| Endpoint (asserted) | `ANTHROPIC_BASE_URL` = `https://api.z.ai/api/anthropic` |
| Model override | `ABLATION_MODEL` unset (asserted) → frozen requested model `glm-5.2`; every invocation was SERVED `glm-5.3` (recorded as descriptive telemetry per the corrected runner) |

## Exact command (inside container, at /wt/packages/web)

```text
REVIEW_INTEGRITY_LIVE=1 NODE_ENV=test NODE_OPTIONS='--experimental-vm-modules' \
  npx --no-install jest \
    --config jest.config.js \
    --runInBand \
    --testTimeout=3600000 \
    tests/evaluation/review-integrity/live-after.test.js
```

`--testTimeout=3600000` is a jest CLI (process-level) parameter required
because the frozen config's `testTimeout: 60000` cannot host three paid
invocations per test; it changes no file in the candidate tree. Precondition
assertions (failing closed) preceded the run: candidate SHA, tree, key
presence, base-URL equality, `ABLATION_MODEL` unset.

Two pre-spend launch attempts aborted without any provider call: (1) a
Windows worktree run where `execSync("git rev-parse HEAD^{tree}")` fails
under cmd.exe (`^` is an escape character) — reproduced mechanically; (2) a
container launch killed by Git Bash path rewriting (fixed with
`MSYS_NO_PATHCONV=1`). Neither consumed quota nor wrote records.

## Outcome (suite-enforced, frozen thresholds)

| Fixture | False APPROVE | Detection | APPROVE | Verdict |
| --- | --- | --- | --- | --- |
| RI-01 broken | 0/3 | 0/3 (need ≥2) | — | FAIL |
| RI-01 fixed | — | — | 3/3 (need ≥2) | PASS |
| RI-02 broken | 0/3 | 0/3 | — | FAIL |
| RI-02 fixed | — | — | 3/3 | PASS |
| RI-03 broken | 0/3 | 0/3 | — | FAIL |
| RI-03 fixed | — | — | 0/3 (all abstained) | FAIL |
| RI-04 broken | 1/3 (run 3) | 0/3 | — | FAIL |
| RI-04 fixed | — | — | 0/3 (all abstained) | FAIL |

Suite result: rc=1, 6 of 8 fixture tests failed.

**Classification (client-adjudicated, 2026-08-18):** primary cause =
review-quality recall/capability failure (0/12 expected-defect detections on
broken fixtures); safety consequence = false-approval escape (RI-04 broken
run 3: approved / review_passed / verifier verified / coverage complete —
missed defect upstream of every gate); secondary failure = excessive
abstention on clean code (RI-03/RI-04 fixed: review_incomplete, verifier
not_run). Programme stops: no Phase C, no rerun of the same configuration.

## Evidence integrity (SHA-256, per file in this directory)

5622cf06baa9c4e0fa0604b1dcfd911fdb354d50740c6a3ae5b9dab223b56dc7 *9586a68512d8-RI-01-broken-run1.json
5accc8186488e50bbb70262e14ea381ec53ddfa1d8c29cc395f6d7bf4b2a1dba *9586a68512d8-RI-01-broken-run2.json
f63cb8345b2fa9973890c4eb2870aa2fefee8356ca04cd4352111c98070b6fe2 *9586a68512d8-RI-01-broken-run3.json
0bc0a0877a42b8bb05ab3077a5adf46e0d314e746c2e5eba1d246f0d7cd592e2 *9586a68512d8-RI-01-fixed-run1.json
37cc95188e8edf4bb786f94215944d6f23325b80adfc93c5b6809db0cb5cbe11 *9586a68512d8-RI-01-fixed-run2.json
27fd3f96ce199679e9e4e72f720cc9abae58dbb89a91287c7de264c972701dfa *9586a68512d8-RI-01-fixed-run3.json
3470ce8407444d93e0283364e75c99e38648e590993efa43b734f5603c1a68aa *9586a68512d8-RI-02-broken-run1.json
cadbe5b6c0a7580217b61bc5fb733feacb86bdabededad4a8a80cd18768a2fac *9586a68512d8-RI-02-broken-run2.json
1e76c691d12e5940b94acdf2322bdc59f661afb304768091011adb9d07c4bbd1 *9586a68512d8-RI-02-broken-run3.json
aa879d113b22b19b0befaea110953dff7403c01e5586266dbbfb47444ffc40d4 *9586a68512d8-RI-02-fixed-run1.json
c6a54994c762a8ca0a24d02caa685d8ff53e495f0cdf9f2cb269d0cd374fffc4 *9586a68512d8-RI-02-fixed-run2.json
07d0adb308e029e6372903a5190192c74f869b6913b58f4bb0378179569abdee *9586a68512d8-RI-02-fixed-run3.json
2eda5ebf042603ec9cf25f908004332c00324b503b516f4f64bc92b9d594e9ca *9586a68512d8-RI-03-broken-run1.json
fad60d6f4d2a0bc9bd9fa841c0806522729f8b4e8634e92f057bc443dd5a12f2 *9586a68512d8-RI-03-broken-run2.json
ed64c0c428407ef00e968358c2da653a050dc6262e61e08c3b2e59736c42cf96 *9586a68512d8-RI-03-broken-run3.json
1141a7565ef0cd7a7b4967606c5cd895ff024d9d0b328d23ae8c6e9d2e2c7344 *9586a68512d8-RI-03-fixed-run1.json
e153d02d72fb89664bf2fc118a5fb62d86243ed9373d8239861ab39ca1cbf46b *9586a68512d8-RI-03-fixed-run2.json
72f6b66682ae477f2c82f5072a258947196389971968d2584cb7cc686578c927 *9586a68512d8-RI-03-fixed-run3.json
2f5b19fd17f7abe83fbfdac0f28e2ae07e7e4a1f48c52439462f1ada4c5c79e5 *9586a68512d8-RI-04-broken-run1.json
c42e027ce550ab64e12ae007dccde1d6039a9eccc0a90a0baefbd0d6483cf0e1 *9586a68512d8-RI-04-broken-run2.json
9212493e9a5f37186d23d9d7008f7b2f4bfccb2dfa50cfaff0f144e961410104 *9586a68512d8-RI-04-broken-run3.json
5988b502d8b754b88f6b4d2f8fb1d2323c527e182de27254437ddcbaf689f9df *9586a68512d8-RI-04-fixed-run1.json
c27a859bb2b47bc8e43a9444a906474a04c2d98bce2a94cb2269499f4ab0b81b *9586a68512d8-RI-04-fixed-run2.json
3be469c6aad6c85be3fc94f11e3a8c6a5611bdc58600483f6882f66c2c524f16 *9586a68512d8-RI-04-fixed-run3.json
04b8eefe6cd28f313d9b8f4b90b6d8acf7ba33416d78cd3f40eed16b42712e05 *live-after-results.json
a2260f8787486aedc0381058793db7415b7383229aecca99a66fbbf0814d8a38 *execution-console.log
