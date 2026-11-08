
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { recoverExpiredWebhookJobs } from "../../src/infra/queues/recovery-dispatcher.js";
import { webhookQueueDataSchema } from "../../src/infra/queues/contracts/job-schemas.js";

import {
  getRecoveryAdapter,
  registerRecoveryAdapter,
} from "../../src/infra/queues/recovery/recovery-adapter-registry.js";

import {
  getWebhookSystemNameFromScope,
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

import type {
  WebhookRecoveryAdapter,
} from "../../src/infra/queues/recovery/recovery-adapter.types.js";

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

const shopifyTestRecoveryAdapter: WebhookRecoveryAdapter = {
  source: "SHOPIFY",

  buildPayload(input) {
    const resourceId = input.payload.id;

    return {
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      webhookEventId: input.webhookEventId,
      correlationId: input.correlationId,
      source: "SHOPIFY",
      eventType: input.eventType,
      resourceType: "product",
      ...(typeof resourceId === "string" ||
      typeof resourceId === "number"
        ? { resourceId: String(resourceId) }
        : {}),
      payload: input.payload,
    };
  },
};

registerRecoveryAdapter(shopifyTestRecoveryAdapter);

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

  try {
    assert(
      getWebhookSystemNameFromScope("WEBHOOK:SHOPIFY") === "SHOPIFY",
      "SHOPIFY webhook scope was not resolved correctly.",
    );

    const accountSpecificScope =
      getIntegrationWebhookIdempotencyScope("SHOPIFY", integrationId);

    assert(
      getWebhookSystemNameFromScope(accountSpecificScope) === "SHOPIFY",
      "Account-specific Shopify scope was not resolved correctly.",
    );

    assert(
      getRecoveryAdapter("SHOPIFY") === shopifyTestRecoveryAdapter,
      "SHOPIFY recovery adapter was not registered correctly.",
    );

    // 1. Create an isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create an active Shopify integration.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "SHOPIFY",
        isActive: true,
      },
    });

        // 3. Create the original webhook event.
    await prisma.webhookEvent.create({
      data: {
        id: webhookEventId,
        tenantId,
        integrationId,
        source: "SHOPIFY",
        eventType: "products/update",
        externalEventId,
        status: "PROCESSING",
        correlationId,
        payload: {
          id: 12345,
          title: "Shopify Recovery Test Product",
        },
      },
    });

    // 4. Create an expired idempotency lease.
    const expiredRecord =
      await prisma.idempotencyRecord.create({
        data: {
          tenantKey: tenantId,
          scope: accountSpecificScope,
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

    // 5. Create an expired idempotency lease for an unsupported provider.
    const unsupportedLeaseToken = randomUUID();

    const unsupportedRecord = await prisma.idempotencyRecord.create({
      data: {
        tenantKey: tenantId,
        scope: "WEBHOOK:UNREGISTERED_PROVIDER",
        idempotencyKey: `unsupported-${randomUUID()}`,
        jobName: "PROCESS_WEBHOOK_EVENT",
        requestHash: "b".repeat(64),
        status: "PROCESSING",
        attemptCount: 1,
        startedAt: new Date(Date.now() - 120_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
        leaseToken: unsupportedLeaseToken,
      },
    });

    // 6. Create expired idempotency leases with malformed or unrelated scopes.
    const malformedScopes = [
      "WEBHOOK:",
      "WEBHOOK:shopify",
      "WEBHOOK:SHOPIFY:EXTRA",
      "ORDER_PROCESSING",
    ] as const;

    const malformedRecords = await Promise.all(
      malformedScopes.map((scope) => {
        const leaseToken = randomUUID();

        return prisma.idempotencyRecord.create({
          data: {
            tenantKey: tenantId,
            scope,
            idempotencyKey: `malformed-${randomUUID()}`,
            jobName: "PROCESS_WEBHOOK_EVENT",
            requestHash: "c".repeat(64),
            status: "PROCESSING",
            attemptCount: 1,
            startedAt: new Date(Date.now() - 120_000),
            leaseExpiresAt: new Date(Date.now() - 1_000),
            leaseToken,
          },
        });
      }),
    );

    // Verify malformed-scope records were not modified.
    for (const malformedRecord of malformedRecords) {
      const recordAfterRecovery =
        await prisma.idempotencyRecord.findUniqueOrThrow({
          where: { id: malformedRecord.id },
        });

      assert(
        recordAfterRecovery.status === "PROCESSING",
        `Malformed scope ${malformedRecord.scope} status was unexpectedly modified.`,
      );

      assert(
        recordAfterRecovery.leaseToken === malformedRecord.leaseToken,
        `Malformed scope ${malformedRecord.scope} lease token was unexpectedly modified.`,
      );

      assert(
        recordAfterRecovery.attemptCount === 1,
        `Malformed scope ${malformedRecord.scope} attempt count was unexpectedly modified.`,
      );
    }

    // 5. Create the previous unfinished SyncLog.
    const oldSyncLog = await prisma.syncLog.create({
      data: {
        tenantId,
        jobId: randomUUID(),
        jobName: "PROCESS_WEBHOOK_EVENT",
        queueName: "integration-sync-queue",
        source: "SHOPIFY",
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

    const result = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    console.info("Recovery Result:", result);

    assert(
      result.scanned === 1,
      `Expected 1 scanned record, received ${result.scanned}.`,
    );

    assert(
      result.recovered === 1,
      `Expected 1 recovered record, received ${result.recovered}.`,
    );

    assert(
      result.skipped === 0,
      `Expected 0 skipped records, received ${result.skipped}.`,
    );

    assert(
      result.failed === 0,
      `Expected 0 failed records, received ${result.failed}.`,
    );

    // Verify that the unsupported provider's lease was not modified.
    const unsupportedRecordAfterRecovery =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: unsupportedRecord.id },
      });

    assert(
      unsupportedRecordAfterRecovery.status === "PROCESSING",
      "Unsupported provider status was unexpectedly modified.",
    );

    assert(
      unsupportedRecordAfterRecovery.leaseToken === unsupportedLeaseToken,
      "Unsupported provider lease token was unexpectedly modified.",
    );

    assert(
      unsupportedRecordAfterRecovery.attemptCount === 1,
      "Unsupported provider attempt count was unexpectedly modified.",
    );

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
      queueData.data.payload.source === "SHOPIFY",
      "Recovered queue payload has an incorrect provider source.",
    );

    assert(
      queueData.data.payload.resourceType === "product",
      "Recovered queue payload has an incorrect resource type.",
    );

    assert(
      queueData.data.payload.integrationId === integrationId,
      "Recovered queue payload references the wrong integration.",
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

    // 12. Verify recovery rejects an account-specific scope
    // that references a different integration.
    const mismatchedIntegrationId = randomUUID();

    const mismatchedRecord =
      await prisma.idempotencyRecord.create({
        data: {
          tenantKey: tenantId,
          scope: getIntegrationWebhookIdempotencyScope(
            "SHOPIFY",
            mismatchedIntegrationId,
          ),
          idempotencyKey: externalEventId,
          jobName: "PROCESS_WEBHOOK_EVENT",
          requestHash,
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: new Date(Date.now() - 120_000),
          leaseExpiresAt: new Date(Date.now() - 1_000),
          leaseToken: randomUUID(),
        },
      });

    const syncLogCountBeforeMismatch =
      await prisma.syncLog.count({
        where: {
          tenantId,
          webhookEventId,
        },
      });

    const mismatchResult = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    assert(
      mismatchResult.scanned === 1 &&
      mismatchResult.recovered === 0 &&
      mismatchResult.failed === 1,
      "Recovery did not reject the mismatched integration scope.",
    );

    const quarantinedMismatch =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: mismatchedRecord.id,
        },
      });

    assert(
      quarantinedMismatch.recoveryBlockedAt !== null,
      "Mismatched integration record was not permanently quarantined.",
    );

    assert(
      quarantinedMismatch.recoveryAttemptCount === 0,
      "Permanent quarantine incorrectly incremented recoveryAttemptCount.",
    );

    assert(
      quarantinedMismatch.recoveryLastError?.includes(
        "Integration-owned WebhookEvent not found",
      ) === true,
      "Permanent quarantine did not preserve the missing integration-owned event reason.",
    );

    const syncLogCountAfterMismatch =
      await prisma.syncLog.count({
        where: {
          tenantId,
          webhookEventId,
        },
      });

    assert(
      syncLogCountAfterMismatch === syncLogCountBeforeMismatch,
      "A SyncLog was created despite the integration mismatch.",
    );

    const outboxCountAfterMismatch =
      await prisma.outboxEvent.count({
        where: {
          aggregateType: "WebhookEvent",
          aggregateId: webhookEventId,
        },
      });

    assert(
      outboxCountAfterMismatch === 1,
      "An additional OutboxEvent was created despite the integration mismatch.",
    );

    console.info("Integration Mismatch: REJECTED");

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
