
import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import {
  encryptCredential,
  decryptCredential,
} from "../../src/shared/security/credential-encryption.js";

import {
  OAuth2TokenCoordinatorService,
} from "../../src/shared/services/oauth2-token-coordinator.service.js";

import {
  oauth2RefreshLockRepository,
} from "../../src/shared/repositories/oauth2-refresh-lock.repository.js";

const SYSTEM_NAME = "OAUTH_TEST";

const TENANT_A_ID = randomUUID();
const TENANT_B_ID = randomUUID();

const INTEGRATION_A_ID = randomUUID();
const INTEGRATION_B_ID = randomUUID();

const originalCredentials = {
  clientId: "test-client",
  clientSecret: "test-secret",
  refreshToken: "original-refresh-token",
  accessToken: "old-access-token",
};

const futureExpiry = () => new Date(Date.now() + 3_600_000);
const expiredDate = () => new Date(Date.now() - 60_000);

const coordinatorInput = {
  tenantId: TENANT_A_ID,
  integrationId: INTEGRATION_A_ID,
  expectedSystemName: SYSTEM_NAME,

  // The injected mock does not make an HTTP request.
  tokenEndpointConfig: {} as never,
  allowedTokenHosts: ["auth.example.com"],

  validityBufferMs: 60_000,
  lockDurationMs: 60_000,
  waitTimeoutMs: 5_000,
  pollIntervalMs: 50,
};

function createFakeRefresher(
  callback: () => Promise<Record<string, unknown>>,
) {
  // The coordinator's production refresher has a specific provider
  // response type. This test helper deliberately supplies controlled
  // mock responses without depending on the provider's HTTP client.
  return callback as never;
}

async function setIntegrationState(
  integrationId: string,
  credentials: Record<string, string>,
  expiresAt: Date | null,
): Promise<void> {
  await prisma.tenantIntegrationConfig.update({
    where: { id: integrationId },
    data: {
      credentialsEncrypted: encryptCredential(
        JSON.stringify(credentials),
      ),
      tokenType: null,
      accessTokenExpiresAt: expiresAt,
      tokenRefreshLockToken: null,
      tokenRefreshLockExpiresAt: null,
    },
  });
}

async function getStoredCredentials(
  integrationId: string,
): Promise<Record<string, string>> {
  const integration =
    await prisma.tenantIntegrationConfig.findUniqueOrThrow({
      where: { id: integrationId },
      select: {
        credentialsEncrypted: true,
      },
    });

  assert.ok(integration.credentialsEncrypted);

  return JSON.parse(
    decryptCredential(integration.credentialsEncrypted),
  ) as Record<string, string>;
}

