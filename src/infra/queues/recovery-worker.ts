import "dotenv/config";

import { recoverExpiredWebhookJobs } from "./recovery-dispatcher.js";

import { integrationQueue } from "./queue.js";
import { redisConnection } from "./redis.js";
import { prisma } from "../../shared/utils/db.js";

const RECOVERY_INTERVAL_MS = 10_000;

let isRunning = false;
let isShuttingDown = false;

async function runRecoveryCycle() {
  if (isRunning || isShuttingDown) {
    return;
  }

  isRunning = true;

  try {
    const result = await recoverExpiredWebhookJobs();

    if (result.scanned > 0) {
      console.info("[Recovery Worker] Cycle completed:", result);
    }
  } catch (error) {
    console.error(
      "[Recovery Worker] Recovery cycle failed:",
      error,
    );
  } finally {
    isRunning = false;
  }
}

async function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  clearInterval(recoveryInterval);

  console.info("[Recovery Worker] Shutting down...");

  // Wait for the current recovery cycle to finish.
  while (isRunning) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await integrationQueue.close();
  await redisConnection.quit();
  await prisma.$disconnect();

  console.info("[Recovery Worker] Shutdown complete.");

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

console.info("[Recovery Worker] Started.");

void runRecoveryCycle();

const recoveryInterval = setInterval(() => {
  void runRecoveryCycle();
}, RECOVERY_INTERVAL_MS);