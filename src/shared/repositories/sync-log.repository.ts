import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db.js";

interface CreatePendingSyncLogInput {
  id: string;
  tenantId: string;
  jobId: string;
  jobName: string;
  correlationId: string;
  source: string;
  target: string;
  webhookEventId: string;
  payload: Prisma.InputJsonValue;
}

class SyncLogRepository {
  // Creates a traceable execution record before dispatching a job.
  async createPending(input: CreatePendingSyncLogInput) {
    return prisma.syncLog.create({
      data: {
        id: input.id,
        tenantId: input.tenantId,
        jobId: input.jobId,
        jobName: input.jobName,
        queueName: "integration-sync-queue",
        source: input.source,
        target: input.target,
        correlationId: input.correlationId,
        webhookEventId: input.webhookEventId,
        status: "PENDING",
        attemptCount: 0,
        payload: input.payload,
      },
    });
  }

  // Records failure only when the SyncLog belongs to the specified tenant.
  async markFailed(
    id: string,
    tenantId: string,
    error: Error,
  ) {
    const finishedAt = new Date();

    const existingLog = await prisma.syncLog.findFirst({
      where: {
        id,
        tenantId,
        status: {
          in: ["PENDING", "PROCESSING"],
        },
      },
      select: {
        startedAt: true,
      },
    });

    if (!existingLog) {
      return { count: 0 };
    }

    return prisma.syncLog.updateMany({
      where: {
        id,
        tenantId,
        status: {
          in: ["PENDING", "PROCESSING"],
        },
      },
      data: {
        status: "FAILED",
        finishedAt,
        durationMs: existingLog.startedAt
          ? finishedAt.getTime() - existingLog.startedAt.getTime()
          : null,
        errorMessage: error.message,
        ...(error.stack !== undefined
          ? { errorStack: error.stack }
          : {}),
      },
    });
  }
}

export const syncLogRepository = new SyncLogRepository();