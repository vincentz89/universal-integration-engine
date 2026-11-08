
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { idempotencyRepository } from "../../shared/repositories/idempotency.repository.js";
import { outboxRepository } from "../../shared/repositories/outbox.repository.js";
import { prisma } from "../../shared/utils/db.js";

import { processWebhookEventSchema } from "./contracts/job-schemas.js";

import {
  getWebhookIdempotencyScope,
  getWebhookSystemNameFromScope,
  getWebhookIntegrationIdFromScope,
} from "../../core/webhooks/idempotency-scope.js";

import {
  getRecoveryAdapter,
  getRegisteredRecoverySources,
} from "./recovery/recovery-adapter-registry.js";
import "./recovery/index.js";

const RECOVERY_JOB_NAME = "PROCESS_WEBHOOK_EVENT";
const BATCH_SIZE = 100;
const QUEUE_NAME = "integration-sync-queue";

class PermanentRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentRecoveryError";
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

type RecoveryResult =
  | "RECOVERED"
  | "SKIPPED";


async function recoverRecord(
  record: {
    id: string;
    tenantKey: string;
    scope: string;
    idempotencyKey: string;
    jobName: string;
    requestHash: string | null;
    leaseToken: string | null;
  },
): Promise<RecoveryResult> {
  const source = getWebhookSystemNameFromScope(record.scope);

  if (
    !source ||
    record.jobName !== RECOVERY_JOB_NAME ||
    typeof record.requestHash !== "string" ||
    record.requestHash.length === 0
  ) {
    return "SKIPPED";
  }

  // Resolve the provider-specific recovery adapter.
  const recoveryAdapter = getRecoveryAdapter(source);

  if (!recoveryAdapter) {
    return "SKIPPED";
  }

  const requestHash = record.requestHash;
  const newLeaseToken = randomUUID();

  return prisma.$transaction(async (tx) => {
    // 1. Atomically claim the expired lease before performing additional reads.
    const claimedRecord =
      await idempotencyRepository.claimExpiredLeaseInTransaction(
        tx,
        {
          id: record.id,
          tenantKey: record.tenantKey,
          scope: record.scope,
          requestHash,
          currentLeaseToken: record.leaseToken,
          newLeaseToken,
        },
      );

    if (!claimedRecord) {
      return "SKIPPED";
    }

    // 2. Resolve the integration identity from the idempotency scope.
    const scopedIntegrationId =
      getWebhookIntegrationIdFromScope(record.scope);

    // Legacy provider-level scopes cannot prove which integration owns
    // the event. Preserve the record and prevent unsafe automatic recovery.
    if (!scopedIntegrationId) {
      throw new PermanentRecoveryError(
        `Legacy webhook idempotency record ${record.id} has no integration-specific scope. ` +
        "Automatic recovery cannot safely determine the original integration.",
      );
    }

    // 3. Load only the event owned by the exact integration in the scope.
    const webhookEvent = await tx.webhookEvent.findFirst({
      where: {
        tenantId: record.tenantKey,
        source,
        externalEventId: record.idempotencyKey,
        integrationId: scopedIntegrationId,
      },
    });

    if (!webhookEvent) {
      throw new PermanentRecoveryError(
        `Integration-owned WebhookEvent not found for idempotency record ${record.id}.`,
      );
    }

    // Verify the stored ownership before resolving the integration.
    if (webhookEvent.integrationId !== scopedIntegrationId) {
      throw new PermanentRecoveryError(
        `WebhookEvent ${webhookEvent.id} does not match the integration in its idempotency scope.`,
      );
    }

    const integration = await tx.tenantIntegrationConfig.findFirst({
      where: {
        id: webhookEvent.integrationId,
        tenantId: record.tenantKey,
        systemName: source,
        isActive: true,
      },
      select: {
        id: true,
      },
    });

    if (!integration) {
      throw new Error(
        `Active ${source} integration ${webhookEvent.integrationId} ` +
        `not found for webhook event ${webhookEvent.id}.`,
      );
    }

    if (!isRecord(webhookEvent.payload)) {
      throw new PermanentRecoveryError(
        `Invalid stored webhook payload for event ${webhookEvent.id}.`,
      );
    }

    const correlationId =
      webhookEvent.correlationId ?? randomUUID();

    // 4. Reconstruct the original worker payload using the provider adapter.
    const jobPayload = recoveryAdapter.buildPayload({
      tenantId: record.tenantKey,
      integrationId: integration.id,
      webhookEventId: webhookEvent.id,
      correlationId,
      eventType: webhookEvent.eventType,
      payload: webhookEvent.payload,
    });

    const parsedPayload =
      processWebhookEventSchema.safeParse(jobPayload);

    if (!parsedPayload.success) {
      throw new PermanentRecoveryError(
        `Invalid recovered webhook payload: ${parsedPayload.error.message}`,
      );
    }

    // 5. If the event was already processed, complete this lease.
    if (webhookEvent.status === "PROCESSED") {
      const completed = await tx.idempotencyRecord.updateMany({
        where: {
          id: claimedRecord.id,
          tenantKey: record.tenantKey,
          scope: record.scope,
          status: "PROCESSING",
          leaseToken: newLeaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: "COMPLETED",
          result: {
            recoveredFromProcessedEvent: true,
            webhookEventId: webhookEvent.id,
          },
          completedAt: new Date(),
          leaseExpiresAt: null,
          leaseToken: null,
          errorMessage: null,
        },
      });

      if (completed.count !== 1) {
        throw new Error(
          "Could not finalize already-processed webhook.",
        );
      }

      return "SKIPPED";
    }

    // 6. Supersede previous unfinished SyncLogs for this event.
    await tx.syncLog.updateMany({
      where: {
        webhookEventId: webhookEvent.id,
        jobName: RECOVERY_JOB_NAME,
        status: {
          in: ["PENDING", "PROCESSING"],
        },
      },
      data: {
        status: "SUPERSEDED",
        finishedAt: new Date(),
        errorMessage: "Superseded by autonomous webhook recovery.",
      },
    });

    // 7. Reset the webhook event for processing.
    await tx.webhookEvent.update({
      where: {
        id: webhookEvent.id,
      },
      data: {
        status: "RECEIVED",
        correlationId,
        errorMessage: null,
        processedAt: null,
      },
    });

    // 8. Create the replacement SyncLog.
    const syncLogId = randomUUID();

    await tx.syncLog.create({
      data: {
        id: syncLogId,
        tenantId: record.tenantKey,
        jobId: syncLogId,
        jobName: RECOVERY_JOB_NAME,
        queueName: QUEUE_NAME,
        source,
        target: "INTERNAL_HANDLER",
        correlationId,
        webhookEventId: webhookEvent.id,
        status: "PENDING",
        attemptCount: 0,
        payload: parsedPayload.data as Prisma.InputJsonValue,
      },
    });

    // 9. Create the replacement OutboxEvent.
    const outboxPayload = {
      jobName: RECOVERY_JOB_NAME,
      jobData: {
        syncLogId,
        idempotencyRecordId: claimedRecord.id,
        leaseToken: newLeaseToken,
        payload: parsedPayload.data,
      },
    } as Prisma.InputJsonValue;

    await outboxRepository.create(tx, {
      eventType: "QUEUE_JOB_DISPATCH",
      aggregateType: "WebhookEvent",
      aggregateId: webhookEvent.id,
      deduplicationKey:
        `webhook:${claimedRecord.id}:attempt:${claimedRecord.attemptCount}`,
      payload: outboxPayload,
    });

    return "RECOVERED";
  });
}


