import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../../../shared/utils/db.js";
import { idempotencyRepository } from "../../../shared/repositories/idempotency.repository.js";
import { outboxRepository } from "../../../shared/repositories/outbox.repository.js";
import type { ProcessWebhookEventDto } from "../../queues/contracts/job-types.js";
import {
  getIntegrationWebhookIdempotencyScope,
} from "../../../core/webhooks/idempotency-scope.js";

import {
  acquireWebhookIdentityLock,
} from "../../../core/webhooks/webhook-identity-lock.js";

interface BigCommerceWebhookIntakeInput {
  tenantId: string;
  integrationId: string;
  externalEventId: string;
  requestHash: string;
  eventType: string;
  resourceType: string;
  resourceId?: string;
  webhookPayload: Prisma.InputJsonValue;
}

export type WebhookIntakeResult =
  | {
      status: "NEW" | "RETRY_CLAIMED";
      webhookEventId: string;
      syncLogId: string;
      outboxEventId: string;
      idempotencyRecordId: string;
    }
  | {
      status: "DUPLICATE";
      webhookEventId?: string;
    }
  | {
      status: "CONFLICT" | "RETRY_REQUIRED";
    };

class LegacyWebhookOwnershipConflictError extends Error {
  constructor() {
    super(
      "Webhook event exists without a verified integration association.",
    );
    this.name = "LegacyWebhookOwnershipConflictError";
  }
}

class BigCommerceWebhookIntakeService {
  private toRecord(
    value: Prisma.InputJsonValue,
  ): Record<string, unknown> {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new Error("Webhook payload must be a JSON object.");
    }

