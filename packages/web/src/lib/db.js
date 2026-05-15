// src/lib/db.js
// Thin wrapper around the `pg` pool.
// Import `db` anywhere and call db.query() or db.transaction().

import pg from "pg";
import { config } from "../../config/index.js";
import { logger } from "./logger.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.db.url,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected PostgreSQL pool error");
});

export const db = {
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
};
