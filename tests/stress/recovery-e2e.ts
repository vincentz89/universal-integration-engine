
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { prisma } from "../../src/shared/utils/db.js";
import { integrationQueue } from "../../src/infra/queues/queue.js";
import { redisConnection } from "../../src/infra/queues/redis.js";

import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";
import { webhookQueueDataSchema } from "../../src/infra/queues/contracts/job-schemas.js";

import { recoverExpiredWebhookJobs } from "../../src/infra/queues/recovery-dispatcher.js";
import { runOutboxDispatchCycle } from "../../src/infra/queues/outbox-dispatcher.js";

import {
  IDEMPOTENCY_LEASE_DURATION_MS,
} from "../../src/shared/repositories/idempotency.repository.js";

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
  waitForOutput: (marker: string, timeoutMs: number) => Promise<void>;
  waitForExit: () => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
}

function startWorker(crashMode: boolean): WorkerProcess {
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
        CRASH_TEST_MODE: String(crashMode),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";

  const appendOutput = (chunk: Buffer) => {
    output += chunk.toString();
  };

  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });

    child.once("error", reject);
  });

  async function waitForOutput(
    marker: string,
    timeoutMs: number,
  ) {
    if (output.includes(marker)) {
      return;
    }

    if (child.exitCode !== null) {
      throw new Error(
        `Worker exited before output "${marker}".\n${output}`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.off("data", checkOutput);
        child.stderr.off("data", checkOutput);
        child.off("exit", checkExit);
      };

      const checkOutput = () => {
        if (output.includes(marker)) {
          cleanup();
          resolve();
        }
      };

      const checkExit = () => {
        cleanup();

        reject(
          new Error(
            `Worker exited before output "${marker}".\n${output}`,
          ),
        );
      };

      const timeout = setTimeout(() => {
        cleanup();

        reject(
          new Error(
            `Timed out waiting for "${marker}".\n${output}`,
          ),
        );
      }, timeoutMs);

      child.stdout.on("data", checkOutput);
      child.stderr.on("data", checkOutput);
      child.once("exit", checkExit);

      checkOutput();
    });
  }

  return {
    child,
    get output() {
      return output;
    },
    waitForOutput,
    waitForExit: () => exitPromise,
  };
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

async function waitForSuccessfulExecution(input: {
  idempotencyRecordId: string;
  webhookEventId: string;
  syncLogId: string;
  timeoutMs?: number;
}) {
  const deadline =
    Date.now() + (input.timeoutMs ?? 90_000);

  while (Date.now() < deadline) {
    const [record, event, syncLog] = await Promise.all([
      prisma.idempotencyRecord.findUnique({
        where: { id: input.idempotencyRecordId },
      }),
      prisma.webhookEvent.findUnique({
        where: { id: input.webhookEventId },
      }),
      prisma.syncLog.findUnique({
        where: { id: input.syncLogId },
      }),
    ]);

    if (
      record?.status === "COMPLETED" &&
      event?.status === "PROCESSED" &&
      syncLog?.status === "SUCCESS"
    ) {
      return { record, event, syncLog };
    }

    if (
      record?.status === "FAILED" ||
      event?.status === "FAILED" ||
      syncLog?.status === "FAILED"
    ) {
      throw new Error(
        "Recovered execution entered FAILED state.",
      );
    }

    await delay(500);
  }

  throw new Error(
    "Timed out waiting for successful webhook execution.",
  );
}

async function waitForJobTerminal(
  jobId: string,
  timeoutMs = 90_000,
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
    `BullMQ job ${jobId} did not reach a terminal state.`,
  );
}

