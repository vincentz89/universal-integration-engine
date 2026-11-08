
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

  async function createTenant(): Promise<string> {
    const tenant = await prisma.tenantConfig.create({
      data: {},
      select: { id: true },
    });

    tenantIds.push(tenant.id);
    return tenant.id;
  }

  function createAccountIdentity() {
    const id = randomUUID();

    return {
      externalAccountId: `concurrency-test-${id}`,
      externalAccountKey: `concurrency-test:${id}`,
    };
  }

  try {
    // 1. Concurrent registration by different tenants.
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const accountA = createAccountIdentity();

    const differentTenantResults = await Promise.allSettled([
      integrationRegistrationService.register({
        tenantId: tenantA,
        systemName: "BIGCOMMERCE",
        ...accountA,
      }),
      integrationRegistrationService.register({
        tenantId: tenantB,
        systemName: "BIGCOMMERCE",
        ...accountA,
      }),
    ]);

    const successfulRegistrations = differentTenantResults.filter(
      (result) => result.status === "fulfilled",
    );

    const rejectedRegistrations = differentTenantResults.filter(
      (result) => result.status === "rejected",
    );

    assert.equal(successfulRegistrations.length, 1);
    assert.equal(rejectedRegistrations.length, 1);

    const successfulRegistration = successfulRegistrations[0];

    assert.ok(successfulRegistration);
    assert.equal(successfulRegistration.value.created, true);

    const rejectedRegistration = rejectedRegistrations[0];

    assert.ok(rejectedRegistration);
    assert.ok(
      rejectedRegistration.reason instanceof IntegrationRegistrationError,
    );
    assert.equal(
      rejectedRegistration.reason.code,
      "ACCOUNT_ALREADY_OWNED",
    );

    const registeredAccount =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: {
          systemName_externalAccountKey: {
            systemName: "BIGCOMMERCE",
            externalAccountKey: accountA.externalAccountKey,
          },
        },
        select: {
          id: true,
          tenantId: true,
          externalAccountId: true,
        },
      });

    assert.equal(
      registeredAccount.tenantId,
      successfulRegistration.value.tenantId,
    );
    assert.equal(
      registeredAccount.externalAccountId,
      accountA.externalAccountId,
    );

    pass("Concurrent registration by different tenants allows exactly one account owner.");

    // 2. Concurrent registration by the same tenant.
    const tenantC = await createTenant();
    const accountB = createAccountIdentity();

    const sameTenantResults = await Promise.all([
      integrationRegistrationService.register({
        tenantId: tenantC,
        systemName: "BIGCOMMERCE",
        ...accountB,
      }),
      integrationRegistrationService.register({
        tenantId: tenantC,
        systemName: "BIGCOMMERCE",
        ...accountB,
      }),
    ]);

    assert.equal(sameTenantResults.length, 2);
    assert.equal(
      sameTenantResults[0].integrationId,
      sameTenantResults[1].integrationId,
    );
    assert.equal(sameTenantResults[0].tenantId, tenantC);
    assert.equal(sameTenantResults[1].tenantId, tenantC);

    assert.equal(
      sameTenantResults.filter((result) => result.created).length,
      1,
    );

    assert.equal(
      sameTenantResults.filter((result) => !result.created).length,
      1,
    );

    const matchingIntegrations =
      await prisma.tenantIntegrationConfig.count({
        where: {
          tenantId: tenantC,
          systemName: "BIGCOMMERCE",
          externalAccountKey: accountB.externalAccountKey,
        },
      });

    assert.equal(matchingIntegrations, 1);

    pass("Concurrent registration by the same tenant reuses one integration.");


    // 3. Concurrent registration with the same account key but different account IDs.
    const tenantD = await createTenant();
    const conflictingAccount = createAccountIdentity();

    const conflictingResults = await Promise.allSettled([
      integrationRegistrationService.register({
        tenantId: tenantD,
        systemName: "BIGCOMMERCE",
        externalAccountId: conflictingAccount.externalAccountId,
        externalAccountKey: conflictingAccount.externalAccountKey,
      }),
      integrationRegistrationService.register({
        tenantId: tenantD,
        systemName: "BIGCOMMERCE",
        externalAccountId: `different-${randomUUID()}`,
        externalAccountKey: conflictingAccount.externalAccountKey,
      }),
    ]);

    const conflictingSuccesses = conflictingResults.filter(
      (result) => result.status === "fulfilled",
    );

    const conflictingFailures = conflictingResults.filter(
      (result) => result.status === "rejected",
    );

    assert.equal(conflictingSuccesses.length, 1);
    assert.equal(conflictingFailures.length, 1);

    const conflictFailure = conflictingFailures[0];

    assert.ok(conflictFailure);
    assert.ok(
      conflictFailure.reason instanceof IntegrationRegistrationError,
    );
    assert.equal(
      conflictFailure.reason.code,
      "ACCOUNT_IDENTITY_MISMATCH",
    );

    const storedConflict =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: {
          systemName_externalAccountKey: {
            systemName: "BIGCOMMERCE",
            externalAccountKey: conflictingAccount.externalAccountKey,
          },
        },
        select: {
          tenantId: true,
          externalAccountId: true,
        },
      });

    assert.equal(storedConflict.tenantId, tenantD);
    assert.ok(
      conflictingSuccesses[0]?.status === "fulfilled" &&
      storedConflict.externalAccountId ===
        conflictingSuccesses[0].value.externalAccountId,
    );

    pass("Concurrent conflicting account IDs cannot overwrite the registered identity.");

    console.log("--------------------------------------");
    console.log(`PASSED: ${passed}`);
    console.log("FAILED: 0");
    console.log("FINAL RESULT: ALL TESTS PASSED");
  } finally {
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
