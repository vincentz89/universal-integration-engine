import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Queue, QueueEvents } from "bullmq";

import { prisma } from "../../src/shared/utils/db.js";
import { redisConnection } from "../../src/infra/queues/redis.js";

const QUEUE_NAME = "integration-sync-queue";

async function main() {
  // Enable the existing test-only handler before importing the worker.
  process.env.ENABLE_STRESS_TEST_HANDLERS = "true";
  process.env.CRASH_TEST_MODE = "false";

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  const integrationBId = randomUUID();
  const webhookEventBId = randomUUID();

  const idempotencyRecordAId = randomUUID();
  const syncLogBId = randomUUID();

  const correlationId = randomUUID();
  const leaseTokenA = randomUUID();

  const externalEventId = `tenant-isolation-${randomUUID()}`;
  const requestHash = "f".repeat(64);

  const jobId = `tenant-isolation-${randomUUID()}`;

  const queue = new Queue(QUEUE_NAME, {
    connection: redisConnection,
  });

  const queueEvents = new QueueEvents(QUEUE_NAME, {
    connection: redisConnection,
  });

  console.info("======================================");
  console.info("TENANT ISOLATION TEST");
  console.info("======================================");

  try {
    // Import the actual production worker after enabling test handlers.
    const { integrationWorker } = await import(
      "../../src/infra/queues/worker.js"
    );

    await integrationWorker.waitUntilReady();
    await queueEvents.waitUntilReady();

    // 1. Create two isolated tenants.
    await prisma.tenantConfig.createMany({
      data: [
        {
          id: tenantAId,
        },
        {
          id: tenantBId,
        },
      ],
    });

    console.info("[Test] Tenant A and Tenant B created.");

    // 2. Create Tenant B's integration configuration.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationBId,
        tenantId: tenantBId,
        systemName: "BIGCOMMERCE",
        baseUrl: "https://example.invalid",
        isActive: true,
      },
    });

    // 3. Create a webhook event belonging to Tenant B.
    await prisma.webhookEvent.create({
      data: {
        id: webhookEventBId,
        tenantId: tenantBId,
        integrationId: integrationBId,
        source: "BIGCOMMERCE",
        eventType: "store/product/updated",
        externalEventId,
        status: "RECEIVED",
        correlationId,
        payload: {
          data: {
            type: "product",
            id: "tenant-b-product",
          },
        },
      },
    });

    // 4. Create Tenant A's valid active idempotency lease.
    await prisma.idempotencyRecord.create({
      data: {
        id: idempotencyRecordAId,
        tenantKey: tenantAId,
        scope: "BIGCOMMERCE_WEBHOOK",
        idempotencyKey: externalEventId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        requestHash,
        status: "PROCESSING",
        attemptCount: 1,
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken: leaseTokenA,
      },
    });

    // 5. Create a SyncLog belonging to Tenant B.
    await prisma.syncLog.create({
      data: {
        id: syncLogBId,
        tenantId: tenantBId,
        jobId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        queueName: QUEUE_NAME,
        source: "BIGCOMMERCE",
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId: webhookEventBId,
        status: "PENDING",
        attemptCount: 0,
        payload: {},
      },
    });

    console.info("[Test] Test records created.");

    console.info("--------------------------------------");
    console.info("PHASE 1: CREATE CROSS-TENANT JOB");
    console.info("--------------------------------------");

    // Tenant B's payload is deliberately combined with
    // Tenant A's idempotency record and lease token.
    const jobData = {
      syncLogId: syncLogBId,
      idempotencyRecordId: idempotencyRecordAId,
      leaseToken: leaseTokenA,
      payload: {
        tenantId: tenantBId,
        integrationId: integrationBId,
        webhookEventId: webhookEventBId,
        correlationId,
        source: "BIGCOMMERCE",
        eventType: "store/product/updated",
        resourceType: "lease-crash",
        resourceId: "tenant-b-product",
        payload: {
          data: {
            type: "product",
            id: "tenant-b-product",
          },
        },
      },
    };

    const job = await queue.add(
      "PROCESS_WEBHOOK_EVENT",
      jobData,
      {
        jobId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    console.info("[Test] Cross-tenant job dispatched.");
    console.info("[Test] Idempotency tenant:", tenantAId);
    console.info("[Test] Payload tenant:", tenantBId);

    console.info("--------------------------------------");
    console.info("PHASE 2: VERIFY WORKER REJECTION");
    console.info("--------------------------------------");

    let jobOutcome: "COMPLETED" | "FAILED";

    try {
      await job.waitUntilFinished(queueEvents, 30_000);
      jobOutcome = "COMPLETED";
    } catch {
      jobOutcome = "FAILED";
    }

    console.info("[Test] Worker outcome:", jobOutcome);

    assert.equal(
      jobOutcome,
      "FAILED",
      "Worker must reject a job whose idempotency tenant does not match its payload tenant.",
    );

    console.info(
      "[PASS] Worker rejected the cross-tenant job.",
    );

    console.info("--------------------------------------");
    console.info("PHASE 3: VERIFY TENANT A");
    console.info("--------------------------------------");

    const recordA =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: idempotencyRecordAId,
        },
      });

    assert.equal(
      recordA.tenantKey,
      tenantAId,
    );

    assert.equal(
      recordA.status,
      "PROCESSING",
      "Tenant A's idempotency record must not be completed by Tenant B's job.",
    );

    assert.equal(
      recordA.leaseToken,
      leaseTokenA,
      "Tenant A's lease token must remain unchanged.",
    );

    assert.equal(
      recordA.completedAt,
      null,
      "Tenant A's record must not be completed.",
    );

    console.info(
      "[PASS] Tenant A's idempotency lease remains unchanged.",
    );

    console.info("--------------------------------------");
    console.info("PHASE 4: VERIFY TENANT B");
    console.info("--------------------------------------");

    const [eventB, syncLogB] = await Promise.all([
      prisma.webhookEvent.findUniqueOrThrow({
        where: {
          id: webhookEventBId,
        },
      }),
      prisma.syncLog.findUniqueOrThrow({
        where: {
          id: syncLogBId,
        },
      }),
    ]);

    assert.equal(
      eventB.tenantId,
      tenantBId,
    );

    assert.equal(
      eventB.status,
      "RECEIVED",
      "Tenant B's webhook must not be processed using Tenant A's lease.",
    );

    assert.equal(
      eventB.processedAt,
      null,
      "Tenant B's webhook must not be finalized.",
    );

    assert.equal(
      syncLogB.tenantId,
      tenantBId,
    );

    assert.equal(
      syncLogB.status,
      "SUPERSEDED",
      "The rejected job's SyncLog should be marked SUPERSEDED.",
    );

    console.info(
      "[PASS] Tenant B's webhook remains RECEIVED.",
    );

    console.info(
      "[PASS] Tenant B's rejected SyncLog is SUPERSEDED.",
    );

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");
  } finally {
    // Remove the test job and its associated records.
    try {
      const testJob = await queue.getJob(jobId);

      if (testJob) {
        await testJob.remove();
      }
    } catch (error) {
      console.warn("[Test] Could not remove test job:", error);
    }

    await prisma.syncLog.deleteMany({
      where: {
        id: syncLogBId,
      },
    });

    await prisma.webhookEvent.deleteMany({
      where: {
        id: webhookEventBId,
      },
    });

    await prisma.idempotencyRecord.deleteMany({
      where: {
        id: idempotencyRecordAId,
      },
    });

    await prisma.tenantIntegrationConfig.deleteMany({
      where: {
        id: integrationBId,
      },
    });

    await prisma.tenantConfig.deleteMany({
      where: {
        id: {
          in: [tenantAId, tenantBId],
        },
      },
    });

    const { integrationWorker } = await import(
      "../../src/infra/queues/worker.js"
    );

    await integrationWorker.close();
    await queueEvents.close();
    await queue.close();

    await prisma.$disconnect();

    console.info("[Test] Database and queue resources cleaned up.");
  }
}

main().catch((error) => {
  console.error(
    "TENANT ISOLATION TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});