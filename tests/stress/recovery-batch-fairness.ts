import "dotenv/config";

import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { recoverExpiredWebhookJobs } from "../../src/infra/queues/recovery-dispatcher.js";

import {
  registerRecoveryAdapter,
} from "../../src/infra/queues/recovery/recovery-adapter-registry.js";

import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";

import type {
  WebhookRecoveryAdapter,
} from "../../src/infra/queues/recovery/recovery-adapter.types.js";

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

function assert(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const tenantId = randomUUID();

  const bigCommerceIntegrationId = randomUUID();
  const bigCommerceEventId = randomUUID();
  const shopifyEventId = randomUUID();

  const bigCommerceEventKey = `fairness-bigcommerce-${randomUUID()}`;
  const shopifyEventKey = `fairness-shopify-${randomUUID()}`;

  const bigCommerceLeaseToken = randomUUID();
  const shopifyLeaseToken = randomUUID();

  try {
    console.info("=================================");
    console.info("RECOVERY BATCH FAIRNESS TEST");
    console.info("=================================");

    // 1. Create one isolated tenant.
    await prisma.tenantConfig.create({
      data: {
        id: tenantId,
      },
    });

    // BigCommerce integration is inactive to test recovery failure.
    await prisma.tenantIntegrationConfig.create({
      data: {
        id: bigCommerceIntegrationId,
        tenantId,
        systemName: "BIGCOMMERCE",
        isActive: false,
      },
    });

    // 2. Register only the Shopify integration.
    // BigCommerce intentionally has no active integration.
    const shopifyIntegration =
      await prisma.tenantIntegrationConfig.create({
        data: {
          tenantId,
          systemName: "SHOPIFY",
          isActive: true,
        },
      });

    const now = Date.now();

    // 3. Create the BigCommerce webhook event.
    await prisma.webhookEvent.create({
      data: {
        id: bigCommerceEventId,
        tenantId,
        integrationId: bigCommerceIntegrationId,
        source: "BIGCOMMERCE",
        eventType: "store/product/updated",
        externalEventId: bigCommerceEventKey,
        status: "PROCESSING",
        correlationId: randomUUID(),
        payload: {
          id: 1001,
          name: "BigCommerce Fairness Test",
        },
      },
    });

    // 4. Create the Shopify webhook event.
    await prisma.webhookEvent.create({
      data: {
        id: shopifyEventId,
        tenantId,
        integrationId: shopifyIntegration.id,
        source: "SHOPIFY",
        eventType: "products/update",
        externalEventId: shopifyEventKey,
        status: "PROCESSING",
        correlationId: randomUUID(),
        payload: {
          id: 2001,
          title: "Shopify Fairness Test",
        },
      },
    });

    // 5. Create the BigCommerce expired lease.
    // Its earlier expiration makes it the first batch candidate.
    const bigCommerceRecord =
      await prisma.idempotencyRecord.create({
        data: {
          tenantKey: tenantId,
          scope: getIntegrationWebhookIdempotencyScope(
            "BIGCOMMERCE",
            bigCommerceIntegrationId,
          ),
          idempotencyKey: bigCommerceEventKey,
          jobName: "PROCESS_WEBHOOK_EVENT",
          requestHash: "a".repeat(64),
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: new Date(now - 120_000),
          leaseExpiresAt: new Date(now - 10_000),
          leaseToken: bigCommerceLeaseToken,
        },
      });

    // 6. Create the Shopify expired lease.
    // It is also expired, but its expiration is later.
    const shopifyRecord =
      await prisma.idempotencyRecord.create({
        data: {
          tenantKey: tenantId,
          scope: getIntegrationWebhookIdempotencyScope(
            "SHOPIFY",
            shopifyIntegration.id,
          ),
          idempotencyKey: shopifyEventKey,
          jobName: "PROCESS_WEBHOOK_EVENT",
          requestHash: "b".repeat(64),
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: new Date(now - 120_000),
          leaseExpiresAt: new Date(now - 5_000),
          leaseToken: shopifyLeaseToken,
        },
      });

    // 7. First recovery cycle.
    // Expected: BigCommerce is selected and fails.
    console.info("---------------------------------");
    console.info("FIRST RECOVERY CYCLE");
    console.info("---------------------------------");

    const firstCycle = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    console.info("First cycle:", firstCycle);

    assert(
      firstCycle.scanned === 1,
      `Expected 1 scanned record, received ${firstCycle.scanned}.`,
    );

    assert(
      firstCycle.failed === 1,
      `Expected 1 failed record, received ${firstCycle.failed}.`,
    );

    assert(
      firstCycle.recovered === 0,
      `Expected 0 recovered records, received ${firstCycle.recovered}.`,
    );

    // 8. Verify BigCommerce was delayed.
    const bigCommerceAfterFirstCycle =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: bigCommerceRecord.id,
        },
      });

    assert(
      bigCommerceAfterFirstCycle.recoveryAttemptCount === 1,
      "BigCommerce recovery attempt was not recorded.",
    );

    assert(
      bigCommerceAfterFirstCycle.recoveryNextAttemptAt !== null &&
      bigCommerceAfterFirstCycle.recoveryNextAttemptAt > new Date(),
      "BigCommerce retry was not scheduled for a future time.",
    );

    console.info(
      "[PASS] Failed BigCommerce recovery received a retry delay.",
    );

    // 9. Second recovery cycle.
    // BigCommerce must now be excluded.
    // Shopify should be selected despite having a later lease expiration.
    console.info("---------------------------------");
    console.info("SECOND RECOVERY CYCLE");
    console.info("---------------------------------");

    const secondCycle = await recoverExpiredWebhookJobs({
      tenantKey: tenantId,
      limit: 1,
    });

    console.info("Second cycle:", secondCycle);

    assert(
      secondCycle.scanned === 1,
      `Expected 1 scanned record, received ${secondCycle.scanned}.`,
    );

    assert(
      secondCycle.recovered === 1,
      `Expected 1 recovered record, received ${secondCycle.recovered}.`,
    );

    assert(
      secondCycle.failed === 0,
      `Expected 0 failed records, received ${secondCycle.failed}.`,
    );

    // 10. Verify Shopify was recovered.
    const shopifyAfterSecondCycle =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: shopifyRecord.id,
        },
      });

    assert(
      shopifyAfterSecondCycle.attemptCount === 2,
      "Shopify lease was not successfully reclaimed.",
    );

    assert(
      shopifyAfterSecondCycle.leaseToken !== shopifyLeaseToken,
      "Shopify lease token was not replaced.",
    );

    assert(
      shopifyAfterSecondCycle.leaseExpiresAt !== null &&
      shopifyAfterSecondCycle.leaseExpiresAt > new Date(),
      "Shopify recovery did not create an active lease.",
    );

    console.info("[PASS] Shopify was recovered in the second cycle.");

    // 11. Verify BigCommerce remains delayed and was not retried.
    const bigCommerceAfterSecondCycle =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: bigCommerceRecord.id,
        },
      });

    assert(
      bigCommerceAfterSecondCycle.recoveryAttemptCount === 1,
      "BigCommerce was retried before its scheduled retry time.",
    );

    assert(
      bigCommerceAfterSecondCycle.leaseToken === bigCommerceLeaseToken,
      "BigCommerce lease unexpectedly changed.",
    );

    console.info(
      "[PASS] Delayed BigCommerce record did not monopolize the batch.",
    );

    console.info("---------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("=================================");
  } finally {
    // Remove only resources created by this test.
    await prisma.outboxEvent.deleteMany({
      where: {
        aggregateType: "WebhookEvent",
        aggregateId: {
          in: [bigCommerceEventId, shopifyEventId],
        },
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

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error) => {
  console.error("RECOVERY BATCH FAIRNESS TEST FAILED:", error);
  process.exitCode = 1;
});