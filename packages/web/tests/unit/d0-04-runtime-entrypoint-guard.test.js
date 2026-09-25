// D0-04: startup worker imports are a source-discovery boundary. Any worker
// module reference or import syntax the runtime scanner does not parse must
// fail CI rather than silently becoming invisible to the surface inventory.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(TEST_DIR, "../..");
const INDEX_PATH = path.join(WEB_ROOT, "src", "index.js");
const WORKER_MODULE_REFERENCE_RE = /["']\.\/workers\/[^"']+\.js["']/g;
const WORKER_IMPORT_CANDIDATE_RE = /from\s+["']\.\/workers\/[^"']+\.js["']/g;
const SCANNER_WORKER_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*"\.\/workers\/([^"]+\.js)";/gms;

function assertScannerCompatibleWorkerImports(source) {
  const references = [...source.matchAll(WORKER_MODULE_REFERENCE_RE)].length;
  const candidates = [...source.matchAll(WORKER_IMPORT_CANDIDATE_RE)].length;
  const parsed = [...source.matchAll(SCANNER_WORKER_IMPORT_RE)].length;
  if (references !== candidates || parsed !== candidates) {
    throw new Error(
      `Scanner-incompatible worker import syntax: found ${references} worker references, ${candidates} import candidates, and ${parsed} parsed imports`,
    );
  }
}

describe("D0-04 runtime entrypoint guard", () => {
  const indexSource = fs.readFileSync(INDEX_PATH, "utf8");

  test("worker module references stay compatible with startup runtime discovery", () => {
    expect(() => assertScannerCompatibleWorkerImports(indexSource)).not.toThrow();
  });

  test("single-quoted, semicolonless, or dynamic worker imports fail closed", () => {
    const variants = [
      "import { startSyntheticWorker } from './workers/syntheticWorker.js';",
      'import { startSyntheticWorker } from "./workers/syntheticWorker.js"',
      'const mod = await import("./workers/syntheticWorker.js");',
    ];

    for (const source of variants) {
      expect(() => assertScannerCompatibleWorkerImports(source)).toThrow(
        /Scanner-incompatible worker import syntax/,
      );
    }
  });
});
