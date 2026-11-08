
import assert from "node:assert/strict";
import { AxiosHeaders } from "axios";

import { ApiKeyAuthenticationStrategy } from
  "../../../src/infra/connectors/auth/strategies/api-key.strategy.js";

import type {
  AuthenticationContext,
} from "../../../src/infra/connectors/auth/auth.types.js";

function main(): void {
  const strategy = new ApiKeyAuthenticationStrategy();

  const context: AuthenticationContext<"API_KEY"> = {
    authType: "API_KEY",
    credentials: {
      apiKey: "test-api-key",
    },
  };

  // 1. Default header authentication.
  const headerResult = strategy.apply(
    {
      baseURL: "https://api.example.com",
    },
    context,
  );

  assert.ok(headerResult.headers instanceof AxiosHeaders);
  assert.equal(
    headerResult.headers.get("X-API-Key"),
    "test-api-key",
  );

  console.log("[PASS] Default API key header authentication.");

  // 2. Custom header authentication.
  const customHeaderResult = strategy.apply(
    {},
    {
      ...context,
      authConfig: {
        location: "HEADER",
        parameterName: "X-Custom-Key",
      },
    },
  );

  assert.ok(customHeaderResult.headers instanceof AxiosHeaders);
  assert.equal(
    customHeaderResult.headers.get("X-Custom-Key"),
    "test-api-key",
  );

  console.log("[PASS] Configurable API key header.");

  // 3. Optional API secret.
  const secretResult = strategy.apply(
    {},
    {
      ...context,
      credentials: {
        apiKey: "test-api-key",
        apiSecret: "test-api-secret",
      },
    },
  );

  assert.ok(secretResult.headers instanceof AxiosHeaders);
  assert.equal(
    secretResult.headers.get("X-API-Key"),
    "test-api-key",
  );
  assert.equal(
    secretResult.headers.get("X-API-Secret"),
    "test-api-secret",
  );

  console.log("[PASS] Optional API secret header.");

  // 4. Query parameter authentication.
  const queryResult = strategy.apply(
    {
      params: {
        page: 1,
      },
    },
    {
      ...context,
      authConfig: {
        location: "QUERY",
        parameterName: "api_key",
      },
    },
  );

  assert.deepEqual(queryResult.params, {
    page: 1,
    api_key: "test-api-key",
  });

  console.log("[PASS] Configurable API key query parameter.");

  // 5. Missing API key.
  assert.throws(
    () =>
      strategy.apply(
        {},
        {
          authType: "API_KEY",
          credentials: {
            apiKey: "",
          },
        },
      ),
    /API key credential is missing/,
  );

  console.log("[PASS] Missing API key rejected.");

  // 6. Unsupported authentication location.
  assert.throws(
    () =>
      strategy.apply(
        {},
        {
          ...context,
          authConfig: {
            location: "BODY",
          },
        },
      ),
    /Unsupported API key authentication location/,
  );

  console.log("[PASS] Unsupported authentication location rejected.");

  // 7. Query authentication cannot silently expose API secret.
  assert.throws(
    () =>
      strategy.apply(
        {},
        {
          ...context,
          credentials: {
            apiKey: "test-api-key",
            apiSecret: "test-api-secret",
          },
          authConfig: {
            location: "QUERY",
          },
        },
      ),
    /API secret requires header-based authentication/,
  );

  console.log("[PASS] API secret rejected in query mode.");

  console.log("--------------------------------------");
  console.log("PASSED: 7");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main();
