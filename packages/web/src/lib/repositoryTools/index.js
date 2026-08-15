// RepositoryTools v2 public surface (RI-9 amendment, Phase 2/3).
//
// Four read-only primitives bound to one immutable repository session:
//   read / grep / find / ls
// The provider/model never appears here: this contract is transport- and
// agent-agnostic, so the current GitWire orchestration and a future Pi
// harness call the exact same instrument.

import { read } from "./read.js";
import { grep } from "./grep.js";
import { find } from "./find.js";
import { ls } from "./ls.js";

/**
 * Bind the four repository primitives to a prepared session.
 *
 * @param {object} session a session returned by prepareRepository()
 * @returns {{read: Function, grep: Function, find: Function, ls: Function}}
 */
export function createRepositoryTools(session) {
  return {
    read: (params) => read(session, params),
    grep: (params) => grep(session, params),
    find: (params) => find(session, params),
    ls: (params) => ls(session, params),
  };
}

export { read, grep, find, ls };
