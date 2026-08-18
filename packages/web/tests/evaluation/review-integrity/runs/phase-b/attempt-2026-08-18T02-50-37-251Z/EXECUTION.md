# Phase B Attempt 2 — Execution Manifest and Evidence Index

Immutable evidence for the second Phase B matrix execution. Evidence-only
branch: never merged; the candidate tree (9586a68 / e6b2b53a) is untouched.

## Identity

| Field | Value |
| --- | --- |
| Attempt ID | `attempt-2026-08-18T02-50-37-251Z` |
| Candidate commit | `9586a68512d8b3e072c0b47c7f1726c482a84df6` (PR #160, unmerged) |
| Candidate tree | `e6b2b53a0bf9c46b37073667750e2d6e6f79ade5` (asserted equal inside the execution container before the first invocation) |
| Configuration | Manifest v5 re-freeze: the ONLY delta vs attempt 1 is `ABLATION_MODEL=glm-5.1` (asserted equal inside the container); provider/route, protocol, prompts, tool contract, corpus, order, criteria, RI-6/RI-7 unchanged |
| Quota authorization | PR #160 review `4956619621` (Alajmah, 2026-08-18T02:37:35Z) — verified before spend; exactly one fresh 24-invocation attempt |
| Stop record | PR #160 review `4957135702` (Alajmah, 2026-08-18T04:10:01Z) — FAILED and stopped; no attempt 3, no further model-name re-freeze, no merge of #160, no Phase C |
| Window | 2026-08-18 02:50:04 UTC → 03:33:56 UTC |
| Invocations | 24/24 completed (fixture-major, frozen order), no retries |
| Recorded usage | 523,381 tokens total (avg 21,808/invocation); avg ~108 s/invocation |

## Execution environment

| Field | Value |
| --- | --- |
| Host | Windows dev host, Docker Desktop (linux/amd64 daemon 27.3.1) |
| Container image | `docker.io/library/node:20` (image ID `33ed5ef90e83`, Node `v20.20.2`) |
| Source acquisition | `git clone --no-hardlinks /src /wt` (read-only mount of the local repository objects), then `git checkout --detach 9586a68…`; SHA and tree asserted equal to the frozen values inside the container before any provider call |
| Install | `npm ci --ignore-scripts` at the worktree root (inside container) |
| Credentials | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` sourced from the production container env via SSH into an env file passed with `--env-file`; the key is never present in any file of this branch (secret-scanned) |
| Endpoint (asserted) | `ANTHROPIC_BASE_URL` = `https://api.z.ai/api/anthropic` |
| Model override | `ABLATION_MODEL=glm-5.1` (asserted equal). Every invocation was REPORTED served as `glm-5.3` — identical reported identity to attempt 1 despite the different requested identifier (recorded as descriptive telemetry; see Outcome) |

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
presence, base-URL equality, `ABLATION_MODEL=glm-5.1`.

## Outcome (suite-enforced, frozen thresholds — unchanged from v4/v5)

| Fixture | False APPROVE | Detection | APPROVE | Verdict | vs attempt 1 |
| --- | --- | --- | --- | --- | --- |
| RI-01 broken | 0/3 | 2/3 (3rd abstained) | — | PASS | was FAIL |
| RI-01 fixed | — | — | 3/3 | PASS | PASS |
| RI-02 broken | 1/3 (run 2) | 0/3 | — | FAIL | FAIL |
| RI-02 fixed | — | — | 3/3 | PASS | PASS |
| RI-03 broken | 0/3 | 0/3 | — | FAIL | FAIL |
| RI-03 fixed | — | — | 0/3 (all abstained) | FAIL | FAIL |
| RI-04 broken | 2/3 (runs 1, 2) | 0/3 | — | FAIL | FAIL (worse: 2 vs 1) |
| RI-04 fixed | — | — | 2/3 (3rd abstained) | PASS | was FAIL |

Suite result: rc=1, 4 of 8 fixture tests failed.

**Classification (client-adjudicated, PR #160 review 4957135702):** primary =
review-quality recall/capability failure (2/12 detections; 10/12 misses);
safety consequence = material false-approval escape (three broken runs
approved — worse than attempt 1's one; all three with verifier `verified`);
secondary = reliability/convergence failure (RI-03 fixed 0/3 APPROVE across
both matrices). **New load-bearing issue: model-selection control is not
demonstrated on this route** — changing the requested identifier from
glm-5.2 to glm-5.1 left every provider-reported response at glm-5.3, so the
requested-model variable did not isolate a distinct served configuration.
Next gate (client-owned): provider-side confirmation of routing/alias/
reporting semantics before any configuration decision.

## Evidence integrity (SHA-256, per file in this directory)

e041f5a2236d95be0c2711f97c8b20bd69db4485eadbb049a5c2e83a663868a2 *9586a68512d8-RI-01-broken-run1.json
5fa3aa91267f5aa23d0b89aa2fde049f59a2081fa3e6bbda4e8ced9728eb0dad *9586a68512d8-RI-01-broken-run2.json
24db9dbea81f37a569eed01eb7a3c76d523c8d4c0e3b372f48e6c19a0e58cc8f *9586a68512d8-RI-01-broken-run3.json
ce58a2852535aad3b5c27011512acf07de4d46e3a59301e5b17414bf6a0b26e7 *9586a68512d8-RI-01-fixed-run1.json
ff7008e4c442a8d5eaeef98f819e1895595648bfdeab8d4971788205b7fa9587 *9586a68512d8-RI-01-fixed-run2.json
afcc589a832e2c7405d523b46ac3b175b3becd8b1567651b1a7c236ee0070c0b *9586a68512d8-RI-01-fixed-run3.json
6b21a4bafd5130f1979dcc661d872a9a56af316420ebac924d29dcdbf8b6bc73 *9586a68512d8-RI-02-broken-run1.json
cbed0265bd889248a440136a141f2b9dd01506f1bf969afa783b14346bf04d5f *9586a68512d8-RI-02-broken-run2.json
486142792c661c18817b259468a8c9e339b5b24a58f8074f53697498ac34eb0a *9586a68512d8-RI-02-broken-run3.json
e7bb5490bce1c620c66592c8ba57c6bf0d252fe4eefd5fa21e9c6cba7c839ff2 *9586a68512d8-RI-02-fixed-run1.json
0a0da8c2a067d6351f97c0d6fb20f7e1cd1924dd2f6bb2e87855879340549fb0 *9586a68512d8-RI-02-fixed-run2.json
847cdd017e16a99542c4a18b6a4e2f5c6315b1a796ee8d798dee7f967acf71a2 *9586a68512d8-RI-02-fixed-run3.json
43e39cc3607f3cba4265f3b8c8492eb6ae67574d50ffb0a94983d9e61d38fb1b *9586a68512d8-RI-03-broken-run1.json
a53188cc529b547db21ef2e011a4c369ca34b59cc6202e567bf0762e15a4c83a *9586a68512d8-RI-03-broken-run2.json
2861719f1c396a6f39c3e1d9e3e17cdbdb87fddf30e575a4395c777b20e06ba4 *9586a68512d8-RI-03-broken-run3.json
2519440ba327140c468d7e32d429abc26f630575262f2740d340eec610137964 *9586a68512d8-RI-03-fixed-run1.json
ad85cbdd1c5b6ef44cc3e6fe93f2adffbf99159be9aaa0b2eba64f634fa84e01 *9586a68512d8-RI-03-fixed-run2.json
123a4e58b9eaf8f44a7436a53ffb9217002b2a9c6facf2997d5e74aafbdf0ff5 *9586a68512d8-RI-03-fixed-run3.json
4d51f18773cdf465c92a8b149c8bd0451058fa322da9a8fdb2df0a1fabc97466 *9586a68512d8-RI-04-broken-run1.json
b307f6bcd7996134bbb0759d4cc208354cec2c6093a5f269bdcd01ff6f76e074 *9586a68512d8-RI-04-broken-run2.json
f10815dae589856b0aaaeab3e7cd26c6818b841620f2e35c8837fcdc176e0522 *9586a68512d8-RI-04-broken-run3.json
095b46679a7b234266c083e428f1d03fa33b46d0b7383441c9dcbcc9801466ff *9586a68512d8-RI-04-fixed-run1.json
ea7c546752ae541f57ee3227c0e58b896876dd275e7cf07867aa180f3bae22b7 *9586a68512d8-RI-04-fixed-run2.json
995adfea5b4c950d7588dd26ff9a6aedc2e9e97457a1e3d8a186065f5c9688e1 *9586a68512d8-RI-04-fixed-run3.json
8366751c528bf5ef526f0ec2a4dd9fb726c170d03b57810e9cae6700e58c0418 *live-after-results.json
e1ea99d26c3f7b43e0aa0ef9efbc94cc65f73963ef1f5ecc893d519bfbe43f66 *execution-console.log
