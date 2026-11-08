
import "dotenv/config";

import { Prisma } from "@prisma/client";

import { prisma } from "../../src/shared/utils/db.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";

import {
  runOutboxDispatchCycle,
} from "../../src/infra/queues/outbox-dispatcher.js";

import {
  OUTBOX_LOCK_DURATION_MS,
} from "../../src/shared/repositories/outbox.repository.js";

import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";

// ==========================================
// CONFIGURATION
// ==========================================

const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 300_000;
const MAX_PUBLISH_ATTEMPTS = 10;

const testPrefix = `outbox-retry-test:${Date.now()}`;

const createdEventIds: string[] = [];

// ==========================================
// HELPERS
// ==========================================

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }

  console.log(`PASS: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedRetryDelay(attempt: number): number {
  return Math.min(
    BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
}

// ==========================================
// CREATE INVALID OUTBOX EVENT
// ==========================================

async function createInvalidOutboxEvent(
  name: string,
  attemptCount = 0,
): Promise<string> {
  const event = await prisma.outboxEvent.create({
    data: {
      eventType: "QUEUE_JOB_DISPATCH",
      aggregateType: "OutboxRetryTest",
      aggregateId: `${testPrefix}:${name}`,
      deduplicationKey: `${testPrefix}:${name}`,
      attemptCount,
      payload: {
        // Supported job name, intentionally invalid queue data.
        jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
        jobData: {
          invalid: true,
          testCase: name,
        },
      } as Prisma.InputJsonValue,
    },
  });

  createdEventIds.push(event.id);

  return event.id;
}

// ==========================================
// MAIN TEST
// ==========================================

async function runTest(): Promise<void> {
  console.log("=================================");
  console.log("OUTBOX RETRY INTEGRATION TEST");
  console.log("=================================");

  try {
    // --------------------------------------
    // 1. Ensure test isolation.
    // --------------------------------------

    const now = new Date();

    const staleLockBefore = new Date(
      now.getTime() - OUTBOX_LOCK_DURATION_MS,
    );

    const existingEligibleEvents =
      await prisma.outboxEvent.count({
        where: {
          attemptCount: {
            lt: MAX_PUBLISH_ATTEMPTS,
          },
          OR: [
            {
              status: "PENDING",
              availableAt: {
                lte: now,
              },
            },
            {
              status: "PROCESSING",
              lockedAt: {
                lte: staleLockBefore,
              },
            },
          ],
        },
      });

    assert(
      existingEligibleEvents === 0,
      "No unrelated eligible Outbox events exist",
    );

    // --------------------------------------
    // 2. FIRST FAILURE
    // --------------------------------------

    console.log("---------------------------------");
    console.log("FIRST PUBLISHING FAILURE");
    console.log("---------------------------------");

    const firstEventId =
      await createInvalidOutboxEvent("first-failure");

    const firstCycle = await runOutboxDispatchCycle();

    console.log("First Cycle:", firstCycle);

    assert(
      firstCycle.failed === 1,
      "Invalid payload was rejected",
    );

    const firstEvent =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: firstEventId,
        },
      });

    assert(
      firstEvent.status === "PENDING",
      "First failure returned event to PENDING",
    );

    assert(
      firstEvent.attemptCount === 1,
      "First publishing attempt count is 1",
    );

    assert(
      firstEvent.lockToken === null,
      "First failure cleared lock token",
    );

    assert(
      firstEvent.lockedAt === null,
      "First failure cleared lock timestamp",
    );

    const firstDelay =
      firstEvent.availableAt.getTime() -
      Date.now();

    assert(
      firstDelay > 0 &&
        firstDelay <= expectedRetryDelay(1) + 1_000,
      "First retry scheduled with approximately 2-second backoff",
    );

    console.log("First Retry Delay:", firstDelay, "ms");

    // --------------------------------------
    // 3. SECOND FAILURE
    // --------------------------------------

    console.log("---------------------------------");
    console.log("SECOND PUBLISHING FAILURE");
    console.log("---------------------------------");

    const remainingDelay = Math.max(
      0,
      firstEvent.availableAt.getTime() - Date.now(),
    );

    // Wait until the first event becomes eligible again.
    await sleep(remainingDelay + 200);

    const secondCycle = await runOutboxDispatchCycle();

    console.log("Second Cycle:", secondCycle);

    assert(
      secondCycle.failed === 1,
      "Second publishing attempt failed as expected",
    );

    const secondEvent =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: firstEventId,
        },
      });

    assert(
      secondEvent.status === "PENDING",
      "Second failure returned event to PENDING",
    );

    assert(
      secondEvent.attemptCount === 2,
      "Second publishing attempt count is 2",
    );

    const secondDelay =
      secondEvent.availableAt.getTime() -
      Date.now();

    assert(
      secondDelay > 0 &&
        secondDelay <= expectedRetryDelay(2) + 1_000,
      "Second retry scheduled with approximately 4-second backoff",
    );

    console.log("Second Retry Delay:", secondDelay, "ms");

    // --------------------------------------
    // 4. MAXIMUM ATTEMPTS
    // --------------------------------------

    console.log("---------------------------------");
    console.log("MAXIMUM PUBLISHING ATTEMPTS");
    console.log("---------------------------------");

    // Start at attempt 9.
    // claimPending increments it to 10.
    const finalEventId =
      await createInvalidOutboxEvent(
        "maximum-attempts",
        MAX_PUBLISH_ATTEMPTS - 1,
      );

    const finalCycle = await runOutboxDispatchCycle();

    console.log("Final Cycle:", finalCycle);

    assert(
      finalCycle.failed === 1,
      "Maximum-attempt publishing failure was recorded",
    );

    const finalEvent =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: finalEventId,
        },
      });

    assert(
      finalEvent.status === "FAILED",
      "Event moved to FAILED after maximum attempts",
    );

    assert(
      finalEvent.attemptCount === MAX_PUBLISH_ATTEMPTS,
      "Publishing attempt count reached 10",
    );

    assert(
      finalEvent.lockToken === null,
      "Final failure cleared lock token",
    );

    assert(
      finalEvent.lockedAt === null,
      "Final failure cleared lock timestamp",
    );

    assert(
      typeof finalEvent.lastError === "string" &&
        finalEvent.lastError.length > 0,
      "Final failure recorded the error message",
    );

    // --------------------------------------
    // FINAL RESULT
    // --------------------------------------

    console.log("---------------------------------");
    console.log("FINAL RESULT: ALL TESTS PASSED");
    console.log("=================================");
  } finally {
    // --------------------------------------
    // CLEANUP
    // --------------------------------------

    console.log("---------------------------------");
    console.log("CLEANUP");
    console.log("---------------------------------");

    try {
      await prisma.outboxEvent.deleteMany({
        where: {
          id: {
            in: createdEventIds,
          },
        },
      });

      console.log("Test OutboxEvents cleaned up.");
    } finally {
      await integrationQueue.close();
      await redisConnection.quit();
      await prisma.$disconnect();
    }
  }
}

runTest().catch((error) => {
  console.error("OUTBOX RETRY TEST FAILED:", error);
  process.exitCode = 1;
});
