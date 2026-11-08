
import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import { decryptCredential, encryptCredential } from "../../src/shared/security/credential-encryption.js";
import { tenantCredentialService } from "../../src/shared/services/tenant-credential.service.js";

async function main(): Promise<void> {
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  const integrationAId = randomUUID();
  const integrationBId = randomUUID();

  const originalCredentialsA = {
    clientId: "tenant-a-client",
    clientSecret: `tenant-a-secret-${randomUUID()}`,
    refreshToken: `tenant-a-refresh-${randomUUID()}`,
  };

  const originalCredentialsB = {
    clientId: "tenant-b-client",
    clientSecret: `tenant-b-secret-${randomUUID()}`,
    refreshToken: `tenant-b-refresh-${randomUUID()}`,
  };

  const originalEncryptedA = encryptCredential(
    JSON.stringify(originalCredentialsA),
  );

  const originalEncryptedB = encryptCredential(
    JSON.stringify(originalCredentialsB),
  );

  console.info("======================================");
  console.info("TENANT CREDENTIAL PERSISTENCE TEST");
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

    // 2. Create two OAuth2 integrations with encrypted credentials.
    await prisma.tenantIntegrationConfig.createMany({
      data: [
        {
          id: integrationAId,
          tenantId: tenantAId,
          systemName: "OAUTH_TEST",
          authType: "OAUTH2",
          credentialsEncrypted: originalEncryptedA,
          tokenType: "Bearer",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          tokenRefreshLockToken: randomUUID(),
          tokenRefreshLockExpiresAt: new Date(Date.now() + 60_000),
          isActive: true,
        },
        {
          id: integrationBId,
          tenantId: tenantBId,
          systemName: "OAUTH_TEST",
          authType: "OAUTH2",
          credentialsEncrypted: originalEncryptedB,
          tokenType: "Bearer",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          tokenRefreshLockToken: randomUUID(),
          tokenRefreshLockExpiresAt: new Date(Date.now() + 60_000),
          isActive: true,
        },
      ],
    });

    console.info("[Test] Two tenant integrations created.");

    // 3. Save replacement credentials for Tenant A.
    const updatedCredentials = {
      clientId: "tenant-a-updated-client",
      clientSecret: `updated-secret-${randomUUID()}`,
      refreshToken: `updated-refresh-${randomUUID()}`,
    };

    await tenantCredentialService.saveIntegrationCredentials({
      tenantId: tenantAId,
      integrationId: integrationAId,
      expectedSystemName: "OAUTH_TEST",
      authType: "OAUTH2",
      credentials: updatedCredentials,
    });

    console.info("[PASS] Tenant credentials successfully updated.");

    // 4. Verify that the database contains encrypted credentials.
    const storedA = await prisma.tenantIntegrationConfig.findUniqueOrThrow({
      where: { id: integrationAId },
      select: {
        credentialsEncrypted: true,
        authType: true,
        tokenType: true,
        accessTokenExpiresAt: true,
        tokenRefreshLockToken: true,
        tokenRefreshLockExpiresAt: true,
      },
    });

    assert.ok(storedA.credentialsEncrypted);
    assert.notEqual(
      storedA.credentialsEncrypted,
      JSON.stringify(updatedCredentials),
    );

    assert.deepEqual(
      JSON.parse(decryptCredential(storedA.credentialsEncrypted)),
      updatedCredentials,
    );

    assert.equal(storedA.authType, "OAUTH2");

    console.info("[PASS] Updated credentials are encrypted in the database.");

    // 5. Verify that the credential service can retrieve the new credentials.
    const retrievedA =
      await tenantCredentialService.getIntegrationCredentials(
        tenantAId,
        integrationAId,
        "OAUTH_TEST",
      );

    assert.deepEqual(retrievedA.credentials, updatedCredentials);
    assert.equal(retrievedA.tenantId, tenantAId);

    console.info("[PASS] Updated credentials decrypt correctly.");

        // 6. Verify that an empty credential object is accepted.
    await prisma.tenantIntegrationConfig.update({
      where: { id: integrationAId },
      data: {
        credentialsEncrypted: encryptCredential(JSON.stringify({})),
      },
    });

    const emptyCredentials =
      await tenantCredentialService.getIntegrationCredentials(
        tenantAId,
        integrationAId,
        "OAUTH_TEST",
      );

    assert.deepEqual(emptyCredentials.credentials, { });

    console.info("[PASS] Empty credential object is accepted.");

    // 7. Verify that malformed decrypted credential payloads are rejected.
    async function expectInvalidPayload(
      plaintext: string,
      expectedError: RegExp,
    ): Promise<void> {
      await prisma.tenantIntegrationConfig.update({
        where: { id: integrationAId },
        data: {
          credentialsEncrypted: encryptCredential(plaintext),
        },
      });

      await assert.rejects(
        () =>
          tenantCredentialService.getIntegrationCredentials(
            tenantAId,
            integrationAId,
            "OAUTH_TEST",
          ),
        expectedError,
      );
    }

    await expectInvalidPayload(
      "{ invalid json",
      /invalid JSON/,
    );

    console.info("[PASS] Invalid JSON credential payload rejected.");

    await expectInvalidPayload(
      "null",
      /must be an object/,
    );

    console.info("[PASS] Null credential payload rejected.");

    await expectInvalidPayload(
      "[]",
      /must be an object/,
    );

    console.info("[PASS] Array credential payload rejected.");

    await expectInvalidPayload(
      "123",
      /must be an object/,
    );

    console.info("[PASS] Numeric credential payload rejected.");

    await expectInvalidPayload(
      JSON.stringify({ accessToken: 123 }),
      /must be a string/,
    );

    console.info("[PASS] Non-string credential values rejected.");

    await expectInvalidPayload(
      JSON.stringify({ "": "invalid-value" }),
      /field names cannot be empty/,
    );

    console.info("[PASS] Empty credential field names rejected.");

    await expectInvalidPayload(
      JSON.stringify({ "   ": "invalid-value" }),
      /field names cannot be empty/,
    );

    console.info("[PASS] Whitespace-only credential field names rejected.");

    // 6. Verify that old token metadata and refresh ownership are cleared.
    assert.equal(storedA.tokenType, null);
    assert.equal(storedA.accessTokenExpiresAt, null);
    assert.equal(storedA.tokenRefreshLockToken, null);
    assert.equal(storedA.tokenRefreshLockExpiresAt, null);

    console.info("[PASS] Stale token metadata and refresh locks cleared.");

    // 7. Attempt to update Tenant B's integration using Tenant A's ID.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenantAId,
          integrationId: integrationBId,
          expectedSystemName: "OAUTH_TEST",
          authType: "OAUTH2",
          credentials: {
            clientId: "unauthorized-client",
            clientSecret: "unauthorized-secret",
            refreshToken: "unauthorized-refresh",
          },
        }),
      /does not belong to the specified tenant/,
    );

    console.info("[PASS] Cross-tenant credential update rejected.");

    // 8. Verify that Tenant B's original credentials remain unchanged.
    const storedB = await prisma.tenantIntegrationConfig.findUniqueOrThrow({
      where: { id: integrationBId },
      select: {
        credentialsEncrypted: true,
        tokenType: true,
        accessTokenExpiresAt: true,
        tokenRefreshLockToken: true,
        tokenRefreshLockExpiresAt: true,
      },
    });

    assert.ok(storedB.credentialsEncrypted);

    assert.deepEqual(
      JSON.parse(decryptCredential(storedB.credentialsEncrypted)),
      originalCredentialsB,
    );

    assert.equal(storedB.tokenType, "Bearer");
    assert.ok(storedB.accessTokenExpiresAt);
    assert.ok(storedB.tokenRefreshLockToken);
    assert.ok(storedB.tokenRefreshLockExpiresAt);

    console.info("[PASS] Tenant B credentials and token state unchanged.");

    // 9. Verify that nonexistent integrations cannot be updated.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenantAId,
          integrationId: randomUUID(),
          expectedSystemName: "OAUTH_TEST",
          authType: "OAUTH2",
          credentials: {
            clientId: "missing-client",
            clientSecret: "missing-secret",
            refreshToken: "missing-refresh",
          },
        }),
      /does not belong to the specified tenant/,
    );

    console.info("[PASS] Nonexistent integration update rejected.");

    console.info("--------------------------------------");
    console.info("PASSED: 15");
    console.info("FAILED: 0");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");
  } finally {
    // Remove only the records created by this test.
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
  console.error("TENANT CREDENTIAL PERSISTENCE TEST FAILED:", error);
  process.exitCode = 1;
});
