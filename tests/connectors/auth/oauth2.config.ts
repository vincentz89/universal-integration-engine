
import assert from "node:assert/strict";

import {
  OAuth2TokenEndpointConfigSchema,
  OAuth2TokenResponseSchema,
} from "../../../src/infra/connectors/auth/oauth2.config.js";

function main(): void {
  // 1. Valid HTTPS token endpoint.
  const validConfig = OAuth2TokenEndpointConfigSchema.parse({
    tokenUrl: "https://auth.example.com/oauth/token",
  });

  assert.equal(
    validConfig.tokenUrl,
    "https://auth.example.com/oauth/token",
  );

  assert.equal(
    validConfig.clientAuthentication,
    "CLIENT_SECRET_BASIC",
  );

  console.log("[PASS] Valid HTTPS token endpoint accepted.");

  // 2. CLIENT_SECRET_POST authentication.
  const postConfig = OAuth2TokenEndpointConfigSchema.parse({
    tokenUrl: "https://auth.example.com/oauth/token",
    clientAuthentication: "CLIENT_SECRET_POST",
  });

  assert.equal(
    postConfig.clientAuthentication,
    "CLIENT_SECRET_POST",
  );

  console.log("[PASS] CLIENT_SECRET_POST configuration accepted.");

  // 3. Optional scope and audience.
  const extendedConfig = OAuth2TokenEndpointConfigSchema.parse({
    tokenUrl: "https://auth.example.com/oauth/token",
    scope: "products.read inventory.write",
    audience: "https://api.example.com",
  });

  assert.equal(
    extendedConfig.scope,
    "products.read inventory.write",
  );

  assert.equal(
    extendedConfig.audience,
    "https://api.example.com",
  );

  console.log("[PASS] Optional scope and audience accepted.");

  // 4. HTTP token endpoint rejected.
  assert.throws(
    () =>
      OAuth2TokenEndpointConfigSchema.parse({
        tokenUrl: "http://auth.example.com/oauth/token",
      }),
  );

  console.log("[PASS] Non-HTTPS token endpoint rejected.");

  // 5. URL containing embedded credentials rejected.
  assert.throws(
    () =>
      OAuth2TokenEndpointConfigSchema.parse({
        tokenUrl: "https://user:password@auth.example.com/token",
      }),
  );

  console.log("[PASS] Token URL containing credentials rejected.");

  // 6. URL containing a fragment rejected.
  assert.throws(
    () =>
      OAuth2TokenEndpointConfigSchema.parse({
        tokenUrl: "https://auth.example.com/token#fragment",
      }),
  );

  console.log("[PASS] Token URL containing fragment rejected.");

  // 7. Unsupported client authentication rejected.
  assert.throws(
    () =>
      OAuth2TokenEndpointConfigSchema.parse({
        tokenUrl: "https://auth.example.com/token",
        clientAuthentication: "CLIENT_SECRET_QUERY",
      }),
  );

  console.log("[PASS] Unsupported client authentication rejected.");

  // 8. Unknown configuration properties rejected.
  assert.throws(
    () =>
      OAuth2TokenEndpointConfigSchema.parse({
        tokenUrl: "https://auth.example.com/token",
        unexpectedProperty: "value",
      }),
  );

  console.log("[PASS] Unknown configuration properties rejected.");

  // 9. Valid token response.
  const tokenResponse = OAuth2TokenResponseSchema.parse({
    access_token: "test-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "test-refresh-token",
  });

  assert.equal(tokenResponse.access_token, "test-access-token");
  assert.equal(tokenResponse.expires_in, 3600);

  console.log("[PASS] Valid OAuth2 token response accepted.");

  // 10. Token response without a new refresh token.
  const responseWithoutRefreshToken =
    OAuth2TokenResponseSchema.parse({
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    });

  assert.equal(
    responseWithoutRefreshToken.refresh_token,
    undefined,
  );

  console.log("[PASS] Missing replacement refresh token accepted.");

  // 11. Missing access token rejected.
  assert.throws(
    () =>
      OAuth2TokenResponseSchema.parse({
        token_type: "Bearer",
        expires_in: 3600,
      }),
  );

  console.log("[PASS] Missing access token rejected.");

  // 12. Empty access token rejected.
  assert.throws(
    () =>
      OAuth2TokenResponseSchema.parse({
        access_token: "",
      }),
  );

  console.log("[PASS] Empty access token rejected.");

  // 13. Invalid expiration rejected.
  assert.throws(
    () =>
      OAuth2TokenResponseSchema.parse({
        access_token: "test-access-token",
        expires_in: -10,
      }),
  );

  console.log("[PASS] Invalid token expiration rejected.");

  console.log("--------------------------------------");
  console.log("PASSED: 13");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main();
