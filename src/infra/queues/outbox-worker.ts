
import { integrationQueue } from "./queue.js";
import { runOutboxDispatchCycle } from "./outbox-dispatcher.js";
import { redisConnection } from "./redis.js";
import { prisma } from "../../shared/utils/db.js";

const OUTBOX_INTERVAL_MS = 10_000;

let isRunning = false;
let isShuttingDown = false;

let activeCycle: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;

async function runOutboxCycle() {
  if (isRunning || isShuttingDown) {
    return;
  }

  isRunning = true;

  const cycle = (async () => {
    try {
      await runOutboxDispatchCycle();
    } catch (error) {
      console.error(
        "[Outbox Worker] Dispatch cycle failed:",
        error,
      );
    } finally {
      isRunning = false;
      activeCycle = null;
    }
  })();

  activeCycle = cycle;

  await cycle;
}

async function shutdown() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    isShuttingDown = true;

    clearInterval(outboxInterval);

    console.info(
      "[Outbox Worker] Shutdown requested. Waiting for active cycle...",
    );

    // Allow the current dispatch cycle to finish.
    if (activeCycle) {
      await activeCycle;
    }

    console.info("[Outbox Worker] Closing resources...");

    const results = await Promise.allSettled([
      integrationQueue.close(),
      redisConnection.quit(),
      prisma.$disconnect(),
    ]);

    const failedOperations = results.filter(
      (result) => result.status === "rejected",
    );

    if (failedOperations.length > 0) {
      console.error(
        "[Outbox Worker] Some resources failed to close:",
        failedOperations,
      );

      process.exitCode = 1;
    } else {
      console.info(
        "[Outbox Worker] Shutdown completed successfully.",
      );
    }
  })();

  return shutdownPromise;
}

const outboxInterval = setInterval(() => {
  void runOutboxCycle();
}, OUTBOX_INTERVAL_MS);

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

console.info(
  `[Outbox Worker] Started. Dispatch interval: ${OUTBOX_INTERVAL_MS}ms`,
);

// Run immediately instead of waiting for the first interval.
void runOutboxCycle();
