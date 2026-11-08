
import "dotenv/config";

import assert from "node:assert/strict";
import { AxiosHeaders } from "axios";

import {
  AuthenticationExecutor,
} from "../../../src/infra/connectors/auth/auth.executor.js";

import {
  createDefaultAuthenticationRegistry,
} from "../../../src/infra/connectors/auth/create-auth-registry.js";

import type {
  OAuth2ProviderConfigResolver,
} from "../../../src/infra/connectors/auth/oauth2-provider-config.js";

import type {
  OAuth2TokenCoordinatorService,
  GetOAuth2AccessTokenInput,
} from "../../../src/shared/services/oauth2-token-coordinator.service.js";

import type {
  TenantCredentialService,
  TenantIntegrationCredentials,
} from "../../../src/shared/services/tenant-credential.service.js";

// --------------------------------------------------
// TEST FIXTURES
// --------------------------------------------------

const credentialLookups: Array<{
  tenantId: string;
  integrationId: string;
  systemName: string;
}> = [];

let integration: TenantIntegrationCredentials = {
  id: "integration-test",
  tenantId: "tenant-test",
  systemName: "TEST_PROVIDER",
  baseUrl: "https://api.example.com",
  authType: "NONE",
  authConfig: null,
  credentials: {},
};

const credentialService = {
  async getIntegrationCredentials(
    tenantId: string,
    integrationId: string,
    expectedSystemName: string,
  ): Promise<TenantIntegrationCredentials> {
    credentialLookups.push({
      tenantId,
      integrationId,
      systemName: expectedSystemName,
    });

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

const providerResolver: OAuth2ProviderConfigResolver = {
  async resolve(input) {
    assert.equal(input.tenantId, "tenant-test");
    assert.equal(input.integrationId, "integration-test");
    assert.equal(input.systemName, "TEST_PROVIDER");

    return {
      tokenEndpointConfig: {
        tokenUrl: "https://auth.example.com/oauth2/token",
        clientAuthentication: "CLIENT_SECRET_BASIC",
      },
      allowedTokenHosts: ["auth.example.com"],
    };
  },
};

const tokenCoordinator = {
  async getAccessToken(input: GetOAuth2AccessTokenInput) {
    assert.equal(input.tenantId, "tenant-test");
    assert.equal(input.integrationId, "integration-test");
    assert.equal(input.expectedSystemName, "TEST_PROVIDER");

    return {
      accessToken: "oauth2-test-access-token",
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  },
} as unknown as OAuth2TokenCoordinatorService;

const registry = createDefaultAuthenticationRegistry({
  oauth2ProviderConfigResolver: providerResolver,
  oauth2TokenCoordinator: tokenCoordinator,
});

const executor = new AuthenticationExecutor(
  registry,
  credentialService,
);

const request = {
  method: "GET",
  url: "https://api.example.com/items",
};

function getHeader(
  headers: unknown,
  name: string,
): unknown {
  const normalizedHeaders = new AxiosHeaders();

  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        normalizedHeaders.set(key, value);
      }
    }
  }

  return normalizedHeaders.get(name);
}

function setIntegration(
  authType: TenantIntegrationCredentials["authType"],
  credentials: Record<string, string>,
  authConfig: Record<string, unknown> | null = null,
): void {
  integration = {
    id: "integration-test",
    tenantId: "tenant-test",
    systemName: "TEST_PROVIDER",
    baseUrl: "https://api.example.com",
    authType,
    authConfig,
    credentials,
  };
}