async function main(): Promise<void> {
  console.info("======================================");
  console.info("OAUTH2 TOKEN COORDINATOR TEST");
  console.info("======================================");

  try {
    // 1. Create two independent tenants.
    await prisma.tenantConfig.createMany({
      data: [
        {
          id: TENANT_A_ID,
        },
        {
          id: TENANT_B_ID,
        },
      ],
    });

    // 2. Create their OAuth2 integrations.
    await prisma.tenantIntegrationConfig.createMany({
      data: [
        {
          id: INTEGRATION_A_ID,
          tenantId: TENANT_A_ID,
          systemName: SYSTEM_NAME,
          authType: "OAUTH2",
          credentialsEncrypted: encryptCredential(
            JSON.stringify(originalCredentials),
          ),
          isActive: true,
        },
        {
          id: INTEGRATION_B_ID,
          tenantId: TENANT_B_ID,
          systemName: SYSTEM_NAME,
          authType: "OAUTH2",
          credentialsEncrypted: encryptCredential(
            JSON.stringify(originalCredentials),
          ),
          isActive: true,
        },
      ],
    });

    console.info("[Test] Tenant fixtures created.");

    // 3. A valid access token must be reused without refreshing.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "still-valid-token",
      },
      futureExpiry(),
    );

    let refreshCalls = 0;

    const noRefreshCoordinator = new OAuth2TokenCoordinatorService(
      createFakeRefresher(async () => {
        refreshCalls++;
        throw new Error("Provider must not be called.");
      }),
    );

    const reused = await noRefreshCoordinator.getAccessToken(
      coordinatorInput,
    );

    assert.equal(reused.accessToken, "still-valid-token");
    assert.equal(refreshCalls, 0);

    console.info("[PASS] Valid access token reused without refreshing.");

    // 4. An expired token must refresh successfully.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "expired-token",
      },
      expiredDate(),
    );

    const refreshCoordinator = new OAuth2TokenCoordinatorService(
      createFakeRefresher(async () => {
        refreshCalls++;

        return {
          access_token: "refreshed-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        };
      }),
    );

    const refreshed = await refreshCoordinator.getAccessToken(
      coordinatorInput,
    );

    assert.equal(refreshed.accessToken, "refreshed-access-token");
    assert.ok(refreshed.expiresAt);
    assert.ok(refreshed.expiresAt.getTime() > Date.now());

    const credentialsAfterRefresh =
      await getStoredCredentials(INTEGRATION_A_ID);

    assert.equal(
      credentialsAfterRefresh.accessToken,
      "refreshed-access-token",
    );

    // The provider did not rotate the refresh token.
    assert.equal(
      credentialsAfterRefresh.refreshToken,
      "original-refresh-token",
    );

    console.info("[PASS] Expired token refreshed and persisted.");
    console.info("[PASS] Existing refresh token preserved when omitted.");

    // 5. A replacement refresh token must be persisted when rotated.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "another-expired-token",
      },
      expiredDate(),
    );

    const rotationCoordinator = new OAuth2TokenCoordinatorService(
      createFakeRefresher(async () => ({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      })),
    );

    const rotated = await rotationCoordinator.getAccessToken(
      coordinatorInput,
    );

    assert.equal(rotated.accessToken, "rotated-access-token");

    const credentialsAfterRotation =
      await getStoredCredentials(INTEGRATION_A_ID);

    assert.equal(
      credentialsAfterRotation.refreshToken,
      "rotated-refresh-token",
    );

    console.info("[PASS] Rotated refresh token persisted.");

    // 6. Concurrent workers must perform only one provider refresh.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "concurrent-expired-token",
      },
      expiredDate(),
    );

    let concurrentRefreshCalls = 0;

    const concurrentCoordinatorA =
      new OAuth2TokenCoordinatorService(
        createFakeRefresher(async () => {
          concurrentRefreshCalls++;

          // Keep the first worker busy while the second tries to acquire
          // the same integration's refresh lock.
          await new Promise((resolve) => setTimeout(resolve, 400));

          return {
            access_token: "concurrent-refreshed-token",
            token_type: "Bearer",
            expires_in: 3600,
          };
        }),
      );

    const concurrentCoordinatorB =
      new OAuth2TokenCoordinatorService(
        createFakeRefresher(async () => {
          concurrentRefreshCalls++;

          return {
            access_token: "unexpected-second-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          };
        }),
      );

    const [workerAResult, workerBResult] = await Promise.all([
      concurrentCoordinatorA.getAccessToken(coordinatorInput),
      concurrentCoordinatorB.getAccessToken(coordinatorInput),
    ]);

    assert.equal(concurrentRefreshCalls, 1);

    assert.equal(
      workerAResult.accessToken,
      "concurrent-refreshed-token",
    );

    assert.equal(
      workerBResult.accessToken,
      "concurrent-refreshed-token",
    );

    console.info("[PASS] Concurrent workers performed only one refresh.");
    console.info("[PASS] Waiting worker reused the persisted access token.");

        // 7. A long-running refresh must retain its lock through heartbeat renewal.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "long-running-expired-token",
      },
      expiredDate(),
    );

    let longRunningRefreshCalls = 0;

    const longRunningCoordinator = new OAuth2TokenCoordinatorService(
      createFakeRefresher(async () => {
        longRunningRefreshCalls++;

        // Simulate a provider request that outlasts the initial lock.
        await new Promise((resolve) => setTimeout(resolve, 1_600));

        return {
          access_token: "long-running-refreshed-token",
          token_type: "Bearer",
          expires_in: 3600,
        };
      }),
    );

    const shortLockInput = {
      ...coordinatorInput,
      lockDurationMs: 1_000,
      waitTimeoutMs: 5_000,
    };

    const longRunningPromise =
      longRunningCoordinator.getAccessToken(shortLockInput);

    // Wait beyond the original lock expiration.
    await new Promise((resolve) => setTimeout(resolve, 1_250));

    const activeLock =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: { id: INTEGRATION_A_ID },
        select: {
          tokenRefreshLockToken: true,
          tokenRefreshLockExpiresAt: true,
        },
      });

    assert.ok(activeLock.tokenRefreshLockToken);
    assert.ok(activeLock.tokenRefreshLockExpiresAt);
    assert.ok(
      activeLock.tokenRefreshLockExpiresAt.getTime() > Date.now(),
      "Heartbeat should keep the lock unexpired.",
    );

    // A competing worker must not acquire the renewed lock.
    const competingLock = await oauth2RefreshLockRepository.acquire({
      tenantId: TENANT_A_ID,
      integrationId: INTEGRATION_A_ID,
      lockDurationMs: 1_000,
    });

    assert.equal(competingLock, null);

    const longRunningResult = await longRunningPromise;

    assert.equal(
      longRunningResult.accessToken,
      "long-running-refreshed-token",
    );
    assert.equal(longRunningRefreshCalls, 1);

    console.info(
      "[PASS] Heartbeat keeps the lock active during long-running refresh.",
    );
    console.info(
      "[PASS] Competing worker cannot acquire a renewed refresh lock.",
    );

        // 8. Credential rotation during refresh must invalidate the old lock.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "rotation-test-expired-token",
      },
      expiredDate(),
    );

    const rotatedCredentialsDuringRefresh = {
      clientId: "new-test-client",
      clientSecret: "new-test-secret",
      refreshToken: "new-refresh-token",
      accessToken: "new-access-token",
    };

    const credentialRotationCoordinator =
      new OAuth2TokenCoordinatorService(
        createFakeRefresher(async () => {
          // Simulate credential rotation while the old worker is refreshing.
          // Rotation clears the old lock and replaces the saved credentials.
          await prisma.tenantIntegrationConfig.update({
            where: { id: INTEGRATION_A_ID },
            data: {
              credentialsEncrypted: encryptCredential(
                JSON.stringify(rotatedCredentialsDuringRefresh),
              ),
              tokenType: null,
              accessTokenExpiresAt: null,
              tokenRefreshLockToken: null,
              tokenRefreshLockExpiresAt: null,
            },
          });

          // Allow the heartbeat to detect that the old lock is gone.
          await new Promise((resolve) => setTimeout(resolve, 450));

          return {
            access_token: "stale-access-token",
            refresh_token: "stale-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          };
        }),
      );

    await assert.rejects(
      () =>
        credentialRotationCoordinator.getAccessToken(shortLockInput),
        /lock ownership was lost during token refresh/i,
    );

    const credentialsAfterConcurrentRotation =
      await getStoredCredentials(INTEGRATION_A_ID);

    assert.deepEqual(
      credentialsAfterConcurrentRotation,
      rotatedCredentialsDuringRefresh,
      "Old refresh operation must not overwrite rotated credentials.",
    );

    const lockAfterCredentialRotation =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: { id: INTEGRATION_A_ID },
        select: {
          tokenRefreshLockToken: true,
          tokenRefreshLockExpiresAt: true,
        },
      });

    assert.equal(lockAfterCredentialRotation.tokenRefreshLockToken, null);
    assert.equal(lockAfterCredentialRotation.tokenRefreshLockExpiresAt, null);

    console.info(
      "[PASS] Credential rotation invalidates the old refresh lock.",
    );
    console.info(
      "[PASS] Old refresh operation cannot overwrite rotated credentials.",
    );

    // 7. A provider failure must release the refresh lock.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "failed-refresh-expired-token",
      },
      expiredDate(),
    );

    const failingCoordinator = new OAuth2TokenCoordinatorService(
      createFakeRefresher(async () => {
        throw new Error("Simulated OAuth2 provider failure.");
      }),
    );

    await assert.rejects(
      () => failingCoordinator.getAccessToken(coordinatorInput),
      /Simulated OAuth2 provider failure/,
    );

    const afterProviderFailure =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: { id: INTEGRATION_A_ID },
        select: {
          tokenRefreshLockToken: true,
          tokenRefreshLockExpiresAt: true,
        },
      });

    assert.equal(afterProviderFailure.tokenRefreshLockToken, null);
    assert.equal(afterProviderFailure.tokenRefreshLockExpiresAt, null);

    console.info("[PASS] Provider failure releases the refresh lock.");

    // 8. A worker that loses lock ownership must not persist tokens.
    await setIntegrationState(
      INTEGRATION_A_ID,
      {
        ...originalCredentials,
        accessToken: "lost-lock-expired-token",
      },
      expiredDate(),
    );

    const replacementLockToken = randomUUID();

    const lostLockCoordinator = new OAuth2TokenCoordinatorService(
      createFakeRefresher(async () => {
        // Simulate another worker taking ownership while the provider
        // request is in progress.
        await prisma.tenantIntegrationConfig.update({
          where: { id: INTEGRATION_A_ID },
          data: {
            tokenRefreshLockToken: replacementLockToken,
            tokenRefreshLockExpiresAt: new Date(
              Date.now() + 60_000,
            ),
          },
        });

        return {
          access_token: "must-not-be-persisted",
          token_type: "Bearer",
          expires_in: 3600,
        };
      }),
    );

    await assert.rejects(
      () => lostLockCoordinator.getAccessToken(coordinatorInput),
      /lock ownership was lost/i,
    );

    const afterLostOwnership =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: { id: INTEGRATION_A_ID },
        select: {
          credentialsEncrypted: true,
          tokenRefreshLockToken: true,
        },
      });

    assert.equal(
      afterLostOwnership.tokenRefreshLockToken,
      replacementLockToken,
    );

    assert.equal(
      JSON.parse(
        decryptCredential(
          afterLostOwnership.credentialsEncrypted!,
        ),
      ).accessToken,
      "lost-lock-expired-token",
    );

    console.info("[PASS] Lost lock owner cannot persist refreshed tokens.");
    console.info("[PASS] New lock owner's token remains untouched.");

    // 9. Cross-tenant integration access must be rejected.
    const crossTenantCoordinator =
      new OAuth2TokenCoordinatorService(
        createFakeRefresher(async () => {
          throw new Error("Provider must not be called.");
        }),
      );

    await assert.rejects(
      () =>
        crossTenantCoordinator.getAccessToken({
          ...coordinatorInput,
          tenantId: TENANT_A_ID,
          integrationId: INTEGRATION_B_ID,
        }),
      /integration not found/i,
    );

    console.info("[PASS] Cross-tenant integration access rejected.");

    console.info("--------------------------------------");
    console.info("PASSED: 11");
    console.info("FAILED: 0");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");
  } finally {
    await prisma.tenantIntegrationConfig.deleteMany({
      where: {
        id: {
          in: [INTEGRATION_A_ID, INTEGRATION_B_ID],
        },
      },
    });

    await prisma.tenantConfig.deleteMany({
      where: {
        id: {
          in: [TENANT_A_ID, TENANT_B_ID],
        },
      },
    });

    await prisma.$disconnect();

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error: unknown) => {
  console.error("OAUTH2 TOKEN COORDINATOR TEST FAILED:", error);
  process.exitCode = 1;
});
