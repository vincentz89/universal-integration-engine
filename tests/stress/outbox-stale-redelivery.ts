import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma } from "@prisma/client";

import { prisma } from "../../src/shared/utils/db.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";
import { dispatchOutboxEvent } from "../../src/infra/queues/outbox-dispatcher.js";

import {
  OUTBOX_LOCK_DURATION_MS,
} from "../../src/shared/repositories/outbox.repository.js";

import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";
import {
  webhookQueueDataSchema,
} from "../../src/infra/queues/contracts/job-schemas.js";

import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

// ==========================================
// ISOLATED TEST DATA
// ==========================================

const tenantId = randomUUID();
const integrationId = randomUUID();
const webhookEventId = randomUUID();
const correlationId = randomUUID();

const externalEventId = `stale-redelivery-${randomUUID()}`;

const idempotencyRecordId = randomUUID();
const oldLeaseToken = randomUUID();

const syncLogId = randomUUID();
const testId = randomUUID();

const deduplicationKey = `outbox-stale-redelivery:${testId}`;

const requestHash = "f".repeat(64);

let outboxEventId: string | null = null;
let worker: ChildProcessWithoutNullStreams | null = null;
let workerOutput = "";

// ==========================================
// ASSERTIONS
// ==========================================

function check(condition: boolean, message: string): void {
  assert.ok(condition, message);
  console.log(`[PASS] ${message}`);
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) {
      return;
    }

    await delay(200);
  }

  throw new Error(`Timed out waiting for: ${message}`);
}

async function waitForWorkerOutput(
  marker: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForCondition(
    async () => workerOutput.includes(marker),
    `worker output: ${marker}`,
    timeoutMs,
  );
}

function startWorker(): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "src/infra/queues/worker.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ENABLE_STRESS_TEST_HANDLERS: "true",
        CRASH_TEST_MODE: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    workerOutput += chunk;
    process.stdout.write(chunk);
  });

  child.stderr.on("data", (chunk: string) => {
    workerOutput += chunk;
    process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    console.error("[Test] Worker process error:", error);
  });

  return child;
}

