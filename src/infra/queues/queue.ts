
import { Queue, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { redisConnection } from "./redis.js";

import {
  JOB_NAMES,
  type JobName,
} from "./contracts/job-names.js";

import {
  testConnectionSchema,
  processWebhookEventSchema,
} from "./contracts/job-schemas.js";

import type {
  JobPayload,
  QueueJobData,
} from "./contracts/job-types.js";

import { syncLogRepository } from "../../shared/repositories/sync-log.repository.js";
import { idempotencyRepository } from "../../shared/repositories/idempotency.repository.js";

const QUEUE_NAME = "integration-sync-queue";

// One shared queue instance for all integration jobs.
export const integrationQueue = new Queue<QueueJobData>(
  QUEUE_NAME,
  {
    connection: redisConnection,

    defaultJobOptions: {
      attempts: 3,

      backoff: {
        type: "exponential",
        delay: 2000,
      },

      removeOnComplete: true,
      removeOnFail: false,
    },
  },
);

export interface DispatchSyncJobResult {
  job: Job<QueueJobData>;
  syncLogId: string | null;
}

// Required ownership information for webhook jobs.
export interface WebhookDispatchOptions {
  idempotencyRecordId: string;
  leaseToken: string;
  scope: string;
  jobId?: string;
}

// Generic queue dispatcher.
// Provider-specific business logic does not belong in this function.
export async function dispatchSyncJob<T extends JobName>(
  jobName: T,
  payload: JobPayload<T>,
  options?: WebhookDispatchOptions,
): Promise<DispatchSyncJobResult> {
  // Simple connection test jobs do not require tenant SyncLogs.
  if (jobName === JOB_NAMES.TEST_CONNECTION) {
    const validatedPayload = testConnectionSchema.parse(payload);

    const job = await integrationQueue.add(
      jobName,
      validatedPayload,
    );

    return {
      job,
      syncLogId: null,
    };
  }

  if (jobName === JOB_NAMES.PROCESS_WEBHOOK_EVENT) {
    const validatedPayload =
      processWebhookEventSchema.parse(payload);

    // Webhook jobs must have a valid idempotency owner.
    if (
      !options?.idempotencyRecordId ||
      !options.leaseToken ||
      !options.scope.trim()
    ) {
      throw new Error(
        "Webhook jobs require idempotencyRecordId, leaseToken, and scope.",
      );
    }

    const syncLogId = randomUUID();

    const syncLog = await syncLogRepository.createPending({
      id: syncLogId,
      tenantId: validatedPayload.tenantId,
      jobId: syncLogId,
      jobName,
      correlationId: validatedPayload.correlationId,
      source: validatedPayload.source,
      target: "INTERNAL_HANDLER",
      webhookEventId: validatedPayload.webhookEventId,
      payload: JSON.parse(
        JSON.stringify(validatedPayload),
      ) as Prisma.InputJsonValue,
    });

    try {
      const job = await integrationQueue.add(
        jobName,
        {
          syncLogId: syncLog.id,
          idempotencyRecordId: options.idempotencyRecordId,
          leaseToken: options.leaseToken,
          payload: validatedPayload,
        },
        {
          jobId: options.jobId ?? syncLog.id,
        },
      );

      return {
        job,
        syncLogId: syncLog.id,
      };
    } catch (error) {
      const normalizedError =
        error instanceof Error
          ? error
          : new Error(String(error));

      // Release idempotency ownership if queue dispatch fails.
      try {
        await idempotencyRepository.markFailed(
          options.idempotencyRecordId,
          options.leaseToken,
          validatedPayload.tenantId,
          options.scope,
          normalizedError,
        );
      } catch (idempotencyError) {
        console.error(
          "[Queue] Could not mark idempotency record as failed:",
          idempotencyError,
        );
      }

      // Keep the SyncLog consistent with the dispatch failure.
      try {
        await syncLogRepository.markFailed(
          syncLog.id,
          validatedPayload.tenantId,
          normalizedError,
        );
      } catch (syncLogError) {
        console.error(
          "[Queue] Could not mark SyncLog as failed:",
          syncLogError,
        );
      }

      throw normalizedError;
    }
  }

  throw new Error(`Unsupported job name: ${jobName}`);
}
