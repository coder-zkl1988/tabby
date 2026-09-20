import { serve } from "@hono/node-server";
import { bootstrapController } from "./app/bootstrap.js";
import { createContainer } from "./app/container.js";
import { createApp } from "./app/create-app.js";
import { acceptTrustedLocalUpgrade } from "./lib/local-request-guard.js";
import { logger } from "./lib/logger.js";
import { flushV8CoverageIfEnabled } from "./lib/v8-coverage.js";

async function main(): Promise<void> {
  const container = await createContainer();
  const app = createApp(container);
  const server = serve(
    {
      fetch: app.fetch,
      hostname: container.env.host,
      port: container.env.port,
    },
    (info) => {
      logger.info(
        { host: info.address, port: info.port },
        "controller started",
      );
    },
  );

  // Wire WebSocket upgrade handlers (device mirror + realtime voice)
  server.on("upgrade", (req, socket, head) => {
    if (!acceptTrustedLocalUpgrade(req, socket)) return;
    if (container.talkVoiceProxy.handleUpgrade(req, socket, head)) return;
    container.deviceMirrorProxy.handleUpgrade(req, socket, head);
  });

  let stopBackgroundLoops = () => {};

  let shuttingDown = false;

  const closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
      // `close()` alone waits for every connection to drain, and an SSE
      // stream never drains. Measured: a replaced controller lingered as a
      // zombie — listener gone, `process.exit` never reached — pinging the
      // desktop's agent-browser stream from beyond the grave, which kept the
      // relay attached to a bridge no /act request would ever reach again.
      if ("closeAllConnections" in server) {
        (server as { closeAllConnections: () => void }).closeAllConnections();
      }
    });

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    stopBackgroundLoops();

    try {
      await closeServer();
    } catch (error: unknown) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "controller shutdown server close failed",
      );
    }

    try {
      container.deviceMirrorProxy.close();
    } catch (error: unknown) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "controller shutdown device mirror proxy close failed",
      );
    }

    try {
      await container.localAutomationService.stop();
    } catch (error: unknown) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "controller shutdown local automation cleanup failed",
      );
    }

    try {
      await container.openclawProcess.stop();
    } catch (error: unknown) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "controller shutdown stop failed",
      );
    } finally {
      flushV8CoverageIfEnabled();
      process.exit(0);
    }
  };

  try {
    stopBackgroundLoops = await bootstrapController(container);
  } catch (error) {
    try {
      await closeServer();
    } catch {
      // Best-effort cleanup on bootstrap failure.
    }

    try {
      container.deviceMirrorProxy.close();
    } catch {
      // Best-effort cleanup on bootstrap failure.
    }

    try {
      await container.localAutomationService.stop();
    } catch {
      // Best-effort cleanup on bootstrap failure.
    }

    try {
      await container.openclawProcess.stop();
    } catch {
      // Best-effort cleanup on bootstrap failure.
    }

    throw error;
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "controller failed to start",
  );
  process.exitCode = 1;
});
