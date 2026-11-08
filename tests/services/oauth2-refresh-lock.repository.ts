
import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import {
  oauth2RefreshLockRepository,
} from "../../src/shared/repositories/oauth2-refresh-lock.repository.js";

async function main(): Promise<void> {
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  const integrationAId = randomUUID();
  const integrationBId = randomUUID();

  console.info("======================================");
  console.info("OAUTH2 REFRESH LOCK TEST");
  console.info("======================================");

  try {
    // 1. Create independent tenants.
    await prisma.tenantConfig.createMany({
      data: [
        {
          id: tenantAId,
        },
        {
          id: tenantBId,
        },
      ],
    });

    // 2. Create OAuth2 integrations.
    await prisma.tenantIntegrationConfig.createMany({
      data: [
        {
          id: integrationAId,
          tenantId: tenantAId,
          systemName: "OAUTH_TEST",
          authType: "OAUTH2",
          isActive: true,
        },
        {
          id: integrationBId,
          tenantId: tenantBId,
          systemName: "OAUTH_TEST",
          authType: "OAUTH2",
          isActive: true,
        },
      ],
    });

    console.info("[Test] Tenant integrations created.");

    // 3. Simulate two workers competing for the same lock.
    const competingResults = await Promise.all([
      oauth2RefreshLockRepository.acquire({
        tenantId: tenantAId,
        integrationId: integrationAId,
      }),
      oauth2RefreshLockRepository.acquire({
        tenantId: tenantAId,
        integrationId: integrationAId,
      }),
    ]);

    const acquiredLocks = competingResults.filter(
      (lock) => lock !== null,
    );

    assert.equal(
      acquiredLocks.length,
      1,
      "Only one worker should acquire the lock.",
    );

    const firstLock = acquiredLocks[0]!;

    console.info("[PASS] Concurrent workers cannot acquire the same lock.");

    // 4. Verify that a different tenant can acquire its own lock.
    const tenantBLock = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantBId,
      integrationId: integrationBId,
    });

    assert.ok(tenantBLock);
    assert.notEqual(firstLock.lockToken, tenantBLock.lockToken);

    console.info("[PASS] Independent tenants can acquire separate locks.");

    // 5. Verify that an active lock cannot be acquired again.
    const duplicateLock = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantAId,
      integrationId: integrationAId,
    });

    assert.equal(duplicateLock, null);

    console.info("[PASS] Active lock cannot be acquired twice.");

    // 6. Verify that the current owner can renew its lock.
    const renewed = await oauth2RefreshLockRepository.renew(firstLock);

    assert.equal(renewed, true);

    console.info("[PASS] Lock owner can renew its lock.");

    // 7. Verify that another lock token cannot renew the lock.
    const unauthorizedRenewal =
      await oauth2RefreshLockRepository.renew({
        ...firstLock,
        lockToken: randomUUID(),
      });

    assert.equal(unauthorizedRenewal, false);

    console.info("[PASS] Non-owner cannot renew the lock.");

    // 8. Verify that a non-owner cannot release the lock.
    const unauthorizedRelease =
      await oauth2RefreshLockRepository.release({
        ...firstLock,
        lockToken: randomUUID(),
      });

    assert.equal(unauthorizedRelease, false);

    const stillOwned = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantAId,
      integrationId: integrationAId,
    });

    assert.equal(stillOwned, null);

    console.info("[PASS] Non-owner cannot release another worker's lock.");

    // 9. Verify that the actual owner can release the lock.
    const released =
      await oauth2RefreshLockRepository.release(firstLock);

    assert.equal(released, true);

    const reacquired = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantAId,
      integrationId: integrationAId,
    });

    assert.ok(reacquired);

    console.info("[PASS] Owner can release and another worker can acquire.");

    // 10. Verify that an expired lock can be reclaimed.
    const shortLock = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantBId,
      integrationId: integrationBId,
      lockDurationMs: 1_000,
    });

    assert.equal(shortLock, null);

    // Release Tenant B's existing lock before creating the short lock.
    await oauth2RefreshLockRepository.release(tenantBLock!);

    const expiringLock = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantBId,
      integrationId: integrationBId,
      lockDurationMs: 1_000,
    });

    assert.ok(expiringLock);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const reclaimedLock = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantBId,
      integrationId: integrationBId,
    });

    assert.ok(reclaimedLock);
    assert.notEqual(
      reclaimedLock.lockToken,
      expiringLock.lockToken,
    );

    console.info("[PASS] Expired lock can be reclaimed.");

    // 11. Verify that the expired owner cannot renew or release
    // the reclaimed lock.
    const staleRenewal =
      await oauth2RefreshLockRepository.renew(expiringLock);

    const staleRelease =
      await oauth2RefreshLockRepository.release(expiringLock);

    assert.equal(staleRenewal, false);
    assert.equal(staleRelease, false);

    const stillHeld = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantBId,
      integrationId: integrationBId,
    });

    assert.equal(stillHeld, null);

    console.info("[PASS] Stale owner cannot renew or release reclaimed lock.");

    // 12. Verify invalid lock duration is rejected.
    await assert.rejects(
      () =>
        oauth2RefreshLockRepository.acquire({
          tenantId: tenantAId,
          integrationId: integrationAId,
          lockDurationMs: 500,
        }),
      /Invalid OAuth2 refresh lock duration/,
    );

    console.info("[PASS] Invalid lock duration rejected.");

    console.info("--------------------------------------");
    console.info("PASSED: 10");
    console.info("FAILED: 0");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");
  } finally {
    await prisma.tenantIntegrationConfig.deleteMany({
      where: {
        id: {
          in: [integrationAId, integrationBId],
        },
      },
    });

    await prisma.tenantConfig.deleteMany({
      where: {
        id: {
          in: [tenantAId, tenantBId],
        },
      },
    });

    await prisma.$disconnect();

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error: unknown) => {
  console.error("OAUTH2 REFRESH LOCK TEST FAILED:", error);
  process.exitCode = 1;
});