export async function recoverExpiredWebhookJobs(
  options: {
    tenantKey?: string;
    limit?: number;
  } = {},
) {
  const registeredSources = getRegisteredRecoverySources();

  const supportedScopes = registeredSources.map(
    getWebhookIdempotencyScope,
  );

  const supportedIntegrationScopePrefixes =
    registeredSources.map(
      (source) => `WEBHOOK:${source}:INTEGRATION:`,
    );

  const expiredRecords =
    await idempotencyRepository.findExpiredWebhookRecoveryRecords(
      options.limit ?? BATCH_SIZE,
      options.tenantKey,
      supportedScopes,
      supportedIntegrationScopePrefixes,
    );

  let recovered = 0;
  let skipped = 0;
  let failed = 0;

    for (const record of expiredRecords) {
    try {
      const result = await recoverRecord(record);

      if (result === "RECOVERED") {
        recovered++;

        console.info(
          `[Recovery] Recovered webhook idempotency record ${record.id}.`,
        );
      } else {
        skipped++;
      }
    } catch (error) {
      failed++;

      const recoveryError =
        error instanceof Error
          ? error
          : new Error(String(error));

      try {
        const failureRecorded =
          recoveryError instanceof PermanentRecoveryError
            ? await idempotencyRepository.blockRecoveryPermanently({
                id: record.id,
                tenantKey: record.tenantKey,
                scope: record.scope,
                leaseToken: record.leaseToken,
                expectedRecoveryAttemptCount: record.recoveryAttemptCount,
                error: recoveryError,
              })
            : await idempotencyRepository.recordRecoveryFailure({
                id: record.id,
                tenantKey: record.tenantKey,
                scope: record.scope,
                leaseToken: record.leaseToken,
                expectedRecoveryAttemptCount: record.recoveryAttemptCount,
                error: recoveryError,
              });

        if (!failureRecorded) {
          console.warn(
            `[Recovery] Failure tracking skipped because record ${record.id} changed ownership or retry state.`,
          );
        } else if (recoveryError instanceof PermanentRecoveryError) {
          console.warn(
            `[Recovery] Permanently quarantined record ${record.id}.`,
          );
        }
      } catch (trackingError) {
        console.error(
          `[Recovery] Could not persist failure tracking for record ${record.id}:`,
          trackingError,
        );
      }

      console.error(
        `[Recovery] Could not recover record ${record.id}:`,
        recoveryError,
      );
    }
  }

  return {
    scanned: expiredRecords.length,
    recovered,
    skipped,
    failed,
  };
}
