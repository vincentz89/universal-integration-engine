import "dotenv/config";

import assert from "node:assert/strict";
import {
  AxiosError,
  AxiosHeaders,
} from "axios";

import type {
  AxiosResponse,
} from "axios";

import {
  createAuthenticatedApiClient,
} from "../../src/infra/connectors/apiClient.js";

import {
  AuthenticationExecutor,
} from "../../src/infra/connectors/auth/auth.executor.js";

import {
  AuthenticationStrategyRegistry,
} from "../../src/infra/connectors/auth/auth.registry.js";

import {
  BearerAuthenticationStrategy,
} from "../../src/infra/connectors/auth/strategies/bearer.strategy.js";

import type {
  TenantCredentialService,
  TenantIntegrationCredentials,
} from "../../src/shared/services/tenant-credential.service.js";

// --------------------------------------------------
// TEST FIXTURES
// --------------------------------------------------

let credentialLookupCount = 0;

const integration: TenantIntegrationCredentials = {
  id: "integration-test",
  tenantId: "tenant-test",
  systemName: "TEST_PROVIDER",
  baseUrl: "https://api.example.com",
  authType: "BEARER",
  authConfig: null,
  credentials: {
    accessToken: "test-access-token",
  },
};

const credentialService = {
  async getIntegrationCredentials(
    tenantId: string,
    integrationId: string,
    expectedSystemName: string,
  ): Promise<TenantIntegrationCredentials> {
    credentialLookupCount++;

    if (
      tenantId !== integration.tenantId ||
      integrationId !== integration.id ||
      expectedSystemName !== integration.systemName
    ) {
      throw new Error("Tenant integration not found.");
    }

    return integration;
  },
} as unknown as TenantCredentialService;

const registry = new AuthenticationStrategyRegistry();

registry.register(new BearerAuthenticationStrategy());

const executor = new AuthenticationExecutor(
  registry,
  credentialService,
);

// --------------------------------------------------
// TESTS
// --------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;

  // 1. Authentication is applied to outgoing requests.
  let capturedAuthorization: unknown;

  const client = createAuthenticatedApiClient(
    {
      baseURL: "https://api.example.com",
      adapter: async (config) => {
        capturedAuthorization = AxiosHeaders
          .from(config.headers)
          .get("Authorization");

        return {
          data: { success: true },
          status: 200,
          statusText: "OK",
          headers: new AxiosHeaders(),
          config,
        };
      },
    },
    {
      tenantId: "tenant-test",
      integrationId: "integration-test",
      expectedSystemName: "TEST_PROVIDER",
      executor,
    },
  );

  const response = await client.get("/items");

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { success: true });
  assert.equal(
    capturedAuthorization,
    "Bearer test-access-token",
  );

  console.log("[PASS] Authentication applied to outgoing request.");
  passed++;

  // 2. Tenant credentials are retrieved for each request.
  assert.equal(credentialLookupCount, 1);

  await client.get("/items/2");

  assert.equal(credentialLookupCount, 2);

  console.log("[PASS] Tenant credentials retrieved per request.");
  passed++;

  // 3. Authentication is reapplied during retries.
  let adapterAttempts = 0;
  const retryAuthorizationHeaders: unknown[] = [];

  const retryClient = createAuthenticatedApiClient(
    {
      baseURL: "https://api.example.com",
      adapter: async (config) => {
        adapterAttempts++;

        retryAuthorizationHeaders.push(
          AxiosHeaders.from(config.headers).get("Authorization"),
        );

        if (adapterAttempts === 1) {
          const retryResponse: AxiosResponse = {
            data: { message: "Temporary failure" },
            status: 503,
            statusText: "Service Unavailable",
            headers: new AxiosHeaders(),
            config,
          };

          throw new AxiosError(
            "Service unavailable",
            "ERR_BAD_RESPONSE",
            config,
            undefined,
            retryResponse,
          );
        }

        return {
          data: { success: true },
          status: 200,
          statusText: "OK",
          headers: new AxiosHeaders(),
          config,
        };
      },
    },
    {
      tenantId: "tenant-test",
      integrationId: "integration-test",
      expectedSystemName: "TEST_PROVIDER",
      executor,
    },
    {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    },
  );

  const retryLookupCountBefore = credentialLookupCount;

  const retryResponse = await retryClient.get("/retry-test");

  assert.equal(retryResponse.status, 200);
  assert.equal(adapterAttempts, 2);

  assert.deepEqual(retryAuthorizationHeaders, [
    "Bearer test-access-token",
    "Bearer test-access-token",
  ]);

  assert.equal(
    credentialLookupCount - retryLookupCountBefore,
    2,
  );

  console.log("[PASS] Authentication reapplied during retry.");
  passed++;

  // 4. Cross-tenant access is rejected before HTTP execution.
  let unauthorizedAdapterCalls = 0;

  const isolatedClient = createAuthenticatedApiClient(
    {
      baseURL: "https://api.example.com",
      adapter: async (config) => {
        unauthorizedAdapterCalls++;

        return {
          data: {},
          status: 200,
          statusText: "OK",
          headers: new AxiosHeaders(),
          config,
        };
      },
    },
    {
      tenantId: "another-tenant",
      integrationId: "integration-test",
      expectedSystemName: "TEST_PROVIDER",
      executor,
    },
  );

  await assert.rejects(
    () => isolatedClient.get("/protected"),
    /Tenant integration not found/,
  );

  assert.equal(unauthorizedAdapterCalls, 0);

  console.log("[PASS] Cross-tenant request rejected before HTTP execution.");
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