async function removeTestJob(jobId: string) {
  const job = await integrationQueue.getJob(jobId);

  if (!job) {
    return;
  }

  const state = await job.getState();

  if (state === "active") {
    console.warn(
      `[Test Cleanup] Job ${jobId} is still active. Skipping removal.`,
    );
    return;
  }

  await job.remove();
}

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();

  const oldLeaseToken = randomUUID();
  const initialJobId = `recovery-e2e-${randomUUID()}`;

  const externalEventId = `recovery-e2e-${randomUUID()}`;
  const requestHash = "b".repeat(64);

  const initialSyncLogId = randomUUID();

  const replacementDeduplicationKey = "";
  const integrationScope =
    getIntegrationWebhookIdempotencyScope(
      "BIGCOMMERCE",
      integrationId,
    );

  let workerA: WorkerProcess | null = null;
  let workerB: WorkerProcess | null = null;

  let idempotencyRecordId: string | null = null;
  let replacementSyncLogId: string | null = null;
  let replacementOutboxId: string | null = null;

  console.info("======================================");
  console.info("CRASH RECOVERY END-TO-END TEST");
  console.info("======================================");

  try {
    // Ensure the global Outbox dispatcher has no unrelated
    // immediately eligible events to consume.
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 60_000);

    const unrelatedEligibleEvents =
      await prisma.outboxEvent.count({
        where: {
          OR: [
            {
              status: "PENDING",
              availableAt: { lte: now },
            },
            {
              status: "PROCESSING",
              lockedAt: { lte: staleBefore },
              attemptCount: { lt: 10 },
            },
          ],
        },
      });

    assert(
      unrelatedEligibleEvents === 0,
      "Unrelated eligible Outbox events exist. Process them before running this test.",
    );

    // 1. Create isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create active BigCommerce integration.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: true,
      },
    });

    // 3. Create original webhook event.
    await prisma.webhookEvent.create({
      data: {
        id: webhookEventId,
        tenantId,
        source: "BIGCOMMERCE",
        integrationId,
        eventType: "store/product/updated",
        externalEventId,
        status: "RECEIVED",
        correlationId,
        payload: {
          data: {
            type: "lease-crash",
            id: "recovery-e2e-product",
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
      resourceType: "lease-crash",
      resourceId: "recovery-e2e-product",
      payload: {
        data: {
          type: "lease-crash",
          id: "recovery-e2e-product",
        },
      },
    };

    // 4. Create active idempotency lease.
    const idempotencyRecord =
      await prisma.idempotencyRecord.create({
        data: {
          tenantKey: tenantId,
          scope: integrationScope,
          idempotencyKey: externalEventId,
          jobName: "PROCESS_WEBHOOK_EVENT",
          requestHash,
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: new Date(),
          leaseExpiresAt: new Date(
            Date.now() + IDEMPOTENCY_LEASE_DURATION_MS,
          ),
          leaseToken: oldLeaseToken,
        },
      });

    idempotencyRecordId = idempotencyRecord.id;

    // 5. Create original SyncLog.
    await prisma.syncLog.create({
      data: {
        id: initialSyncLogId,
        tenantId,
        jobId: initialJobId,
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
    });

    // 6. Publish original job directly to BullMQ.
    const initialQueueData = {
      syncLogId: initialSyncLogId,
      idempotencyRecordId: idempotencyRecord.id,
      leaseToken: oldLeaseToken,
      payload: jobPayload,
    };

    const validatedInitialData =
      webhookQueueDataSchema.parse(initialQueueData);

    await integrationQueue.add(
      JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      validatedInitialData,
      {
        jobId: initialJobId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    console.info("--------------------------------------");
    console.info("PHASE 1: START WORKER A");
    console.info("--------------------------------------");

    // 7. Start Worker A in a separate process.
    workerA = startWorker(true);

    await workerA.waitForOutput(
      "[Crash Test Handler] Worker A started:",
      60_000,
    );

    console.info(
      "[Test] Worker A entered the crash handler.",
    );

    // 8. Wait for the intentional process crash.
    const workerAExit = await workerA.waitForExit();

    assert(
      workerAExit.code === 1,
      `Expected Worker A exit code 1, received ${workerAExit.code}.`,
    );

    console.info(
      "[Test] Worker A crashed as expected.",
    );

    // 9. Verify the abandoned execution still owns its old lease.
    const abandonedRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: idempotencyRecord.id },
      });

    assert(
      abandonedRecord.status === "PROCESSING",
      "Unexpected idempotency status after Worker A crash.",
    );

    assert(
      abandonedRecord.leaseToken === oldLeaseToken,
      "Original lease token unexpectedly changed.",
    );

    // 10. Simulate lease expiration.
    await prisma.idempotencyRecord.update({
      where: { id: idempotencyRecord.id },
      data: {
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    console.info("--------------------------------------");
    console.info("PHASE 2: RUN RECOVERY");
    console.info("--------------------------------------");

    // 11. Run the actual production recovery dispatcher.
    const recoveryResult =
      await recoverExpiredWebhookJobs({
        tenantKey: tenantId,
        limit: 10,
      });

    console.info("[Test] Recovery result:", recoveryResult);

    assert(
      recoveryResult.scanned === 1 &&
      recoveryResult.recovered === 1 &&
      recoveryResult.failed === 0,
      "Recovery dispatcher did not recover exactly one record.",
    );

    // 12. Retrieve replacement records.
    const replacementLog =
      await prisma.syncLog.findFirst({
        where: {
          tenantId,
          webhookEventId,
          id: { not: initialSyncLogId },
        },
        orderBy: { createdAt: "desc" },
      });

    assert(
      replacementLog !== null,
      "Replacement SyncLog was not created.",
    );

    replacementSyncLogId = replacementLog.id;

    const oldLog =
      await prisma.syncLog.findUniqueOrThrow({
        where: { id: initialSyncLogId },
      });

    assert(
      oldLog.status === "SUPERSEDED",
      "Original SyncLog was not superseded.",
    );

    assert(
      replacementLog.status === "PENDING",
      "Replacement SyncLog is not PENDING.",
    );

    const recoveredRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: idempotencyRecord.id },
      });

    assert(
      recoveredRecord.attemptCount === 2,
      "Recovery did not increment the attempt count.",
    );

    assert(
      recoveredRecord.leaseToken !== oldLeaseToken,
      "Recovery did not replace the old lease token.",
    );

    assert(
      recoveredRecord.leaseExpiresAt !== null &&
      recoveredRecord.leaseExpiresAt > new Date(),
      "Replacement lease is not active.",
    );

    const recoveredEvent =
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: webhookEventId },
      });

    assert(
      recoveredEvent.status === "RECEIVED",
      "WebhookEvent was not reset to RECEIVED.",
    );

    // 13. Find the replacement Outbox event.
    const deduplicationKey =
      `webhook:${idempotencyRecord.id}:attempt:2`;

    const outboxEvent =
      await prisma.outboxEvent.findUnique({
        where: { deduplicationKey },
      });

    assert(
      outboxEvent !== null,
      "Replacement OutboxEvent was not created.",
    );

    replacementOutboxId = outboxEvent.id;

    assert(
      outboxEvent.status === "PENDING",
      "Replacement OutboxEvent is not PENDING.",
    );

    // 14. Publish the replacement job.
    console.info("--------------------------------------");
    console.info("PHASE 3: DISPATCH OUTBOX");
    console.info("--------------------------------------");

    const dispatchResult =
      await runOutboxDispatchCycle();

    console.info("[Test] Outbox dispatch result:", dispatchResult);

    assert(
      dispatchResult.published === 1,
      "Expected exactly one Outbox event to be published.",
    );

    const publishedOutbox =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: outboxEvent.id },
      });

    assert(
      publishedOutbox.status === "PUBLISHED",
      "OutboxEvent was not marked PUBLISHED.",
    );

    const replacementJobId = `outbox_${outboxEvent.id}`;

    console.info(
      "[Test] Replacement BullMQ job:",
      replacementJobId,
    );

    console.info("--------------------------------------");
    console.info("PHASE 4: START WORKER B");
    console.info("--------------------------------------");

    // 15. Start Worker B without crash mode.
    workerB = startWorker(false);

    await workerB.waitForOutput(
      "[Worker] Integration worker is running.",
      30_000,
    );

    // 16. Wait for the recovered execution to finish.
    const finalState = await waitForSuccessfulExecution({
      idempotencyRecordId: idempotencyRecord.id,
      webhookEventId,
      syncLogId: replacementLog.id,
      timeoutMs: 120_000,
    });

    // 17. Wait until BullMQ has also finalized the abandoned
    // original job. This prevents leaving an active stalled job.
    await waitForJobTerminal(initialJobId, 90_000);

    const replacementJob =
      await integrationQueue.getJob(replacementJobId);

    if (replacementJob) {
      const replacementJobState =
        await replacementJob.getState();

      assert(
        replacementJobState === "completed",
        `Replacement BullMQ job state is ${replacementJobState}, expected completed.`,
      );

      console.info(
        "[Test] Replacement BullMQ job state:",
        replacementJobState,
      );
    } else {
      console.info(
        "[Test] Replacement BullMQ job was automatically removed after processing.",
      );
    }

    console.info("--------------------------------------");
    console.info("FINAL DATABASE ASSERTIONS");
    console.info("--------------------------------------");

    assert(
      finalState.record.status === "COMPLETED",
      "IdempotencyRecord is not COMPLETED.",
    );

    assert(
      finalState.event.status === "PROCESSED",
      "WebhookEvent is not PROCESSED.",
    );

    assert(
      finalState.syncLog.status === "SUCCESS",
      "Replacement SyncLog is not SUCCESS.",
    );

    console.info("Worker A: CRASHED");
    console.info("Original SyncLog: SUPERSEDED");
    console.info("Recovery: SUCCESS");
    console.info("Replacement OutboxEvent: PUBLISHED");
    console.info("Replacement BullMQ Job: COMPLETED");
    console.info("Worker B: SUCCESS");
    console.info("IdempotencyRecord: COMPLETED");
    console.info("WebhookEvent: PROCESSED");
    console.info("Replacement SyncLog: SUCCESS");

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");

  } finally {
    // Stop the replacement worker before cleaning its records.
    await stopWorker(workerB);
    await stopWorker(workerA);

    // Remove only the two jobs created by this test.
    await removeTestJob(initialJobId);

    if (replacementOutboxId) {
      await removeTestJob(`outbox_${replacementOutboxId}`);
    }

    // Clean up only this test's database records.
    if (replacementOutboxId) {
      await prisma.outboxEvent.deleteMany({
        where: { id: replacementOutboxId },
      });
    }

    if (idempotencyRecordId) {
      await prisma.idempotencyRecord.deleteMany({
        where: { id: idempotencyRecordId },
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
    "CRASH RECOVERY END-TO-END TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});
