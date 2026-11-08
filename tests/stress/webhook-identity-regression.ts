
import "dotenv/config";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { outboxRepository } from "../../src/shared/repositories/outbox.repository.js";
import { acquireWebhookIdentityLock } from "../../src/core/webhooks/webhook-identity-lock.js";
import {
  getIntegrationWebhookIdempotencyScope,
} from "../../src/core/webhooks/idempotency-scope.js";
import {
  bigCommerceWebhookIntakeService,
} from "../../src/infra/webhooks/bigcommerce/webhook-intake.service.js";

const PROVIDER = "BIGCOMMERCE";
const SOURCE = "BIGCOMMERCE";
const EVENT_TYPE = "store/product/updated";
const RESOURCE_TYPE = "product";

const tenantIds: string[] = [];
const outboxIds: string[] = [];

let passed = 0;
let skipped = 0;

function logPass(message: string): void {
  passed++;
  console.info(`[PASS] ${message}`);
}

function logSkip(message: string): void {
  skipped++;
  console.info(`[SKIP] ${message}`);
}

function createPayload(resourceId: string, revision: number) {
  return {
    id: resourceId,
    revision,
    type: EVENT_TYPE,
  };
}

function createInput(
  tenantId: string,
  integrationId: string,
  externalEventId: string,
  revision = 1,
) {
  const webhookPayload = createPayload(externalEventId, revision);

  const requestHash = createHash("sha256")
    .update(JSON.stringify(webhookPayload))
    .digest("hex");

  return {
    tenantId,
    integrationId,
    externalEventId,
    requestHash,
    eventType: EVENT_TYPE,
    resourceType: RESOURCE_TYPE,
    resourceId: externalEventId,
    webhookPayload,
  };
}

async function createTenant(): Promise<string> {
  const tenantId = randomUUID();

  await prisma.tenantConfig.create({
    data: { id: tenantId },
  });

  tenantIds.push(tenantId);

  return tenantId;
}

async function createIntegration(
  tenantId: string,
): Promise<string> {
  const integrationId = randomUUID();

  await prisma.tenantIntegrationConfig.create({
    data: {
      id: integrationId,
      tenantId,
      systemName: PROVIDER,
      isActive: true,
    },
  });

  return integrationId;
}

function trackOutbox(result: {
  status: string;
  outboxEventId?: string;
}): void {
  if (
    (result.status === "NEW" || result.status === "RETRY_CLAIMED") &&
    result.outboxEventId
  ) {
    outboxIds.push(result.outboxEventId);
  }
}

async function hasRequiredPartialIndexes(): Promise<boolean> {
  const indexes = await prisma.$queryRaw<
    Array<{ indexname: string }>
  >`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'WebhookEvent'
      AND indexname IN (
        'WebhookEvent_integration_event_unique',
        'WebhookEvent_legacy_event_unique'
      )
  `;

  const names = new Set(indexes.map((index) => index.indexname));

  return (
    names.has("WebhookEvent_integration_event_unique") &&
    names.has("WebhookEvent_legacy_event_unique")
  );
}

async function testSameIntegrationIdentity(): Promise<void> {
  const tenantId = await createTenant();
  const integrationId = await createIntegration(tenantId);
  const externalEventId = `identity-${randomUUID()}`;

  const first = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationId, externalEventId),
  );

  assert.equal(first.status, "NEW");
  trackOutbox(first);

  const duplicate = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationId, externalEventId),
  );

  assert.equal(duplicate.status, "DUPLICATE");

  if (duplicate.status === "DUPLICATE") {
    assert.equal(duplicate.webhookEventId, first.webhookEventId);
  }

  const conflict = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationId, externalEventId, 2),
  );

  assert.equal(conflict.status, "CONFLICT");

  const events = await prisma.webhookEvent.findMany({
    where: {
      tenantId,
      source: SOURCE,
      externalEventId,
      integrationId,
    },
  });

  assert.equal(events.length, 1);

  logPass("Same integration: NEW, DUPLICATE, and changed-payload CONFLICT");
}

async function testExistingLegacyEvent(): Promise<void> {
  const tenantId = await createTenant();
  const integrationId = await createIntegration(tenantId);
  const externalEventId = `legacy-${randomUUID()}`;

  await prisma.webhookEvent.create({
    data: {
      tenantId,
      source: SOURCE,
      eventType: EVENT_TYPE,
      externalEventId,
      integrationId: null,
      status: "RECEIVED",
      correlationId: randomUUID(),
      payload: createPayload(externalEventId, 1),
    },
  });

  const result = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationId, externalEventId),
  );

  assert.equal(result.status, "CONFLICT");

  const idempotencyScope =
    getIntegrationWebhookIdempotencyScope(PROVIDER, integrationId);

  const records = await prisma.idempotencyRecord.findMany({
    where: {
      tenantKey: tenantId,
      scope: idempotencyScope,
      idempotencyKey: externalEventId,
    },
  });

  assert.equal(records.length, 0);

  logPass("Existing legacy event prevents linked intake");
}

