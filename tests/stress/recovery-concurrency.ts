
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { recoverExpiredWebhookJobs } from "../../src/infra/queues/recovery-dispatcher.js";

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

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();

  const externalEventId = `recovery-concurrency-${randomUUID()}`;
  const requestHash = "c".repeat(64);

  const originalLeaseToken = randomUUID();
  const originalSyncLogId = randomUUID();

  const startedAt = new Date();
  const expiredLeaseDate = new Date(Date.now() - 10_000);

  let idempotencyRecordId: string | null = null;

  console.info("======================================");
  console.info("CONCURRENT RECOVERY WORKERS TEST");
  console.info("======================================");

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

    // 3. Create a webhook event awaiting recovery.
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
            id: "concurrent-recovery-product",
          },
        },
      },
    });

    const jobPayload = {
      tenantId,
      integrationId,
      webhookEventId,
      correlationId,
      source: "BIGCOMMERCE",
      eventType: "store/product/updated",
      resourceType: "product",
      resourceId: "concurrent-recovery-product",
      payload: {
        data: {
          type: "product",
          id: "concurrent-recovery-product",
        },
      },
    };

    // 4. Create an expired idempotency lease.
    const idempotencyRecord =
      await prisma.idempotencyRecord.create({
        data: {
          tenantKey: tenantId,
          scope: getIntegrationWebhookIdempotencyScope(
            "BIGCOMMERCE",
            integrationId,
          ),
          idempotencyKey: externalEventId,
          jobName: "PROCESS_WEBHOOK_EVENT",
          requestHash,
          status: "PROCESSING",
          attemptCount: 1,
          startedAt,
          leaseExpiresAt: expiredLeaseDate,
          leaseToken: originalLeaseToken,
        },
      });

    idempotencyRecordId = idempotencyRecord.id;

    // 5. Create the original unfinished SyncLog.
    await prisma.syncLog.create({
      data: {
        id: originalSyncLogId,
        tenantId,
        jobId: `original-${randomUUID()}`,
        jobName: "PROCESS_WEBHOOK_EVENT",
        queueName: "integration-sync-queue",
        source: "BIGCOMMERCE",
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId,
        status: "PROCESSING",
        attemptCount: 1,
        startedAt,
        payload: jobPayload,
      },
    });

    console.info("[Test] Recovery fixture created.");
    console.info("[Test] Idempotency record:", idempotencyRecord.id);

    // 6. Start two recovery workers simultaneously.
    console.info("--------------------------------------");
    console.info("PHASE 1: CONCURRENT RECOVERY");
    console.info("--------------------------------------");

    const recoveryStart = Date.now();

    const [workerAResult, workerBResult] =
      await Promise.all([
        recoverExpiredWebhookJobs({
          tenantKey: tenantId,
          limit: 10,
        }),
        recoverExpiredWebhookJobs({
          tenantKey: tenantId,
          limit: 10,
        }),
      ]);

    const recoveryDuration = Date.now() - recoveryStart;

    console.info("[Recovery Worker A]", workerAResult);
    console.info("[Recovery Worker B]", workerBResult);
    console.info(
      `[Test] Concurrent recovery duration: ${recoveryDuration}ms`,
    );

    // 7. Verify exactly one recovery succeeded.
    const totalRecovered =
      workerAResult.recovered + workerBResult.recovered;

    const totalFailed =
      workerAResult.failed + workerBResult.failed;

    assert(
      totalRecovered === 1,
      `Expected exactly one successful recovery, received ${totalRecovered}.`,
    );

    assert(
      totalFailed === 0,
      `Expected zero recovery failures, received ${totalFailed}.`,
    );

    console.info(
      "[PASS] Exactly one recovery worker claimed the expired lease.",
    );

    // 8. Verify idempotency ownership.
    const finalRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: idempotencyRecord.id },
      });

    assert(
      finalRecord.status === "PROCESSING",
      "Idempotency record is not PROCESSING.",
    );

    assert(
      finalRecord.attemptCount === 2,
      `Expected attemptCount 2, received ${finalRecord.attemptCount}.`,
    );

    assert(
      finalRecord.leaseToken !== originalLeaseToken,
      "Original lease token was not replaced.",
    );

    assert(
      finalRecord.leaseExpiresAt !== null &&
      finalRecord.leaseExpiresAt > new Date(),
      "Replacement lease is not active.",
    );

    console.info("[PASS] Lease ownership replaced exactly once.");

    // 9. Verify the original SyncLog was superseded.
    const originalSyncLog =
      await prisma.syncLog.findUniqueOrThrow({
        where: { id: originalSyncLogId },
      });

    assert(
      originalSyncLog.status === "SUPERSEDED",
      `Original SyncLog status is ${originalSyncLog.status}.`,
    );

    console.info("[PASS] Original SyncLog is SUPERSEDED.");

    // 10. Verify only one replacement SyncLog exists.
    const syncLogs = await prisma.syncLog.findMany({
      where: {
        tenantId,
        webhookEventId,
      },
      orderBy: { createdAt: "asc" },
    });

    const replacementLogs = syncLogs.filter(
      (log) => log.id !== originalSyncLogId,
    );

    assert(
      syncLogs.length === 2,
      `Expected exactly 2 SyncLogs, received ${syncLogs.length}.`,
    );

    assert(
      replacementLogs.length === 1,
      `Expected exactly 1 replacement SyncLog, received ${replacementLogs.length}.`,
    );

    const replacementLog = replacementLogs[0];

    assert(
      replacementLog !== undefined,
      "Replacement SyncLog does not exist.",
    );

    assert(
      replacementLog.status === "PENDING",
      "Replacement SyncLog is not PENDING.",
    );

    console.info("[PASS] Exactly one replacement SyncLog created.");

    // 11. Verify only one replacement OutboxEvent exists.
    const expectedDeduplicationKey =
      `webhook:${idempotencyRecord.id}:attempt:2`;

    const outboxEvents =
      await prisma.outboxEvent.findMany({
        where: {
          aggregateType: "WebhookEvent",
          aggregateId: webhookEventId,
        },
      });

    assert(
      outboxEvents.length === 1,
      `Expected exactly 1 OutboxEvent, received ${outboxEvents.length}.`,
    );

    const replacementOutbox = outboxEvents[0];

    assert(
      replacementOutbox !== undefined,
      "Replacement OutboxEvent does not exist.",
    );

    assert(
      replacementOutbox.deduplicationKey ===
        expectedDeduplicationKey,
      "OutboxEvent deduplication key is incorrect.",
    );

    assert(
      replacementOutbox.status === "PENDING",
      "Replacement OutboxEvent is not PENDING.",
    );

    console.info("[PASS] Exactly one replacement OutboxEvent created.");

    // 12. Verify the Outbox job envelope uses the winning lease.
    const outboxPayload = replacementOutbox.payload;

    assert(
      typeof outboxPayload === "object" &&
      outboxPayload !== null &&
      !Array.isArray(outboxPayload),
      "Outbox payload is not an object.",
    );

    const payload = outboxPayload as Record<string, unknown>;

    assert(
      payload.jobName === "PROCESS_WEBHOOK_EVENT",
      "Outbox job name is incorrect.",
    );

    assert(
      typeof payload.jobData === "object" &&
      payload.jobData !== null &&
      !Array.isArray(payload.jobData),
      "Outbox jobData is invalid.",
    );

    const jobData =
      payload.jobData as Record<string, unknown>;

    assert(
      jobData.idempotencyRecordId === idempotencyRecord.id,
      "Outbox idempotencyRecordId is incorrect.",
    );

    assert(
      jobData.leaseToken === finalRecord.leaseToken,
      "Outbox lease token does not match the winning lease.",
    );

    assert(
      jobData.syncLogId === replacementLog.id,
      "Outbox SyncLog ID does not match the replacement SyncLog.",
    );

    console.info("[PASS] Outbox envelope matches winning lease.");

    // 13. Verify webhook event state.
    const finalWebhookEvent =
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: webhookEventId },
      });

    assert(
      finalWebhookEvent.status === "RECEIVED",
      `Expected WebhookEvent RECEIVED, received ${finalWebhookEvent.status}.`,
    );

    console.info("[PASS] WebhookEvent is RECEIVED.");

    // 14. Final verification.
    console.info("--------------------------------------");
    console.info("FINAL ASSERTIONS");
    console.info("--------------------------------------");

    console.info("Recovery Worker A:", workerAResult);
    console.info("Recovery Worker B:", workerBResult);
    console.info("Successful Recoveries:", totalRecovered);
    console.info("Idempotency Attempts:", finalRecord.attemptCount);
    console.info("Replacement SyncLogs:", replacementLogs.length);
    console.info("Replacement OutboxEvents:", outboxEvents.length);
    console.info("Lease Replaced:", true);
    console.info("Original SyncLog:", originalSyncLog.status);
    console.info("WebhookEvent:", finalWebhookEvent.status);

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");

  } finally {
    // Clean up only records belonging to this test.
    if (idempotencyRecordId) {
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateType: "WebhookEvent",
          aggregateId: webhookEventId,
        },
      });

      await prisma.idempotencyRecord.deleteMany({
        where: {
          id: idempotencyRecordId,
        },
      });
    }

    await prisma.syncLog.deleteMany({
      where: { tenantId },
    });

    await prisma.webhookEvent.deleteMany({
      where: { tenantId },
    });

    await prisma.tenantIntegrationConfig.deleteMany({
      where: { tenantId },
    });

    await prisma.tenantConfig.deleteMany({
      where: { id: tenantId },
    });

    await prisma.$disconnect();

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error) => {
  console.error(
    "CONCURRENT RECOVERY TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});
