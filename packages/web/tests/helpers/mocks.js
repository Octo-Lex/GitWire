// tests/helpers/mocks.js
// Shared mock setup for service unit tests.
// Mocks: db, logger, config, queue, fetch
//
// Usage in test files:
//   import { mockDb, mockLogger, setupMocks } from '../helpers/mocks.js';
//   setupMocks();

// ── Mock db.query ────────────────────────────────────────────────────────────
const _rows = [];
const _dbQueries = [];

export const mockDb = {
  /** Set the rows that the next db.query() call returns */
  setRows(rows) { _rows.length = 0; _rows.push(...rows); },
  /** Set different rows for sequential queries: [{ rows: [...] }, { rows: [...] }] */
  setSequential(responses) { _rows.length = 0; _rows.push(...responses); },
  /** Get all queries that were executed */
  getQueries() { return [..._dbQueries]; },
  /** Get the last query executed */
  getLastQuery() { return _dbQueries[_dbQueries.length - 1] || null; },
  /** Clear all recorded queries and rows */
  clear() { _rows.length = 0; _dbQueries.length = 0; },
};

// ── Mock logger ──────────────────────────────────────────────────────────────
export const mockLogger = {
  info: (...args) => {},
  warn: (...args) => {},
  error: (...args) => {},
  debug: (...args) => {},
  fatal: (...args) => {},
  child: () => mockLogger,
};

// ── Setup all mocks (call once per test file, before imports) ────────────────
export function setupMocks() {
  // This is a no-op when called at runtime because we use jest.mock()
  // Actual mocking is done via jest.mock() in the test files
}

// ── Helper: create a mock octokit ───────────────────────────────────────────
export function createMockOctokit(responses = {}) {
  const calls = [];
  const octokit = {
    request: async (route, params) => {
      calls.push({ route, params });
      const handler = responses[route];
      if (handler) {
        if (typeof handler === 'function') return handler(params);
        return handler;
      }
      // Default responses based on route
      if (route.includes('/repos')) return { data: { default_branch: 'main' } };
      if (route.includes('/issues')) return { data: { number: 1, state: 'open' } };
      if (route.includes('/pulls')) return { data: { number: 1, state: 'open' } };
      return { data: {} };
    },
    _calls: calls,
  };
  return octokit;
}

// ── Helper: create mock db that returns different results per query pattern ──
export function createMockDb(queryHandlers = {}) {
  const calls = [];
  return {
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [pattern, handler] of Object.entries(queryHandlers)) {
        if (sql.includes(pattern)) {
          const result = typeof handler === 'function' ? handler(sql, params) : handler;
          return result;
        }
      }
      return { rows: [], rowCount: 0 };
    },
    transaction: async (fn) => {
      const txMock = {
        query: async (sql, params) => {
          calls.push({ sql, params, inTransaction: true });
          for (const [pattern, handler] of Object.entries(queryHandlers)) {
            if (sql.includes(pattern)) {
              const result = typeof handler === 'function' ? handler(sql, params) : handler;
              return result;
            }
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(txMock);
    },
    _calls: calls,
  };
}