async function testCrossIntegrationIdentity(): Promise<void> {
  if (!(await hasRequiredPartialIndexes())) {
    logSkip(
      "Cross-integration identity: partial unique indexes are not deployed yet",
    );
    return;
  }

  const tenantId = await createTenant();
  const integrationA = await createIntegration(tenantId);
  const integrationB = await createIntegration(tenantId);
  const externalEventId = `cross-${randomUUID()}`;

  const resultA = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationA, externalEventId),
  );

  assert.equal(resultA.status, "NEW");
  trackOutbox(resultA);

  const resultB = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationB, externalEventId),
  );

  assert.equal(resultB.status, "NEW");
  trackOutbox(resultB);

  assert.notEqual(resultA.webhookEventId, resultB.webhookEventId);
  assert.notEqual(resultA.idempotencyRecordId, resultB.idempotencyRecordId);

  const duplicateA = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationA, externalEventId),
  );

  const duplicateB = await bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationB, externalEventId),
  );

  assert.equal(duplicateA.status, "DUPLICATE");
  assert.equal(duplicateB.status, "DUPLICATE");

  if (
    duplicateA.status === "DUPLICATE" &&
    duplicateB.status === "DUPLICATE"
  ) {
    assert.equal(duplicateA.webhookEventId, resultA.webhookEventId);
    assert.equal(duplicateB.webhookEventId, resultB.webhookEventId);
  }

  const events = await prisma.webhookEvent.findMany({
    where: {
      tenantId,
      source: SOURCE,
      externalEventId,
    },
  });

  assert.equal(events.length, 2);

  logPass("Same external event ID accepted independently by two integrations");
}

async function testConcurrentLinkedRegistrations(): Promise<void> {
  if (!(await hasRequiredPartialIndexes())) {
    logSkip(
      "Concurrent linked registrations: partial unique indexes are not deployed yet",
    );
    return;
  }

  const tenantId = await createTenant();
  const integrationA = await createIntegration(tenantId);
  const integrationB = await createIntegration(tenantId);
  const externalEventId = `concurrent-linked-${randomUUID()}`;

  const [resultA, resultB] = await Promise.all([
    bigCommerceWebhookIntakeService.register(
      createInput(tenantId, integrationA, externalEventId),
    ),
    bigCommerceWebhookIntakeService.register(
      createInput(tenantId, integrationB, externalEventId),
    ),
  ]);

  assert.equal(resultA.status, "NEW");
  assert.equal(resultB.status, "NEW");

  trackOutbox(resultA);
  trackOutbox(resultB);

  assert.notEqual(resultA.webhookEventId, resultB.webhookEventId);
  assert.notEqual(resultA.idempotencyRecordId, resultB.idempotencyRecordId);

  const events = await prisma.webhookEvent.findMany({
    where: {
      tenantId,
      source: SOURCE,
      externalEventId,
    },
  });

  assert.equal(events.length, 2);

  const integrationIds = new Set(
    events.map((event) => event.integrationId),
  );

  assert.equal(integrationIds.size, 2);
  assert.ok(integrationIds.has(integrationA));
  assert.ok(integrationIds.has(integrationB));

  logPass("Concurrent linked registrations across integrations both accepted");
}

