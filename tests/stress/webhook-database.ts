import { randomUUID } from "node:crypto";
import { QueueEvents } from "bullmq";

import { dispatchSyncJob } from "../../src/infra/queues/producer.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";

import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";
import { idempotencyRepository } from "../../src/shared/repositories/idempotency.repository.js";
import { prisma } from "../../src/shared/utils/db.js";
import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

const QUEUE_NAME = "integration-sync-queue";
const TIMEOUT_MS = 60_000;

async function runDatabaseTest() {
  const queueEvents = new QueueEvents(QUEUE_NAME, {
    connection: redisConnection,
  });

  let tenantId: string | undefined;
  let syncLogId: string | null = null;

  try {
    await queueEvents.waitUntilReady();

    console.log("=================================");
    console.log("WEBHOOK DATABASE TEST");
    console.log("=================================");

    // 1. Create a temporary tenant.
    const tenant = await prisma.tenantConfig.create({
      data: {
      },
    });

    tenantId = tenant.id;

    // 2. Create a temporary BigCommerce integration.
    const integration = await prisma.tenantIntegrationConfig.create({
      data: {
        tenantId: tenant.id,
        systemName: "BIGCOMMERCE",
        baseUrl: "https://example.com",
        isActive: true,
      },
    });

    // Use the same provider-specific idempotency scope as the worker.
    const idempotencyScope = getIntegrationWebhookIdempotencyScope(
      integration.systemName,
      integration.id,
    );

    // 3. Create a test webhook event.
    const correlationId = randomUUID();

    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        tenantId: tenant.id,
        integrationId: integration.id,
        source: "BIGCOMMERCE",
        eventType: "product.updated",
        correlationId,
        payload: {
          test: true,
          resourceType: "product",
          resourceId: "STRESS-TEST-001",
        },
      },
    });

    console.log("[Test] Tenant created:", tenant.id);
    console.log("[Test] Integration created:", integration.id);
    console.log("[Test] Webhook event created:", webhookEvent.id);

    // 4. Prepare the generic webhook job payload.
    const payload = {
      tenantId: tenant.id,
      integrationId: integration.id,
      webhookEventId: webhookEvent.id,
      correlationId,
      source: "BIGCOMMERCE",
      eventType: "product.updated",
      resourceType: "product",
      resourceId: "STRESS-TEST-001",
      payload: {
        test: true,
        resourceId: "STRESS-TEST-001",
      },
    };

    // 5. Register the idempotency record before dispatching.
    const idempotencyKey = webhookEvent.id;

    const requestHash = idempotencyRepository.createRequestHash(
      JSON.stringify(payload),
    );

    const registration = await idempotencyRepository.register({
      tenantKey: tenant.id,
      scope: idempotencyScope,
      idempotencyKey,
      jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      requestHash,
    });

    if (registration.status !== "NEW") {
      throw new Error(
        `Expected NEW idempotency registration, received ${registration.status}.`,
      );
    }

    console.log(
      "[Test] Idempotency record created:",
      registration.recordId,
    );

    // 6. Dispatch the webhook job with its ownership credentials.
    const dispatchResult = await dispatchSyncJob(
      JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      payload,
      {
        idempotencyRecordId: registration.recordId,
        leaseToken: registration.leaseToken,
        scope: idempotencyScope,
      },
    );

    syncLogId = dispatchResult.syncLogId;

    if (!syncLogId) {
      throw new Error("Expected a SyncLog ID but received null.");
    }

    console.log("[Test] Job dispatched:", dispatchResult.job.id);
    console.log("[Test] SyncLog created:", syncLogId);

    // 7. Wait for actual BullMQ completion.
    await dispatchResult.job.waitUntilFinished(
      queueEvents,
      TIMEOUT_MS,
    );

    console.log("[Test] BullMQ job completed.");

    // 8. Wait for the asynchronous completion listener
    // to update the SyncLog in PostgreSQL.
    let syncLog = null;

    for (let attempt = 0; attempt < 40; attempt++) {
      syncLog = await prisma.syncLog.findUnique({
        where: { id: syncLogId },
      });

      if (
        syncLog?.status === "SUCCESS" ||
        syncLog?.status === "FAILED"
      ) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // 9. Retrieve final database records.
    const finalWebhook = await prisma.webhookEvent.findUnique({
      where: { id: webhookEvent.id },
    });

    const finalIdempotency = await prisma.idempotencyRecord.findUnique({
      where: { id: registration.recordId },
    });

    //add
    // 10. Test duplicate webhook protection.
    const duplicateRegistration = await idempotencyRepository.register({
      tenantKey: tenant.id,
      scope: idempotencyScope,
      idempotencyKey,
      jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      requestHash,
    });

    console.log(
      "[Test] Duplicate request result:",
      duplicateRegistration.status,
    );

    // 11. Test payload conflict protection.
    const modifiedPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        resourceId: "DIFFERENT-RESOURCE",
      },
    };

    //add
    // 12. Test concurrent idempotency registration.
    const concurrentKey = randomUUID();

    const concurrentRequestHash =
      idempotencyRepository.createRequestHash(
        JSON.stringify({
          test: true,
          resourceId: "CONCURRENT-TEST-001",
        }),
      );

    const concurrentRequests = await Promise.all(
      Array.from({ length: 10 }, () =>
        idempotencyRepository.register({
          tenantKey: tenant.id,
          scope: idempotencyScope,
          idempotencyKey: concurrentKey,
          jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
          requestHash: concurrentRequestHash,
        }),
      ),
    );

    const newRegistrations = concurrentRequests.filter(
      (result) => result.status === "NEW",
    );

    const duplicateRegistrations = concurrentRequests.filter(
      (result) => result.status === "DUPLICATE",
    );

    console.log("---------------------------------");
    console.log("CONCURRENT REGISTRATION TEST");
    console.log("---------------------------------");
    console.log("Total requests:", concurrentRequests.length);
    console.log("NEW registrations:", newRegistrations.length);
    console.log("DUPLICATE registrations:", duplicateRegistrations.length);
    console.log("---------------------------------");
    //end

    const modifiedRequestHash = idempotencyRepository.createRequestHash(
      JSON.stringify(modifiedPayload),
    );

    const conflictRegistration = await idempotencyRepository.register({
      tenantKey: tenant.id,
      scope: idempotencyScope,
      idempotencyKey,
      jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      requestHash: modifiedRequestHash,
    });

    console.log(
      "[Test] Modified payload result:",
      conflictRegistration.status,
    );
    //end

    console.log("---------------------------------");
    console.log("DATABASE VERIFICATION");
    console.log("---------------------------------");
    console.log("SyncLog Status:", syncLog?.status);
    console.log("Webhook Status:", finalWebhook?.status);
    console.log("Idempotency Status:", finalIdempotency?.status);
    console.log("Attempt Count:", syncLog?.attemptCount);
    console.log("Correlation ID:", syncLog?.correlationId);
    console.log("Duration (ms):", syncLog?.durationMs);
    console.log("---------------------------------");

    // 10. Validate expected database states.
    const passed =
      syncLog?.status === "SUCCESS" &&
      syncLog.attemptCount === 1 &&
      syncLog.finishedAt !== null &&
      finalWebhook?.status === "PROCESSED" &&
      finalWebhook.processedAt !== null &&
      finalIdempotency?.status === "COMPLETED" &&
      syncLog.correlationId === correlationId &&
      duplicateRegistration.status === "DUPLICATE" &&
      conflictRegistration.status === "CONFLICT" &&
      newRegistrations.length === 1 &&
      duplicateRegistrations.length === 9;

    if (!passed ) {
      throw new Error(
        "Database verification failed. Check the records above.",
      );
    }

    console.log("RESULT: PASSED");
    console.log("Test records were retained for inspection.");
  } catch (error) {
    console.error("[Test] Database test failed:", error);
    process.exitCode = 1;

    if (syncLogId) {
      console.error("[Test] SyncLog ID:", syncLogId);
    }

    if (tenantId) {
      console.error("[Test] Tenant ID:", tenantId);
    }
  } finally {
    await queueEvents.close();
    await integrationQueue.close();
    await redisConnection.quit();
    await prisma.$disconnect();
  }
}

runDatabaseTest();