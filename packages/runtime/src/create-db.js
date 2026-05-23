// @gitwire/runtime/src/create-db.js
// Factory for creating a PostgreSQL pool wrapper.
// Accepts { url, logger? } — no config import needed.

import pg from "pg";

const { Pool } = pg;

/**
 * Create a database pool wrapper with query(), transaction(), end().
 * @param {{ url: string, logger?: object }} opts
 * @returns {{ query: Function, transaction: Function, end: Function, pool: pg.Pool }}
 */
export function createDatabase(opts) {
  const logger = opts.logger || console;

  const pool = new Pool({
    connectionString: opts.url,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected PostgreSQL pool error");
  });

  return {
    /**
     * Run a single query.
     * @param {string} text  - Parameterised SQL string
     * @param {any[]}  params - Bound values
     */
    query(text, params) {
      return pool.query(text, params);
    },

    /**
     * Run multiple queries in a transaction.
     * Rolls back automatically on any thrown error.
     * @param {(client: pg.PoolClient) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    /** Gracefully close all pool connections (for shutdown hooks). */
    end() {
      return pool.end();
    },

    /** Raw pool for advanced use. */
    pool,
  };
}
