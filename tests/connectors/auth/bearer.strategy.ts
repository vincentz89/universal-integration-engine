
import assert from "node:assert/strict";
import { AxiosHeaders } from "axios";

import { BearerAuthenticationStrategy } from
  "../../../src/infra/connectors/auth/strategies/bearer.strategy.js";

import type {
  AuthenticationContext,
} from "../../../src/infra/connectors/auth/auth.types.js";

function main(): void {
  const strategy = new BearerAuthenticationStrategy();

  const context: AuthenticationContext<"BEARER"> = {
    authType: "BEARER",
    credentials: {
      accessToken: "test-access-token",
    },
  };

  // 1. Standard Bearer authentication.
  const result = strategy.apply({}, context);

  assert.ok(result.headers instanceof AxiosHeaders);

  assert.equal(
    result.headers.get("Authorization"),
    "Bearer test-access-token",
  );

  console.log("[PASS] Bearer authentication header generated.");

  // 2. Existing headers are preserved.
  const preservedResult = strategy.apply(
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
    "Bearer test-access-token",
  );

  console.log("[PASS] Existing request headers preserved.");

  // 3. Missing access token.
  assert.throws(
    () =>
      strategy.apply(
        {},
        {
          authType: "BEARER",
          credentials: {
            accessToken: "",
          },
        },
      ),
    /Bearer authentication access token is missing/,
  );

  console.log("[PASS] Missing access token rejected.");

  // 4. Whitespace-only access token.
  assert.throws(
    () =>
      strategy.apply(
        {},
        {
          authType: "BEARER",
          credentials: {
            accessToken: "   ",
          },
        },
      ),
    /Bearer authentication access token is missing/,
  );

  console.log("[PASS] Whitespace-only access token rejected.");

  // 5. Existing Authorization header is replaced.
  const replacedResult = strategy.apply(
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
    "Bearer test-access-token",
  );

  console.log("[PASS] Existing Authorization header replaced.");

  console.log("--------------------------------------");
  console.log("PASSED: 5");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main();
