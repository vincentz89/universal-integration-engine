
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { recoverExpiredWebhookJobs } from "../../src/infra/queues/recovery-dispatcher.js";
import { webhookQueueDataSchema } from "../../src/infra/queues/contracts/job-schemas.js";

import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

function assert(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();
  const oldLeaseToken = randomUUID();

  const externalEventId = `recovery-test-${randomUUID()}`;
  const requestHash = "a".repeat(64);

  console.info("=================================");
  console.info("RECOVERY DISPATCHER INTEGRATION TEST");
  console.info("=================================");

  const integrationScope =
    getIntegrationWebhookIdempotencyScope(
      "BIGCOMMERCE",
      integrationId,
    );

  try {
    // 1. Create an isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create an active BigCommerce integration.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: true,
      },
    });

    // 3. Create the original webhook event.
    await prisma.webhookEvent.create({
      data: {
        id: webhookEventId,
        tenantId,
        integrationId,
        source: "BIGCOMMERCE",
        eventType: "store/product/updated",
        externalEventId,
        status: "PROCESSING",
        correlationId,
        payload: {
          data: {
            type: "product",
            id: 12345,
          },
        },
      },
    });

    // 4. Create an expired idempotency lease.
    const expiredRecord =
      await prisma.idempotencyRecord.create({
        data: {
          tenantKey: tenantId,
          scope: integrationScope,
          idempotencyKey: externalEventId,
          jobName: "PROCESS_WEBHOOK_EVENT",
          requestHash,
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: new Date(Date.now() - 120_000),
          leaseExpiresAt: new Date(Date.now() - 1_000),
          leaseToken: oldLeaseToken,
        },
      });

    // 5. Create the previous unfinished SyncLog.
    const oldSyncLog = await prisma.syncLog.create({
      data: {
        tenantId,
        jobId: randomUUID(),
        jobName: "PROCESS_WEBHOOK_EVENT",
        queueName: "integration-sync-queue",
        source: "BIGCOMMERCE",
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId,
        status: "PROCESSING",
        attemptCount: 1,
        startedAt: new Date(Date.now() - 120_000),
        payload: {
          test: "original-processing-attempt",
        },
      },
    });

    console.info("---------------------------------");
    console.info("RUNNING RECOVERY");
    console.info("---------------------------------");

    const result = await recoverExpiredWebhookJobs({ tenantKey: tenantId, limit: 1, });

    console.info("Recovery Result:", result);

    // 6. Verify the previous SyncLog was superseded.
    const previousLog = await prisma.syncLog.findUniqueOrThrow({
      where: {
        id: oldSyncLog.id,
      },
    });

    assert(
      previousLog.status === "SUPERSEDED",
      "Previous SyncLog was not marked SUPERSEDED.",
    );

    // 7. Verify a replacement SyncLog exists.
    const replacementLog = await prisma.syncLog.findFirst({
      where: {
        tenantId,
        webhookEventId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        id: { not: oldSyncLog.id },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    assert(
      replacementLog !== null,
      "Replacement SyncLog was not created.",
    );

    assert(
      replacementLog.status === "PENDING",
      "Replacement SyncLog is not PENDING.",
    );

    // 8. Verify the WebhookEvent was reset.
    const recoveredEvent =
      await prisma.webhookEvent.findUniqueOrThrow({
        where: {
          id: webhookEventId,
        },
      });

    assert(
      recoveredEvent.status === "RECEIVED",
      "WebhookEvent was not reset to RECEIVED.",
    );

    // 9. Verify the replacement OutboxEvent.
    const expectedDeduplicationKey =
      `webhook:${expiredRecord.id}:attempt:2`;

    const outboxEvent =
      await prisma.outboxEvent.findUnique({
        where: {
          deduplicationKey: expectedDeduplicationKey,
        },
      });

    assert(
      outboxEvent !== null,
      "Replacement OutboxEvent was not created.",
    );

    assert(
      outboxEvent.status === "PENDING",
      "Replacement OutboxEvent is not PENDING.",
    );

    assert(
      outboxEvent.eventType === "QUEUE_JOB_DISPATCH",
      "Unexpected Outbox event type.",
    );

    assert(
      outboxEvent.aggregateId === webhookEventId,
      "Outbox aggregate ID does not match the WebhookEvent.",
    );

    // 10. Validate the actual stored BullMQ envelope.
    assert(
      isRecord(outboxEvent.payload),
      "Outbox payload is not a JSON object.",
    );

    assert(
      outboxEvent.payload.jobName === "PROCESS_WEBHOOK_EVENT",
      "Outbox job name is incorrect.",
    );

    const queueData = webhookQueueDataSchema.safeParse(
      outboxEvent.payload.jobData,
    );

    assert(
      queueData.success,
      "Recovered Outbox job data failed queue schema validation.",
    );

    assert(
      queueData.data.syncLogId === replacementLog.id,
      "Queue envelope references the wrong SyncLog.",
    );

    assert(
      queueData.data.idempotencyRecordId === expiredRecord.id,
      "Queue envelope references the wrong idempotency record.",
    );

    assert(
      queueData.data.leaseToken !== oldLeaseToken,
      "Recovery reused the old lease token.",
    );

    // 11. Verify the idempotency record has a new active lease.
    const recoveredRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: expiredRecord.id,
        },
      });

    assert(
      recoveredRecord.status === "PROCESSING",
      "Recovered idempotency record is not PROCESSING.",
    );

    assert(
      recoveredRecord.attemptCount === 2,
      "Recovery did not increment attemptCount to 2.",
    );

    assert(
      recoveredRecord.leaseToken === queueData.data.leaseToken,
      "Idempotency record and queue envelope have different lease tokens.",
    );

    assert(
      recoveredRecord.leaseToken !== oldLeaseToken,
      "Idempotency lease token was not replaced.",
    );

    assert(
      recoveredRecord.leaseExpiresAt !== null &&
      recoveredRecord.leaseExpiresAt > new Date(),
      "Recovered lease is not active.",
    );

    assert(
      result.scanned === 1 &&
      result.recovered === 1 &&
      result.skipped === 0 &&
      result.failed === 0,
      "Unexpected recovery cycle result.",
    );

    console.info("---------------------------------");
    console.info("RECOVERY ASSERTIONS");
    console.info("---------------------------------");
    console.info("Previous SyncLog: SUPERSEDED");
    console.info("Replacement SyncLog: PENDING");
    console.info("WebhookEvent: RECEIVED");
    console.info("OutboxEvent: PENDING");
    console.info("Queue Envelope: VALID");
    console.info("Lease Replaced: true");
    console.info("Attempt Count:", recoveredRecord.attemptCount);
    console.info("---------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("=================================");
  } finally {
    // Clean up only records belonging to this test.
    await prisma.outboxEvent.deleteMany({
      where: {
        aggregateType: "WebhookEvent",
        aggregateId: webhookEventId,
      },
    });

    await prisma.idempotencyRecord.deleteMany({
      where: {
        tenantKey: tenantId,
      },
    });

    await prisma.syncLog.deleteMany({
      where: {
        tenantId,
      },
    });

    await prisma.webhookEvent.deleteMany({
      where: {
        tenantId,
      },
    });

    await prisma.tenantIntegrationConfig.deleteMany({
      where: {
        tenantId,
      },
    });

    await prisma.tenantConfig.deleteMany({
      where: {
        id: tenantId,
      },
    });

    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("RECOVERY INTEGRATION TEST FAILED:", error);
  process.exitCode = 1;
});
