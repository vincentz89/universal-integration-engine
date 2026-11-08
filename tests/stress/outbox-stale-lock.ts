
import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";

import {
  outboxRepository,
} from "../../src/shared/repositories/outbox.repository.js";

async function main() {
  const eventId = randomUUID();
  const deduplicationKey = `stale-lock-test:${randomUUID()}`;

  const lockDurationMs = 100;

  let testPassed = false;

  console.info("======================================");
  console.info("OUTBOX STALE LOCK RECOVERY TEST");
  console.info("======================================");

  try {
    // Stop the regular Outbox dispatcher before running this test.
    // This test expects exclusive access to eligible Outbox events.

    const now = new Date();

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
                lt: 10,
              },
            },
            {
              status: "PROCESSING",
              lockedAt: {
                lte: new Date(
                  now.getTime() - lockDurationMs,
                ),
              },
              attemptCount: {
                lt: 10,
              },
            },
          ],
        },
      });

    assert.equal(
      existingEligibleEvents,
      0,
      "Other eligible Outbox events exist. Stop the Outbox dispatcher and clear or process them before testing.",
    );

    // 1. Create a fresh Outbox event.
    await prisma.outboxEvent.create({
      data: {
        id: eventId,
        eventType: "STALE_LOCK_TEST",
        aggregateType: "Test",
        aggregateId: eventId,
        deduplicationKey,
        payload: {
          test: true,
          eventId,
        },
        status: "PENDING",
        attemptCount: 0,
      },
    });

    console.info("[Test] Outbox event created.");

    // 2. Dispatcher A claims the event.
    console.info("--------------------------------------");
    console.info("PHASE 1: DISPATCHER A CLAIMS EVENT");
    console.info("--------------------------------------");

    const firstClaim = await outboxRepository.claimPending({
      limit: 1,
      lockDurationMs,
    });

    assert.equal(
      firstClaim.length,
      1,
      "Dispatcher A should claim exactly one event.",
    );

    const dispatcherAEvent = firstClaim[0];

    assert.ok(
      dispatcherAEvent,
      "Dispatcher A claim result is missing.",
    );

    assert.equal(dispatcherAEvent.id, eventId);
    assert.equal(dispatcherAEvent.status, "PROCESSING");
    assert.equal(dispatcherAEvent.attemptCount, 1);
    assert.ok(dispatcherAEvent.lockToken);

    const dispatcherALockToken =
      dispatcherAEvent.lockToken;

    console.info("[PASS] Dispatcher A claimed the event.");
    console.info("[Test] Dispatcher A token:", dispatcherALockToken);

    // 3. Simulate Dispatcher A crashing.
    // No markPublished() or markFailed() is called.
    console.info("--------------------------------------");
    console.info("PHASE 2: SIMULATE DISPATCHER CRASH");
    console.info("--------------------------------------");

    await prisma.outboxEvent.update({
      where: {
        id: eventId,
      },
      data: {
        lockedAt: new Date(
          Date.now() - lockDurationMs - 1_000,
        ),
      },
    });

    const crashedState =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: eventId,
        },
      });

    assert.equal(crashedState.status, "PROCESSING");
    assert.equal(
      crashedState.lockToken,
      dispatcherALockToken,
    );

    console.info(
      "[PASS] Event remains PROCESSING with Dispatcher A's expired lock.",
    );

    // 4. Dispatcher B reclaims the stale event.
    console.info("--------------------------------------");
    console.info("PHASE 3: DISPATCHER B RECLAIMS EVENT");
    console.info("--------------------------------------");

    const secondClaim = await outboxRepository.claimPending({
      limit: 1,
      lockDurationMs,
    });

    assert.equal(
      secondClaim.length,
      1,
      "Dispatcher B should reclaim exactly one stale event.",
    );

    const dispatcherBEvent = secondClaim[0];

    assert.ok(
      dispatcherBEvent,
      "Dispatcher B claim result is missing.",
    );

    assert.equal(dispatcherBEvent.id, eventId);
    assert.equal(dispatcherBEvent.status, "PROCESSING");
    assert.equal(dispatcherBEvent.attemptCount, 2);

    assert.ok(dispatcherBEvent.lockToken);

    const dispatcherBLockToken =
      dispatcherBEvent.lockToken;

    assert.notEqual(
      dispatcherBLockToken,
      dispatcherALockToken,
      "Dispatcher B must receive a new lock token.",
    );

    console.info("[PASS] Dispatcher B reclaimed the event.");
    console.info("[Test] Dispatcher B token:", dispatcherBLockToken);

    // 5. Verify Dispatcher A cannot finalize the event.
    console.info("--------------------------------------");
    console.info("PHASE 4: REJECT STALE LOCK OWNER");
    console.info("--------------------------------------");

    const oldOwnerResult =
      await outboxRepository.markPublished(
        eventId,
        dispatcherALockToken,
      );

    assert.equal(
      oldOwnerResult,
      false,
      "Dispatcher A must not publish using its expired lock token.",
    );

    console.info(
      "[PASS] Dispatcher A cannot publish using its old token.",
    );

    const afterOldOwnerAttempt =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: eventId,
        },
      });

    assert.equal(
      afterOldOwnerAttempt.status,
      "PROCESSING",
    );

    assert.equal(
      afterOldOwnerAttempt.lockToken,
      dispatcherBLockToken,
    );

    assert.equal(
      afterOldOwnerAttempt.attemptCount,
      2,
    );

    console.info(
      "[PASS] Dispatcher A did not overwrite Dispatcher B's ownership.",
    );

    // 6. Dispatcher B successfully publishes the event.
    console.info("--------------------------------------");
    console.info("PHASE 5: DISPATCHER B FINALIZES EVENT");
    console.info("--------------------------------------");

    const newOwnerResult =
      await outboxRepository.markPublished(
        eventId,
        dispatcherBLockToken,
      );

    assert.equal(
      newOwnerResult,
      true,
      "Dispatcher B should successfully publish the event.",
    );

    const finalEvent =
      await prisma.outboxEvent.findUniqueOrThrow({
        where: {
          id: eventId,
        },
      });

    assert.equal(finalEvent.status, "PUBLISHED");
    assert.equal(finalEvent.attemptCount, 2);
    assert.equal(finalEvent.lockToken, null);
    assert.equal(finalEvent.lockedAt, null);
    assert.ok(finalEvent.publishedAt);

    console.info(
      "[PASS] Dispatcher B successfully published the event.",
    );

    console.info(
      "[PASS] Lock fields were cleared.",
    );

    console.info(
      "[PASS] Attempt count is exactly 2.",
    );

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");

    testPassed = true;
  } finally {
    if (!testPassed) {
      console.error(
        "[Test] Test did not complete successfully.",
      );
    }

    await prisma.outboxEvent.deleteMany({
      where: {
        id: eventId,
      },
    });

    await prisma.$disconnect();

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error) => {
  console.error(
    "OUTBOX STALE LOCK RECOVERY TEST FAILED:",
    error,
  );

  process.exitCode = 1;
});
