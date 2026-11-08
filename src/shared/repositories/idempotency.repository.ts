
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../utils/db.js";

export const IDEMPOTENCY_LEASE_DURATION_MS = 60_000;
export const IDEMPOTENCY_LEASE_RENEW_INTERVAL_MS = 20_000;

export interface RegisterIdempotencyInput {
  tenantKey: string;
  scope: string;
  idempotencyKey: string;
  jobName: string;
  requestHash: string;
  leaseDurationMs?: number;
}

export type RegistrationResult =
  | { status: "NEW"; recordId: string; leaseToken: string }
  | {
      status: "DUPLICATE";
      recordId: string;
      existingStatus: "PROCESSING" | "COMPLETED";
    }
  | { status: "CONFLICT"; recordId: string }
  | { status: "RETRY_CLAIMED"; recordId: string; leaseToken: string }
  | { status: "RETRY_REQUIRED"; recordId: string };

class IdempotencyRepository {
  createRequestHash(payload: Buffer | string): string {
    return createHash("sha256")
      .update(payload)
      .digest("hex");
  }

    async registerInTransaction(
    tx: Prisma.TransactionClient,
    input: RegisterIdempotencyInput,
  ): Promise<RegistrationResult> {
    const now = new Date();

    const leaseDurationMs =
      input.leaseDurationMs ?? IDEMPOTENCY_LEASE_DURATION_MS;

    const leaseExpiresAt = new Date(
      now.getTime() + leaseDurationMs,
    );

    const leaseToken = randomUUID();
    const candidateRecordId = randomUUID();

    // Create the initial record without aborting the transaction
    // when another request has already registered the same key.
    const created = await tx.idempotencyRecord.createMany({
      data: [
        {
          id: candidateRecordId,
          tenantKey: input.tenantKey,
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
          jobName: input.jobName,
          requestHash: input.requestHash,
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: now,
          leaseExpiresAt,
          leaseToken,
        },
      ],
      skipDuplicates: true,
    });

    if (created.count === 1) {
      return {
        status: "NEW",
        recordId: candidateRecordId,
        leaseToken,
      };
    }

    const existing = await tx.idempotencyRecord.findUniqueOrThrow({
      where: {
        tenantKey_scope_idempotencyKey: {
          tenantKey: input.tenantKey,
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });

    if (existing.requestHash !== input.requestHash) {
      return {
        status: "CONFLICT",
        recordId: existing.id,
      };
    }

    if (existing.recoveryBlockedAt !== null) {
      return {
        status: "RETRY_REQUIRED",
        recordId: existing.id,
      };
    }

    if (existing.status === "COMPLETED") {
      return {
        status: "DUPLICATE",
        recordId: existing.id,
        existingStatus: "COMPLETED",
      };
    }

    if (
      existing.status === "PROCESSING" &&
      existing.leaseExpiresAt !== null &&
      existing.leaseExpiresAt > now
    ) {
      return {
        status: "DUPLICATE",
        recordId: existing.id,
        existingStatus: "PROCESSING",
      };
    }

    const canRecover =
      existing.status === "FAILED" ||
      (
        existing.status === "PROCESSING" &&
        (
          existing.leaseExpiresAt === null ||
          existing.leaseExpiresAt <= now
        )
      );

    if (canRecover) {
      const recoveryToken = randomUUID();

      const claimConditions: Prisma.IdempotencyRecordWhereInput =
        existing.status === "FAILED"
          ? {
              id: existing.id,
              tenantKey: input.tenantKey,
              scope: input.scope,
              status: "FAILED",
              requestHash: input.requestHash,
              recoveryBlockedAt: null,
            }
          : {
              id: existing.id,
              tenantKey: input.tenantKey,
              scope: input.scope,
              status: "PROCESSING",
              requestHash: input.requestHash,
              recoveryBlockedAt: null,
              leaseToken: existing.leaseToken,
              leaseExpiresAt:
                existing.leaseExpiresAt === null
                  ? null
                  : { lte: now },
            };

      const claim = await tx.idempotencyRecord.updateMany({
        where: claimConditions,
        data: {
          status: "PROCESSING",
          attemptCount: {
            increment: 1,
          },
          startedAt: now,
          leaseExpiresAt,
          leaseToken: recoveryToken,
          errorMessage: null,
          completedAt: null,
        },
      });

      if (claim.count === 1) {
        return {
          status: "RETRY_CLAIMED",
          recordId: existing.id,
          leaseToken: recoveryToken,
        };
      }
    }

    const latest = await tx.idempotencyRecord.findFirstOrThrow({
      where: {
        id: existing.id,
        tenantKey: input.tenantKey,
        scope: input.scope,
      },
    });

    if (latest.requestHash !== input.requestHash) {
      return {
        status: "CONFLICT",
        recordId: latest.id,
      };
    }

    if (latest.recoveryBlockedAt !== null) {
      return {
        status: "RETRY_REQUIRED",
        recordId: latest.id,
      };
    }

    if (latest.status === "COMPLETED") {
      return {
        status: "DUPLICATE",
        recordId: latest.id,
        existingStatus: "COMPLETED",
      };
    }

    if (
      latest.status === "PROCESSING" &&
      latest.leaseExpiresAt !== null &&
      latest.leaseExpiresAt > new Date()
    ) {
      return {
        status: "DUPLICATE",
        recordId: latest.id,
        existingStatus: "PROCESSING",
      };
    }

    return {
      status: "RETRY_REQUIRED",
      recordId: latest.id,
    };
  }

  async register(
    input: RegisterIdempotencyInput,
  ): Promise<RegistrationResult> {
    const now = new Date();
    const leaseDurationMs = input.leaseDurationMs ?? IDEMPOTENCY_LEASE_DURATION_MS;
    const leaseExpiresAt = new Date(
      now.getTime() + leaseDurationMs,
    );

    // Each new claim receives a unique ownership token.
    const leaseToken = randomUUID();

    try {
      const record = await prisma.idempotencyRecord.create({
        data: {
          tenantKey: input.tenantKey,
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
          jobName: input.jobName,
          requestHash: input.requestHash,
          recoveryBlockedAt: null,
          status: "PROCESSING",
          attemptCount: 1,
          startedAt: now,
          leaseExpiresAt,
          leaseToken,
        },
      });

      return {
        status: "NEW",
        recordId: record.id,
        leaseToken,
      };
    } catch (error) {
      if (
        !(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
      ) {
        throw error;
      }
    }

    const existing = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        tenantKey_scope_idempotencyKey: {
          tenantKey: input.tenantKey,
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });

    if (existing.requestHash !== input.requestHash) {
      return {
        status: "CONFLICT",
        recordId: existing.id,
      };
    }

    if (existing.status === "COMPLETED") {
      return {
        status: "DUPLICATE",
        recordId: existing.id,
        existingStatus: "COMPLETED",
      };
    }

    if (
      existing.status === "PROCESSING" &&
      existing.leaseExpiresAt !== null &&
      existing.leaseExpiresAt > now
    ) {
      return {
        status: "DUPLICATE",
        recordId: existing.id,
        existingStatus: "PROCESSING",
      };
    }

    // A FAILED record or expired PROCESSING lease can be reclaimed.
    const canRecover =
      existing.status === "FAILED" ||
      (
        existing.status === "PROCESSING" &&
        (
          existing.leaseExpiresAt === null ||
          existing.leaseExpiresAt <= now
        )
      );

    if (canRecover) {
      const recoveryToken = randomUUID();

      const claimConditions =
        existing.status === "FAILED"
          ? {
              id: existing.id,
              tenantKey: input.tenantKey,
              scope: input.scope,
              status: "FAILED" as const,
              requestHash: input.requestHash,
              recoveryBlockedAt: null,
            }
          : {
              id: existing.id,
              tenantKey: input.tenantKey,
              scope: input.scope,
              status: "PROCESSING" as const,
              requestHash: input.requestHash,
              recoveryBlockedAt: null,
              leaseToken: existing.leaseToken,
              leaseExpiresAt:
                existing.leaseExpiresAt === null
                  ? null
                  : { lte: now },
            };

      // Atomic claim: only one concurrent request can acquire ownership.
      const claim = await prisma.idempotencyRecord.updateMany({
        where: claimConditions,
        data: {
          status: "PROCESSING",
          attemptCount: {
            increment: 1,
          },
          startedAt: now,
          leaseExpiresAt,
          leaseToken: recoveryToken,
          errorMessage: null,
          completedAt: null,
        },
      });

      if (claim.count === 1) {
        return {
          status: "RETRY_CLAIMED",
          recordId: existing.id,
          leaseToken: recoveryToken,
        };
      }
    }

    // Another request may have acquired ownership.
    const latest = await prisma.idempotencyRecord.findFirstOrThrow({
      where: {
        id: existing.id,
        tenantKey: input.tenantKey,
        scope: input.scope,
      },
    });

    if (latest.requestHash !== input.requestHash) {
      return {
        status: "CONFLICT",
        recordId: latest.id,
      };
    }

    if (latest.status === "COMPLETED") {
      return {
        status: "DUPLICATE",
        recordId: latest.id,
        existingStatus: "COMPLETED",
      };
    }

    if (
      latest.status === "PROCESSING" &&
      latest.leaseExpiresAt !== null &&
      latest.leaseExpiresAt > new Date()
    ) {
      return {
        status: "DUPLICATE",
        recordId: latest.id,
        existingStatus: "PROCESSING",
      };
    }

    return {
      status: "RETRY_REQUIRED",
      recordId: latest.id,
    };
  }

  //add
  async findExpiredProcessingRecords(
    limit = 100,
    scope?: string,
    tenantKey?: string,
  ) {
    return prisma.idempotencyRecord.findMany({
      where: {
        status: "PROCESSING",
        leaseExpiresAt: { lte: new Date() },
        requestHash: { not: null },
        recoveryBlockedAt: null,
        ...(scope ? { scope } : {}),
        ...(tenantKey ? { tenantKey } : {}),
      },
      orderBy: { leaseExpiresAt: "asc" },
      take: limit,
    });
  }
  //end

    // Find expired webhook jobs whose recovery retry time has arrived.
    // Find expired webhook jobs for registered providers,
  // including legacy provider-level and account-specific scopes.
  async findExpiredWebhookRecoveryRecords(
    limit = 100,
    tenantKey?: string,
    supportedScopes: string[] = [],
    supportedIntegrationScopePrefixes: string[] = [],
  ) {
    if (
      supportedScopes.length === 0 &&
      supportedIntegrationScopePrefixes.length === 0
    ) {
      return [];
    }

    const now = new Date();

    const supportedScopeConditions: Prisma.IdempotencyRecordWhereInput[] = [
      ...(supportedScopes.length > 0
        ? [{ scope: { in: supportedScopes } }]
        : []),
      ...supportedIntegrationScopePrefixes.map((prefix) => ({
        scope: { startsWith: prefix },
      })),
    ];

    return prisma.idempotencyRecord.findMany({
      where: {
        status: "PROCESSING",
        jobName: "PROCESS_WEBHOOK_EVENT",
        leaseExpiresAt: { lte: now },
        requestHash: { not: null },
        recoveryBlockedAt: null,
        AND: [
          {
            OR: supportedScopeConditions,
          },
          {
            OR: [
              { recoveryNextAttemptAt: null },
              { recoveryNextAttemptAt: { lte: now } },
            ],
          },
        ],
        ...(tenantKey ? { tenantKey } : {}),
      },
      orderBy: [
        { recoveryNextAttemptAt: "asc" },
        { leaseExpiresAt: "asc" },
      ],
      take: limit,
    });
  }

  //add
  // Atomically claim an expired lease for autonomous recovery.
  async claimExpiredLeaseInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      id: string;
      tenantKey: string;
      scope: string;
      requestHash: string;
      currentLeaseToken: string | null;
      newLeaseToken: string;
      leaseDurationMs?: number;
    },
  ) {
    const now = new Date();

    const leaseDurationMs =
      input.leaseDurationMs ?? IDEMPOTENCY_LEASE_DURATION_MS;

    const leaseExpiresAt = new Date(
      now.getTime() + leaseDurationMs,
    );

    const claim = await tx.idempotencyRecord.updateMany({
      where: {
        id: input.id,
        tenantKey: input.tenantKey,
        scope: input.scope,
        status: "PROCESSING",
        requestHash: input.requestHash,
        recoveryBlockedAt: null,
        leaseToken: input.currentLeaseToken,
        leaseExpiresAt: {
          lte: now,
        },
      },
      data: {
        leaseToken: input.newLeaseToken,
        leaseExpiresAt,
        attemptCount: {
          increment: 1,
        },
        startedAt: now,
        completedAt: null,
        errorMessage: null,
      },
    });

    if (claim.count !== 1) {
      return null;
    }

    return tx.idempotencyRecord.findUniqueOrThrow({
      where: {
        id: input.id,
      },
    });
  }
  //end

