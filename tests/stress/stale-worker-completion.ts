
import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";

import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();

  const externalEventId = `stale-worker-${randomUUID()}`;

  const idempotencyRecordId = randomUUID();

  // Worker A's original lease token.
  const oldLeaseToken = randomUUID();

  // Worker B's replacement lease token, assigned by recovery.
  const newLeaseToken = randomUUID();

  const oldSyncLogId = randomUUID();
  const replacementSyncLogId = randomUUID();

  const oldJobId = `stale-worker-a-${randomUUID()}`;
  const replacementJobId = `stale-worker-b-${randomUUID()}`;

  const requestHash = "e".repeat(64);

  console.info("======================================");
  console.info("STALE WORKER COMPLETION TEST");
  console.info("======================================");

  try {
    // 1. Create an isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: true,
      },
    });

    // 2. Create a webhook event already reset by recovery.
    await prisma.webhookEvent.create({
      data: {
        id: webhookEventId,
        tenantId,
        integrationId,
        source: "BIGCOMMERCE",
        eventType: "store/product/updated",
        externalEventId,
        status: "RECEIVED",
        correlationId,
        payload: {
          data: {
            type: "product",
            id: "stale-worker-product",
          },
        },
      },
    });

    // 3. Simulate recovery having transferred lease ownership.
    await prisma.idempotencyRecord.create({
      data: {
        id: idempotencyRecordId,
        tenantKey: tenantId,
        scope: getIntegrationWebhookIdempotencyScope(
          "BIGCOMMERCE",
          integrationId,
        ),
        idempotencyKey: externalEventId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        requestHash,
        status: "PROCESSING",
        attemptCount: 2,
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken: newLeaseToken,
      },
    });

    // 4. Create Worker A's original SyncLog.
    await prisma.syncLog.create({
      data: {
        id: oldSyncLogId,
        tenantId,
        jobId: oldJobId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        queueName: "integration-sync-queue",
        source: "BIGCOMMERCE",
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId,
        status: "SUPERSEDED",
        attemptCount: 1,
        startedAt: new Date(Date.now() - 90_000),
        finishedAt: new Date(),
        errorMessage: "Superseded after lease recovery.",
        payload: {},
      },
    });

    // 5. Create Worker B's replacement SyncLog.
    await prisma.syncLog.create({
      data: {
        id: replacementSyncLogId,
        tenantId,
        jobId: replacementJobId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        queueName: "integration-sync-queue",
        source: "BIGCOMMERCE",
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId,
        status: "PENDING",
        attemptCount: 0,
        payload: {},
      },
    });

    console.info("[Test] Recovery state created.");
    console.info("[Test] Worker A lease:", oldLeaseToken);
    console.info("[Test] Worker B lease:", newLeaseToken);

    // 6. Simulate Worker A attempting the same successful
    // finalization transaction used by the production worker.
    console.info("--------------------------------------");
    console.info("PHASE 1: STALE WORKER COMPLETION");
    console.info("--------------------------------------");

    const oldWorkerCompleted = await prisma.$transaction(
      async (tx) => {
        const finishedAt = new Date();

        const claim = await tx.idempotencyRecord.updateMany({
          where: {
            id: idempotencyRecordId,
            status: "PROCESSING",
            leaseToken: oldLeaseToken,
            leaseExpiresAt: {
              gt: finishedAt,
            },
          },
          data: {
            status: "COMPLETED",
            result: {
              success: true,
              worker: "A",
            },
            errorMessage: null,
            completedAt: finishedAt,
            leaseExpiresAt: null,
            leaseToken: null,
          },
        });

        // Worker A no longer owns the lease.
        if (claim.count !== 1) {
          await tx.syncLog.updateMany({
            where: {
              id: oldSyncLogId,
              status: {
                in: ["PENDING", "PROCESSING"],
              },
            },
            data: {
              status: "SUPERSEDED",
              finishedAt,
              errorMessage:
                "Execution superseded: idempotency lease is no longer owned by this worker.",
            },
          });

          return false;
        }

        // These updates must never run for Worker A.
        await tx.webhookEvent.update({
          where: {
            id: webhookEventId,
          },
          data: {
            status: "PROCESSED",
            processedAt: finishedAt,
            errorMessage: null,
          },
        });

        await tx.syncLog.updateMany({
          where: {
            id: oldSyncLogId,
            status: "PROCESSING",
          },
          data: {
            status: "SUCCESS",
            finishedAt,
            errorMessage: null,
          },
        });

        return true;
      },
    );

    assert.equal(
      oldWorkerCompleted,
      false,
      "Worker A must not complete using its expired lease token.",
    );

    console.info(
      "[PASS] Worker A was rejected by the lease ownership check.",
    );

    // 7. Verify that Worker B still owns the record.
    console.info("--------------------------------------");
    console.info("PHASE 2: VERIFY WORKER B OWNERSHIP");
    console.info("--------------------------------------");

    const finalRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: idempotencyRecordId,
        },
      });

    assert.equal(
      finalRecord.status,
      "PROCESSING",
      "IdempotencyRecord must remain PROCESSING.",
    );

    assert.equal(
      finalRecord.leaseToken,
      newLeaseToken,
      "Worker B's lease token must remain unchanged.",
    );

    assert.equal(
      finalRecord.attemptCount,
      2,
      "Recovery attempt count must remain unchanged.",
    );

    assert.equal(
      finalRecord.completedAt,
      null,
      "Stale Worker A must not set completedAt.",
    );

    assert.equal(
      finalRecord.result,
      null,
      "Stale Worker A must not write its result.",
    );

    console.info(
      "[PASS] Worker B retains idempotency lease ownership.",
    );

    // 8. Verify that the webhook was not finalized by Worker A.
    const finalEvent =
      await prisma.webhookEvent.findUniqueOrThrow({
        where: {
          id: webhookEventId,
        },
      });

    assert.equal(
      finalEvent.status,
      "RECEIVED",
      "Worker A must not mark the webhook PROCESSED.",
    );

    assert.equal(
      finalEvent.processedAt,
      null,
      "Worker A must not set processedAt.",
    );

    console.info(
      "[PASS] WebhookEvent remains RECEIVED.",
    );

    // 9. Verify both execution logs.
    const [oldLog, replacementLog] = await Promise.all([
      prisma.syncLog.findUniqueOrThrow({
        where: {
          id: oldSyncLogId,
        },
      }),
      prisma.syncLog.findUniqueOrThrow({
        where: {
          id: replacementSyncLogId,
        },
      }),
    ]);

    assert.equal(
      oldLog.status,
      "SUPERSEDED",
      "Worker A's original SyncLog must remain SUPERSEDED.",
    );

    assert.equal(
      replacementLog.status,
      "PENDING",
      "Worker B's replacement SyncLog must remain PENDING.",
    );

    console.info(
      "[PASS] Worker A's SyncLog remains SUPERSEDED.",
    );

    console.info(
      "[PASS] Worker B's SyncLog remains PENDING.",
    );

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");
  } finally {
    await prisma.idempotencyRecord.deleteMany({
      where: {
        id: idempotencyRecordId,
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
        id: integrationId,
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
  console.error(
    "STALE WORKER COMPLETION TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});
