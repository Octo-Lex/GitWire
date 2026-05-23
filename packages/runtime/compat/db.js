// @gitwire/runtime/compat/db.js
// Lazy singleton — delegates to the runtime-initialized database.
// This allows existing code to keep using:
//   import { db } from "../lib/db.js";

import { getRuntime } from "../src/index.js";

export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const rt = getRuntime();
      const val = rt.db[prop];
      return typeof val === "function" ? val.bind(rt.db) : val;
    },
  }
);