    // Record a failed autonomous recovery attempt and schedule the next retry.
  async recordRecoveryFailure(
    input: {
      id: string;
      tenantKey: string;
      scope: string;
      leaseToken: string | null;
      expectedRecoveryAttemptCount: number;
      error: Error;
    },
  ): Promise<boolean> {
    const now = new Date();

    const nextAttemptCount = input.expectedRecoveryAttemptCount + 1;

    const baseDelayMs = 10_000;
    const maxDelayMs = 5 * 60_000;

    const delayMs = Math.min(
      baseDelayMs * 2 ** (nextAttemptCount - 1),
      maxDelayMs,
    );

    const recoveryNextAttemptAt = new Date(
      now.getTime() + delayMs,
    );

    const update = await prisma.idempotencyRecord.updateMany({
      where: {
        id: input.id,
        tenantKey: input.tenantKey,
        scope: input.scope,
        status: "PROCESSING",
        leaseToken: input.leaseToken,
        leaseExpiresAt: { lte: now },
        recoveryAttemptCount: input.expectedRecoveryAttemptCount,
        OR: [
          { recoveryNextAttemptAt: null },
          { recoveryNextAttemptAt: { lte: now } },
        ],
      },
      data: {
        recoveryAttemptCount: {
          increment: 1,
        },
        recoveryNextAttemptAt,
        recoveryLastError: input.error.message.slice(0, 10_000),
      },
    });

    return update.count === 1;
  }

