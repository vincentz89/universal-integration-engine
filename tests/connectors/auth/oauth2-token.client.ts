
import assert from "node:assert/strict";

import {
  refreshOAuth2AccessToken,
} from "../../../src/infra/connectors/auth/oauth2-token.client.js";

import type {
  OAuth2TokenHttpClient,
} from "../../../src/infra/connectors/auth/oauth2-token.client.js";

import type {
  OAuth2Credentials,
} from "../../../src/infra/connectors/auth/auth.types.js";

const credentials: OAuth2Credentials = {
  clientId: "test-client",
  clientSecret: "test-secret",
  refreshToken: "test-refresh-token",
};

const allowedTokenHosts = ["auth.example.com"];

function createMockClient(
  responseData: unknown,
  onRequest?: (
    url: string,
    body: string,
    config: Record<string, unknown>,
  ) => void,
): OAuth2TokenHttpClient {
  return {
    async post(url, body, config) {
      onRequest?.(
        url,
        body,
        config as unknown as Record<string, unknown>,
      );

      return { data: responseData };
    },
  };
}

async function main(): Promise<void> {
  // 1. CLIENT_SECRET_BASIC request.
  let basicAuthorization = "";

  const basicClient = createMockClient(
    {
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh-token",
    },
    (_url, _body, config) => {
      const headers = config.headers as Record<string, string>;
      basicAuthorization = headers.Authorization ?? "";
    },
  );

  const basicResult = await refreshOAuth2AccessToken(
    {
      config: {
        tokenUrl: "https://auth.example.com/oauth/token",
        clientAuthentication: "CLIENT_SECRET_BASIC",
      },
      credentials,
      allowedTokenHosts,
    },
    basicClient,
  );

  const encodedCredentials = Buffer.from(
    "test-client:test-secret",
    "utf8",
  ).toString("base64");

  assert.equal(
    basicAuthorization,
    `Basic ${encodedCredentials}`,
  );
  assert.equal(basicResult.access_token, "new-access-token");
  assert.equal(basicResult.refresh_token, "new-refresh-token");

  console.log("[PASS] CLIENT_SECRET_BASIC refresh request.");

    // 2. CLIENT_SECRET_BASIC correctly encodes special characters.
  const specialCredentials: OAuth2Credentials = {
    clientId: "client+id",
    clientSecret: "secret:with space",
    refreshToken: "refresh-token",
  };

  let specialAuthorization = "";

  const specialClient = createMockClient(
    {
      access_token: "special-access-token",
      token_type: "Bearer",
    },
    (_url, _body, config) => {
      const headers = config.headers as Record<string, string>;
      specialAuthorization = headers.Authorization ?? "";
    },
  );

  await refreshOAuth2AccessToken(
    {
      config: {
        tokenUrl: "https://auth.example.com/oauth/token",
        clientAuthentication: "CLIENT_SECRET_BASIC",
      },
      credentials: specialCredentials,
      allowedTokenHosts,
    },
    specialClient,
  );

  const expectedSpecialCredentials = Buffer.from(
    "client%2Bid:secret%3Awith+space",
    "utf8",
  ).toString("base64");

  assert.equal(
    specialAuthorization,
    `Basic ${expectedSpecialCredentials}`,
  );

  console.log("[PASS] Special characters correctly encoded in Basic authentication.");

  // 2. CLIENT_SECRET_POST request.
  let postBody = "";

  const postClient = createMockClient(
    {
      access_token: "post-access-token",
      token_type: "Bearer",
      expires_in: 1800,
    },
    (_url, body) => {
      postBody = body;
    },
  );

  await refreshOAuth2AccessToken(
    {
      config: {
        tokenUrl: "https://auth.example.com/oauth/token",
        clientAuthentication: "CLIENT_SECRET_POST",
      },
      credentials,
      allowedTokenHosts,
    },
    postClient,
  );

  const postParams = new URLSearchParams(postBody);

  assert.equal(postParams.get("grant_type"), "refresh_token");
  assert.equal(postParams.get("refresh_token"), "test-refresh-token");
  assert.equal(postParams.get("client_id"), "test-client");
  assert.equal(postParams.get("client_secret"), "test-secret");

  console.log("[PASS] CLIENT_SECRET_POST refresh request.");

  // 3. Optional scope and audience.
  let extendedBody = "";

  const extendedClient = createMockClient(
    {
      access_token: "extended-access-token",
      token_type: "Bearer",
    },
    (_url, body) => {
      extendedBody = body;
    },
  );

  await refreshOAuth2AccessToken(
    {
      config: {
        tokenUrl: "https://auth.example.com/oauth/token",
        clientAuthentication: "CLIENT_SECRET_POST",
        scope: "products.read inventory.write",
        audience: "https://api.example.com",
      },
      credentials,
      allowedTokenHosts,
    },
    extendedClient,
  );

  const extendedParams = new URLSearchParams(extendedBody);

  assert.equal(
    extendedParams.get("scope"),
    "products.read inventory.write",
  );
  assert.equal(
    extendedParams.get("audience"),
    "https://api.example.com",
  );

  console.log("[PASS] Optional scope and audience included.");

  // 4. Untrusted token host rejected before HTTP request.
  let untrustedHostRequestMade = false;

  const untrustedClient = createMockClient(
    { access_token: "unused-token", token_type: "Bearer" },
    () => {
      untrustedHostRequestMade = true;
    },
  );

  await assert.rejects(
    () =>
      refreshOAuth2AccessToken(
        {
          config: {
            tokenUrl: "https://untrusted.example.com/token",
          },
          credentials,
          allowedTokenHosts,
        },
        untrustedClient,
      ),
    /not in the trusted allowlist/,
  );

  assert.equal(untrustedHostRequestMade, false);

  console.log("[PASS] Untrusted token host rejected.");

  // 5. Non-HTTPS endpoint rejected.
  await assert.rejects(
    () =>
      refreshOAuth2AccessToken(
        {
          config: {
            tokenUrl: "http://auth.example.com/token",
          },
          credentials,
          allowedTokenHosts,
        },
        basicClient,
      ),
    /Invalid OAuth2 token endpoint configuration/,
  );

  console.log("[PASS] Non-HTTPS token endpoint rejected.");

  // 6. Missing refresh token rejected.
  await assert.rejects(
    () =>
      refreshOAuth2AccessToken(
        {
          config: {
            tokenUrl: "https://auth.example.com/token",
          },
          credentials: {
            clientId: "test-client",
            clientSecret: "test-secret",
          },
          allowedTokenHosts,
        },
        basicClient,
      ),
    /OAuth2 refresh token is missing/,
  );

  console.log("[PASS] Missing refresh token rejected.");

  // 7. Invalid token response rejected.
  const invalidResponseClient = createMockClient({
    token_type: "Bearer",
    expires_in: 3600,
  });

  await assert.rejects(
    () =>
      refreshOAuth2AccessToken(
        {
          config: {
            tokenUrl: "https://auth.example.com/token",
          },
          credentials,
          allowedTokenHosts,
        },
        invalidResponseClient,
      ),
    /invalid token response/,
  );

  console.log("[PASS] Invalid token response rejected.");

  // 8. Unsupported token type rejected.
  const unsupportedTokenTypeClient = createMockClient({
    access_token: "test-access-token",
    token_type: "MAC",
  });

  await assert.rejects(
    () =>
      refreshOAuth2AccessToken(
        {
          config: {
            tokenUrl: "https://auth.example.com/token",
          },
          credentials,
          allowedTokenHosts,
        },
        unsupportedTokenTypeClient,
      ),
    /unsupported token type/,
  );

  console.log("[PASS] Unsupported token type rejected.");

  console.log("--------------------------------------");
  console.log("PASSED: 8");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
