
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { idempotencyRepository } from "../../src/shared/repositories/idempotency.repository.js";
import { prisma } from "../../src/shared/utils/db.js";

async function runIdempotencyConflictTest() {
  const tenantKey = `conflict-test-${randomUUID()}`;
  const scope = "BIGCOMMERCE_WEBHOOK";
  const idempotencyKey = `event-${randomUUID()}`;

  const originalPayload = JSON.stringify({
    scope: "store/product/updated",
    store_id: "TEST-STORE",
    data: {
      id: 12345,
      name: "Original Product",
    },
  });

  const modifiedPayload = JSON.stringify({
    scope: "store/product/updated",
    store_id: "TEST-STORE",
    data: {
      id: 12345,
      name: "Modified Product",
    },
  });

  const originalHash =
    idempotencyRepository.createRequestHash(originalPayload);

  const modifiedHash =
    idempotencyRepository.createRequestHash(modifiedPayload);

  try {
    console.log("=================================");
    console.log("IDEMPOTENCY DATABASE TEST");
    console.log("=================================");

    // TEST 1: Original registration and payload conflict.
    const firstResult = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
    });

    const secondResult = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: modifiedHash,
    });

    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        tenantKey_scope_idempotencyKey: {
          tenantKey,
          scope,
          idempotencyKey,
        },
      },
    });

    const conflictPassed =
      firstResult.status === "NEW" &&
      secondResult.status === "CONFLICT" &&
      record.requestHash === originalHash &&
      record.status === "PROCESSING";

    console.log("---------------------------------");
    console.log("PAYLOAD CONFLICT TEST");
    console.log("---------------------------------");
    console.log("First Request:", firstResult.status);
    console.log("Second Request:", secondResult.status);
    console.log("Original Hash Preserved:", record.requestHash === originalHash);
    console.log("RESULT:", conflictPassed ? "PASSED" : "FAILED");

    if (!conflictPassed) {
      throw new Error("Payload conflict test failed.");
    }

    // TEST 2: Completed event duplicate.
    await idempotencyRepository.markCompleted(
      record.id,
      firstResult.leaseToken,
      tenantKey,
      scope,
      {
        accepted: true,
        externalId: "TEST-123",
      },
    );

    const completedResult = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
    });

    const completedRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: record.id },
      });

    const completedPassed =
      completedResult.status === "DUPLICATE" &&
      completedResult.existingStatus === "COMPLETED" &&
      completedRecord.status === "COMPLETED";

    console.log("---------------------------------");
    console.log("COMPLETED DUPLICATE TEST");
    console.log("---------------------------------");
    console.log("Request:", completedResult.status);
    console.log("Database Status:", completedRecord.status);
    console.log("RESULT:", completedPassed ? "PASSED" : "FAILED");

    if (!completedPassed) {
      throw new Error("Completed duplicate test failed.");
    }

    // TEST 3: Failed request recovery.
    const failedKey = `failed-${randomUUID()}`;

    const failedRegistration = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: failedKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
    });

    if (failedRegistration.status !== "NEW") {
      throw new Error("Failed test initial registration failed.");
    }

    const failedResult = await idempotencyRepository.markFailed(
      failedRegistration.recordId,
      failedRegistration.leaseToken,
      tenantKey,
      scope,
      new Error("Simulated processing failure"),
    );

    if (!failedResult) {
      throw new Error("Failed to mark original request as FAILED.");
    }

    const retryResult = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: failedKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
    });

    const failedRecord = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { id: failedRegistration.recordId },
    });

    const failedRecoveryPassed =
      retryResult.status === "RETRY_CLAIMED" &&
      failedRecord.status === "PROCESSING" &&
      failedRecord.attemptCount === 2 &&
      failedRecord.errorMessage === null;

    console.log("---------------------------------");
    console.log("FAILED REQUEST RECOVERY TEST");
    console.log("---------------------------------");
    console.log("Retry Request:", retryResult.status);
    console.log("Database Status:", failedRecord.status);
    console.log("Attempt Count:", failedRecord.attemptCount);
    console.log("Error Cleared:", failedRecord.errorMessage === null);
    console.log("RESULT:", failedRecoveryPassed ? "PASSED" : "FAILED");

    if (!failedRecoveryPassed) {
      throw new Error("Failed request recovery test failed.");
    }

    // TEST 4: Expired processing lease recovery.
    const expiredKey = `expired-${randomUUID()}`;

    const expiredRegistration = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: expiredKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
      leaseDurationMs: 1,
    });

    if (expiredRegistration.status !== "NEW") {
      throw new Error("Expired lease initial registration failed.");
    }

    // Force the lease to expire without waiting.
    await prisma.idempotencyRecord.update({
      where: { id: expiredRegistration.recordId },
      data: {
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    // TEST 5: Concurrent retry claim protection.
    const concurrentKey = `concurrent-${randomUUID()}`;

    const concurrentRegistration = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: concurrentKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
    });

    if (concurrentRegistration.status !== "NEW") {
      throw new Error("Concurrent test initial registration failed.");
    }

    const concurrentFailedResult =
      await idempotencyRepository.markFailed(
        concurrentRegistration.recordId,
        concurrentRegistration.leaseToken,
        tenantKey,
        scope,
        new Error("Simulated concurrent retry failure"),
      );

    if (!concurrentFailedResult) {
      throw new Error("Failed to mark concurrent test record as FAILED.");
    }

    const concurrentResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        idempotencyRepository.register({
          tenantKey,
          scope,
          idempotencyKey: concurrentKey,
          jobName: "PROCESS_WEBHOOK_EVENT",
          requestHash: originalHash,
        }),
      ),
    );

    const retryClaimedCount = concurrentResults.filter(
      (result) => result.status === "RETRY_CLAIMED",
    ).length;

    const duplicateCount = concurrentResults.filter(
      (result) => result.status === "DUPLICATE",
    ).length;

    const concurrentRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: concurrentRegistration.recordId },
      });

    const concurrentPassed =
      retryClaimedCount === 1 &&
      duplicateCount === 4 &&
      concurrentRecord.attemptCount === 2 &&
      concurrentRecord.status === "PROCESSING";

    console.log("---------------------------------");
    console.log("CONCURRENT RETRY CLAIM TEST");
    console.log("---------------------------------");
    console.log("Concurrent Requests:", concurrentResults.length);
    console.log("Retry Claimed:", retryClaimedCount);
    console.log("Duplicates:", duplicateCount);
    console.log("Database Attempt Count:", concurrentRecord.attemptCount);
    console.log("RESULT:", concurrentPassed ? "PASSED" : "FAILED");

    if (!concurrentPassed) {
      throw new Error("Concurrent retry claim test failed.");
    }
    // end


    // TEST 6: Stale worker ownership protection.
    const staleWorkerKey = `stale-worker-${randomUUID()}`;

    // Worker A claims the request.
    const workerA = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: staleWorkerKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
      leaseDurationMs: 1,
    });

    if (workerA.status !== "NEW") {
      throw new Error("Worker A initial claim failed.");
    }

    // Simulate Worker A's lease expiration.
    await prisma.idempotencyRecord.update({
      where: { id: workerA.recordId },
      data: {
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    // Worker B reclaims the expired request.
    const workerB = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: staleWorkerKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
    });

    if (workerB.status !== "RETRY_CLAIMED") {
      throw new Error("Worker B failed to reclaim the request.");
    }

    // Worker A attempts to update using its outdated token.
    const staleFailureResult = await idempotencyRepository.markFailed(
      workerA.recordId,
      workerA.leaseToken,
      tenantKey,
      scope,
      new Error("Stale worker failure"),
    );

    const staleCompletionResult = await idempotencyRepository.markCompleted(
      workerA.recordId,
      workerA.leaseToken,
      tenantKey,
      scope,
      {
        worker: "A",
        result: "STALE",
      },
    );

    const currentCompletionResult = await idempotencyRepository.markCompleted(
      workerB.recordId,
      workerB.leaseToken,
      tenantKey,
      scope,
      {
        worker: "B",
        result: "SUCCESS",
      },
    );

    const staleWorkerRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: workerA.recordId },
      });

    const staleWorkerPassed =
      staleFailureResult === false &&
      staleCompletionResult === false &&
      currentCompletionResult === true &&
      staleWorkerRecord.status === "COMPLETED" &&
      staleWorkerRecord.result !== null &&
      (staleWorkerRecord.result as { worker?: string }).worker === "B";

    console.log("---------------------------------");
    console.log("STALE WORKER OWNERSHIP TEST");
    console.log("---------------------------------");
    console.log("Worker A Claim:", workerA.status);
    console.log("Worker B Claim:", workerB.status);
    console.log("Worker A Mark Failed:", staleFailureResult);
    console.log("Worker A Mark Completed:", staleCompletionResult);
    console.log("Worker B Mark Completed:", currentCompletionResult);
    console.log("Final Status:", staleWorkerRecord.status);
    console.log("Final Owner:", (staleWorkerRecord.result as { worker?: string } | null)?.worker);
    console.log("RESULT:", staleWorkerPassed ? "PASSED" : "FAILED");

    if (!staleWorkerPassed) {
      throw new Error("Stale worker ownership test failed.");
    }
    //end

    //add
    // TEST 7: Atomic expired lease recovery claim.
    const recoveryKey = `recovery-${randomUUID()}`;

    const recoveryRegistration = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: recoveryKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
      leaseDurationMs: 1,
    });

    if (recoveryRegistration.status !== "NEW") {
      throw new Error("Recovery test initial registration failed.");
    }

    // Force the lease to expire.
    await prisma.idempotencyRecord.update({
      where: {
        id: recoveryRegistration.recordId,
      },
      data: {
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    // Confirm that the recovery scanner can find the record.
    const expiredCandidates =
      await idempotencyRepository.findExpiredProcessingRecords(
        100,
        scope,
        tenantKey,
      );

    const candidateFound = expiredCandidates.some(
      (record) => record.id === recoveryRegistration.recordId,
    );

    if (!candidateFound) {
      throw new Error("Expired record was not found by recovery scanner.");
    }

    // Simulate two recovery processes competing for the same record.
    const recoveryClaims = await Promise.all(
      Array.from({ length: 2 }, () => {
        const newLeaseToken = randomUUID();

        return prisma.$transaction((tx) =>
          idempotencyRepository.claimExpiredLeaseInTransaction(
            tx,
            {
              id: recoveryRegistration.recordId,
              tenantKey,
              scope,
              requestHash: originalHash,
              currentLeaseToken: recoveryRegistration.leaseToken,
              newLeaseToken,
            },
          ),
        );
      }),
    );

    const successfulClaims = recoveryClaims.filter(
      (result) => result !== null,
    );

    const recoveryRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          id: recoveryRegistration.recordId,
        },
      });

    const recoveryClaimPassed =
      candidateFound &&
      successfulClaims.length === 1 &&
      recoveryRecord.status === "PROCESSING" &&
      recoveryRecord.attemptCount === 2 &&
      recoveryRecord.leaseToken !== null &&
      recoveryRecord.leaseToken !== recoveryRegistration.leaseToken &&
      recoveryRecord.leaseExpiresAt !== null &&
      recoveryRecord.leaseExpiresAt > new Date();

    console.log("---------------------------------");
    console.log("AUTONOMOUS RECOVERY CLAIM TEST");
    console.log("---------------------------------");
    console.log("Expired Candidate Found:", candidateFound);
    console.log("Concurrent Recovery Processes:", recoveryClaims.length);
    console.log("Successful Claims:", successfulClaims.length);
    console.log("Attempt Count:", recoveryRecord.attemptCount);
    console.log("Lease Replaced:", recoveryRecord.leaseToken !== recoveryRegistration.leaseToken);
    console.log("RESULT:", recoveryClaimPassed ? "PASSED" : "FAILED");

    if (!recoveryClaimPassed) {
      throw new Error("Autonomous recovery claim test failed.");
    }
    //end

    const expiredRetryResult = await idempotencyRepository.register({
      tenantKey,
      scope,
      idempotencyKey: expiredKey,
      jobName: "PROCESS_WEBHOOK_EVENT",
      requestHash: originalHash,
    });

    const expiredRecord =
      await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: expiredRegistration.recordId },
      });

    const expiredRecoveryPassed =
      expiredRetryResult.status === "RETRY_CLAIMED" &&
      expiredRecord.status === "PROCESSING" &&
      expiredRecord.attemptCount === 2 &&
      expiredRecord.leaseExpiresAt !== null &&
      expiredRecord.leaseExpiresAt > new Date();

    console.log("---------------------------------");
    console.log("EXPIRED LEASE RECOVERY TEST");
    console.log("---------------------------------");
    console.log("Retry Request:", expiredRetryResult.status);
    console.log("Database Status:", expiredRecord.status);
    console.log("Attempt Count:", expiredRecord.attemptCount);
    console.log("New Lease Active:", expiredRecoveryPassed);
    console.log("RESULT:", expiredRecoveryPassed ? "PASSED" : "FAILED");

    if (!expiredRecoveryPassed) {
      throw new Error("Expired lease recovery test failed.");
    }

    console.log("=================================");
    console.log("FINAL RESULT: ALL TESTS PASSED");
    console.log("=================================");
  } catch (error) {
    console.error("[Test] Idempotency test failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

runIdempotencyConflictTest();