  // Permanently quarantine records that cannot be safely recovered.
  async blockRecoveryPermanently(
    input: {
      id: string;
      tenantKey: string;
      scope: string;
      leaseToken: string | null;
      expectedRecoveryAttemptCount: number;
      error: Error;
    },
  ): Promise<boolean> {
    const now = new Date();

    const update = await prisma.idempotencyRecord.updateMany({
      where: {
        id: input.id,
        tenantKey: input.tenantKey,
        scope: input.scope,
        status: "PROCESSING",
        leaseToken: input.leaseToken,
        leaseExpiresAt: { lte: now },
        recoveryAttemptCount: input.expectedRecoveryAttemptCount,
        recoveryBlockedAt: null,
        OR: [
          { recoveryNextAttemptAt: null },
          { recoveryNextAttemptAt: { lte: now } },
        ],
      },
      data: {
        recoveryBlockedAt: now,
        recoveryLastError: input.error.message.slice(0, 10_000),
      },
    });

    return update.count === 1;
  }

  //add
  // Extend the lease only while the correct tenant and scope
  // still own an active lease.
  async renewLease(
    id: string,
    leaseToken: string,
    tenantKey: string,
    scope: string,
    leaseDurationMs: number = IDEMPOTENCY_LEASE_DURATION_MS,
  ): Promise<boolean> {
    const now = new Date();

    const update = await prisma.idempotencyRecord.updateMany({
      where: {
        id,
        tenantKey,
        scope,
        status: "PROCESSING",
        leaseToken,
        leaseExpiresAt: {
          gt: now,
        },
      },
      data: {
        leaseExpiresAt: new Date(
          now.getTime() + leaseDurationMs,
        ),
      },
    });

    return update.count === 1;
  }
  //end

