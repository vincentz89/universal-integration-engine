import { randomUUID } from "node:crypto";

import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";
import { dispatchSyncJob } from "../../src/infra/queues/producer.js";

import {
  idempotencyRepository,
} from "../../src/shared/repositories/idempotency.repository.js";

import { prisma } from "../../src/shared/utils/db.js";
import {
  integrationRegistrationService,
} from "../../src/shared/services/integration-registration.service.js";

import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function runCrashRecoveryTest() {
  let tenantId: string | undefined;

  try {
    console.log("=================================");
    console.log("WORKER CRASH RECOVERY TEST");
    console.log("=================================");

        // 1. Create a temporary internal tenant.
    const tenant = await prisma.tenantConfig.create({
      data: {},
    });

    tenantId = tenant.id;

    // 2. Register a synthetic BigCommerce account for this test.
    const externalAccountId = `crash-test-${randomUUID()}`;

    const integration =
      await integrationRegistrationService.register({
        tenantId: tenant.id,
        systemName: "BIGCOMMERCE",
        externalAccountId,
        externalAccountKey: `crash-recovery:${externalAccountId}`,
        baseUrl: "https://example.com",
      });

    const integrationScope = getIntegrationWebhookIdempotencyScope(
      "BIGCOMMERCE",
      integration.integrationId,
    );

    // 3. Create webhook event.
    const externalEventId = randomUUID();
    const correlationId = randomUUID();
    const resourceId = `CRASH-${randomUUID()}`;

    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        tenantId: tenant.id,
        source: "BIGCOMMERCE",
        eventType: "stress/lease-crash",
        externalEventId,
        integrationId: integration.integrationId,
        correlationId,
        payload: {
          scope: "stress/lease-crash",
          store_id: externalAccountId,
          data: {
            type: "lease-crash",
            id: resourceId,
          },
        },
      },
    });

    const payload = {
      tenantId: tenant.id,
      integrationId: integration.integrationId,
      webhookEventId: webhookEvent.id,
      correlationId,
      source: "BIGCOMMERCE",
      eventType: "stress/lease-crash",
      resourceType: "lease-crash",
      resourceId,
      payload: {
        test: true,
        resourceId,
      },
    };

    // 4. Register a deliberately short lease.
    const requestHash =
      idempotencyRepository.createRequestHash(
        JSON.stringify(payload),
      );

    const registration =
      await idempotencyRepository.register({
        tenantKey: tenant.id,
        scope: integrationScope,
        idempotencyKey: externalEventId,
        jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
        requestHash,
        leaseDurationMs: 15_000,
      });

    if (registration.status !== "NEW") {
      throw new Error(
        `Expected NEW, received ${registration.status}.`,
      );
    }

    console.log(
      "[Test] Idempotency record:",
      registration.recordId,
    );

    // 5. Dispatch original job to Worker A.
    const dispatched = await dispatchSyncJob(
      JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      payload,
      {
        idempotencyRecordId: registration.recordId,
        leaseToken: registration.leaseToken,
        scope: integrationScope,
      },
    );

    console.log("[Test] Original job:", dispatched.job.id);

    // 6. Wait for Worker A to start.
    let workerStarted = false;

    for (let i = 0; i < 60; i++) {
      const event = await prisma.webhookEvent.findUnique({
        where: { id: webhookEvent.id },
      });

      if (event?.status === "PROCESSING") {
        workerStarted = true;
        break;
      }

      await sleep(500);
    }

    if (!workerStarted) {
      throw new Error("Worker A did not start.");
    }

    console.log("---------------------------------");
    console.log("WORKER A IS PROCESSING");
    console.log("---------------------------------");
    console.log("Terminate Worker A now using Ctrl+C.");
    console.log("Do not stop the recovery worker.");

    // 7. Wait for recovery to claim the expired lease.
    let recoveryClaimed = false;

    for (let i = 0; i < 100; i++) {
      const record =
        await prisma.idempotencyRecord.findUniqueOrThrow({
          where: { id: registration.recordId },
        });

      if (
        record.attemptCount >= 2 &&
        record.leaseToken !== registration.leaseToken
      ) {
        recoveryClaimed = true;
        break;
      }

      await sleep(1_000);
    }

    if (!recoveryClaimed) {
      throw new Error(
        "Recovery dispatcher did not claim the expired lease.",
      );
    }

    console.log("---------------------------------");
    console.log("RECOVERY CLAIM CONFIRMED");
    console.log("---------------------------------");
    console.log("New lease acquired.");
    console.log("Start Worker B in another terminal:");
    console.log(
      "ENABLE_STRESS_TEST_HANDLERS=true npm.cmd run dev:worker",
    );

        // 8. Wait for Worker B to complete.
    // The recovery execution must create its own successful SyncLog.
    let completed = false;

    for (let i = 0; i < 180; i++) {
      const [record, event, logs] = await Promise.all([
        prisma.idempotencyRecord.findUnique({
          where: { id: registration.recordId },
        }),
        prisma.webhookEvent.findUnique({
          where: { id: webhookEvent.id },
        }),
        prisma.syncLog.findMany({
          where: { webhookEventId: webhookEvent.id },
          orderBy: { createdAt: "asc" },
        }),
      ]);

      const originalLog = logs.find(
        (log) => log.id === dispatched.job.id,
      );

      const recoveryLog = logs.find(
        (log) => log.id !== dispatched.job.id,
      );

      const recoveryCompleted =
        record?.status === "COMPLETED" &&
        event?.status === "PROCESSED" &&
        record.attemptCount >= 2 &&
        originalLog?.status === "SUPERSEDED" &&
        recoveryLog?.status === "SUCCESS";

      if (recoveryCompleted) {
        completed = true;
        break;
      }

      if (i % 10 === 0) {
        console.log("[Test] Waiting for recovery execution...", {
          idempotencyStatus: record?.status,
          webhookStatus: event?.status,
          originalSyncLog: originalLog?.status,
          recoverySyncLog: recoveryLog?.status,
        });
      }

      await sleep(1_000);
    }

    // 9. Read final database state.
    const finalRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: registration.recordId },
      });

    const finalEvent =
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: webhookEvent.id },
      });

    const syncLogs = await prisma.syncLog.findMany({
      where: { webhookEventId: webhookEvent.id },
      orderBy: { createdAt: "asc" },
    });

    const originalLog = syncLogs.find(
      (log) => log.id === dispatched.job.id,
    );

    const recoveryLog = syncLogs.find(
      (log) => log.id !== dispatched.job.id,
    );

    console.log("---------------------------------");
    console.log("FINAL DATABASE VERIFICATION");
    console.log("---------------------------------");
    console.log("Idempotency:", finalRecord.status);
    console.log("Attempt count:", finalRecord.attemptCount);
    console.log("Webhook:", finalEvent.status);
    console.log("Original SyncLog:", originalLog?.status);
    console.log("Recovery SyncLog:", recoveryLog?.status);
    console.log("---------------------------------");

    const passed =
      completed &&
      finalRecord.status === "COMPLETED" &&
      finalRecord.attemptCount >= 2 &&
      finalEvent.status === "PROCESSED" &&
      originalLog?.status === "SUPERSEDED" &&
      recoveryLog?.status === "SUCCESS";

    if (!passed) {
      throw new Error(
        "Crash recovery verification failed. Check the final database state.",
      );
    }

    console.log("RESULT: PASSED");
    console.log("Test records retained for inspection.");
  } catch (error) {
    console.error("[Test] Crash recovery failed:", error);
    process.exitCode = 1;

    if (tenantId) {
      console.error("Tenant ID:", tenantId);
    }
  } finally {
    await prisma.$disconnect();
  }
}

runCrashRecoveryTest();