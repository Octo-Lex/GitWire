// tests/fixtures/budget-child.mjs
//
// Child process for the budget concurrency regression test
// (tests/unit/target-policy.test.js). Uses the PUBLIC budget API exactly as
// production does — no monkey-patching of internal paths. The child receives
// a single JSON argument and waits on a stdin barrier so all children can be
// released simultaneously by the parent.

import { TESTING_ONLY } from "../target-policy.js";

const { RunWideMutationBudget } = TESTING_ONLY;

// Single JSON argument at argv[2] (argv[0]=node, argv[1]=this script path).
const cfg = JSON.parse(process.argv[2]);

// WAIT on the stdin barrier. The parent spawns all children paused, then
// writes a byte to each stdin to release them at the same instant. This is
// what actually exercises O_EXCL contention: without the barrier, children
// start at staggered times and rarely collide on the same slot index.
const barrier = new Promise((resolve) => {
  process.stdin.once("data", resolve);
  process.stdin.resume();
});
await barrier;

// Construct via the PUBLIC API. The first child to run becomes the owner
// (atomically creates the marker); the rest attach (validate metadata). Both
// roles consume slots identically against the shared directory.
let b;
let role;
try {
  b = new RunWideMutationBudget(cfg.max, cfg.runId, {
    fixtureRepo: cfg.fixtureRepo,
    fixtureInstallationId: cfg.fixtureInstallationId,
  });
  role = b.role();
} catch (err) {
  // Construction failed (collision, mismatch, etc.). Report and exit nonzero
  // so the parent surfaces it rather than treating it as zero claims.
  console.log("CHILD_ERROR=" + err.message);
  process.exit(0); // exit 0 so spawn doesn't signal; parent reads CHILD_ERROR
}

// Attempt cfg.perWorker consumptions.
let ok = 0;
for (let i = 0; i < cfg.perWorker; i++) {
  try {
    b.consume("child-" + process.pid);
    ok++;
  } catch (e) {
    // exhausted — stop early
    break;
  }
}

// Report claim count and role so the parent can assert contention happened.
console.log("CHILD_OK=" + ok + " ROLE=" + role);
