import "dotenv/config";

import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { recoverExpiredWebhookJobs } from "../../src/infra/queues/recovery-dispatcher.js";

import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

import {
  registerRecoveryAdapter,
} from "../../src/infra/queues/recovery/recovery-adapter-registry.js";

import {
  idempotencyRepository,
} from "../../src/shared/repositories/idempotency.repository.js";

import type {
  WebhookRecoveryAdapter,
} from "../../src/infra/queues/recovery/recovery-adapter.types.js";

function assert(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const shopifyTestRecoveryAdapter: WebhookRecoveryAdapter = {
  source: "SHOPIFY",

  buildPayload(input) {
    const resourceId = input.payload.id;

    return {
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      webhookEventId: input.webhookEventId,
      correlationId: input.correlationId,
      source: "SHOPIFY",
      eventType: input.eventType,
      resourceType: "product",
      ...(typeof resourceId === "string" ||
      typeof resourceId === "number"
        ? { resourceId: String(resourceId) }
        : {}),
      payload: input.payload,
    };
  },
};

registerRecoveryAdapter(shopifyTestRecoveryAdapter);

async function main() {
  const tenantId = randomUUID();
  const integrationId = randomUUID();
  const webhookEventId = randomUUID();
  const correlationId = randomUUID();
  const leaseToken = randomUUID();

  const externalEventId = `permanent-failure-${randomUUID()}`;
  const scope = getIntegrationWebhookIdempotencyScope(
    "SHOPIFY",
    integrationId,
  );

  const expiredAt = new Date(Date.now() - 1_000);

  console.info("=================================");
  console.info("PERMANENT RECOVERY FAILURE TEST");
  console.info("=================================");

  try {
    // 1. Create an isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // 2. Create a webhook event without an integration association.
    await prisma.webhookEvent.create({
      data: {
        id: webhookEventId,
        tenantId,
        source: "SHOPIFY",
        eventType: "products/update",
        externalEventId,
        status: "PROCESSING",
        correlationId,
        payload: {
          id: 12345,
          title: "Permanent Recovery Failure Test",
        },
      },
    });

    // 3. Create an expired account-specific idempotency lease.
    const record = await prisma.idempotencyRecord.create({
      data: {
        tenantKey: tenantId,
        scope,
        idempotencyKey: externalEventId,
        jobName: "PROCESS_WEBHOOK_EVENT",
        requestHash: "d".repeat(64),
        status: "PROCESSING",
        attemptCount: 1,
        startedAt: new Date(Date.now() - 120_000),
        leaseExpiresAt: expiredAt,
        leaseToken,
      },
    });

    console.info("---------------------------------");
    console.info("FIRST RECOVERY CYCLE");
    console.info("---------------------------------");

    const firstResult = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    console.info("Recovery Result:", firstResult);

    assert(
      firstResult.scanned === 1,
      `Expected 1 scanned record, received ${firstResult.scanned}.`,
    );

    assert(
      firstResult.recovered === 0,
      "Invalid webhook record was unexpectedly recovered.",
    );

    assert(
      firstResult.failed === 1,
      `Expected 1 failed record, received ${firstResult.failed}.`,
    );

    // 4. Verify permanent quarantine preserved the original lease.
    const quarantinedRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: record.id,
        },
      });

    assert(
      quarantinedRecord.status === "PROCESSING",
      "Quarantine unexpectedly changed the idempotency status.",
    );

    assert(
      quarantinedRecord.leaseToken === leaseToken,
      "Quarantine unexpectedly changed the lease token.",
    );

    assert(
      quarantinedRecord.leaseExpiresAt?.getTime() === expiredAt.getTime(),
      "Quarantine unexpectedly changed the lease expiration.",
    );

    assert(
      quarantinedRecord.attemptCount === 1,
      "Quarantine unexpectedly incremented the execution attempt count.",
    );

    assert(
      quarantinedRecord.recoveryBlockedAt !== null,
      "Invalid webhook record was not permanently quarantined.",
    );

    assert(
      quarantinedRecord.recoveryAttemptCount === 0,
      "Permanent quarantine incorrectly incremented recoveryAttemptCount.",
    );

    assert(
      quarantinedRecord.recoveryNextAttemptAt === null,
      "Permanent quarantine unexpectedly scheduled another retry.",
    );

    assert(
      quarantinedRecord.recoveryLastError?.includes(
        "Integration-owned WebhookEvent not found",
      ) === true,
      "Permanent quarantine did not preserve the missing integration-owned event reason.",
    );

    // 5. Verify no replacement SyncLog or OutboxEvent was created.
    const syncLogCount = await prisma.syncLog.count({
      where: {
        tenantId,
        webhookEventId,
      },
    });

    const outboxCount = await prisma.outboxEvent.count({
      where: {
        aggregateType: "WebhookEvent",
        aggregateId: webhookEventId,
      },
    });

    assert(
      syncLogCount === 0,
      "A SyncLog was created for a permanently quarantined record.",
    );

    assert(
      outboxCount === 0,
      "An OutboxEvent was created for a permanently quarantined record.",
    );

    console.info("Permanent Quarantine: VERIFIED");

    console.info("---------------------------------");
    console.info("SECOND RECOVERY CYCLE");
    console.info("---------------------------------");

    // 6. Verify quarantined records are excluded from future recovery scans.
    const secondResult = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    console.info("Recovery Result:", secondResult);

    assert(
      secondResult.scanned === 0,
      `Quarantined record was scanned again: ${secondResult.scanned}.`,
    );

    assert(
      secondResult.recovered === 0 &&
      secondResult.failed === 0 &&
      secondResult.skipped === 0,
      "Second recovery cycle unexpectedly processed the quarantined record.",
    );

        console.info("---------------------------------");
    console.info("QUARANTINE REGISTRATION BYPASS TEST");
    console.info("---------------------------------");

    const registrationInput = {
      tenantKey: tenantId,
      scope,
      idempotencyKey: externalEventId,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: "d".repeat(64),
    };

    // 7. Verify direct registration cannot reclaim a quarantined record.
    const directRegistration =
      await idempotencyRepository.register(registrationInput);

    assert(
      directRegistration.status === "RETRY_REQUIRED",
      `Direct registration bypassed quarantine: ${directRegistration.status}.`,
    );

    // 8. Verify transactional registration cannot reclaim a quarantined record.
    const transactionalRegistration = await prisma.$transaction((tx) =>
      idempotencyRepository.registerInTransaction(tx, registrationInput),
    );

    assert(
      transactionalRegistration.status === "RETRY_REQUIRED",
      `Transactional registration bypassed quarantine: ${transactionalRegistration.status}.`,
    );

    // 9. Verify neither registration method modified the quarantined record.
    const afterRegistration =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: record.id,
        },
      });

    assert(
      afterRegistration.recoveryBlockedAt !== null,
      "Registration unexpectedly removed permanent quarantine.",
    );

    assert(
      afterRegistration.leaseToken === leaseToken,
      "Registration unexpectedly replaced the original lease token.",
    );

    assert(
      afterRegistration.attemptCount === 1,
      "Registration unexpectedly incremented the execution attempt count.",
    );

    assert(
      afterRegistration.recoveryAttemptCount === 0,
      "Registration unexpectedly modified the recovery attempt count.",
    );

    console.info("Direct Registration: RETRY_REQUIRED");
    console.info("Transactional Registration: RETRY_REQUIRED");
    console.info("Quarantine Preserved: true");
    console.info("Lease Token Preserved: true");
    console.info("Execution Attempt Count: 1");

    console.info("---------------------------------");
    console.info("PERMANENT QUARANTINE ASSERTIONS");
    console.info("---------------------------------");
    console.info("Original Lease Preserved: true");
    console.info("Execution Attempt Count: 1");
    console.info("Recovery Attempt Count: 0");
    console.info("Recovery Blocked: true");
    console.info("Retry Scheduled: false");
    console.info("Second Recovery Scan: 0");
    console.info("Replacement SyncLog: none");
    console.info("Replacement OutboxEvent: none");
    console.info("---------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("=================================");
  } finally {
    // Clean up only records belonging to this test.
    await prisma.outboxEvent.deleteMany({
      where: {
        aggregateType: "WebhookEvent",
        aggregateId: webhookEventId,
      },
    });

    await prisma.idempotencyRecord.deleteMany({
      where: {
        tenantKey: tenantId,
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
        tenantId,
      },
    });

    await prisma.tenantConfig.deleteMany({
      where: {
        id: tenantId,
      },
    });

    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("PERMANENT RECOVERY FAILURE TEST FAILED:", error);
  process.exitCode = 1;
});
