import { randomUUID } from "node:crypto";
import { QueueEvents } from "bullmq";

import { dispatchSyncJob } from "../../src/infra/queues/producer.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";

import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";

import {
  IDEMPOTENCY_LEASE_RENEW_INTERVAL_MS,
  idempotencyRepository,
} from "../../src/shared/repositories/idempotency.repository.js";

import { prisma } from "../../src/shared/utils/db.js";

import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

const QUEUE_NAME = "integration-sync-queue";
const TIMEOUT_MS = 100_000;
const OBSERVATION_TIME_MS = 65_000;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function runLeaseRenewalTest() {
  const queueEvents = new QueueEvents(QUEUE_NAME, {
    connection: redisConnection,
  });

  let tenantId: string | undefined;
  let syncLogId: string | null = null;

  try {
    await queueEvents.waitUntilReady();

    console.log("=================================");
    console.log("LEASE RENEWAL STRESS TEST");
    console.log("=================================");

    // 1. Create a temporary tenant.
    const tenant = await prisma.tenantConfig.create({
      data: {
      },
    });

    tenantId = tenant.id;

    // 2. Create an integration.
    const integration = await prisma.tenantIntegrationConfig.create({
      data: {
        tenantId: tenant.id,
        systemName: "BIGCOMMERCE",
        baseUrl: "https://example.com",
        isActive: true,
      },
    });

    const idempotencyScope = getIntegrationWebhookIdempotencyScope(
      integration.systemName,
      integration.id,
    );

    // 3. Create a webhook event.
    const correlationId = randomUUID();
    const resourceId = `LEASE-TEST-${randomUUID()}`;

    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        tenantId: tenant.id,
        integrationId: integration.id,
        source: "BIGCOMMERCE",
        eventType: "stress.lease_renewal",
        correlationId,
        payload: {
          test: true,
          resourceType: "lease-test",
          resourceId,
        },
      },
    });

    // 4. Prepare the generic job payload.
    const payload = {
      tenantId: tenant.id,
      integrationId: integration.id,
      webhookEventId: webhookEvent.id,
      correlationId,
      source: "BIGCOMMERCE",
      eventType: "stress.lease_renewal",
      resourceType: "lease-test",
      resourceId,
      payload: {
        test: true,
        resourceId,
      },
    };

    // 5. Register idempotency.
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
        `Expected NEW registration, received ${registration.status}.`,
      );
    }

    console.log(
      "[Test] Idempotency record:",
      registration.recordId,
    );

    // 6. Dispatch the long-running job.
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
      throw new Error("Expected a SyncLog ID.");
    }

    console.log("[Test] Job dispatched:", dispatchResult.job.id);

    // 7. Wait until the worker starts processing.
    let processingStarted = false;

    for (let attempt = 0; attempt < 60; attempt++) {
      const event = await prisma.webhookEvent.findUnique({
        where: { id: webhookEvent.id },
      });

      if (event?.status === "PROCESSING") {
        processingStarted = true;
        break;
      }

      await sleep(500);
    }

    if (!processingStarted) {
      throw new Error("Worker did not start processing the webhook.");
    }

    const initialRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: registration.recordId },
      });

    if (!initialRecord.leaseExpiresAt) {
      throw new Error("Initial lease expiration was not found.");
    }

    const initialLeaseExpiry =
      initialRecord.leaseExpiresAt.getTime();

    let previousLeaseExpiry = initialLeaseExpiry;
    let renewalCount = 0;

    console.log("---------------------------------");
    console.log("LEASE RENEWAL OBSERVATION");
    console.log("---------------------------------");
    console.log(
      "Initial lease expiry:",
      initialRecord.leaseExpiresAt.toISOString(),
    );
    console.log(
      "Expected renewal interval:",
      IDEMPOTENCY_LEASE_RENEW_INTERVAL_MS,
      "ms",
    );

    // 8. Observe the lease for 65 seconds.
    // This exceeds the original 60-second lease.
    const observationStartedAt = Date.now();
    const observationDeadline =
      observationStartedAt + OBSERVATION_TIME_MS;

    while (Date.now() < observationDeadline) {
      await sleep(2_000);

      const currentRecord =
        await prisma.idempotencyRecord.findUnique({
          where: { id: registration.recordId },
        });

      if (!currentRecord?.leaseExpiresAt) {
        throw new Error(
          "Lease disappeared while the handler was still processing.",
        );
      }

      const currentExpiry =
        currentRecord.leaseExpiresAt.getTime();

      if (currentExpiry > previousLeaseExpiry) {
        renewalCount++;

        console.log(
          `[Test] Lease renewed (${renewalCount}):`,
          currentRecord.leaseExpiresAt.toISOString(),
        );

        previousLeaseExpiry = currentExpiry;
      }
    }

    // 9. Try to register the same request while the handler is running.
    const duplicateRegistration =
      await idempotencyRepository.register({
        tenantKey: tenant.id,
        scope: idempotencyScope,
        idempotencyKey,
        jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
        requestHash,
      });

    console.log("---------------------------------");
    console.log("ACTIVE LEASE DUPLICATE TEST");
    console.log("---------------------------------");
    console.log(
      "Duplicate result:",
      duplicateRegistration.status,
    );

    if (duplicateRegistration.status === "DUPLICATE") {
      console.log(
        "Existing status:",
        duplicateRegistration.existingStatus,
      );
    }

    // 10. Wait for the actual job completion.
    await dispatchResult.job.waitUntilFinished(
      queueEvents,
      TIMEOUT_MS,
    );

    console.log("[Test] BullMQ job completed.");

    // 11. Allow the completion listener to update SyncLog.
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

      await sleep(250);
    }

    // 12. Retrieve final database states.
    const finalWebhook = await prisma.webhookEvent.findUnique({
      where: { id: webhookEvent.id },
    });

    const finalIdempotency =
      await prisma.idempotencyRecord.findUnique({
        where: { id: registration.recordId },
      });

    console.log("---------------------------------");
    console.log("FINAL DATABASE VERIFICATION");
    console.log("---------------------------------");
    console.log("SyncLog:", syncLog?.status);
    console.log("Webhook:", finalWebhook?.status);
    console.log("Idempotency:", finalIdempotency?.status);
    console.log("Lease renewals observed:", renewalCount);
    console.log("Duplicate result:", duplicateRegistration.status);
    console.log("Duration (ms):", syncLog?.durationMs);
    console.log("---------------------------------");

    // 13. Validate the complete test.
    const passed =
      renewalCount >= 2 &&
      duplicateRegistration.status === "DUPLICATE" &&
      duplicateRegistration.existingStatus === "PROCESSING" &&
      syncLog?.status === "SUCCESS" &&
      finalWebhook?.status === "PROCESSED" &&
      finalIdempotency?.status === "COMPLETED";

    if (!passed) {
      throw new Error(
        "Lease renewal verification failed. Check the results above.",
      );
    }

    console.log("RESULT: PASSED");
    console.log("Test records were retained for inspection.");
  } catch (error) {
    console.error("[Test] Lease renewal test failed:", error);
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

runLeaseRenewalTest();