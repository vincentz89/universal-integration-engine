
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { prisma } from "../../src/shared/utils/db.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";
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

interface WorkerProcess {
  child: ChildProcess;
  output: string;
  waitForExit: () => Promise<void>;
}

function startWorker(): WorkerProcess {
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
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const waitForExit = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }

      child.once("exit", () => resolve());
    });

  return {
    child,
    get output() {
      return output;
    },
    waitForExit,
  };
}

async function waitForWorkerReady(
  worker: WorkerProcess,
  timeoutMs = 30_000,
) {
  const marker = "[Worker] Integration worker is running.";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (worker.output.includes(marker)) {
      return;
    }

    if (worker.child.exitCode !== null) {
      throw new Error(
        `Worker exited before becoming ready.\n${worker.output}`,
      );
    }

    await delay(200);
  }

  throw new Error(
    `Worker startup timed out.\n${worker.output}`,
  );
}

async function stopWorker(worker: WorkerProcess | null) {
  if (!worker || worker.child.exitCode !== null) {
    return;
  }

  worker.child.kill("SIGTERM");

  await Promise.race([
    worker.waitForExit(),
    delay(5_000),
  ]);

  if (worker.child.exitCode === null) {
    worker.child.kill("SIGKILL");
    await worker.waitForExit();
  }
}

async function waitForJobTerminal(
  jobId: string,
  timeoutMs = 110_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = await integrationQueue.getJob(jobId);

    if (!job) {
      return;
    }

    const state = await job.getState();

    if (state === "completed" || state === "failed") {
      return;
    }

    await delay(500);
  }

  throw new Error(
    `Job ${jobId} did not reach a terminal state.`,
  );
}

