import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closePool } from "./db/pool.js";
import { logger } from "./lib/logger.js";
import { ensureUploadRoot } from "./lib/user-image-storage.js";

const app = createApp();

// Create the upload root at boot rather than discovering on a rider's first upload that the
// directory is missing or unwritable. A failure here is a deployment problem (UPLOADS_DIR
// pointing somewhere the process cannot write), so it is worth a loud warning — but not a
// refusal to start: every other endpoint works fine without it.
void ensureUploadRoot().catch((err: Error) => {
  logger.error({ err: err.message }, "could not create the user upload directory (UPLOADS_DIR)");
});

// The listen callback fires even when the bind FAILED (server.listening === false,
// address() === null), so it cannot be trusted as proof of a successful start. Without
// the `error` handler below, a port clash printed "listening on port N" and then exited 0
// as the event loop drained — a dead server that looked like a healthy one.
const server = app.listen(env.PORT, () => {
  if (!server.listening) return;
  logger.info(`Commissaire server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  // console, not logger: this is a startup fatal, and pino's file stream is async — a
  // process.exit() here can discard a buffered log line. Matches config/env.ts.
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${env.PORT} is already in use — another server is still running.\n` +
        `  Find it:  netstat -ano | findstr :${env.PORT}\n` +
        `  Stop it:  taskkill /PID <pid> /F\n` +
        `  Or start this one on a different port: PORT=6501 npm run serve`,
    );
  } else {
    console.error(`HTTP server failed to start: ${err.code ?? ""} ${err.message}`);
  }
  process.exit(1);
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down`);
  server.close(async (err) => {
    if (err) {
      logger.error({ err }, "Error while closing HTTP server");
    }
    await closePool();
    process.exit(err ? 1 : 0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