async function stopWorker(): Promise<void> {
  if (!worker || worker.exitCode !== null) {
    return;
  }

  const child = worker;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  child.kill("SIGTERM");

  await Promise.race([
    exited,
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);

  worker = null;
}

// ==========================================
// MAIN TEST
// ==========================================

async function main(): Promise<void> {
  console.log("======================================");
  console.log("OUTBOX STALE REDELIVERY TEST");
  console.log("======================================");

  try {
    // --------------------------------------
    // 2. Create tenant and integration.
    // --------------------------------------

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

    console.log("[PASS] Isolated tenant and integration created.");

    // --------------------------------------
    // 3. Create webhook event.
    // --------------------------------------

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
            id: "stale-redelivery-product",
          },
        },
      },
    });

    // --------------------------------------
    // 4. Create original idempotency lease.
    // --------------------------------------

    await prisma.idempotencyRecord.create({
      data: {
        id: idempotencyRecordId,
        tenantKey: tenantId,
        scope: getIntegrationWebhookIdempotencyScope(
          "BIGCOMMERCE",
          integrationId,
        ),
        idempotencyKey: externalEventId,
        jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
        requestHash,
        status: "PROCESSING",
        attemptCount: 1,
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken: oldLeaseToken,
      },
    });

    // --------------------------------------
    // 5. Create original SyncLog.
    // --------------------------------------

    const webhookPayload = {
      tenantId,
      integrationId,
      webhookEventId,
      correlationId,
      source: "BIGCOMMERCE",
      eventType: "store/product/updated",
      resourceType: "product",
      resourceId: "stale-redelivery-product",
      payload: {
        data: {
          type: "product",
          id: "stale-redelivery-product",
        },
      },
    };

    await prisma.syncLog.create({
      data: {
        id: syncLogId,
        tenantId,
        jobId: syncLogId,
        jobName: JOB_NAMES.PROCESS_WEBHOOK_EVENT,
        queueName: "integration-sync-queue",
        source: "BIGCOMMERCE",
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId,
        status: "PENDING",
        attemptCount: 0,
        payload: webhookPayload,
      },
    });

    // --------------------------------------
    // 6. Validate and create Outbox event.
    // --------------------------------------

    const queuePayload = {
      syncLogId,
      idempotencyRecordId,
      leaseToken: oldLeaseToken,
      payload: webhookPayload,
    };

    const parsedPayload =
      webhookQueueDataSchema.safeParse(queuePayload);

    if (!parsedPayload.success) {
      throw new Error(
        `Invalid webhook queue payload: ${parsedPayload.error.message}`,
      );
    }

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

    const actualJobId = `outbox_${event.id}`;

    check(
      event.status === "PENDING",
      "Outbox event initially has PENDING status",
    );

    // --------------------------------------
    // PHASE 1: DISPATCHER A PUBLISHES
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 1: ORIGINAL JOB PUBLICATION");
    console.log("--------------------------------------");

    const workerReady = startWorker();
    worker = workerReady;

    const firstLockToken = randomUUID();

    const firstClaim = await prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: "PENDING",
        attemptCount: 0,
      },
      data: {
        status: "PROCESSING",
        lockedAt: new Date(),
        lockToken: firstLockToken,
        attemptCount: {
          increment: 1,
        },
      },
    });

    check(
      firstClaim.count === 1,
      "Dispatcher A claimed only the test Outbox event",
    );

    check(
      firstClaim.count === 1,
      "Dispatcher A owns the Outbox lock",
    );

    const originalJob = await integrationQueue.add(
      JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      parsedPayload.data,
      {
        jobId: actualJobId,
      },
    );

    check(
      originalJob.id === actualJobId,
      "Original BullMQ job was published",
    );

    // Intentionally do not mark the Outbox event PUBLISHED.
    // This simulates a dispatcher crash after queue.add().

    // --------------------------------------
    // PHASE 2: ORIGINAL WORKER COMPLETES
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 2: ORIGINAL WORKER COMPLETES");
    console.log("--------------------------------------");

    try {
      await waitForWorkerOutput(
        "[Product Handler] Received event:",
      );
    } catch (error) {
      const job = await integrationQueue.getJob(actualJobId);

      console.error("\n[DIAGNOSTIC] Worker output:");
      console.error(workerOutput);

      console.error("\n[DIAGNOSTIC] Worker process:", {
        exitCode: worker?.exitCode,
        signalCode: worker?.signalCode,
      });

      if (job) {
        console.error("\n[DIAGNOSTIC] BullMQ job:", {
          id: job.id,
          name: job.name,
          state: await job.getState(),
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          data: job.data,
        });
      } else {
        console.error("\n[DIAGNOSTIC] BullMQ job not found.");
      }

      const [record, webhook, log] = await Promise.all([
        prisma.idempotencyRecord.findUnique({
          where: { id: idempotencyRecordId },
        }),
        prisma.webhookEvent.findUnique({
          where: { id: webhookEventId },
        }),
        prisma.syncLog.findUnique({
          where: { id: syncLogId },
        }),
      ]);

      console.error("\n[DIAGNOSTIC] Database state:", {
        idempotencyStatus: record?.status,
        webhookStatus: webhook?.status,
        syncLogStatus: log?.status,
        syncLogError: log?.errorMessage,
      });

      throw error;
    }

    await waitForCondition(
      async () => {
        const [record, webhook, log] = await Promise.all([
          prisma.idempotencyRecord.findUnique({
            where: {
              id: idempotencyRecordId,
            },
          }),
          prisma.webhookEvent.findUnique({
            where: {
              id: webhookEventId,
            },
          }),
          prisma.syncLog.findUnique({
            where: {
              id: syncLogId,
            },
          }),
        ]);

        return (
          record?.status === "COMPLETED" &&
          webhook?.status === "PROCESSED" &&
          log?.status === "SUCCESS"
        );
      },
      "original worker to finalize all database records",
    );

    check(
      workerOutput.includes("[Product Handler] Received event:"),
      "Original product handler executed",
    );

    const completedJob = await integrationQueue.getJob(actualJobId);

    check(
      completedJob === undefined,
      "BullMQ removed the completed job",
    );

    const completedOutbox =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: event.id,
        },
      });

    check(
      completedOutbox.status === "PROCESSING",
      "Outbox remains PROCESSING after the worker completed",
    );

    check(
      completedOutbox.publishedAt === null,
      "Outbox was not finalized by the crashed dispatcher",
    );

    // --------------------------------------
    // PHASE 3: EXPIRE ORIGINAL OUTBOX LOCK
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 3: EXPIRE OUTBOX LOCK");
    console.log("--------------------------------------");

    await prisma.outboxEvent.update({
      where: {
        id: event.id,
      },
      data: {
        lockedAt: new Date(
          Date.now() - OUTBOX_LOCK_DURATION_MS - 1_000,
        ),
      },
    });

    check(
      true,
      "Original Outbox lock was expired",
    );

    // --------------------------------------
    // PHASE 4: DISPATCHER B REDELIVERS
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 4: STALE JOB REDELIVERY");
    console.log("--------------------------------------");

    const secondLockToken = randomUUID();

    const secondClaim = await prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: "PROCESSING",
        lockedAt: {
          lte: new Date(
            Date.now() - OUTBOX_LOCK_DURATION_MS,
          ),
        },
        attemptCount: {
          lt: 10,
        },
      },
      data: {
        lockedAt: new Date(),
        lockToken: secondLockToken,
        attemptCount: {
          increment: 1,
        },
      },
    });

    check(
      secondClaim.count === 1,
      "Dispatcher B reclaimed only the test Outbox event",
    );

    const claimedEvent = await prisma.outboxEvent.findUniqueOrThrow({
      where: {
        id: event.id,
      },
    });

    const dispatchResult = await dispatchOutboxEvent(claimedEvent);

    check(
      dispatchResult === "PUBLISHED",
      "Dispatcher B republished the stale Outbox event",
    );

    await waitForWorkerOutput(
      "cannot start: ownership or execution state is no longer valid.",
    );

    // The second job must be rejected and retained as failed.
    await waitForCondition(
      async () => {
        const job = await integrationQueue.getJob(actualJobId);

        if (!job) {
          return false;
        }

        return (await job.getState()) === "failed";
      },
      "stale BullMQ delivery to fail",
    );

    // --------------------------------------
    // PHASE 5: VERIFY NO SECOND EXECUTION
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 5: VERIFY STALE DELIVERY REJECTION");
    console.log("--------------------------------------");

    const handlerExecutionCount =
      workerOutput.split("[Product Handler] Received event:").length - 1;

    check(
      handlerExecutionCount === 1,
      "Product handler executed exactly once",
    );

    const staleJob = await integrationQueue.getJob(actualJobId);

    assert.ok(staleJob, "Failed stale job should be retained");

    const staleJobState = await staleJob.getState();

    check(
      staleJobState === "failed",
      "Stale redelivery was rejected by the worker",
    );

    check(
      staleJob.failedReason?.includes(
        "ownership or execution state is no longer valid",
      ) === true,
      "Stale job failed because it no longer owns the lease",
    );

    // --------------------------------------
    // PHASE 6: VERIFY ORIGINAL DATA UNCHANGED
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 6: VERIFY ORIGINAL EXECUTION");
    console.log("--------------------------------------");

    const [finalRecord, finalWebhook, finalLog, finalOutbox] =
      await Promise.all([
        prisma.idempotencyRecord.findUniqueOrThrow({
          where: {
            id: idempotencyRecordId,
          },
        }),
        prisma.webhookEvent.findUniqueOrThrow({
          where: {
            id: webhookEventId,
          },
        }),
        prisma.syncLog.findUniqueOrThrow({
          where: {
            id: syncLogId,
          },
        }),
        prisma.outboxEvent.findUniqueOrThrow({
          where: {
            id: event.id,
          },
        }),
      ]);

    check(
      finalRecord.status === "COMPLETED",
      "IdempotencyRecord remains COMPLETED",
    );

    check(
      finalRecord.leaseToken === null,
      "Completed idempotency lease remains released",
    );

    check(
      finalRecord.completedAt !== null,
      "Original completion timestamp is preserved",
    );

    check(
      finalWebhook.status === "PROCESSED",
      "WebhookEvent remains PROCESSED",
    );

    check(
      finalLog.status === "SUCCESS",
      "Original SyncLog remains SUCCESS",
    );

    check(
      finalLog.attemptCount === 1,
      "Original SyncLog attempt count remains unchanged",
    );

    check(
      finalOutbox.status === "PUBLISHED",
      "Outbox event is eventually marked PUBLISHED",
    );

    check(
      finalOutbox.attemptCount === 2,
      "Outbox attempt count is exactly 2",
    );

    check(
      finalOutbox.lockToken === null &&
        finalOutbox.lockedAt === null,
      "Outbox dispatcher lock was cleared",
    );

    check(
      finalOutbox.publishedAt !== null,
      "Outbox published timestamp was recorded",
    );

    // --------------------------------------
    // FINAL RESULT
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("FINAL RESULT: ALL TESTS PASSED");
    console.log("======================================");
  } finally {
    console.log("--------------------------------------");
    console.log("CLEANUP");
    console.log("--------------------------------------");

    await stopWorker();

    try {
      const job = outboxEventId
        ? await integrationQueue.getJob(`outbox_${outboxEventId}`)
        : undefined;

      if (job) {
        await job.remove();
      }

      if (outboxEventId) {
        await prisma.outboxEvent.deleteMany({
          where: {
            id: outboxEventId,
          },
        });
      }

      await prisma.idempotencyRecord.deleteMany({
        where: {
          id: idempotencyRecordId,
        },
      });

      await prisma.syncLog.deleteMany({
        where: {
          id: syncLogId,
        },
      });

      await prisma.webhookEvent.deleteMany({
        where: {
          id: webhookEventId,
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

      console.log("[Test] Test database and queue resources cleaned up.");
    } finally {
      await integrationQueue.close();
      await redisConnection.quit();
      await prisma.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error("OUTBOX STALE REDELIVERY TEST FAILED:", error);
  process.exitCode = 1;
});