async function removeTestJob(jobId: string) {
  const job = await integrationQueue.getJob(jobId);

  if (!job) {
    return;
  }

  const state = await job.getState();

  if (state !== "active") {
    await job.remove();
  } else {
    console.warn(
      `[Cleanup] Job ${jobId} remains active. Skipping removal.`,
    );
  }
}

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const integrationScope =
    getIntegrationWebhookIdempotencyScope(
      "BIGCOMMERCE",
      integrationId,
    );
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();

  const externalEventId =
    `concurrent-webhook-${randomUUID()}`;

  const idempotencyRecordId = randomUUID();
  const leaseToken = randomUUID();

  const syncLogAId = randomUUID();
  const syncLogBId = randomUUID();

  const jobAId = `concurrent-webhook-a-${randomUUID()}`;
  const jobBId = `concurrent-webhook-b-${randomUUID()}`;

  const requestHash = "d".repeat(64);

  let workerA: WorkerProcess | null = null;
  let workerB: WorkerProcess | null = null;

  let bothProcessedConcurrently = false;

  console.info("======================================");
  console.info("CONCURRENT WEBHOOK PROCESSING TEST");
  console.info("======================================");

  try {
    // Ensure no unrelated eligible Outbox events are present.
    const now = new Date();

    const unrelatedOutboxEvents =
      await prisma.outboxEvent.count({
        where: {
          status: "PENDING",
          availableAt: { lte: now },
        },
      });

    assert(
      unrelatedOutboxEvents === 0,
      "Unrelated pending Outbox events exist. Process them before this test.",
    );

    // 1. Create isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create tenant integration.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: true,
      },
    });

    // 3. Create one webhook event.
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
            type: "lease-test",
            id: "concurrent-webhook-product",
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
      resourceType: "lease-test",
      resourceId: "concurrent-webhook-product",
      payload: {
        data: {
          type: "lease-test",
          id: "concurrent-webhook-product",
        },
      },
    };

    // 4. Create one shared active idempotency lease.
    await prisma.idempotencyRecord.create({
      data: {
        id: idempotencyRecordId,
        tenantKey: tenantId,
        scope: integrationScope,
        idempotencyKey: externalEventId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        requestHash,
        status: "PROCESSING",
        attemptCount: 1,
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken,
      },
    });

    // 5. Create two different SyncLogs for the same webhook.
    await prisma.syncLog.createMany({
      data: [
        {
          id: syncLogAId,
          tenantId,
          jobId: jobAId,
          jobName: "PROCESS_WEBHOOK_EVENT",
          queueName: "integration-sync-queue",
          source: "BIGCOMMERCE",
          target: "INTERNAL_HANDLER",
          correlationId,
          webhookEventId,
          status: "PENDING",
          attemptCount: 0,
          payload: jobPayload,
        },
        {
          id: syncLogBId,
          tenantId,
          jobId: jobBId,
          jobName: "PROCESS_WEBHOOK_EVENT",
          queueName: "integration-sync-queue",
          source: "BIGCOMMERCE",
          target: "INTERNAL_HANDLER",
          correlationId,
          webhookEventId,
          status: "PENDING",
          attemptCount: 0,
          payload: jobPayload,
        },
      ],
    });

    // 6. Validate both queue envelopes.
    const queueDataA = webhookQueueDataSchema.parse({
      syncLogId: syncLogAId,
      idempotencyRecordId,
      leaseToken,
      payload: jobPayload,
    });

    const queueDataB = webhookQueueDataSchema.parse({
      syncLogId: syncLogBId,
      idempotencyRecordId,
      leaseToken,
      payload: jobPayload,
    });

    console.info("[Test] Shared webhook and lease created.");

    // 7. Start two independent worker processes.
    console.info("--------------------------------------");
    console.info("PHASE 1: START TWO WORKERS");
    console.info("--------------------------------------");

    workerA = startWorker();
    workerB = startWorker();

    await Promise.all([
      waitForWorkerReady(workerA),
      waitForWorkerReady(workerB),
    ]);

    console.info("[Test] Both workers are ready.");

    // 8. Dispatch two different BullMQ jobs with the same
    // webhookEventId, idempotencyRecordId, and leaseToken.
    console.info("--------------------------------------");
    console.info("PHASE 2: DISPATCH DUPLICATE WEBHOOK WORK");
    console.info("--------------------------------------");

    await Promise.all([
      integrationQueue.add(
        "PROCESS_WEBHOOK_EVENT",
        queueDataA,
        {
          jobId: jobAId,
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      ),
      integrationQueue.add(
        "PROCESS_WEBHOOK_EVENT",
        queueDataB,
        {
          jobId: jobBId,
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      ),
    ]);

    console.info("[Test] Two distinct jobs dispatched.");
    console.info("[Test] Both jobs share the same lease token.");

    // 9. Observe SyncLog states while the 75-second stress
    // handlers are executing.
    console.info("--------------------------------------");
    console.info("PHASE 3: OBSERVE CONCURRENT EXECUTION");
    console.info("--------------------------------------");

    const observationDeadline = Date.now() + 20_000;
    let observedBothProcessing = false;

    while (Date.now() < observationDeadline) {
      const logs = await prisma.syncLog.findMany({
        where: {
          id: {
            in: [syncLogAId, syncLogBId],
          },
        },
      });

      const processingCount = logs.filter(
        (log) => log.status === "PROCESSING",
      ).length;

      console.info(
        `[Test] Currently PROCESSING SyncLogs: ${processingCount}`,
      );

      if (processingCount === 2) {
        observedBothProcessing = true;
        break;
      }

      if (processingCount === 1) {
        // Give the second worker time to acquire its job.
        await delay(500);
      } else {
        await delay(250);
      }
    }

    bothProcessedConcurrently = observedBothProcessing;

    if (bothProcessedConcurrently) {
      console.error(
        "[FAIL] Both jobs entered PROCESSING simultaneously.",
      );
    } else {
      console.info(
        "[PASS] Both jobs were not observed PROCESSING simultaneously.",
      );
    }

    // 10. Allow both jobs to reach terminal states before
    // stopping workers, so no active BullMQ locks are abandoned.
    console.info("--------------------------------------");
    console.info("PHASE 4: WAIT FOR JOB FINALIZATION");
    console.info("--------------------------------------");

    await Promise.all([
      waitForJobTerminal(jobAId),
      waitForJobTerminal(jobBId),
    ]);

    // 11. Read final database states.
    const [finalLogs, finalRecord, finalEvent] =
      await Promise.all([
        prisma.syncLog.findMany({
          where: {
            id: {
              in: [syncLogAId, syncLogBId],
            },
          },
        }),
        prisma.idempotencyRecord.findUniqueOrThrow({
          where: { id: idempotencyRecordId },
        }),
        prisma.webhookEvent.findUniqueOrThrow({
          where: { id: webhookEventId },
        }),
      ]);

    const successfulLogs = finalLogs.filter(
      (log) => log.status === "SUCCESS",
    );

    const supersededLogs = finalLogs.filter(
      (log) => log.status === "SUPERSEDED",
    );

    console.info("--------------------------------------");
    console.info("FINAL ASSERTIONS");
    console.info("--------------------------------------");

    console.info(
      "Both jobs processed concurrently:",
      bothProcessedConcurrently,
    );

    console.info(
      "SyncLog states:",
      finalLogs.map((log) => ({
        id: log.id,
        status: log.status,
      })),
    );

    console.info(
      "Successful SyncLogs:",
      successfulLogs.length,
    );

    console.info(
      "Superseded SyncLogs:",
      supersededLogs.length,
    );

    console.info(
      "IdempotencyRecord:",
      finalRecord.status,
    );

    console.info(
      "WebhookEvent:",
      finalEvent.status,
    );

    // This is the critical concurrency assertion.
    assert(
      !bothProcessedConcurrently,
      "Concurrent duplicate processing detected: both workers entered PROCESSING for the same webhook.",
    );

    assert(
      successfulLogs.length === 1,
      `Expected exactly one successful SyncLog, received ${successfulLogs.length}.`,
    );

    assert(
      supersededLogs.length === 1,
      `Expected exactly one superseded SyncLog, received ${supersededLogs.length}.`,
    );

    assert(
      finalRecord.status === "COMPLETED",
      `Expected IdempotencyRecord COMPLETED, received ${finalRecord.status}.`,
    );

    assert(
      finalEvent.status === "PROCESSED",
      `Expected WebhookEvent PROCESSED, received ${finalEvent.status}.`,
    );

    console.info("--------------------------------------");
    console.info("WORKER A OUTPUT");
    console.info("--------------------------------------");
    console.info(workerA?.output);

    console.info("--------------------------------------");
    console.info("WORKER B OUTPUT");
    console.info("--------------------------------------");
    console.info(workerB?.output);

  } finally {
    // Wait for active jobs to finish before terminating workers.
    if (workerA && workerB) {
      await Promise.allSettled([
        waitForJobTerminal(jobAId, 110_000),
        waitForJobTerminal(jobBId, 110_000),
      ]);
    }

    await stopWorker(workerA);
    await stopWorker(workerB);

    await removeTestJob(jobAId);
    await removeTestJob(jobBId);

    await prisma.outboxEvent.deleteMany({
      where: {
        aggregateType: "WebhookEvent",
        aggregateId: webhookEventId,
      },
    });

    await prisma.idempotencyRecord.deleteMany({
      where: { id: idempotencyRecordId },
    });

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

    await Promise.allSettled([
      integrationQueue.close(),
      redisConnection.quit(),
      prisma.$disconnect(),
    ]);

    console.info("[Test] Test resources cleaned up.");
  }
}

main().catch((error) => {
  console.error(
    "CONCURRENT WEBHOOK PROCESSING TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});
