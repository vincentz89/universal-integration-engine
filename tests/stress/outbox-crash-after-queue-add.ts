import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../../src/shared/utils/db.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";
import { runOutboxDispatchCycle } from "../../src/infra/queues/outbox-dispatcher.js";

import {
  outboxRepository,
  OUTBOX_LOCK_DURATION_MS,
} from "../../src/shared/repositories/outbox.repository.js";

import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";
import {
  webhookQueueDataSchema,
} from "../../src/infra/queues/contracts/job-schemas.js";

// ==========================================
// TEST DATA
// ==========================================

const tenantId = randomUUID();
const integrationId = randomUUID();
const webhookEventId = randomUUID();
const correlationId = randomUUID();

const syncLogId = randomUUID();
const idempotencyRecordId = randomUUID();
const leaseToken = randomUUID();

const testId = randomUUID();

const deduplicationKey = `outbox-crash-test:${testId}`;
const expectedJobId = `outbox_${testId}`;

let outboxEventId: string | null = null;

// ==========================================
// ASSERTION
// ==========================================

function check(
  condition: boolean,
  message: string,
): void {
  assert.ok(condition, message);
  console.log(`[PASS] ${message}`);
}

// ==========================================
// MAIN TEST
// ==========================================

async function main(): Promise<void> {
  console.log("======================================");
  console.log("OUTBOX CRASH-AFTER-QUEUE-ADD TEST");
  console.log("======================================");

  try {
    // --------------------------------------
    // 1. Ensure an isolated test environment.
    // --------------------------------------

    const now = new Date();

    const staleLockBefore = new Date(
      now.getTime() - OUTBOX_LOCK_DURATION_MS,
    );

    const existingEligibleEvents =
      await prisma.outboxEvent.count({
        where: {
          OR: [
            {
              status: "PENDING",
              availableAt: {
                lte: now,
              },
              attemptCount: {
                lt: 10,
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

    check(
      existingEligibleEvents === 0,
      "No unrelated eligible or stale Outbox events exist",
    );

    // --------------------------------------
    // 2. Build a valid webhook queue payload.
    // --------------------------------------

    const queuePayload = {
      syncLogId,
      idempotencyRecordId,
      leaseToken,
      payload: {
        tenantId,
        integrationId,
        webhookEventId,
        correlationId,
        source: "BIGCOMMERCE",
        eventType: "store/product/updated",
        resourceType: "product",
        resourceId: "12345",
        payload: {
          data: {
            type: "product",
            id: 12345,
          },
        },
      },
    };

    const parsedPayload =
      webhookQueueDataSchema.safeParse(queuePayload);

    if (!parsedPayload.success) {
      throw new Error(
        `Invalid test queue payload: ${parsedPayload.error.message}`,
      );
    }

    console.log(
      "[PASS] Webhook queue payload passes Zod validation",
    );

    // --------------------------------------
    // 3. Create the Outbox event.
    // --------------------------------------

    const event = await prisma.outboxEvent.create({
      data: {
        eventType: "QUEUE_JOB_DISPATCH",
        aggregateType: "WebhookEvent",
        aggregateId: webhookEventId,
        deduplicationKey,
        payload: {
          jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
          jobData: queuePayload,
        } as Prisma.InputJsonValue,
      },
    });

    outboxEventId = event.id;

    const actualJobId = `outbox_${event.id}`;

    console.log("[Test] Outbox event:", event.id);
    console.log("[Test] Expected BullMQ job ID:", actualJobId);

    check(
      event.status === "PENDING",
      "Outbox event initially has PENDING status",
    );

    // --------------------------------------
    // PHASE 1: DISPATCHER A CLAIMS EVENT
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 1: DISPATCHER A CLAIMS EVENT");
    console.log("--------------------------------------");

    const firstClaim =
      await outboxRepository.claimPending({
        limit: 1,
      });

    check(
      firstClaim.length === 1,
      "Dispatcher A claimed exactly one event",
    );

    const dispatcherAEvent = firstClaim[0];

    assert.ok(dispatcherAEvent);

    check(
      dispatcherAEvent.id === event.id,
      "Dispatcher A claimed the test event",
    );

    check(
      dispatcherAEvent.lockToken !== null,
      "Dispatcher A received a lock token",
    );

    const dispatcherALockToken =
      dispatcherAEvent.lockToken!;

    // --------------------------------------
    // PHASE 2: QUEUE.ADD SUCCEEDS
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 2: QUEUE.ADD SUCCEEDS");
    console.log("--------------------------------------");

    // Simulate the exact queue.add operation performed
    // by the Outbox dispatcher.
    const originalJob = await integrationQueue.add(
      JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      parsedPayload.data,
      {
        jobId: actualJobId,
      },
    );

    check(
      originalJob.id === actualJobId,
      "Dispatcher A successfully inserted the BullMQ job",
    );

    const originalStoredJob =
      await integrationQueue.getJob(actualJobId);

    check(
      originalStoredJob !== undefined,
      "Original BullMQ job exists in Redis",
    );

    const originalState =
      await originalStoredJob!.getState();

    check(
      originalState === "waiting",
      "Original job remains waiting because no worker is running",
    );

    // --------------------------------------
    // PHASE 3: SIMULATE PROCESS CRASH
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 3: SIMULATE DISPATCHER CRASH");
    console.log("--------------------------------------");

    // Intentionally DO NOT call markPublished().
    // Dispatcher A is assumed to have crashed here.

    const beforeRecovery =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: event.id,
        },
      });

    check(
      beforeRecovery.status === "PROCESSING",
      "Outbox event remains PROCESSING after simulated crash",
    );

    check(
      beforeRecovery.lockToken === dispatcherALockToken,
      "Dispatcher A still owns the original lock",
    );

    check(
      beforeRecovery.publishedAt === null,
      "Outbox event has not been marked PUBLISHED",
    );

    // Expire Dispatcher A's lock.
    await prisma.outboxEvent.update({
      where: {
        id: event.id,
      },
      data: {
        lockedAt: new Date(
          Date.now() - OUTBOX_LOCK_DURATION_MS - 1000,
        ),
      },
    });

    // --------------------------------------
    // PHASE 4: DISPATCHER B RECOVERS EVENT
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 4: DISPATCHER B RECOVERS EVENT");
    console.log("--------------------------------------");

    // Run the actual dispatcher.
    // It will reclaim the stale event, attempt queue.add()
    // with the same deterministic job ID, then mark it published.
    const dispatchResult =
      await runOutboxDispatchCycle();

    console.log("[Test] Dispatch result:", dispatchResult);

    check(
      dispatchResult.published === 1,
      "Dispatcher B successfully finalized one event",
    );

    check(
      dispatchResult.failed === 0,
      "Dispatcher B encountered no publishing failures",
    );

    check(
      dispatchResult.skipped === 0,
      "Dispatcher B skipped no events",
    );

    // --------------------------------------
    // PHASE 5: VERIFY DETERMINISTIC JOB ID
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 5: VERIFY DUPLICATE PREVENTION");
    console.log("--------------------------------------");

    const recoveredJob =
      await integrationQueue.getJob(actualJobId);

    check(
      recoveredJob !== undefined,
      "BullMQ job still exists after Dispatcher B retries",
    );

    check(
      recoveredJob!.id === originalJob.id,
      "Dispatcher B reused the original deterministic job ID",
    );

    const recoveredState =
      await recoveredJob!.getState();

    check(
      recoveredState === "waiting",
      "Original job remains waiting and was not consumed",
    );

    // Verify that only one matching job exists in the queue.
    const waitingJobs = await integrationQueue.getJobs(
      ["waiting", "delayed", "active"],
      0,
      -1,
    );

    const matchingJobs = waitingJobs.filter(
      (job) => job.id === actualJobId,
    );

    check(
      matchingJobs.length === 1,
      "Exactly one matching BullMQ job exists",
    );

    // Verify the original job payload was retained.
    const recoveredPayload =
      webhookQueueDataSchema.safeParse(
        recoveredJob!.data,
      );

    check(
      recoveredPayload.success,
      "Retained BullMQ payload remains valid",
    );

    const recoveredQueuePayload =
      webhookQueueDataSchema.safeParse(recoveredJob!.data);

    if (!recoveredQueuePayload.success) {
      throw new Error(
        `Recovered job has invalid webhook data: ${recoveredQueuePayload.error.message}`,
      );
    }

    check(
      recoveredQueuePayload.data.syncLogId === syncLogId,
      "Original SyncLog ID is preserved",
    );

    check(
      recoveredQueuePayload.data.idempotencyRecordId ===
        idempotencyRecordId,
      "Original idempotency record ID is preserved",
    );

    check(
      recoveredQueuePayload.data.leaseToken === leaseToken,
      "Original lease token is preserved",
    );

    // --------------------------------------
    // PHASE 6: VERIFY OUTBOX FINALIZATION
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 6: VERIFY OUTBOX FINALIZATION");
    console.log("--------------------------------------");

    const finalEvent =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: event.id,
        },
      });

    check(
      finalEvent.status === "PUBLISHED",
      "Outbox event is PUBLISHED",
    );

    check(
      finalEvent.lockToken === null,
      "Outbox lock token was cleared",
    );

    check(
      finalEvent.lockedAt === null,
      "Outbox lock timestamp was cleared",
    );

    check(
      finalEvent.publishedAt !== null,
      "Published timestamp was recorded",
    );

    check(
      finalEvent.attemptCount === 2,
      "Outbox attempt count is exactly 2",
    );

    // --------------------------------------
    // FINAL RESULT
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("FINAL RESULT: ALL TESTS PASSED");
    console.log("======================================");
  } finally {
    console.log("--------------------------------------");
    console.log("CLEANUP");
    console.log("--------------------------------------");

    try {
      if (outboxEventId) {
        const job = await integrationQueue.getJob(
          `outbox_${outboxEventId}`,
        );

        if (job) {
          await job.remove();
        }

        await prisma.outboxEvent.deleteMany({
          where: {
            id: outboxEventId,
          },
        });
      }

      console.log("[Test] BullMQ job and Outbox event cleaned up.");
    } finally {
      await integrationQueue.close();
      await redisConnection.quit();
      await prisma.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error("OUTBOX CRASH TEST FAILED:", error);
  process.exitCode = 1;
});