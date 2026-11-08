import "dotenv/config";

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import { prisma } from "../../src/shared/utils/db.js";

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

interface WorkerResult {
  scanned: number;
  recovered: number;
  skipped: number;
  failed: number;
}

interface WorkerHandle {
  process: ChildProcessWithoutNullStreams;
  output: string;
  ready: boolean;
}

const WORKER_SCRIPT =
  "tests/stress/recovery-process-runner.ts";

function startWorker(tenantKey: string): WorkerHandle {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      WORKER_SCRIPT,
      tenantKey,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    },
  );

  const worker: WorkerHandle = {
    process: child,
    output: "",
    ready: false,
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    worker.output += chunk;

    if (worker.output.includes("[Recovery Process] READY")) {
      worker.ready = true;
    }

    process.stdout.write(`[Child ${child.pid}] ${chunk}`);
  });

  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(`[Child ${child.pid}] ${chunk}`);
  });

  return worker;
}

async function waitForWorkersReady(
  workers: WorkerHandle[],
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now();

  while (!workers.every((worker) => worker.ready)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        "Timed out waiting for recovery processes to become ready.",
      );
    }

    for (const worker of workers) {
      if (worker.process.exitCode !== null) {
        throw new Error(
          `Recovery process ${worker.process.pid} exited before becoming ready.`,
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForWorkerResults(
  workers: WorkerHandle[],
): Promise<WorkerResult[]> {
  // Register every exit listener before awaiting any child.
  const exitPromises = workers.map((worker) =>
    once(worker.process, "exit") as Promise<[number | null]>,
  );

  const exits = await Promise.all(exitPromises);

  return workers.map((worker, index) => {
    const [exitCode] = exits[index]!;

    assert(
      exitCode === 0,
      `Recovery process ${worker.process.pid} exited with code ${exitCode}.`,
    );

    const match = worker.output.match(
      /MULTIPROCESS_RESULT=(\{.*\})/,
    );

    assert(
      match !== null,
      `Recovery process ${worker.process.pid} did not return a result.`,
    );

    return JSON.parse(match[1]!) as WorkerResult;
  });
}

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();

  const externalEventId =
    `recovery-multiprocess-failure-${randomUUID()}`;

  const requestHash = "e".repeat(64);
  const originalLeaseToken = randomUUID();
  const originalSyncLogId = randomUUID();

  const startedAt = new Date();
  const expiredLeaseDate = new Date(Date.now() - 10_000);

  let idempotencyRecordId: string | null = null;

  const workers: WorkerHandle[] = [];

  console.info("======================================");
  console.info("MULTI-PROCESS RECOVERY FAILURE TEST");
  console.info("======================================");

  try {
    // 1. Create an isolated tenant without an active integration.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create an inactive integration to test recovery failure.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: false,
      },
    });

    // 2. Create a webhook event awaiting recovery.
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
            id: "multiprocess-failure-product",
          },
        },
      },
    });

    const jobPayload = {
      tenantId,
      webhookEventId,
      correlationId,
      source: "BIGCOMMERCE",
      eventType: "store/product/updated",
      resourceType: "product",
      resourceId: "multiprocess-failure-product",
      payload: {
        data: {
          type: "product",
          id: "multiprocess-failure-product",
        },
      },
    };

    // 3. Create an expired idempotency lease.
    const idempotencyRecord =
      await prisma.idempotencyRecord.create({
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
          startedAt,
          leaseExpiresAt: expiredLeaseDate,
          leaseToken: originalLeaseToken,
        },
      });

    idempotencyRecordId = idempotencyRecord.id;

    // 4. Create the original unfinished SyncLog.
    await prisma.syncLog.create({
      data: {
        id: originalSyncLogId,
        tenantId,
        jobId: `original-${randomUUID()}`,
        jobName: "PROCESS_WEBHOOK_EVENT",
        queueName: "integration-sync-queue",
        source: "BIGCOMMERCE",
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId,
        status: "PROCESSING",
        attemptCount: 1,
        startedAt,
        payload: jobPayload,
      },
    });

    console.info("[Test] Failure fixture created.");
    console.info("[Test] BigCommerce integration exists but is inactive.");
    console.info("[Test] Idempotency record:", idempotencyRecord.id);

    // 5. Start two independent recovery processes.
    console.info("--------------------------------------");
    console.info("PHASE 1: START INDEPENDENT PROCESSES");
    console.info("--------------------------------------");

    workers.push(
      startWorker(tenantId),
      startWorker(tenantId),
    );

    await waitForWorkersReady(workers);

    console.info("[Test] Both recovery processes are ready.");

    // 6. Release both processes simultaneously.
    console.info("--------------------------------------");
    console.info("PHASE 2: SIMULTANEOUS FAILED RECOVERY");
    console.info("--------------------------------------");

    const recoveryStart = Date.now();

    for (const worker of workers) {
      worker.process.stdin.write("START\n");
      worker.process.stdin.end();
    }

    const workerResults =
      await waitForWorkerResults(workers);

    console.info("[Test] Worker results:", workerResults);
    console.info(
      `[Test] Recovery duration: ${Date.now() - recoveryStart}ms`,
    );

    // 7. Verify recovery outcomes across independent processes.
    const totalScanned = workerResults.reduce(
      (total, result) => total + result.scanned,
      0,
    );

    const totalRecovered = workerResults.reduce(
      (total, result) => total + result.recovered,
      0,
    );

    const totalSkipped = workerResults.reduce(
      (total, result) => total + result.skipped,
      0,
    );

    const totalFailed = workerResults.reduce(
      (total, result) => total + result.failed,
      0,
    );

    assert(
      totalScanned >= 1 && totalScanned <= workers.length,
      `Unexpected total scanned count: ${totalScanned}.`,
    );

    assert(
      totalRecovered === 0,
      `Expected zero successful recoveries, received ${totalRecovered}.`,
    );

    assert(
      totalFailed >= 1,
      `Expected at least one failed recovery attempt, received ${totalFailed}.`,
    );

    assert(
      totalFailed + totalSkipped === totalScanned,
      "Recovery outcomes do not match the number of scanned records.",
    );

    console.info(
      `[PASS] Recovery outcomes verified: ${totalFailed} failed, ${totalSkipped} skipped.`,
    );

    console.info(
      "[INFO] Multiple failed attempts are possible after transaction rollback.",
    );

    // 8. Verify retry tracking was updated exactly once.
    const finalRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: idempotencyRecord.id },
      });

    assert(
      finalRecord.recoveryAttemptCount === 1,
      `Expected recoveryAttemptCount 1, received ${finalRecord.recoveryAttemptCount}.`,
    );

    assert(
      finalRecord.recoveryNextAttemptAt !== null &&
      finalRecord.recoveryNextAttemptAt > new Date(),
      "Recovery retry was not scheduled in the future.",
    );

    assert(
      finalRecord.recoveryLastError?.includes(
        "Active BIGCOMMERCE integration",
      ) === true,
      "Recovery error was not recorded correctly.",
    );

    console.info("[PASS] Recovery failure recorded exactly once.");
    console.info("[PASS] Next recovery attempt scheduled in the future.");

    // 9. Verify the original lease was preserved after rollback.
    assert(
      finalRecord.status === "PROCESSING",
      "Idempotency status changed unexpectedly.",
    );

    assert(
      finalRecord.leaseToken === originalLeaseToken,
      "Original lease token changed despite transaction rollback.",
    );

    assert(
      finalRecord.leaseExpiresAt?.getTime() ===
        expiredLeaseDate.getTime(),
      "Original lease expiration changed despite transaction rollback.",
    );

    assert(
      finalRecord.attemptCount === 1,
      `Expected attemptCount 1 after rollback, received ${finalRecord.attemptCount}.`,
    );

    console.info("[PASS] Original idempotency lease preserved.");

    // 10. Verify the original SyncLog remains unchanged.
    const originalSyncLog =
      await prisma.syncLog.findUniqueOrThrow({
        where: { id: originalSyncLogId },
      });

    assert(
      originalSyncLog.status === "PROCESSING",
      `Expected original SyncLog PROCESSING, received ${originalSyncLog.status}.`,
    );

    const syncLogs = await prisma.syncLog.findMany({
      where: {
        tenantId,
        webhookEventId,
      },
    });

    assert(
      syncLogs.length === 1,
      `Expected only the original SyncLog, received ${syncLogs.length}.`,
    );

    console.info("[PASS] Original SyncLog remains PROCESSING.");
    console.info("[PASS] No replacement SyncLog was created.");

    // 11. Verify no OutboxEvent was created.
    const outboxEvents =
      await prisma.outboxEvent.findMany({
        where: {
          aggregateType: "WebhookEvent",
          aggregateId: webhookEventId,
        },
      });

    assert(
      outboxEvents.length === 0,
      `Expected zero OutboxEvents, received ${outboxEvents.length}.`,
    );

    console.info("[PASS] No OutboxEvent was created.");

    // 12. Verify webhook state was preserved.
    const finalWebhookEvent =
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: webhookEventId },
      });

    assert(
      finalWebhookEvent.status === "PROCESSING",
      `Expected WebhookEvent PROCESSING, received ${finalWebhookEvent.status}.`,
    );

    console.info("[PASS] WebhookEvent remains PROCESSING.");

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");

  } finally {
    // 13. Stop any child processes still running.
    for (const worker of workers) {
      if (worker.process.exitCode === null) {
        worker.process.kill();
      }
    }

    // 14. Clean up only test-owned database records.
    if (idempotencyRecordId) {
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateType: "WebhookEvent",
          aggregateId: webhookEventId,
        },
      });

      await prisma.idempotencyRecord.deleteMany({
        where: {
          id: idempotencyRecordId,
        },
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

    await prisma.$disconnect();

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error) => {
  console.error(
    "MULTI-PROCESS RECOVERY FAILURE TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});