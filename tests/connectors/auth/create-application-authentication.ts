import "dotenv/config";
import assert from "node:assert/strict";

import {
  createApplicationAuthentication,
} from "../../../src/infra/connectors/auth/create-application-authentication.js";

import type {
  OAuth2ProviderConfig,
} from "../../../src/infra/connectors/auth/oauth2-provider-config.js";

const providers: Record<string, OAuth2ProviderConfig> = {
  TEST_PROVIDER: {
    tokenEndpointConfig: {
      tokenUrl: "https://auth.example.com/oauth2/token",
      clientAuthentication: "CLIENT_SECRET_BASIC",
    },
    allowedTokenHosts: ["auth.example.com"],
  },
};

async function main(): Promise<void> {
  let passed = 0;

  // 1. Application authentication components are created.
  const application = createApplicationAuthentication({
    oauth2Providers: providers,
  });

  assert.ok(application.executor);
  assert.ok(application.registry);
  assert.ok(application.providerResolver);

  console.log("[PASS] Application authentication components created.");
  passed++;

  // 2. All five authentication strategies are registered.
  const registeredTypes = application.registry
    .getRegisteredTypes()
    .sort();

  assert.deepEqual(registeredTypes, [
    "API_KEY",
    "BASIC",
    "BEARER",
    "NONE",
    "OAUTH2",
  ]);

  console.log("[PASS] All authentication strategies registered.");
  passed++;

  // 3. Trusted provider configuration is available.
  const provider = await application.providerResolver.resolve({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    systemName: "TEST_PROVIDER",
  });

  assert.deepEqual(provider, providers.TEST_PROVIDER);

  console.log("[PASS] Trusted provider configuration resolved.");
  passed++;

  // 4. Unknown providers are rejected.
  await assert.rejects(
    () =>
      application.providerResolver.resolve({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        systemName: "UNKNOWN_PROVIDER",
      }),
    /not registered/,
  );

  console.log("[PASS] Unknown provider rejected.");
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