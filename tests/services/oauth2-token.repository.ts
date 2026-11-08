
import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { encryptCredential, decryptCredential } from "../../src/shared/security/credential-encryption.js";

import {
  oauth2RefreshLockRepository,
} from "../../src/shared/repositories/oauth2-refresh-lock.repository.js";

import {
  oauth2TokenRepository,
} from "../../src/shared/repositories/oauth2-token.repository.js";

async function main(): Promise<void> {
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  const integrationAId = randomUUID();
  const integrationBId = randomUUID();

  const originalCredentials = {
    clientId: "test-client",
    clientSecret: "test-secret",
    refreshToken: "old-refresh-token",
    accessToken: "old-access-token",
  };

  const updatedCredentials = {
    clientId: "test-client",
    clientSecret: "test-secret",
    refreshToken: "new-refresh-token",
    accessToken: "new-access-token",
  };

  console.info("======================================");
  console.info("OAUTH2 TOKEN PERSISTENCE TEST");
  console.info("======================================");

  try {
    // 1. Create two independent tenants.
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

    // 2. Create two OAuth2 integrations.
    await prisma.tenantIntegrationConfig.createMany({
      data: [
        {
          id: integrationAId,
          tenantId: tenantAId,
          systemName: "OAUTH_TEST",
          authType: "OAUTH2",
          credentialsEncrypted: encryptCredential(
            JSON.stringify(originalCredentials),
          ),
          isActive: true,
        },
        {
          id: integrationBId,
          tenantId: tenantBId,
          systemName: "OAUTH_TEST",
          authType: "OAUTH2",
          credentialsEncrypted: encryptCredential(
            JSON.stringify(originalCredentials),
          ),
          isActive: true,
        },
      ],
    });

    console.info("[Test] Tenant integrations created.");

    // 3. Acquire Tenant A's refresh lock.
    const lockA = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantAId,
      integrationId: integrationAId,
    });

    assert.ok(lockA);

    // 4. Persist refreshed credentials using the valid lock.
    const encryptedUpdatedCredentials = encryptCredential(
      JSON.stringify(updatedCredentials),
    );

    const expiration = new Date(Date.now() + 3_600_000);

    const persisted = await oauth2TokenRepository.persistRefreshedTokens({
      tenantId: tenantAId,
      integrationId: integrationAId,
      lockToken: lockA.lockToken,
      credentialsEncrypted: encryptedUpdatedCredentials,
      tokenType: "Bearer",
      accessTokenExpiresAt: expiration,
    });

    assert.equal(persisted, true);

    console.info("[PASS] Current lock owner can persist refreshed tokens.");

    // 5. Verify encrypted credentials and token metadata.
    const storedA = await prisma.tenantIntegrationConfig.findUniqueOrThrow({
      where: { id: integrationAId },
      select: {
        credentialsEncrypted: true,
        tokenType: true,
        accessTokenExpiresAt: true,
        tokenRefreshLockToken: true,
        tokenRefreshLockExpiresAt: true,
      },
    });

    assert.ok(storedA.credentialsEncrypted);

    assert.deepEqual(
      JSON.parse(decryptCredential(storedA.credentialsEncrypted)),
      updatedCredentials,
    );

    assert.equal(storedA.tokenType, "Bearer");
    assert.ok(storedA.accessTokenExpiresAt);
    assert.equal(
      storedA.accessTokenExpiresAt.getTime(),
      expiration.getTime(),
    );

    assert.equal(storedA.tokenRefreshLockToken, null);
    assert.equal(storedA.tokenRefreshLockExpiresAt, null);

    console.info("[PASS] Tokens encrypted and metadata saved correctly.");
    console.info("[PASS] Refresh lock released with successful persistence.");

    // 6. Acquire another lock and simulate a newer worker taking ownership.
    const staleLock = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantAId,
      integrationId: integrationAId,
    });

    assert.ok(staleLock);

    const replacementLockToken = randomUUID();

    await prisma.tenantIntegrationConfig.update({
      where: { id: integrationAId },
      data: {
        tokenRefreshLockToken: replacementLockToken,
        tokenRefreshLockExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    // The old worker must not overwrite the newer worker's credentials.
    const stalePersist = await oauth2TokenRepository.persistRefreshedTokens({
      tenantId: tenantAId,
      integrationId: integrationAId,
      lockToken: staleLock.lockToken,
      credentialsEncrypted: encryptCredential(
        JSON.stringify({
          ...updatedCredentials,
          accessToken: "stale-worker-token",
        }),
      ),
      tokenType: "Bearer",
      accessTokenExpiresAt: new Date(Date.now() + 7_200_000),
    });

    assert.equal(stalePersist, false);

    console.info("[PASS] Stale lock owner cannot overwrite newer tokens.");

    // 7. Verify that the newer worker's lock remains untouched.
    const afterStaleAttempt =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: { id: integrationAId },
        select: {
          credentialsEncrypted: true,
          tokenRefreshLockToken: true,
        },
      });

    assert.deepEqual(
      JSON.parse(decryptCredential(afterStaleAttempt.credentialsEncrypted!)),
      updatedCredentials,
    );

    assert.equal(
      afterStaleAttempt.tokenRefreshLockToken,
      replacementLockToken,
    );

    console.info("[PASS] Newer worker's credentials and lock remain intact.");

    // 8. Verify that an expired lock cannot persist tokens.
    const expiredLockToken = randomUUID();

    await prisma.tenantIntegrationConfig.update({
      where: { id: integrationAId },
      data: {
        tokenRefreshLockToken: expiredLockToken,
        tokenRefreshLockExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    const expiredPersist =
      await oauth2TokenRepository.persistRefreshedTokens({
        tenantId: tenantAId,
        integrationId: integrationAId,
        lockToken: expiredLockToken,
        credentialsEncrypted: encryptCredential(
          JSON.stringify({
            ...updatedCredentials,
            accessToken: "expired-worker-token",
          }),
        ),
        tokenType: "Bearer",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      });

    assert.equal(expiredPersist, false);

    console.info("[PASS] Expired lock cannot persist tokens.");

    // 9. Verify that cross-tenant persistence is rejected.
    const lockB = await oauth2RefreshLockRepository.acquire({
      tenantId: tenantBId,
      integrationId: integrationBId,
    });

    assert.ok(lockB);

    const crossTenantPersist =
      await oauth2TokenRepository.persistRefreshedTokens({
        tenantId: tenantAId,
        integrationId: integrationBId,
        lockToken: lockB.lockToken,
        credentialsEncrypted: encryptCredential(
          JSON.stringify({
            ...updatedCredentials,
            accessToken: "cross-tenant-token",
          }),
        ),
        tokenType: "Bearer",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      });

    assert.equal(crossTenantPersist, false);

    console.info("[PASS] Cross-tenant token persistence rejected.");

    // 10. Verify that Tenant B's original credentials remain unchanged.
    const storedB = await prisma.tenantIntegrationConfig.findUniqueOrThrow({
      where: { id: integrationBId },
      select: {
        credentialsEncrypted: true,
        tokenRefreshLockToken: true,
      },
    });

    assert.deepEqual(
      JSON.parse(decryptCredential(storedB.credentialsEncrypted!)),
      originalCredentials,
    );

    assert.equal(storedB.tokenRefreshLockToken, lockB.lockToken);

    console.info("[PASS] Tenant B credentials and lock remain unchanged.");

    // 11. Reject unsupported token types.
    await assert.rejects(
      () =>
        oauth2TokenRepository.persistRefreshedTokens({
          tenantId: tenantAId,
          integrationId: integrationAId,
          lockToken: randomUUID(),
          credentialsEncrypted: encryptCredential(
            JSON.stringify(updatedCredentials),
          ),
          tokenType: "MAC",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        }),
      /Unsupported OAuth2 token type/,
    );

    console.info("[PASS] Unsupported token type rejected.");

    console.info("--------------------------------------");
    console.info("PASSED: 9");
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
  console.error("OAUTH2 TOKEN PERSISTENCE TEST FAILED:", error);
  process.exitCode = 1;
});
