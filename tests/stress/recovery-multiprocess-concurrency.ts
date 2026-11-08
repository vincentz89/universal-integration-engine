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
  const results: WorkerResult[] = [];

  for (const worker of workers) {
    const [exitCode] = await once(
      worker.process,
      "exit",
    ) as [number | null];

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

    results.push(
      JSON.parse(match[1]!) as WorkerResult,
    );
  }

  return results;
}

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();

  const externalEventId =
    `recovery-multiprocess-${randomUUID()}`;

  const requestHash = "d".repeat(64);
  const originalLeaseToken = randomUUID();
  const originalSyncLogId = randomUUID();

  const startedAt = new Date();
  const expiredLeaseDate = new Date(Date.now() - 10_000);

  let idempotencyRecordId: string | null = null;
  const workers: WorkerHandle[] = [];

  console.info("======================================");
  console.info("MULTI-PROCESS RECOVERY CONCURRENCY TEST");
  console.info("======================================");

  try {
    // 1. Create an isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create an active integration.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: integrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: true,
      },
    });

    // 3. Create a webhook event.
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
            id: "multiprocess-recovery-product",
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
      resourceType: "product",
      resourceId: "multiprocess-recovery-product",
      payload: {
        data: {
          type: "product",
          id: "multiprocess-recovery-product",
        },
      },
    };

    // 4. Create an expired idempotency lease.
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

    // 5. Create the original unfinished SyncLog.
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

    console.info("[Test] Recovery fixture created.");
    console.info("[Test] Idempotency record:", idempotencyRecord.id);

    // 6. Start two independent Node.js processes.
    console.info("--------------------------------------");
    console.info("PHASE 1: START INDEPENDENT PROCESSES");
    console.info("--------------------------------------");

    workers.push(
      startWorker(tenantId),
      startWorker(tenantId),
    );

    await waitForWorkersReady(workers);

    console.info("[Test] Both recovery processes are ready.");

    // 7. Release both processes simultaneously.
    console.info("--------------------------------------");
    console.info("PHASE 2: SIMULTANEOUS RECOVERY");
    console.info("--------------------------------------");

    const recoveryStart = Date.now();

    for (const worker of workers) {
      worker.process.stdin.write("START\n");
      worker.process.stdin.end();
    }

    const workerResults =
      await waitForWorkerResults(workers);

    const recoveryDuration = Date.now() - recoveryStart;

    console.info("[Test] Worker results:", workerResults);
    console.info(
      `[Test] Multi-process recovery duration: ${recoveryDuration}ms`,
    );

    // 8. Verify exactly one recovery succeeded.
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
      totalRecovered === 1,
      `Expected exactly one successful recovery, received ${totalRecovered}.`,
    );

    assert(
      totalSkipped === 1,
      `Expected exactly one skipped recovery, received ${totalSkipped}.`,
    );

    assert(
      totalFailed === 0,
      `Expected zero failures, received ${totalFailed}.`,
    );

    console.info(
      "[PASS] Exactly one independent process recovered the record.",
    );

    // 9. Verify idempotency lease ownership.
    const finalRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: idempotencyRecord.id },
      });

    assert(
      finalRecord.attemptCount === 2,
      `Expected attemptCount 2, received ${finalRecord.attemptCount}.`,
    );

    assert(
      finalRecord.leaseToken !== originalLeaseToken,
      "Original lease token was not replaced.",
    );

    assert(
      finalRecord.leaseExpiresAt !== null &&
      finalRecord.leaseExpiresAt > new Date(),
      "Replacement lease is not active.",
    );

    console.info("[PASS] Lease ownership replaced exactly once.");

    // 10. Verify original SyncLog was superseded.
    const originalSyncLog =
      await prisma.syncLog.findUniqueOrThrow({
        where: { id: originalSyncLogId },
      });

    assert(
      originalSyncLog.status === "SUPERSEDED",
      `Original SyncLog status is ${originalSyncLog.status}.`,
    );

    console.info("[PASS] Original SyncLog is SUPERSEDED.");

    // 11. Verify only one replacement SyncLog exists.
    const syncLogs = await prisma.syncLog.findMany({
      where: {
        tenantId,
        webhookEventId,
      },
    });

    const replacementLogs = syncLogs.filter(
      (log) => log.id !== originalSyncLogId,
    );

    assert(
      syncLogs.length === 2 &&
      replacementLogs.length === 1,
      `Expected 2 total SyncLogs and 1 replacement, received ${syncLogs.length}.`,
    );

    const replacementLog = replacementLogs[0];

    assert(
      replacementLog !== undefined &&
      replacementLog.status === "PENDING",
      "Replacement SyncLog is missing or not PENDING.",
    );

    console.info("[PASS] Exactly one replacement SyncLog created.");

    // 12. Verify only one replacement OutboxEvent exists.
    const outboxEvents =
      await prisma.outboxEvent.findMany({
        where: {
          aggregateType: "WebhookEvent",
          aggregateId: webhookEventId,
        },
      });

    assert(
      outboxEvents.length === 1,
      `Expected exactly one OutboxEvent, received ${outboxEvents.length}.`,
    );

    const replacementOutbox = outboxEvents[0];

    assert(
      replacementOutbox !== undefined,
      "Replacement OutboxEvent does not exist.",
    );

    assert(
      replacementOutbox.deduplicationKey ===
        `webhook:${idempotencyRecord.id}:attempt:2`,
      "Outbox deduplication key is incorrect.",
    );

    assert(
      replacementOutbox.status === "PENDING",
      "Replacement OutboxEvent is not PENDING.",
    );

    const outboxPayload = replacementOutbox.payload;

    assert(
      typeof outboxPayload === "object" &&
      outboxPayload !== null &&
      !Array.isArray(outboxPayload),
      "Outbox payload is invalid.",
    );

    const payload =
      outboxPayload as Record<string, unknown>;

    assert(
      typeof payload.jobData === "object" &&
      payload.jobData !== null &&
      !Array.isArray(payload.jobData),
      "Outbox jobData is invalid.",
    );

    const jobData =
      payload.jobData as Record<string, unknown>;

    assert(
      jobData.leaseToken === finalRecord.leaseToken,
      "Outbox lease token does not match the winning lease.",
    );

    console.info("[PASS] Exactly one replacement OutboxEvent created.");
    console.info("[PASS] Outbox envelope matches winning lease.");

    // 13. Verify webhook event state.
    const finalWebhookEvent =
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: webhookEventId },
      });

    assert(
      finalWebhookEvent.status === "RECEIVED",
      `Expected WebhookEvent RECEIVED, received ${finalWebhookEvent.status}.`,
    );

    console.info("[PASS] WebhookEvent is RECEIVED.");

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");

  } finally {
    // 14. Stop any child processes that are still running.
    for (const worker of workers) {
      if (worker.process.exitCode === null) {
        worker.process.kill();
      }
    }

    // 15. Clean up only test-owned database records.
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
    "MULTI-PROCESS RECOVERY TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});