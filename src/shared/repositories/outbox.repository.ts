
import { randomUUID } from "node:crypto";
import { Prisma, type OutboxEvent } from "@prisma/client";

import { prisma } from "../utils/db.js";

// ==========================================
// CONFIGURATION
// ==========================================

export const OUTBOX_BATCH_SIZE = 50;
export const OUTBOX_LOCK_DURATION_MS = 60_000;

const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 300_000;
const MAX_PUBLISH_ATTEMPTS = 10;

// ==========================================
// TYPES
// ==========================================

export interface CreateOutboxInput {
  eventType: string;
  aggregateType?: string;
  aggregateId?: string;
  deduplicationKey: string;
  payload: Prisma.InputJsonValue;
}

export interface ClaimOutboxOptions {
  limit?: number;
  lockDurationMs?: number;
}

// ==========================================
// REPOSITORY
// ==========================================

class OutboxRepository {
  /**
   * Create an Outbox event using an existing transaction.
   *
   * The caller is responsible for wrapping this operation
   * with related database writes in prisma.$transaction().
   */
  async create(
    tx: Prisma.TransactionClient,
    input: CreateOutboxInput,
  ): Promise<OutboxEvent> {
    return tx.outboxEvent.create({
      data: {
        eventType: input.eventType,
        deduplicationKey: input.deduplicationKey,
        payload: input.payload,

        ...(input.aggregateType !== undefined
          ? { aggregateType: input.aggregateType }
          : {}),

        ...(input.aggregateId !== undefined
          ? { aggregateId: input.aggregateId }
          : {}),
      },
    });
  }

  /**
   * Atomically claim pending events.
   *
   * PostgreSQL SKIP LOCKED prevents multiple dispatchers
   * from claiming the same available records simultaneously.
   *
   * Expired PROCESSING locks can also be reclaimed.
   */
  // async claimPending(
  //   options: ClaimOutboxOptions = {},
  // ): Promise<OutboxEvent[]> {
  //   const limit = Math.max(
  //     1,
  //     Math.min(options.limit ?? OUTBOX_BATCH_SIZE, 500),
  //   );

  //   const lockDurationMs =
  //     options.lockDurationMs ?? OUTBOX_LOCK_DURATION_MS;

  //   const now = new Date();

  //   const staleLockBefore = new Date(
  //     now.getTime() - lockDurationMs,
  //   );

  //   // One ownership token for this claim batch.
  //   const lockToken = randomUUID();

  //   return prisma.$queryRaw<OutboxEvent[]>`
  //     WITH candidates AS (
  //       SELECT id
  //       FROM "OutboxEvent"
  //       WHERE
  //         (
  //           "status" = 'PENDING'::"OutboxStatus"
  //           AND "availableAt" <= ${now}
  //         )
  //         OR
  //         (
  //           "status" = 'PROCESSING'::"OutboxStatus"
  //           AND "lockedAt" <= ${staleLockBefore}
  //         )
  //       ORDER BY "availableAt" ASC, "createdAt" ASC
  //       LIMIT ${limit}
  //       FOR UPDATE SKIP LOCKED
  //     )
  //     UPDATE "OutboxEvent" AS event
  //     SET
  //       "status" = 'PROCESSING'::"OutboxStatus",
  //       "lockedAt" = ${now},
  //       "lockToken" = ${lockToken},
  //       "attemptCount" = event."attemptCount" + 1,
  //       "updatedAt" = ${now}
  //     FROM candidates
  //     WHERE event.id = candidates.id
  //     RETURNING event.*;
  //   `;
  // }

  async claimPending(
    options: ClaimOutboxOptions = {},
  ): Promise<OutboxEvent[]> {
    const limit = Math.max(
      1,
      Math.min(options.limit ?? OUTBOX_BATCH_SIZE, 500),
    );

    const lockDurationMs =
      options.lockDurationMs ?? OUTBOX_LOCK_DURATION_MS;

    const now = new Date();

    const staleLockBefore = new Date(
      now.getTime() - lockDurationMs,
    );

    const lockToken = randomUUID();

    return prisma.$queryRaw<OutboxEvent[]>`
      WITH exhausted AS (
        UPDATE "OutboxEvent"
        SET
          "status" = 'FAILED'::"OutboxStatus",
          "lockedAt" = NULL,
          "lockToken" = NULL,
          "lastError" = 'Publishing lease expired after maximum attempts.',
          "updatedAt" = ${now}
        WHERE
          "status" = 'PROCESSING'::"OutboxStatus"
          AND "lockedAt" <= ${staleLockBefore}
          AND "attemptCount" >= ${MAX_PUBLISH_ATTEMPTS}
        RETURNING id
      ),
      candidates AS (
        SELECT id
        FROM "OutboxEvent"
        WHERE
          (
            "status" = 'PENDING'::"OutboxStatus"
            AND "availableAt" <= ${now}
            AND "attemptCount" < ${MAX_PUBLISH_ATTEMPTS}
          )
          OR
          (
            "status" = 'PROCESSING'::"OutboxStatus"
            AND "lockedAt" <= ${staleLockBefore}
            AND "attemptCount" < ${MAX_PUBLISH_ATTEMPTS}
          )
        ORDER BY "availableAt" ASC, "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" AS event
      SET
        "status" = 'PROCESSING'::"OutboxStatus",
        "lockedAt" = ${now},
        "lockToken" = ${lockToken},
        "attemptCount" = event."attemptCount" + 1,
        "updatedAt" = ${now}
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.*;
    `;
  }

  /**
   * Mark an event as successfully published.
   *
   * Only the current lock owner can finalize it.
   */
  async markPublished(
    id: string,
    lockToken: string,
  ): Promise<boolean> {
    const update = await prisma.outboxEvent.updateMany({
      where: {
        id,
        status: "PROCESSING",
        lockToken,
      },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });

    return update.count === 1;
  }

  /**
   * Release a failed publishing attempt.
   *
   * Uses exponential backoff.
   * After the maximum number of attempts, the event
   * moves to FAILED for inspection or manual replay.
   */
  async markFailed(
    event: OutboxEvent,
    lockToken: string,
    error: Error,
  ): Promise<boolean> {
    const isFinalAttempt =
      event.attemptCount >= MAX_PUBLISH_ATTEMPTS;

    const retryDelayMs = Math.min(
      BASE_RETRY_DELAY_MS *
        2 ** Math.max(0, event.attemptCount - 1),
      MAX_RETRY_DELAY_MS,
    );

    const availableAt = new Date(
      Date.now() + retryDelayMs,
    );

    const update = await prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: "PROCESSING",
        lockToken,
      },
      data: {
        status: isFinalAttempt ? "FAILED" : "PENDING",
        availableAt,
        lockedAt: null,
        lockToken: null,
        lastError: error.message,
      },
    });

    return update.count === 1;
  }
}

export const outboxRepository = new OutboxRepository();