async function testLegacyVersusLinkedOwnership(): Promise<void> {
  const tenantId = await createTenant();
  const integrationId = await createIntegration(tenantId);
  const externalEventId = `ownership-race-${randomUUID()}`;

  const legacyWriter = prisma.$transaction(async (tx) => {
    await acquireWebhookIdentityLock(tx, {
      tenantId,
      provider: PROVIDER,
      externalEventId,
    });

    const linkedEvent = await tx.webhookEvent.findFirst({
      where: {
        tenantId,
        source: SOURCE,
        externalEventId,
        integrationId: { not: null },
      },
    });

    if (linkedEvent) {
      return "LINKED_EXISTS" as const;
    }

    await tx.webhookEvent.create({
      data: {
        tenantId,
        source: SOURCE,
        eventType: EVENT_TYPE,
        externalEventId,
        integrationId: null,
        status: "RECEIVED",
        correlationId: randomUUID(),
        payload: createPayload(externalEventId, 1),
      },
    });

    return "LEGACY_CREATED" as const;
  });

  const linkedWriter = bigCommerceWebhookIntakeService.register(
    createInput(tenantId, integrationId, externalEventId),
  );

  const [legacyResult, linkedResult] = await Promise.all([
    legacyWriter,
    linkedWriter,
  ]);

  trackOutbox(linkedResult);

  const events = await prisma.webhookEvent.findMany({
    where: {
      tenantId,
      source: SOURCE,
      externalEventId,
    },
  });

  assert.equal(events.length, 1);

  const winningEvent = events[0];
  assert.ok(winningEvent, "Expected exactly one winning webhook event");

  if (linkedResult.status === "NEW") {
    assert.equal(legacyResult, "LINKED_EXISTS");
    assert.ok(winningEvent.integrationId);
  } else {
    assert.equal(linkedResult.status, "CONFLICT");
    assert.equal(legacyResult, "LEGACY_CREATED");
    assert.equal(winningEvent.integrationId, null);
  }

  logPass("Concurrent legacy-versus-linked ownership: exactly one owner wins");
}

async function testIntakeTransactionRollback(): Promise<void> {
  const tenantId = await createTenant();
  const integrationId = await createIntegration(tenantId);
  const externalEventId = `rollback-${randomUUID()}`;

  const scope = getIntegrationWebhookIdempotencyScope(
    PROVIDER,
    integrationId,
  );

  const originalCreate = outboxRepository.create.bind(outboxRepository);

  let capturedOutboxId: string | null = null;

  outboxRepository.create = async (tx, input) => {
    const row = await originalCreate(tx, input);

    capturedOutboxId = row.id;

    throw new Error("TEST_FORCED_OUTBOX_ROLLBACK");
  };

  try {
    await assert.rejects(
      bigCommerceWebhookIntakeService.register(
        createInput(tenantId, integrationId, externalEventId),
      ),
      /TEST_FORCED_OUTBOX_ROLLBACK/,
    );
  } finally {
    outboxRepository.create = originalCreate;
  }

  assert.ok(capturedOutboxId, "Outbox create should have been reached");

  const [idempotencyRecords, webhookEvents, syncLogs, outboxEvent] =
    await Promise.all([
      prisma.idempotencyRecord.findMany({
        where: {
          tenantKey: tenantId,
          scope,
          idempotencyKey: externalEventId,
        },
      }),
      prisma.webhookEvent.findMany({
        where: {
          tenantId,
          source: SOURCE,
          externalEventId,
          integrationId,
        },
      }),
      prisma.syncLog.findMany({
        where: { tenantId },
      }),
      prisma.outboxEvent.findUnique({
        where: { id: capturedOutboxId },
      }),
    ]);

  assert.equal(idempotencyRecords.length, 0);
  assert.equal(webhookEvents.length, 0);
  assert.equal(syncLogs.length, 0);
  assert.equal(outboxEvent, null);

  logPass(
    "Intake transaction rollback removed IdempotencyRecord, WebhookEvent, SyncLog, and OutboxEvent",
  );
}

async function cleanup(): Promise<void> {
  if (outboxIds.length > 0) {
    await prisma.outboxEvent.deleteMany({
      where: { id: { in: [...new Set(outboxIds)] } },
    });
  }

  if (tenantIds.length === 0) {
    return;
  }

  await prisma.idempotencyRecord.deleteMany({
    where: { tenantKey: { in: tenantIds } },
  });

  await prisma.syncLog.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });

  await prisma.webhookEvent.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });

  await prisma.tenantIntegrationConfig.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });

  await prisma.tenantConfig.deleteMany({
    where: { id: { in: tenantIds } },
  });
}

async function main(): Promise<void> {
  console.info("========================================");
  console.info("WEBHOOK IDENTITY REGRESSION TEST");
  console.info("========================================");

  try {
    await testSameIntegrationIdentity();
    await testExistingLegacyEvent();
    await testCrossIntegrationIdentity();
    await testConcurrentLinkedRegistrations();
    await testLegacyVersusLinkedOwnership();
    await testIntakeTransactionRollback();

    console.info("----------------------------------------");
    console.info(`Passed: ${passed}`);
    console.info(`Skipped: ${skipped}`);
    console.info("RESULT: PASSED");
  } finally {
    try {
      await cleanup();
      console.info("[CLEANUP] Test-owned database records removed.");
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch((error: unknown) => {
  console.error("[FAIL] Webhook identity regression test failed.");
  console.error(error);
  process.exitCode = 1;
});