    return value as Record<string, unknown>;
  }

  async register(
    input: BigCommerceWebhookIntakeInput,
  ): Promise<WebhookIntakeResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        // 1. Verify that the integration belongs to this tenant.
        const integration = await tx.tenantIntegrationConfig.findFirst({
          where: {
            id: input.integrationId,
            tenantId: input.tenantId,
            systemName: "BIGCOMMERCE",
            isActive: true,
          },
          select: {
            id: true,
            systemName: true,
          },
        });

        if (!integration) {
          throw new Error(
            "Active BigCommerce integration not found for the specified tenant.",
          );
        }

        // Acquire ownership lock before checking legacy or integration-linked events.
        await acquireWebhookIdentityLock(tx, {
          tenantId: input.tenantId,
          provider: integration.systemName,
          externalEventId: input.externalEventId,
        });

        // Use an idempotency scope isolated to this integration.
        const idempotencyScope =
          getIntegrationWebhookIdempotencyScope(
            integration.systemName,
            integration.id,
          );

        // 2. Reject historical events without verified integration ownership.
        const legacyEvent = await tx.webhookEvent.findFirst({
          where: {
            tenantId: input.tenantId,
            source: integration.systemName,
            externalEventId: input.externalEventId,
            integrationId: null,
          },
          select: {
            id: true,
          },
        });

        if (legacyEvent) {
          return { status: "CONFLICT" };
        }

        // 3. Register or reclaim idempotency ownership.
        const registration =
          await idempotencyRepository.registerInTransaction(tx, {
            tenantKey: input.tenantId,
            scope: idempotencyScope,
            idempotencyKey: input.externalEventId,
            jobName: "PROCESS_WEBHOOK_EVENT",
            requestHash: input.requestHash,
          });

        if (
          registration.status === "CONFLICT" ||
          registration.status === "RETRY_REQUIRED"
        ) {
          return { status: registration.status };
        }

        // Check again after registration to protect against a concurrent
        // legacy event appearing before this transaction proceeds.
        const legacyEventAfterRegistration =
          await tx.webhookEvent.findFirst({
            where: {
              tenantId: input.tenantId,
              source: integration.systemName,
              externalEventId: input.externalEventId,
              integrationId: null,
            },
            select: {
              id: true,
            },
          });

        if (legacyEventAfterRegistration) {
          // Throwing rolls back any newly registered idempotency claim.
          throw new LegacyWebhookOwnershipConflictError();
        }

        // 4. Handle an existing idempotency registration.
        if (registration.status === "DUPLICATE") {
          const duplicateEvent = await tx.webhookEvent.findFirst({
            where: {
              tenantId: input.tenantId,
              source: integration.systemName,
              externalEventId: input.externalEventId,
              integrationId: integration.id,
            },
            select: {
              id: true,
            },
          });

          // Never report a duplicate without confirming the exact
          // integration-owned webhook event.
          if (!duplicateEvent) {
            return { status: "RETRY_REQUIRED" };
          }

          return {
            status: "DUPLICATE",
            webhookEventId: duplicateEvent.id,
          };
        }

        const { recordId, leaseToken } = registration;
        const now = new Date();

        // 5. Retrieve the current attempt number for outbox deduplication.
        const idempotencyRecord =
          await tx.idempotencyRecord.findFirstOrThrow({
            where: {
              id: recordId,
              tenantKey: input.tenantId,
              scope: idempotencyScope,
              status: "PROCESSING",
              leaseToken,
            },
            select: {
              attemptCount: true,
            },
          });

        // 6. Find an event owned by this exact integration.
        const existingEvent = await tx.webhookEvent.findFirst({
          where: {
            tenantId: input.tenantId,
            source: integration.systemName,
            externalEventId: input.externalEventId,
            integrationId: integration.id,
          },
        });

        if (existingEvent?.status === "PROCESSED") {
          // The event was already processed. Complete this new claim.
          const completed = await tx.idempotencyRecord.updateMany({
            where: {
              id: recordId,
              tenantKey: input.tenantId,
              scope: idempotencyScope,
              status: "PROCESSING",
              leaseToken,
              leaseExpiresAt: { gt: now },
            },
            data: {
              status: "COMPLETED",
              completedAt: now,
              leaseExpiresAt: null,
              leaseToken: null,
              errorMessage: null,
            },
          });

          if (completed.count !== 1) {
            throw new Error("Idempotency lease ownership was lost.");
          }

          return {
            status: "DUPLICATE",
            webhookEventId: existingEvent.id,
          };
        }

        const correlationId =
          existingEvent?.correlationId ?? randomUUID();

        const webhookEvent = existingEvent
          ? await tx.webhookEvent.update({
              where: {
                id: existingEvent.id,
              },
              data: {
                eventType: input.eventType,
                status: "RECEIVED",
                payload: input.webhookPayload,
                correlationId,
                errorMessage: null,
                processedAt: null,
              },
            })
          : await tx.webhookEvent.create({
              data: {
                tenantId: input.tenantId,
                source: integration.systemName,
                eventType: input.eventType,
                externalEventId: input.externalEventId,
                status: "RECEIVED",
                payload: input.webhookPayload,
                correlationId,
                integrationId: integration.id,
              },
            });

        // 7. Build the generic worker payload.
        const jobPayload: ProcessWebhookEventDto = {
          tenantId: input.tenantId,
          integrationId: integration.id,
          webhookEventId: webhookEvent.id,
          correlationId,
          source: integration.systemName,
          eventType: input.eventType,
          resourceType: input.resourceType,
          ...(input.resourceId !== undefined
            ? { resourceId: input.resourceId }
            : {}),
          payload: this.toRecord(input.webhookPayload),
        };

        // 8. Create the SyncLog inside this same transaction.
        const syncLogId = randomUUID();

        await tx.syncLog.create({
          data: {
            id: syncLogId,
            tenantId: input.tenantId,
            jobId: syncLogId,
            jobName: "PROCESS_WEBHOOK_EVENT",
            queueName: "integration-sync-queue",
            source: integration.systemName,
            target: "INTERNAL_HANDLER",
            correlationId,
            webhookEventId: webhookEvent.id,
            status: "PENDING",
            attemptCount: 0,
            payload: jobPayload as Prisma.InputJsonValue,
          },
        });

        // 9. Persist the queue-dispatch instruction in the Outbox.
        const outboxPayload = {
          jobName: "PROCESS_WEBHOOK_EVENT",
          jobData: {
            syncLogId,
            idempotencyRecordId: recordId,
            leaseToken,
            payload: jobPayload,
          },
        } as Prisma.InputJsonValue;

        const outboxEvent = await outboxRepository.create(tx, {
          eventType: "QUEUE_JOB_DISPATCH",
          aggregateType: "WebhookEvent",
          aggregateId: webhookEvent.id,
          deduplicationKey:
            `webhook:${recordId}:attempt:${idempotencyRecord.attemptCount}`,
          payload: outboxPayload,
        });

        return {
          status: registration.status,
          webhookEventId: webhookEvent.id,
          syncLogId,
          outboxEventId: outboxEvent.id,
          idempotencyRecordId: recordId,
        };
      });
    } catch (error) {
      if (error instanceof LegacyWebhookOwnershipConflictError) {
        return { status: "CONFLICT" };
      }

      throw error;
    }
  }
}

export const bigCommerceWebhookIntakeService =
  new BigCommerceWebhookIntakeService();