// --------------------------------------------------
// TESTS
// --------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;

  function pass(message: string): void {
    console.log(`[PASS] ${message}`);
    passed++;
  }

  // 1. NONE authentication removes standard authentication headers.
  setIntegration("NONE", {});

  const noneResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request: {
      ...request,
      headers: {
        Authorization: "Bearer stale-token",
        "Proxy-Authorization": "Basic stale-token",
        Accept: "application/json",
      },
    },
  });

  assert.equal(
    getHeader(noneResult.headers, "Authorization"),
    undefined,
  );

  assert.equal(
    getHeader(noneResult.headers, "Proxy-Authorization"),
    undefined,
  );

  assert.equal(
    getHeader(noneResult.headers, "Accept"),
    "application/json",
  );

  pass("NONE removes stale standard authentication headers.");

  // 2. API_KEY HEADER authentication.
  setIntegration(
    "API_KEY",
    {
      apiKey: "test-api-key",
    },
    {
      location: "HEADER",
      parameterName: "X-Test-API-Key",
    },
  );

  const apiKeyResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request: {
      ...request,
      headers: {
        Authorization: "Bearer stale-token",
        Accept: "application/json",
      },
    },
  });

  assert.equal(
    getHeader(apiKeyResult.headers, "X-Test-API-Key"),
    "test-api-key",
  );

  assert.equal(
    getHeader(apiKeyResult.headers, "Authorization"),
    undefined,
  );

  assert.equal(
    getHeader(apiKeyResult.headers, "Accept"),
    "application/json",
  );

  pass("API_KEY HEADER authentication applied and stale Authorization removed.");

  // 3. API_KEY HEADER authentication with API secret.
  setIntegration(
    "API_KEY",
    {
      apiKey: "test-api-key",
      apiSecret: "test-api-secret",
    },
    {
      location: "HEADER",
      parameterName: "X-Test-API-Key",
      secretHeaderName: "X-Test-API-Secret",
    },
  );

  const apiKeySecretResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request,
  });

  assert.equal(
    getHeader(apiKeySecretResult.headers, "X-Test-API-Key"),
    "test-api-key",
  );

  assert.equal(
    getHeader(apiKeySecretResult.headers, "X-Test-API-Secret"),
    "test-api-secret",
  );

  pass("API_KEY and API secret applied to separate headers.");

  // 4. API_KEY QUERY authentication.
  setIntegration(
    "API_KEY",
    {
      apiKey: "test-query-api-key",
    },
    {
      location: "QUERY",
      parameterName: "api_key",
    },
  );

  const queryResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request: {
      ...request,
      params: {
        page: 2,
        limit: 50,
      },
    },
  });

  assert.deepEqual(queryResult.params, {
    page: 2,
    limit: 50,
    api_key: "test-query-api-key",
  });

  pass("API_KEY QUERY authentication preserves existing query parameters.");

    // 4.1 API_KEY QUERY removes stale authentication headers.
  const queryHeaderResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request: {
      ...request,
      headers: {
        Authorization: "Bearer stale-token",
        "Proxy-Authorization": "Basic stale-proxy-token",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      params: {
        page: 2,
      },
    },
  });

  assert.deepEqual(queryHeaderResult.params, {
    page: 2,
    api_key: "test-query-api-key",
  });

  assert.equal(
    getHeader(queryHeaderResult.headers, "Authorization"),
    undefined,
  );

  assert.equal(
    getHeader(queryHeaderResult.headers, "Proxy-Authorization"),
    undefined,
  );

  assert.equal(
    getHeader(queryHeaderResult.headers, "Accept"),
    "application/json",
  );

  assert.equal(
    getHeader(queryHeaderResult.headers, "Content-Type"),
    "application/json",
  );

  pass("API_KEY QUERY removes stale authentication headers and preserves unrelated headers.");

  // 5. API_KEY QUERY authentication overwrites a caller-supplied key.
  const overwrittenQueryResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request: {
      ...request,
      params: {
        api_key: "untrusted-caller-key",
        page: 3,
      },
    },
  });

  assert.deepEqual(overwrittenQueryResult.params, {
    api_key: "test-query-api-key",
    page: 3,
  });

  pass("API_KEY QUERY authentication overrides caller-supplied API key.");

  // 6. Reject API secret in QUERY mode.
  setIntegration(
    "API_KEY",
    {
      apiKey: "test-api-key",
      apiSecret: "test-api-secret",
    },
    {
      location: "QUERY",
      parameterName: "api_key",
    },
  );

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /API secret requires header-based authentication/,
  );

  pass("API secret rejected in QUERY authentication mode.");

  // 7. Reject missing API key.
  setIntegration(
    "API_KEY",
    {},
    {
      location: "HEADER",
      parameterName: "X-Test-API-Key",
    },
  );

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /API key credential is missing/,
  );

  pass("Missing API key rejected.");

    // 7.1 Reject Authorization as an API key header.
  setIntegration(
    "API_KEY",
    {
      apiKey: "test-api-key",
    },
    {
      location: "HEADER",
      parameterName: "Authorization",
    },
  );

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Reserved HTTP header cannot be used/,
  );

  pass("API_KEY rejects Authorization as a custom header.");

  const expectedBasic = Buffer.from(
    "test-user:test-password",
    "utf8",
  ).toString("base64");

  // 8. BASIC authentication.
  setIntegration("BASIC", {
    username: "test-user",
    password: "test-password",
  });


  // 8.1 Reject empty username.
  setIntegration("BASIC", {
    username: "",
    password: "test-password",
  });

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Basic authentication username is missing/,
  );

  pass("BASIC rejects empty username.");

  // 8.2 Reject whitespace-only username.
  setIntegration("BASIC", {
    username: "   ",
    password: "test-password",
  });

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Basic authentication username is missing/,
  );

  pass("BASIC rejects whitespace-only username.");

  // 8.3 Reject empty password.
  setIntegration("BASIC", {
    username: "test-user",
    password: "",
  });

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Basic authentication password is missing/,
  );

  pass("BASIC rejects empty password.");

  // 8.4 Reject whitespace-only password.
  setIntegration("BASIC", {
    username: "test-user",
    password: "   ",
  });

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Basic authentication password is missing/,
  );

  pass("BASIC rejects whitespace-only password.");

  // 8.5 Reject username containing a colon.
  setIntegration("BASIC", {
    username: "test:user",
    password: "test-password",
  });

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /username cannot contain a colon/,
  );

  pass("BASIC rejects usernames containing a colon.");

  // 8.6 Verify UTF-8 encoding with Unicode credentials.
  setIntegration("BASIC", {
    username: "utilisateur-é",
    password: "密碼-ñ",
  });

  const unicodeBasicResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request,
  });

  const expectedUnicodeBasic = Buffer.from(
    "utilisateur-é:密碼-ñ",
    "utf8",
  ).toString("base64");

  assert.equal(
    getHeader(unicodeBasicResult.headers, "Authorization"),
    `Basic ${expectedUnicodeBasic}`,
  );

  pass("BASIC correctly encodes Unicode credentials.");

  // 8.7 Preserve unrelated and proxy authentication headers.
  setIntegration("BASIC", {
    username: "test-user",
    password: "test-password",
  });

  const basicHeaderResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request: {
      ...request,
      headers: {
        Authorization: "Bearer stale-token",
        "Proxy-Authorization": "Basic proxy-credentials",
        Accept: "application/json",
      },
    },
  });

  assert.equal(
    getHeader(basicHeaderResult.headers, "Authorization"),
    `Basic ${expectedBasic}`,
  );

  assert.equal(
    getHeader(basicHeaderResult.headers, "Proxy-Authorization"),
    "Basic proxy-credentials",
  );

  assert.equal(
    getHeader(basicHeaderResult.headers, "Accept"),
    "application/json",
  );

  pass("BASIC replaces Authorization and preserves other headers.");


  const basicResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request,
  });

  assert.equal(
    getHeader(basicResult.headers, "Authorization"),
    `Basic ${expectedBasic}`,
  );

  pass("BASIC authentication executed.");

  // 9. BEARER authentication.
  setIntegration("BEARER", {
    accessToken: "test-bearer-token",
  });

  const bearerResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request,
  });

  assert.equal(
    getHeader(bearerResult.headers, "Authorization"),
    "Bearer test-bearer-token",
  );

  pass("BEARER authentication executed.");


  // 9.1 Custom header with raw token.
  setIntegration(
    "BEARER",
    {
      accessToken: "test-custom-token",
    },
    {
      headerName: "X-Auth-Token",
      scheme: "",
    },
  );

  const customBearerResult = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request: {
      ...request,
      headers: {
        Authorization: "Bearer stale-token",
        "Proxy-Authorization": "Basic proxy-credentials",
        Accept: "application/json",
      },
    },
  });

  assert.equal(
    getHeader(customBearerResult.headers, "X-Auth-Token"),
    "test-custom-token",
  );

  assert.equal(
    getHeader(customBearerResult.headers, "Authorization"),
    undefined,
  );

  assert.equal(
    getHeader(customBearerResult.headers, "Proxy-Authorization"),
    "Basic proxy-credentials",
  );

  assert.equal(
    getHeader(customBearerResult.headers, "Accept"),
    "application/json",
  );

  pass("BEARER supports custom headers and raw tokens.");

  // 9.2 Reject whitespace-only access token.
  setIntegration("BEARER", {
    accessToken: "   ",
  });

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Bearer authentication access token is missing or invalid/,
  );

  pass("BEARER rejects whitespace-only access tokens.");

  // 9.3 Reject access tokens with leading or trailing whitespace.
  setIntegration("BEARER", {
    accessToken: " test-token ",
  });

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Bearer authentication access token is missing or invalid/,
  );

  pass("BEARER rejects access tokens with surrounding whitespace.");

  // 9.4 Reject invalid custom header names.
  setIntegration(
    "BEARER",
    {
      accessToken: "test-token",
    },
    {
      headerName: "Invalid Header",
    },
  );

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Invalid bearer authentication header name/,
  );

  pass("BEARER rejects invalid custom header names.");

  // 9.5 Reject invalid authentication schemes.
  setIntegration(
    "BEARER",
    {
      accessToken: "test-token",
    },
    {
      headerName: "Authorization",
      scheme: "Bearer Scheme With Spaces",
    },
  );

  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "tenant-test",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Invalid bearer authentication scheme/,
  );

  pass("BEARER rejects invalid authentication schemes.");

  // 10. OAUTH2 authentication.
  setIntegration("OAUTH2", {
    clientId: "test-client",
    clientSecret: "test-secret",
    refreshToken: "test-refresh-token",
  });

  const oauth2Result = await executor.execute({
    tenantId: "tenant-test",
    integrationId: "integration-test",
    expectedSystemName: "TEST_PROVIDER",
    request,
  });

  assert.equal(
    getHeader(oauth2Result.headers, "Authorization"),
    "Bearer oauth2-test-access-token",
  );

  pass("OAUTH2 authentication executed.");

  // 11. Tenant isolation.
  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "another-tenant",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Tenant integration not found/,
  );

  pass("Cross-tenant credential access rejected.");

  // 12. Invalid execution input.
  await assert.rejects(
    () =>
      executor.execute({
        tenantId: "",
        integrationId: "integration-test",
        expectedSystemName: "TEST_PROVIDER",
        request,
      }),
    /Authentication tenant ID is required/,
  );

  pass("Invalid tenant input rejected.");

  // Verify tenant identifiers were passed to credential retrieval.
  assert.equal(credentialLookups.length, 25);

  assert.ok(
    credentialLookups.every(
      (lookup) =>
        lookup.tenantId === "tenant-test" ||
        lookup.tenantId === "another-tenant",
    ),
  );

  pass("Tenant context propagated to credential service.");

  console.log("--------------------------------------");
  console.log(`PASSED: ${passed}`);
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
