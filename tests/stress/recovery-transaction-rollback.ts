
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
  const originalLeaseToken = randomUUID();

  const externalEventId = `rollback-test-${randomUUID()}`;
  const requestHash = "b".repeat(64);
  const originalLeaseExpiresAt = new Date(Date.now() - 60_000);

  console.info("======================================");
  console.info("RECOVERY TRANSACTION ROLLBACK TEST");
  console.info("======================================");

  try {
    // 1. Create an isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create an inactive BigCommerce integration.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: false,
      },
    });

    // 3. Create a webhook event without an active integration.
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
            id: 98765,
          },
        },
      },
    });

    // 4. Create an expired idempotency lease.
    const originalRecord = await prisma.idempotencyRecord.create({
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
        startedAt: new Date(Date.now() - 120_000),
        leaseExpiresAt: originalLeaseExpiresAt,
        leaseToken: originalLeaseToken,
      },
    });

    // 5. Create the original unfinished SyncLog.
    const originalSyncLog = await prisma.syncLog.create({
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

    console.info("--------------------------------------");
    console.info("PHASE 1: TRIGGER RECOVERY FAILURE");
    console.info("--------------------------------------");
    console.info("[Test] No active integration was created.");
    console.info("[Test] An inactive integration exists; recovery should fail.");

    const result = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    console.info("[Test] Recovery result:", result);

    assert(
      result.scanned === 1 &&
      result.recovered === 0 &&
      result.skipped === 0 &&
      result.failed === 1,
      "Recovery did not report the expected transaction failure.",
    );

    // 6. Verify the idempotency lease was rolled back.
    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        id: originalRecord.id,
      },
    });

    assert(
      record.status === "PROCESSING",
      "Idempotency status changed despite transaction rollback.",
    );

    assert(
      record.attemptCount === 1,
      "Idempotency attempt count was not rolled back.",
    );

    assert(
      record.leaseToken === originalLeaseToken,
      "Original lease token was not restored.",
    );

    assert(
      record.leaseExpiresAt !== null &&
      record.leaseExpiresAt.getTime() === originalLeaseExpiresAt.getTime(),
      "Original lease expiration was not restored.",
    );

    assert(
      record.leaseExpiresAt <= new Date(),
      "Original lease should remain expired.",
    );

    // 7. Verify autonomous recovery failure tracking.
    assert(
      record.recoveryAttemptCount === 1,
      "Recovery failure count was not incremented.",
    );

    assert(
      record.recoveryNextAttemptAt !== null &&
      record.recoveryNextAttemptAt > new Date(),
      "Next recovery attempt was not scheduled in the future.",
    );

    assert(
      typeof record.recoveryLastError === "string" &&
      record.recoveryLastError.includes("Active BIGCOMMERCE integration"),
      "Recovery failure reason was not persisted correctly.",
    );

    // 8. Verify the delayed record is excluded from the next recovery batch.
    const secondCycle = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    assert(
      secondCycle.scanned === 0 &&
      secondCycle.recovered === 0 &&
      secondCycle.failed === 0,
      "A record scheduled for delayed recovery was selected again immediately.",
    );

    // 9. Verify the original SyncLog was not modified.
    const syncLog = await prisma.syncLog.findUniqueOrThrow({
      where: {
        id: originalSyncLog.id,
      },
    });

    assert(
      syncLog.status === "PROCESSING",
      "Original SyncLog was modified despite transaction rollback.",
    );

    // 10. Verify no replacement SyncLog was committed.
    const replacementSyncLogs = await prisma.syncLog.count({
      where: {
        tenantId,
        webhookEventId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        id: {
          not: originalSyncLog.id,
        },
      },
    });

    assert(
      replacementSyncLogs === 0,
      "A replacement SyncLog survived transaction rollback.",
    );

    // 11. Verify no replacement OutboxEvent was committed.
    const outboxCount = await prisma.outboxEvent.count({
      where: {
        aggregateType: "WebhookEvent",
        aggregateId: webhookEventId,
      },
    });

    assert(
      outboxCount === 0,
      "An OutboxEvent survived transaction rollback.",
    );

    // 12. Verify the original WebhookEvent was not modified.
    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({
      where: {
        id: webhookEventId,
      },
    });

    assert(
      webhookEvent.status === "PROCESSING",
      "WebhookEvent status changed despite transaction rollback.",
    );

    console.info("--------------------------------------");
    console.info("PHASE 2: VERIFY TRANSACTION ROLLBACK");
    console.info("--------------------------------------");
    console.info("[PASS] Recovery reported one failure.");
    console.info("[PASS] Idempotency status remains PROCESSING.");
    console.info("[PASS] Attempt count remains 1.");
    console.info("[PASS] Original lease token preserved.");
    console.info("[PASS] Original lease expiration preserved.");
    console.info("[PASS] Original lease remains expired.");
    console.info("[PASS] Original SyncLog remains PROCESSING.");
    console.info("[PASS] No replacement SyncLog committed.");
    console.info("[PASS] No replacement OutboxEvent committed.");
    console.info("[PASS] WebhookEvent remains PROCESSING.");
    console.info("[PASS] Recovery failure count incremented.");
    console.info("[PASS] Next recovery attempt scheduled.");
    console.info("[PASS] Recovery failure reason persisted.");
    console.info("[PASS] Delayed record excluded from the next batch.");

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");
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

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error) => {
  console.error("RECOVERY ROLLBACK TEST FAILED:", error);
  process.exitCode = 1;
});