    // Only the correct tenant and current lease owner can complete a request.
  async markCompleted(
    id: string,
    leaseToken: string,
    tenantKey: string,
    scope: string,
    result: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const now = new Date();

    const update = await prisma.idempotencyRecord.updateMany({
      where: {
        id,
        tenantKey,
        scope,
        status: "PROCESSING",
        leaseToken,
        leaseExpiresAt: {
          gt: now,
        },
      },
      data: {
        status: "COMPLETED",
        result,
        errorMessage: null,
        completedAt: now,
        leaseExpiresAt: null,
        leaseToken: null,
      },
    });

    return update.count === 1;
  }

    // Only the correct tenant and current lease owner can fail a request.
  async markFailed(
    id: string,
    leaseToken: string,
    tenantKey: string,
    scope: string,
    error: Error,
  ): Promise<boolean> {
    const now = new Date();

    const update = await prisma.idempotencyRecord.updateMany({
      where: {
        id,
        tenantKey,
        scope,
        status: "PROCESSING",
        leaseToken,
        leaseExpiresAt: {
          gt: now,
        },
      },
      data: {
        status: "FAILED",
        errorMessage: error.message,
        leaseExpiresAt: null,
        leaseToken: null,
      },
    });

    return update.count === 1;
  }
}

export const idempotencyRepository = new IdempotencyRepository();
