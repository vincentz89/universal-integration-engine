
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../../src/shared/utils/db.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";
import { runOutboxDispatchCycle } from "../../src/infra/queues/outbox-dispatcher.js";
import {
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

const jobId = `outbox_test_${testId}`;
const deduplicationKey = `outbox-test:${testId}`;

let outboxEventId: string | null = null;

// ==========================================
// ASSERTION
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

// ==========================================
// MAIN TEST
// ==========================================

async function runTest(): Promise<void> {
  console.log("=================================");
  console.log("OUTBOX DISPATCHER INTEGRATION TEST");
  console.log("=================================");

  try {
    // --------------------------------------
    // 1. Ensure the test will not dispatch
    // unrelated pending Outbox events.
    // --------------------------------------

    const now = new Date();

    const staleLockBefore = new Date(
      now.getTime() - OUTBOX_LOCK_DURATION_MS,
    );

    const existingEligibleEvents =
      await prisma.outboxEvent.count({
        where: {
          attemptCount: {
            lt: 10,
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

    assert(
      parsedPayload.success,
      "Queue envelope passes Zod validation",
    );

    // --------------------------------------
    // 3. Create a pending Outbox event.
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

    console.log("Created OutboxEvent:", event.id);

    assert(
      event.status === "PENDING",
      "Initial Outbox status is PENDING",
    );

    // --------------------------------------
    // 4. Execute the actual dispatcher.
    // --------------------------------------

    console.log("---------------------------------");
    console.log("RUNNING OUTBOX DISPATCHER");
    console.log("---------------------------------");

    const result = await runOutboxDispatchCycle();

    console.log("Dispatch Result:", result);

    assert(
      result.published === 1,
      "Exactly one event was published",
    );

    assert(
      result.failed === 0,
      "No publishing failures",
    );

    assert(
      result.skipped === 0,
      "No events were skipped",
    );

    // --------------------------------------
    // 5. Verify BullMQ job.
    // --------------------------------------

    const expectedJobId = `outbox_${event.id}`;

    const job = await integrationQueue.getJob(
      expectedJobId,
    );

    assert(
      job !== undefined,
      "BullMQ job exists",
    );

    assert(
      job!.id === expectedJobId,
      "Deterministic job ID is correct",
    );

    assert(
      job!.name === JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      "BullMQ job name is correct",
    );

    const publishedPayload =
      webhookQueueDataSchema.safeParse(job!.data);

    assert(
      publishedPayload.success,
      "Published BullMQ payload is valid",
    );

    const verifiedQueueData = webhookQueueDataSchema.parse(
      job!.data,
    );

    assert(
      verifiedQueueData.syncLogId === syncLogId,
      "SyncLog ID is preserved",
    );

    assert(
      verifiedQueueData.idempotencyRecordId ===
        idempotencyRecordId,
      "Idempotency record ID is preserved",
    );

    assert(
      verifiedQueueData.leaseToken === leaseToken,
      "Lease token is preserved",
    );

    // --------------------------------------
    // 6. Verify Outbox finalization.
    // --------------------------------------

    const updatedEvent =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: event.id,
        },
      });

    assert(
      updatedEvent.status === "PUBLISHED",
      "Outbox status changed to PUBLISHED",
    );

    assert(
      updatedEvent.lockToken === null,
      "Outbox lock token was cleared",
    );

    assert(
      updatedEvent.lockedAt === null,
      "Outbox lock timestamp was cleared",
    );

    assert(
      updatedEvent.publishedAt !== null,
      "Published timestamp was recorded",
    );

    assert(
      updatedEvent.attemptCount === 1,
      "Publishing attempt count is 1",
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
      const job = await integrationQueue.getJob(jobId);

      if (job) {
        await job.remove();
      }

      // The actual dispatcher uses outbox_${event.id}.
      if (outboxEventId) {
        const publishedJob = await integrationQueue.getJob(
          `outbox_${outboxEventId}`,
        );

        if (publishedJob) {
          await publishedJob.remove();
        }

        await prisma.outboxEvent.deleteMany({
          where: {
            id: outboxEventId,
          },
        });
      }

      console.log("Test queue job and OutboxEvent cleaned up.");
    } finally {
      await integrationQueue.close();
      await redisConnection.quit();
      await prisma.$disconnect();
    }
  }
}

runTest().catch((error) => {
  console.error("OUTBOX DISPATCHER TEST FAILED:", error);
  process.exitCode = 1;
});
