import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { outboxRepository } from "../../src/shared/repositories/outbox.repository.js";
import { OUTBOX_LOCK_DURATION_MS } from "../../src/shared/repositories/outbox.repository.js";

// ==========================================
// TEST CONFIGURATION
// ==========================================

const MAX_ATTEMPTS = 10;

const eventId = randomUUID();

const deduplicationKey =
  `outbox-exhausted-test:${randomUUID()}`;

const staleLockedAt = new Date(
  Date.now() - OUTBOX_LOCK_DURATION_MS - 5000,
);

let testPassed = false;

// ==========================================
// MAIN TEST
// ==========================================

async function main(): Promise<void> {
  console.log("======================================");
  console.log("OUTBOX EXHAUSTED STALE LOCK TEST");
  console.log("======================================");

  try {
    // --------------------------------------
    // 1. Ensure isolated test environment.
    // --------------------------------------

    const now = new Date();

    const staleLockBefore = new Date(
      now.getTime() - OUTBOX_LOCK_DURATION_MS,
    );

    const existingEligibleEvents =
      await prisma.outboxEvent.count({
        where: {
          OR: [
            {
              status: "PENDING",
              availableAt: {
                lte: now,
              },
              attemptCount: {
                lt: MAX_ATTEMPTS,
              },
            },
            {
              status: "PROCESSING",
              lockedAt: {
                lte: staleLockBefore,
              },
            },
          ],
        },
      });

    assert.equal(
      existingEligibleEvents,
      0,
      "Unrelated eligible or stale Outbox events exist. Stop the dispatcher before testing.",
    );

    console.log(
      "[PASS] No unrelated eligible or stale Outbox events exist",
    );

    // --------------------------------------
    // 2. Create an exhausted stale event.
    // --------------------------------------

    const event = await prisma.outboxEvent.create({
      data: {
        id: eventId,
        eventType: "EXHAUSTED_STALE_LOCK_TEST",
        aggregateType: "Test",
        aggregateId: eventId,
        deduplicationKey,
        payload: {
          test: true,
          eventId,
        },
        status: "PROCESSING",
        attemptCount: MAX_ATTEMPTS,
        lockedAt: staleLockedAt,
        lockToken: randomUUID(),
      },
    });

    console.log("[Test] Created event:", event.id);

    assert.equal(
      event.status,
      "PROCESSING",
    );

    assert.equal(
      event.attemptCount,
      MAX_ATTEMPTS,
    );

    assert.ok(event.lockToken);

    console.log(
      "[PASS] Event starts PROCESSING with maximum attempts exhausted",
    );

    console.log(
      "[PASS] Event has an expired processing lock",
    );

    // --------------------------------------
    // 3. Run claimPending().
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 1: PROCESS EXHAUSTED EVENT");
    console.log("--------------------------------------");

    const claimedEvents =
      await outboxRepository.claimPending({
        limit: 1,
      });

    assert.equal(
      claimedEvents.some(
        (claimed) => claimed.id === eventId,
      ),
      false,
      "Exhausted event must not be reclaimed",
    );

    console.log(
      "[PASS] Exhausted event was not reclaimed",
    );

    // --------------------------------------
    // 4. Verify automatic failure.
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("PHASE 2: VERIFY FAILED STATUS");
    console.log("--------------------------------------");

    const failedEvent =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: eventId,
        },
      });

    assert.equal(
      failedEvent.status,
      "FAILED",
    );

    console.log(
      "[PASS] Exhausted stale event was marked FAILED",
    );

    assert.equal(
      failedEvent.attemptCount,
      MAX_ATTEMPTS,
    );

    console.log(
      "[PASS] Attempt count remains exactly 10",
    );

    assert.equal(
      failedEvent.lockToken,
      null,
    );

    console.log(
      "[PASS] Lock token was cleared",
    );

    assert.equal(
      failedEvent.lockedAt,
      null,
    );

    console.log(
      "[PASS] Lock timestamp was cleared",
    );

    assert.ok(
      failedEvent.lastError,
      "Failure reason should be recorded",
    );

    console.log(
      "[PASS] Failure reason was recorded",
    );

    assert.equal(
      failedEvent.publishedAt,
      null,
    );

    console.log(
      "[PASS] Event was not incorrectly marked as published",
    );

    // --------------------------------------
    // FINAL RESULT
    // --------------------------------------

    testPassed = true;

    console.log("--------------------------------------");
    console.log("FINAL RESULT: ALL TESTS PASSED");
    console.log("======================================");
  } finally {
    // --------------------------------------
    // CLEANUP
    // --------------------------------------

    console.log("--------------------------------------");
    console.log("CLEANUP");
    console.log("--------------------------------------");

    await prisma.outboxEvent.deleteMany({
      where: {
        id: eventId,
      },
    });

    await prisma.$disconnect();

    console.log(
      "[Test] Database resources cleaned up.",
    );

    if (!testPassed) {
      console.error(
        "[Test] Exhausted stale lock test did not pass.",
      );
    }
  }
}

main().catch((error) => {
  console.error(
    "OUTBOX EXHAUSTED STALE LOCK TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});