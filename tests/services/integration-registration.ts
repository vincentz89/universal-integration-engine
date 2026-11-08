
import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "../../src/shared/utils/db.js";
import {
  IntegrationRegistrationError,
  integrationRegistrationService,
} from "../../src/shared/services/integration-registration.service.js";

async function main(): Promise<void> {
  let passed = 0;

  const tenantIds: string[] = [];

  function pass(message: string): void {
    console.log(`[PASS] ${message}`);
    passed++;
  }

  async function createTenant(isActive = true): Promise<string> {
    const tenant = await prisma.tenantConfig.create({
      data: { isActive },
      select: { id: true },
    });

    tenantIds.push(tenant.id);
    return tenant.id;
  }

  function createAccountIdentity() {
    const id = randomUUID();

    return {
      externalAccountId: `registration-test-${id}`,
      externalAccountKey: `registration-test:${id}`,
    };
  }

  try {
    // 1. Register an account for an active tenant.
    const tenantA = await createTenant();
    const account = createAccountIdentity();

    const first = await integrationRegistrationService.register({
      tenantId: tenantA,
      systemName: "BIGCOMMERCE",
      ...account,
      baseUrl: "https://example.com",
      externalAccountMetadata: {
        environment: "test",
      },
    });

    assert.equal(first.tenantId, tenantA);
    assert.equal(first.systemName, "BIGCOMMERCE");
    assert.equal(first.externalAccountId, account.externalAccountId);
    assert.equal(first.externalAccountKey, account.externalAccountKey);
    assert.equal(first.isActive, true);
    assert.equal(first.created, true);

    pass("Active tenant can register a new provider account.");

    // 2. Re-register the same account for the same tenant.
    const second = await integrationRegistrationService.register({
      tenantId: tenantA,
      systemName: "BIGCOMMERCE",
      ...account,
      baseUrl: "https://different-example.com",
      externalAccountMetadata: {
        environment: "changed",
      },
    });

    assert.equal(second.integrationId, first.integrationId);
    assert.equal(second.created, false);

    const existingIntegration =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: { id: first.integrationId },
        select: {
          baseUrl: true,
          externalAccountMetadata: true,
          isActive: true,
        },
      });

    assert.equal(existingIntegration.baseUrl, "https://example.com");
    assert.deepEqual(existingIntegration.externalAccountMetadata, {
      environment: "test",
    });
    assert.equal(existingIntegration.isActive, true);

    pass("Repeated registration is idempotent and preserves existing configuration.");

    // 3. Reject registration of the same account by another tenant.
    const tenantB = await createTenant();

    await assert.rejects(
      () =>
        integrationRegistrationService.register({
          tenantId: tenantB,
          systemName: "BIGCOMMERCE",
          ...account,
        }),
      (error: unknown) =>
        error instanceof IntegrationRegistrationError &&
        error.code === "ACCOUNT_ALREADY_OWNED",
    );

    pass("Provider account cannot be registered to another tenant.");

    // 4. Reject a different external account ID using the same account key.
    await assert.rejects(
      () =>
        integrationRegistrationService.register({
          tenantId: tenantA,
          systemName: "BIGCOMMERCE",
          externalAccountId: `different-${randomUUID()}`,
          externalAccountKey: account.externalAccountKey,
        }),
      (error: unknown) =>
        error instanceof IntegrationRegistrationError &&
        error.code === "ACCOUNT_IDENTITY_MISMATCH",
    );

    pass("Existing account key cannot be reused with a different external account ID.");

    // 5. Reject registration for an inactive tenant.
    const inactiveTenant = await createTenant(false);

    await assert.rejects(
      () =>
        integrationRegistrationService.register({
          tenantId: inactiveTenant,
          systemName: "BIGCOMMERCE",
          ...createAccountIdentity(),
        }),
      (error: unknown) =>
        error instanceof IntegrationRegistrationError &&
        error.code === "TENANT_INACTIVE",
    );

    pass("Inactive tenant cannot register a provider account.");

    // 6. Reject registration for a nonexistent tenant.
    await assert.rejects(
      () =>
        integrationRegistrationService.register({
          tenantId: randomUUID(),
          systemName: "BIGCOMMERCE",
          ...createAccountIdentity(),
        }),
      (error: unknown) =>
        error instanceof IntegrationRegistrationError &&
        error.code === "TENANT_NOT_FOUND",
    );

    pass("Nonexistent tenant cannot register a provider account.");

    // 7. Reject invalid tenant identifiers.
    for (const tenantId of ["", "   "]) {
      await assert.rejects(
        () =>
          integrationRegistrationService.register({
            tenantId,
            systemName: "BIGCOMMERCE",
            ...createAccountIdentity(),
          }),
        (error: unknown) =>
          error instanceof IntegrationRegistrationError &&
          error.code === "INVALID_INPUT",
      );
    }

    pass("Empty and whitespace-only tenant IDs are rejected.");

    // 8. Reject invalid system names.
    for (const systemName of [
      "",
      "   ",
      "BigCommerce",
      "BIG COMMERCE",
      "bigcommerce",
    ]) {
      await assert.rejects(
        () =>
          integrationRegistrationService.register({
            tenantId: tenantA,
            systemName,
            ...createAccountIdentity(),
          }),
        (error: unknown) =>
          error instanceof IntegrationRegistrationError &&
          error.code === "INVALID_INPUT",
      );
    }

    pass("Invalid provider system names are rejected.");

    // 9. Reject empty external account identifiers.
    await assert.rejects(
      () =>
        integrationRegistrationService.register({
          tenantId: tenantA,
          systemName: "BIGCOMMERCE",
          externalAccountId: "",
          externalAccountKey: "valid-key",
        }),
      (error: unknown) =>
        error instanceof IntegrationRegistrationError &&
        error.code === "INVALID_INPUT",
    );

    await assert.rejects(
      () =>
        integrationRegistrationService.register({
          tenantId: tenantA,
          systemName: "BIGCOMMERCE",
          externalAccountId: "valid-id",
          externalAccountKey: "   ",
        }),
      (error: unknown) =>
        error instanceof IntegrationRegistrationError &&
        error.code === "INVALID_INPUT",
    );

    pass("Empty external account identifiers are rejected.");

    console.log("--------------------------------------");
    console.log(`PASSED: ${passed}`);
    console.log("FAILED: 0");
    console.log("FINAL RESULT: ALL TESTS PASSED");
  } finally {
    // Delete only the temporary tenants created by this test.
    if (tenantIds.length > 0) {
      await prisma.tenantConfig.deleteMany({
        where: {
          id: { in: tenantIds },
        },
      });
    }

    await prisma.$disconnect();
    console.log("[Test] Temporary database resources cleaned up.");
  }
}

main().catch(async (error: unknown) => {
  console.error("TEST FAILURE:", error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
