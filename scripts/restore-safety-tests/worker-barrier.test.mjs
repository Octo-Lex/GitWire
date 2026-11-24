// Test 5/5: the permanent fail-closed worker barrier. Its state is a host-side
// marker file independent of the restored data: a crashed restore or host
// reboot cannot clear the block, and workers start only on complete positive
// classification evidence.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, die, pass } from './helpers.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'rs-t5-barrier-'));
const MARKER = join(DIR, 'restore-barrier.json');

// The barrier under test: reads its state from the marker file every call —
// no in-memory state, so any crash or reboot resumes from disk (fail-closed).
class Barrier {
  constructor(markerPath) { this.markerPath = markerPath; }
  #load() {
    if (!existsSync(this.markerPath)) return { state: 'absent' };
    return JSON.parse(readFileSync(this.markerPath, 'utf8'));
  }
  mayStartWorkers() {
    const s = this.#load();
    return s.state === 'complete' && s.uncertainCount === 0 && s.restoreId != null;
  }
  refuseReason() {
    const s = this.#load();
    if (s.state === 'absent') return 'no classification marker exists';
    if (s.state !== 'complete') return 'classification is not complete: ' + s.state;
    if (s.uncertainCount > 0) return 'uncertain items present: ' + s.uncertainCount;
    return null;
  }
}

// Absent marker -> refuse (fail-closed).
const b = new Barrier(MARKER);
if (b.mayStartWorkers()) die('workers allowed with NO marker at all');
log('refused (absent):', b.refuseReason());
// Incomplete classification -> refuse.
writeFileSync(MARKER, JSON.stringify({ restoreId: 'r-42', state: 'incomplete', uncertainCount: 0 }));
if (b.mayStartWorkers()) die('workers allowed on incomplete classification');
log('refused (incomplete):', b.refuseReason());
// Any uncertain -> refuse.
writeFileSync(MARKER, JSON.stringify({ restoreId: 'r-42', state: 'complete', uncertainCount: 2 }));
if (b.mayStartWorkers()) die('workers allowed with uncertain items present');
log('refused (uncertain):', b.refuseReason());

// Simulated restore crash + host reboot: a FRESH barrier instance reads the
// same marker from disk and stays blocked (state outlives the process).
writeFileSync(MARKER, JSON.stringify({ restoreId: 'r-43', state: 'incomplete', uncertainCount: 0 }));
const b2 = new Barrier(MARKER);
if (b2.mayStartWorkers()) die('barrier state did not survive the simulated crash');
log('survived simulated crash: still blocked');

// Complete positive evidence -> allow, and only then.
writeFileSync(MARKER, JSON.stringify({ restoreId: 'r-44', state: 'complete', uncertainCount: 0 }));
if (!b2.mayStartWorkers()) die('workers refused despite complete positive classification');
log('allowed only on complete positive evidence (r-44)');
rmSync(DIR, { recursive: true, force: true });
pass('worker-barrier: fail-closed on absent/incomplete/uncertain; state survives crash; opens on complete evidence');
