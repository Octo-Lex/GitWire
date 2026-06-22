// packages/executor-service/src/index.js
// Entry point: load config, build the HTTP server, listen.
//
// Production: `node src/index.js` (invoked by the package's Dockerfile CMD).
// The server listens on config.port. Health is served at GET /health.

import { loadExecutorServiceConfig } from "./config.js";
import { createServer } from "./server.js";

function log(obj, msg) {
  // Minimal structured logger; pino isn't a dependency of this package and
  // we don't want one for a 2-endpoint service. Matches gitwire-app's pino
  // shape so docker logs --filter still works.
  console.log(JSON.stringify({ level: 30, ...obj, msg }));
}

function main() {
  const config = loadExecutorServiceConfig();
  const server = createServer({ config });

  server.listen(config.port, () => {
    log({
      service: "executor-service",
      executor_service_id: config.executor_service_id,
      deployment_mode: config.deployment_mode,
      port: config.port,
    }, "executor service listening");
  });

  // Graceful shutdown — exit on signals so Docker's restart policy catches it.
  // (No background workers / DB pool to drain in v0.23.0; just stop accepting.)
  function shutdown(signal) {
    log({ signal }, "shutdown signal — closing server");
    server.close(() => process.exit(0));
    // Hard exit if close() hangs.
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
