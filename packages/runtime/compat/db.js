// @gitwire/runtime/compat/db.js
// Lazy singleton — delegates to the runtime-initialized database.
// Auto-initializes from config if needed.

import { getRuntime } from "../src/index.js";
import { ensureRuntime } from "./_init.js";

let _db = null;

function getDb() {
  if (!_db) {
    ensureRuntime();
    _db = getRuntime().db;
  }
  return _db;
}

export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const d = getDb();
      const val = d[prop];
      return typeof val === "function" ? val.bind(d) : val;
    },
  }
);
