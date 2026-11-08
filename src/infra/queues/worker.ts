
import {
  Worker,
  UnrecoverableError,
  type Job,
} from "bullmq";

import { redisConnection } from "./redis.js";

import { JOB_NAMES } from "./contracts/job-names.js";

import {
  testConnectionSchema,
  webhookQueueDataSchema,
} from "./contracts/job-schemas.js";

import type { QueueJobData } from "./contracts/job-types.js";

import { syncLogRepository } from "../../shared/repositories/sync-log.repository.js";
import { prisma } from "../../shared/utils/db.js";

import { executeWebhookHandler } from "./handlers/handler-registry.js";

// Import handler registrations before processing jobs.
import "./handlers/index.js";

import {
  idempotencyRepository,
  IDEMPOTENCY_LEASE_DURATION_MS,
  IDEMPOTENCY_LEASE_RENEW_INTERVAL_MS,
} from "../../shared/repositories/idempotency.repository.js";

import { WebhookStatus } from "@prisma/client";

import {
  getWebhookIdempotencyScope,
  getIntegrationWebhookIdempotencyScope,
} from "../../core/webhooks/idempotency-scope.js";

const QUEUE_NAME = "integration-sync-queue";

async function processJob(job: Job<QueueJobData>) {
  switch (job.name) {
    case JOB_NAMES.TEST_CONNECTION: {
      const payload = testConnectionSchema.parse(job.data);

      console.info(
        "[Worker] Connection test:",
        payload.message,
      );

      return {
        success: true,
        message: "Connection test completed.",
      };
    }

    case JOB_NAMES.PROCESS_WEBHOOK_EVENT: {
      const queueData = webhookQueueDataSchema.parse(job.data);
      const payload = queueData.payload;

      const {
        syncLogId,
        idempotencyRecordId,
        leaseToken,
      } = queueData;

      let idempotencyScope: string | null = null;

      try {
        // Atomically validate integration identity and acquire execution ownership.
        idempotencyScope = await prisma.$transaction(
          async (tx): Promise<string | null> => {
            const now = new Date();

            // 1. Verify that the integration belongs to this tenant.
            const tenantIntegration =
              await tx.tenantIntegrationConfig.findFirst({
                where: {
                  id: payload.integrationId,
                  tenantId: payload.tenantId,
                  systemName: payload.source,
                  isActive: true,
                },
                select: {
                  id: true,
                  systemName: true,
                },
              });

            if (!tenantIntegration) {
              await tx.syncLog.updateMany({
                where: {
                  id: syncLogId,
                  tenantId: payload.tenantId,
                  webhookEventId: payload.webhookEventId,
                  status: {
                    in: ["PENDING", "PROCESSING"],
                  },
                },
                data: {
                  status: "SUPERSEDED",
                  finishedAt: now,
                  errorMessage:
                    "Job superseded: integration does not belong to the specified tenant or is inactive.",
                },
              });

              return null;
            }

            // Resolve supported scopes only from the verified integration.
            const allowedIdempotencyScopes = [
              getWebhookIdempotencyScope(tenantIntegration.systemName),
              getIntegrationWebhookIdempotencyScope(
                tenantIntegration.systemName,
                tenantIntegration.id,
              ),
            ];

            // Verify that the webhook event belongs to this exact integration.
            const webhookEvent = await tx.webhookEvent.findFirst({
              where: {
                id: payload.webhookEventId,
                tenantId: payload.tenantId,
                source: tenantIntegration.systemName,
              },
              select: {
                integrationId: true,
              },
            });

            if (
              !webhookEvent ||
              webhookEvent.integrationId !== tenantIntegration.id
            ) {
              await tx.syncLog.updateMany({
                where: {
                  id: syncLogId,
                  tenantId: payload.tenantId,
                  webhookEventId: payload.webhookEventId,
                  status: {
                    in: ["PENDING", "PROCESSING"],
                  },
                },
                data: {
                  status: "SUPERSEDED",
                  finishedAt: now,
                  errorMessage:
                    "Job superseded: webhook event does not belong to the verified integration.",
                },
              });

              return null;
            }

            // Lock the idempotency record and retrieve its actual scope.
            // This supports both legacy jobs and new account-specific jobs.
            const ownership = await tx.$queryRaw<
              Array<{ id: string; scope: string }>
            >`
              SELECT "id", "scope"
              FROM "IdempotencyRecord"
              WHERE
                "id" = ${idempotencyRecordId}
                AND "tenantKey" = ${payload.tenantId}
                AND "status" = 'PROCESSING'
                AND "leaseToken" = ${leaseToken}
                AND "leaseExpiresAt" > ${now}
              FOR UPDATE
            `;

            const ownershipRecord = ownership[0];

            if (
              !ownershipRecord ||
              !allowedIdempotencyScopes.includes(ownershipRecord.scope)
            ) {
              await tx.syncLog.updateMany({
                where: {
                  id: syncLogId,
                  tenantId: payload.tenantId,
                  webhookEventId: payload.webhookEventId,
                  status: {
                    in: ["PENDING", "PROCESSING"],
                  },
                },
                data: {
                  status: "SUPERSEDED",
                  finishedAt: now,
                  errorMessage:
                    "Job superseded: idempotency lease or integration scope is invalid.",
                },
              });

              return null;
            }

            const verifiedIdempotencyScope = ownershipRecord.scope;

            // 3. Extend the lease before releasing the row lock.
            const leaseExtension =
              await tx.idempotencyRecord.updateMany({
                where: {
                  id: idempotencyRecordId,
                  tenantKey: payload.tenantId,
                  scope: verifiedIdempotencyScope,
                  status: "PROCESSING",
                  leaseToken,
                  leaseExpiresAt: {
                    gt: now,
                  },
                },
                data: {
                  leaseExpiresAt: new Date(
                    now.getTime() +
                      IDEMPOTENCY_LEASE_DURATION_MS,
                  ),
                },
              });

            if (leaseExtension.count !== 1) {
              return null;
            }

            // 4. Retrieve the current SyncLog state.
            const existingSyncLog =
              await tx.syncLog.findFirst({
                where: {
                  id: syncLogId,
                  tenantId: payload.tenantId,
                  webhookEventId: payload.webhookEventId,
                  status: {
                    in: ["PENDING", "PROCESSING"],
                  },
                },
                select: {
                  status: true,
                  startedAt: true,
                },
              });

            if (!existingSyncLog) {
              return null;
            }

            // 5. Transition this execution to PROCESSING.
            const syncLogUpdate =
              await tx.syncLog.updateMany({
                where: {
                  id: syncLogId,
                  tenantId: payload.tenantId,
                  webhookEventId: payload.webhookEventId,
                  status: {
                    in: ["PENDING", "PROCESSING"],
                  },
                },
                data: {
                  status: "PROCESSING",
                  attemptCount: job.attemptsMade + 1,
                  startedAt:
                    existingSyncLog.startedAt ?? now,
                  finishedAt: null,
                  durationMs: null,
                  errorMessage: null,
                  errorStack: null,
                },
              });

            if (syncLogUpdate.count !== 1) {
              return null;
            }

            const isRetryOfSameExecution =
              job.attemptsMade > 0 &&
              existingSyncLog.status === "PROCESSING";

            const allowedWebhookStatuses: WebhookStatus[] =
              isRetryOfSameExecution
                ? [WebhookStatus.PROCESSING]
                : [WebhookStatus.RECEIVED];

            const webhookUpdate =
              await tx.webhookEvent.updateMany({
                where: {
                  id: payload.webhookEventId,
                  tenantId: payload.tenantId,
                  source: payload.source,
                  status: {
                    in: allowedWebhookStatuses,
                  },
                },
                data: {
                  status: "PROCESSING",
                  errorMessage: null,
                },
              });

            if (webhookUpdate.count !== 1) {
              await tx.syncLog.updateMany({
                where: {
                  id: syncLogId,
                  tenantId: payload.tenantId,
                  webhookEventId: payload.webhookEventId,
                  status: "PROCESSING",
                },
                data: {
                  status: "SUPERSEDED",
                  finishedAt: now,
                  errorMessage:
                    "Job superseded: webhook event is already claimed by another execution or is no longer available.",
                },
              });

              return null;
            }

            return verifiedIdempotencyScope;
          },
        );

        // Narrow the nullable scope before using it in subsequent operations.
        if (idempotencyScope === null) {
          console.warn(
            `[Worker] Job ${job.id} cannot start: ownership or execution state is no longer valid.`,
          );

          throw new UnrecoverableError(
            "Job superseded: ownership or execution state is no longer valid.",
          );
        }

        const verifiedIdempotencyScope = idempotencyScope;

        // Keep the idempotency lease alive during long-running execution.
        let leaseLost = false;
        let renewalTask: Promise<void> | null = null;

        const heartbeat = setInterval(() => {
          // Prevent overlapping renewal requests.
          if (renewalTask) {
            return;
          }

          renewalTask = (async () => {
            try {
              const renewed = await idempotencyRepository.renewLease(
                idempotencyRecordId,
                leaseToken,
                payload.tenantId,
                verifiedIdempotencyScope,
              );

              if (!renewed) {
                leaseLost = true;

                console.error(
                  `[Worker] Lost idempotency lease for job ${job.id}.`,
                );
              }
            } catch (renewalError) {
              leaseLost = true;

              console.error(
                `[Worker] Lease renewal failed for job ${job.id}:`,
                renewalError,
              );
            }
          })().finally(() => {
            renewalTask = null;
          });
        }, IDEMPOTENCY_LEASE_RENEW_INTERVAL_MS);

        let result: Awaited<
          ReturnType<typeof executeWebhookHandler>
        >;

        try {
          // Execute the registered generic webhook handler.
          result = await executeWebhookHandler(payload);
        } finally {
          // Stop future heartbeat requests when execution finishes.
          clearInterval(heartbeat);

          // Wait for any ongoing renewal request.
          const pendingRenewal = renewalTask;

          if (pendingRenewal) {
            await pendingRenewal;
          }
        }

        // Never finalize successfully if ownership was lost.
        if (leaseLost) {
          throw new Error(
            "Cannot complete webhook: idempotency lease renewal failed.",
          );
        }

        // Finalize all successful records atomically.
        const completed = await prisma.$transaction(
          async (tx) => {
            const finishedAt = new Date();

            const claim =
              await tx.idempotencyRecord.updateMany({
                where: {
                  id: idempotencyRecordId,
                  tenantKey: payload.tenantId,
                  scope: verifiedIdempotencyScope,
                  status: "PROCESSING",
                  leaseToken,
                  leaseExpiresAt: {
                    gt: finishedAt,
                  },
                },
                data: {
                  status: "COMPLETED",
                  result: JSON.parse(
                    JSON.stringify(result ?? null),
                  ),
                  errorMessage: null,
                  completedAt: finishedAt,
                  leaseExpiresAt: null,
                  leaseToken: null,
                },
              });

            // Ownership was lost. Roll back this transaction.
            if (claim.count !== 1) {
              return null;
            }

            const webhookUpdate =
              await tx.webhookEvent.updateMany({
                where: {
                  id: payload.webhookEventId,
                  tenantId: payload.tenantId,
                  source: payload.source,
                  status: "PROCESSING",
                },
                data: {
                  status: "PROCESSED",
                  processedAt: finishedAt,
                  errorMessage: null,
                },
              });

            if (webhookUpdate.count !== 1) {
              throw new Error(
                `Unable to mark WebhookEvent ${payload.webhookEventId} as PROCESSED.`,
              );
            }

            // Finalize SyncLog in the same transaction.
            const syncLog = await tx.syncLog.findFirst({
              where: {
                id: syncLogId,
                tenantId: payload.tenantId,
                webhookEventId: payload.webhookEventId,
                status: "PROCESSING",
              },
              select: {
                startedAt: true,
              },
            });

            if (!syncLog) {
              throw new Error(
                `SyncLog ${syncLogId} does not belong to the expected tenant or is not PROCESSING.`,
              );
            }

            const syncLogUpdate =
              await tx.syncLog.updateMany({
                where: {
                  id: syncLogId,
                  tenantId: payload.tenantId,
                  webhookEventId: payload.webhookEventId,
                  status: "PROCESSING",
                },
                data: {
                  status: "SUCCESS",
                  finishedAt,
                  durationMs: syncLog.startedAt
                    ? finishedAt.getTime() -
                      syncLog.startedAt.getTime()
                    : null,
                  errorMessage: null,
                  errorStack: null,
                },
              });

            if (syncLogUpdate.count !== 1) {
              throw new Error(
                `Unable to mark SyncLog ${syncLogId} as SUCCESS.`,
              );
            }

            return true;
          },
        );

        if (!completed) {
          throw new Error(
            "Could not complete webhook: idempotency ownership was lost or expired.",
          );
        }

        return {
          success: true,
          result,
        };
      } catch (error) {
        const normalizedError =
          error instanceof Error
            ? error
            : new Error(String(error));

        const maxAttempts = job.opts.attempts ?? 1;

        // attemptsMade is zero-based while the processor is running.
        const isFinalAttempt =
          job.attemptsMade + 1 >= maxAttempts;

        // Superseded jobs must never be retried.
        if (normalizedError instanceof UnrecoverableError) {
          throw normalizedError;
        }

        if (
          isFinalAttempt &&
          idempotencyScope !== null
        ) {
          const finalizationScope = idempotencyScope;

          try {
            const finalizationResult =
              await prisma.$transaction(
                async (tx) => {
                  const finishedAt = new Date();

                  const failedClaim =
                    await tx.idempotencyRecord.updateMany({
                      where: {
                        id: idempotencyRecordId,
                        tenantKey: payload.tenantId,
                        scope: finalizationScope,
                        status: "PROCESSING",
                        leaseToken,
                        leaseExpiresAt: {
                          gt: finishedAt,
                        },
                      },
                      data: {
                        status: "FAILED",
                        errorMessage: normalizedError.message,
                        leaseExpiresAt: null,
                        leaseToken: null,
                      },
                    });

                  // This worker no longer owns the lease.
                  // Only update its own SyncLog.
                  if (failedClaim.count !== 1) {
                    await tx.syncLog.updateMany({
                      where: {
                        id: syncLogId,
                        tenantId: payload.tenantId,
                        webhookEventId:
                          payload.webhookEventId,
                        status: {
                          in: ["PENDING", "PROCESSING"],
                        },
                      },
                      data: {
                        status: "SUPERSEDED",
                        finishedAt,
                        errorMessage:
                          "Execution superseded: idempotency lease is no longer owned by this worker.",
                        ...(normalizedError.stack !== undefined
                          ? {
                              errorStack:
                                normalizedError.stack,
                            }
                          : {}),
                      },
                    });

                    return "SUPERSEDED" as const;
                  }

                  // Only the current lease owner may fail the webhook.
                  const webhookUpdate =
                    await tx.webhookEvent.updateMany({
                      where: {
                        id: payload.webhookEventId,
                        tenantId: payload.tenantId,
                        source: payload.source,
                        status: "PROCESSING",
                      },
                      data: {
                        status: "FAILED",
                        errorMessage:
                          normalizedError.message,
                      },
                    });

                  if (webhookUpdate.count !== 1) {
                    throw new Error(
                      `Unable to mark WebhookEvent ${payload.webhookEventId} as FAILED.`,
                    );
                  }

                  const syncLog =
                    await tx.syncLog.findFirst({
                      where: {
                        id: syncLogId,
                        tenantId: payload.tenantId,
                        webhookEventId:
                          payload.webhookEventId,
                        status: {
                          in: ["PENDING", "PROCESSING"],
                        },
                      },
                      select: {
                        startedAt: true,
                      },
                    });

                  if (!syncLog) {
                    throw new Error(
                      `SyncLog ${syncLogId} does not belong to the expected tenant or is no longer available for failure finalization.`,
                    );
                  }

                  const syncLogUpdate =
                    await tx.syncLog.updateMany({
                      where: {
                        id: syncLogId,
                        tenantId: payload.tenantId,
                        webhookEventId:
                          payload.webhookEventId,
                        status: {
                          in: ["PENDING", "PROCESSING"],
                        },
                      },
                      data: {
                        status: "FAILED",
                        finishedAt,
                        durationMs: syncLog.startedAt
                          ? finishedAt.getTime() -
                            syncLog.startedAt.getTime()
                          : null,
                        errorMessage:
                          normalizedError.message,
                        ...(normalizedError.stack !== undefined
                          ? {
                              errorStack:
                                normalizedError.stack,
                            }
                          : {}),
                      },
                    });

                  if (syncLogUpdate.count !== 1) {
                    throw new Error(
                      `Unable to mark SyncLog ${syncLogId} as FAILED.`,
                    );
                  }

                  return "FAILED" as const;
                },
              );

            if (finalizationResult === "SUPERSEDED") {
              console.warn(
                `[Worker] Job ${job.id} lost ownership. Its SyncLog was marked SUPERSEDED.`,
              );
            }
          } catch (finalizationError) {
            console.error(
              "[Worker] Could not finalize webhook failure:",
              finalizationError,
            );
          }
        } else {
          console.warn(
            `[Worker] Retrying job ${job.id}: ` +
              `${job.attemptsMade + 1}/${maxAttempts}`,
          );
        }

        throw normalizedError;
      }
    }

    default:
      throw new Error(
        `Unsupported job name: ${job.name}`,
      );
  }
}

export const integrationWorker =
  new Worker<QueueJobData>(
    QUEUE_NAME,
    processJob,
    {
      connection: redisConnection,
      concurrency: 5,
    },
  );

// Database finalization is handled inside processJob transactions.
integrationWorker.on("completed", (job) => {
  console.info(
    `[Worker] Completed job: ${job.id}`,
  );
});

// Only logs the failure. Database state is handled by processJob.
integrationWorker.on("failed", (job, error) => {
  if (!job) {
    console.error(
      "[Worker] Failed job without job information:",
      error,
    );
    return;
  }

  console.error(
    `[Worker] Job failed: ${job.id}`,
    error.message,
  );
});

integrationWorker.on("error", (error) => {
  console.error("[Worker] Worker error:", error);
});

console.info("[Worker] Integration worker is running.");
