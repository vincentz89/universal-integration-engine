import assert from "node:assert/strict";

import {
  StaticOAuth2ProviderConfigResolver,
} from "../../../src/infra/connectors/auth/static-oauth2-provider-config-resolver.js";

import type {
  OAuth2ProviderConfig,
} from "../../../src/infra/connectors/auth/oauth2-provider-config.js";

// --------------------------------------------------
// TEST FIXTURES
// --------------------------------------------------

const providers: Record<string, OAuth2ProviderConfig> = {
  TEST_PROVIDER: {
    tokenEndpointConfig: {
      tokenUrl: "https://auth.example.com/oauth2/token",
      clientAuthentication: "CLIENT_SECRET_BASIC",
    },
    allowedTokenHosts: ["auth.example.com"],
  },

  SECOND_PROVIDER: {
    tokenEndpointConfig: {
      tokenUrl: "https://login.example.org/connect/token",
      clientAuthentication: "CLIENT_SECRET_POST",
    },
    allowedTokenHosts: ["login.example.org"],
  },
};

const resolver = new StaticOAuth2ProviderConfigResolver(providers);

// --------------------------------------------------
// TESTS
// --------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;

  // 1. Resolve a registered provider.
  const result = await resolver.resolve({
    tenantId: "tenant-a",
    integrationId: "integration-a",
    systemName: "TEST_PROVIDER",
  });

  assert.deepEqual(result, providers.TEST_PROVIDER);

  console.log("[PASS] Registered provider resolved.");
  passed++;

  // 2. Provider lookup is case-insensitive.
  const caseInsensitiveResult = await resolver.resolve({
    tenantId: "tenant-a",
    integrationId: "integration-a",
    systemName: "test_provider",
  });

  assert.deepEqual(caseInsensitiveResult, providers.TEST_PROVIDER);

  console.log("[PASS] Provider lookup is case-insensitive.");
  passed++;

  // 3. Different providers resolve independently.
  const secondResult = await resolver.resolve({
    tenantId: "tenant-b",
    integrationId: "integration-b",
    systemName: "SECOND_PROVIDER",
  });

  assert.deepEqual(secondResult, providers.SECOND_PROVIDER);

  console.log("[PASS] Multiple provider configurations are isolated.");
  passed++;

  // 4. Unknown provider is rejected.
  await assert.rejects(
    () =>
      resolver.resolve({
        tenantId: "tenant-a",
        integrationId: "integration-a",
        systemName: "UNKNOWN_PROVIDER",
      }),
    /not registered/,
  );

  console.log("[PASS] Unknown provider rejected.");
  passed++;

  // 5. Invalid tenant ID is rejected.
  await assert.rejects(
    () =>
      resolver.resolve({
        tenantId: " ",
        integrationId: "integration-a",
        systemName: "TEST_PROVIDER",
      }),
    /Tenant ID is required/,
  );

  console.log("[PASS] Empty tenant ID rejected.");
  passed++;

  // 6. Invalid integration ID is rejected.
  await assert.rejects(
    () =>
      resolver.resolve({
        tenantId: "tenant-a",
        integrationId: " ",
        systemName: "TEST_PROVIDER",
      }),
    /Integration ID is required/,
  );

  console.log("[PASS] Empty integration ID rejected.");
  passed++;

  // 7. Invalid provider name is rejected.
  await assert.rejects(
    () =>
      resolver.resolve({
        tenantId: "tenant-a",
        integrationId: "integration-a",
        systemName: " ",
      }),
    /Provider system name is required/,
  );

  console.log("[PASS] Empty provider name rejected.");
  passed++;

  console.log("--------------------------------------");
  console.log(`PASSED: ${passed}`);
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main().catch((error: unknown) => {
  console.error("TEST FAILURE:", error);
  process.exitCode = 1;
});