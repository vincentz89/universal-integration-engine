import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db.js";

type AcquireIdempotencyInput = {
  tenantKey: string;
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  jobId: string;
  leaseDurationMs?: number;
};

type AcquireIdempotencyResult =
  | { acquired: true; jobId: string }
  | { acquired: false; status: "COMPLETED" }
  | { acquired: false; status: "PROCESSING" };

export class IdempotencyService {
  // Atomically acquire a new operation or reclaim an expired/failed operation.
  async acquire(
    input: AcquireIdempotencyInput
  ): Promise<AcquireIdempotencyResult> {
    const now = new Date();
    const leaseDurationMs = input.leaseDurationMs ?? 60_000;
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const uniqueWhere = {
      tenantKey_scope_idempotencyKey: {
        tenantKey: input.tenantKey,
        scope: input.scope,
        idempotencyKey: input.idempotencyKey,
      },
    };

    try {
      const record = await prisma.idempotencyRecord.create({
        data: {
          tenantKey: input.tenantKey,
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          jobName: input.scope,
          jobId: input.jobId,
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: now,
          leaseExpiresAt,
        },
      });

      return { acquired: true, jobId: input.jobId };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
    }

    const existing = await prisma.idempotencyRecord.findUnique({
      where: uniqueWhere,
    });

    if (!existing) {
      throw new Error("Unable to retrieve idempotency record after conflict.");
    }

    // A key must never be reused for a different logical request.
    if (existing.requestHash !== input.requestHash) {
      throw new Error(
        "Idempotency key conflict: the request payload does not match the original operation."
      );
    }

    if (existing.status === "COMPLETED") {
      return { acquired: false, status: "COMPLETED" };
    }

    if (
      existing.status === "PROCESSING" &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt > now
    ) {
      return { acquired: false, status: "PROCESSING" };
    }

    // Reclaim failed operations or processing records with expired leases.
    const reclaimed = await prisma.idempotencyRecord.updateMany({
      where: {
        id: existing.id,
        requestHash: input.requestHash,
        OR: [
          { status: "FAILED" },
          {
            status: "PROCESSING",
            leaseExpiresAt: { lte: now },
          },
        ],
      },
      data: {
        status: "PROCESSING",
        jobId: input.jobId,
        attemptCount: { increment: 1 },
        startedAt: now,
        completedAt: null,
        leaseExpiresAt,
        errorMessage: null,
      },
    });

    if (reclaimed.count === 1) {
      return { acquired: true, jobId: input.jobId };
    }

    // Another worker may have acquired the record first.
    const latest = await prisma.idempotencyRecord.findUnique({
      where: uniqueWhere,
    });

    if (latest?.status === "COMPLETED") {
      return { acquired: false, status: "COMPLETED" };
    }

    return { acquired: false, status: "PROCESSING" };
  }

  // Complete an operation only if this worker still owns its lease.
  async markCompleted(
    tenantKey: string,
    scope: string,
    idempotencyKey: string,
    jobId: string,
    result: Prisma.InputJsonValue
  ): Promise<void> {
    const updated = await prisma.idempotencyRecord.updateMany({
      where: {
        tenantKey,
        scope,
        idempotencyKey,
        jobId,
        status: "PROCESSING",
      },
      data: {
        status: "COMPLETED",
        result,
        completedAt: new Date(),
        leaseExpiresAt: null,
        errorMessage: null,
      },
    });

    if (updated.count !== 1) {
      throw new Error(
        "Cannot complete idempotency operation: worker no longer owns the operation."
      );
    }
  }

  // Release the processing state after a failed attempt.
  async markFailed(
    tenantKey: string,
    scope: string,
    idempotencyKey: string,
    jobId: string,
    error: unknown
  ): Promise<void> {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    const updated = await prisma.idempotencyRecord.updateMany({
      where: {
        tenantKey,
        scope,
        idempotencyKey,
        jobId,
        status: "PROCESSING",
      },
      data: {
        status: "FAILED",
        errorMessage: errorMessage.slice(0, 5000),
        leaseExpiresAt: null,
      },
    });

    if (updated.count !== 1) {
      throw new Error(
        "Cannot mark idempotency operation as failed: worker no longer owns the operation."
      );
    }
  }

  // Retrieve operation state for diagnostics and recovery.
  async getStatus(
    tenantKey: string,
    scope: string,
    idempotencyKey: string
  ) {
    return prisma.idempotencyRecord.findUnique({
      where: {
        tenantKey_scope_idempotencyKey: {
          tenantKey,
          scope,
          idempotencyKey,
        },
      },
      select: {
        status: true,
        attemptCount: true,
        startedAt: true,
        completedAt: true,
        leaseExpiresAt: true,
        errorMessage: true,
      },
    });
  }
}

export const idempotencyService = new IdempotencyService();