import "dotenv/config";

import assert from "node:assert/strict";
import { AxiosHeaders } from "axios";

import {
  OAuth2AuthenticationStrategy,
} from "../../../src/infra/connectors/auth/strategies/oauth2.strategy.js";

import type {
  GetOAuth2AccessTokenInput,
} from "../../../src/shared/services/oauth2-token-coordinator.service.js";

import type {
  AuthenticationContext,
} from "../../../src/infra/connectors/auth/auth.types.js";

import type {
  OAuth2ProviderConfigResolver,
} from "../../../src/infra/connectors/auth/oauth2-provider-config.js";

import type {
  OAuth2TokenCoordinatorService,
} from "../../../src/shared/services/oauth2-token-coordinator.service.js";

async function main(): Promise<void> {
  let resolverCalls = 0;
  let coordinatorCalls = 0;

  const providerConfigResolver: OAuth2ProviderConfigResolver = {
    async resolve(input) {
      resolverCalls++;

      assert.equal(input.tenantId, "tenant-test");
      assert.equal(input.integrationId, "integration-test");
      assert.equal(input.systemName, "OAUTH_TEST");

      return {
        tokenEndpointConfig: {
          tokenUrl: "https://auth.example.com/oauth/token",
          clientAuthentication: "CLIENT_SECRET_BASIC",
        },
        allowedTokenHosts: ["auth.example.com"],
      };
    },
  };

  const tokenCoordinator = {
    async getAccessToken(input: GetOAuth2AccessTokenInput) {
      coordinatorCalls++;

      assert.equal(input.tenantId, "tenant-test");
      assert.equal(input.integrationId, "integration-test");
      assert.equal(input.expectedSystemName, "OAUTH_TEST");

      return {
        accessToken: "test-oauth-access-token",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    },
  } as unknown as OAuth2TokenCoordinatorService;

  const strategy = new OAuth2AuthenticationStrategy(
    providerConfigResolver,
    tokenCoordinator,
  );

  const context: AuthenticationContext<"OAUTH2"> & {
    tenantId: string;
    integrationId: string;
    systemName: string;
  } = {
    authType: "OAUTH2",
    tenantId: "tenant-test",
    integrationId: "integration-test",
    systemName: "OAUTH_TEST",
    credentials: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    },
  };

  // 1. Standard OAuth2 Bearer token authentication.
  const result = await strategy.apply({}, context);

  assert.ok(result.headers instanceof AxiosHeaders);

  assert.equal(
    result.headers.get("Authorization"),
    "Bearer test-oauth-access-token",
  );

  console.log("[PASS] OAuth2 Bearer authorization header generated.");

  // 2. Existing request headers are preserved.
  const preservedResult = await strategy.apply(
    {
      headers: {
        Accept: "application/json",
        "X-Custom-Header": "custom-value",
      },
    },
    context,
  );

  assert.ok(preservedResult.headers instanceof AxiosHeaders);

  assert.equal(
    preservedResult.headers.get("Accept"),
    "application/json",
  );

  assert.equal(
    preservedResult.headers.get("X-Custom-Header"),
    "custom-value",
  );

  assert.equal(
    preservedResult.headers.get("Authorization"),
    "Bearer test-oauth-access-token",
  );

  console.log("[PASS] Existing request headers preserved.");

  // 3. Missing tenant ID is rejected.
  const missingTenantContext: AuthenticationContext<"OAUTH2"> = {
    authType: "OAUTH2",
    integrationId: context.integrationId,
    systemName: context.systemName,
    credentials: context.credentials,
  };

  await assert.rejects(
    () => strategy.apply({}, missingTenantContext),
    /OAuth2 tenant ID is required/,
  );

  console.log("[PASS] Missing tenant ID rejected.");

  // 4. Missing integration ID is rejected.
  const missingIntegrationContext: AuthenticationContext<"OAUTH2"> = {
    authType: "OAUTH2",
    tenantId: context.tenantId,
    systemName: context.systemName,
    credentials: context.credentials,
  };

  await assert.rejects(
    () => strategy.apply({}, missingIntegrationContext),
    /OAuth2 integration ID is required/,
  );

  console.log("[PASS] Missing integration ID rejected.");

  // 5. Existing Authorization header is replaced.
  const replacedResult = await strategy.apply(
    {
      headers: {
        Authorization: "Basic old-credentials",
      },
    },
    context,
  );

  assert.ok(replacedResult.headers instanceof AxiosHeaders);

  assert.equal(
    replacedResult.headers.get("Authorization"),
    "Bearer test-oauth-access-token",
  );

  console.log("[PASS] Existing Authorization header replaced.");

  // 6. Provider resolver and token coordinator are used.
  assert.equal(resolverCalls, 3);
  assert.equal(coordinatorCalls, 3);

  console.log("[PASS] Trusted provider resolver and token coordinator invoked.");

  // 7. Missing system name is rejected before resolving provider config.
  const missingSystemNameContext: AuthenticationContext<"OAUTH2"> = {
    authType: "OAUTH2",
    tenantId: context.tenantId,
    integrationId: context.integrationId,
    credentials: context.credentials,
  };

  await assert.rejects(
    () => strategy.apply({}, missingSystemNameContext),
    /OAuth2 system name is required/,
  );

  assert.equal(resolverCalls, 3);
  assert.equal(coordinatorCalls, 3);

  console.log("[PASS] Missing system name rejected before token retrieval.");

  console.log("--------------------------------------");
  console.log("PASSED: 7");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main().catch((error: unknown) => {
  console.error("OAUTH2 STRATEGY TEST FAILED:", error);
  process.exitCode = 1;
});
