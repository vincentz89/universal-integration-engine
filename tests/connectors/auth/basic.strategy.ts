
import assert from "node:assert/strict";
import { AxiosHeaders } from "axios";

import { BasicAuthenticationStrategy } from
  "../../../src/infra/connectors/auth/strategies/basic.strategy.js";

import type {
  AuthenticationContext,
} from "../../../src/infra/connectors/auth/auth.types.js";

function main(): void {
  const strategy = new BasicAuthenticationStrategy();

  const context: AuthenticationContext<"BASIC"> = {
    authType: "BASIC",
    credentials: {
      username: "test-user",
      password: "test-password",
    },
  };

  // 1. Standard Basic authentication.
  const result = strategy.apply({}, context);

  assert.ok(result.headers instanceof AxiosHeaders);

  const expectedCredentials = Buffer.from(
    "test-user:test-password",
    "utf8",
  ).toString("base64");

  assert.equal(
    result.headers.get("Authorization"),
    `Basic ${expectedCredentials}`,
  );

  console.log("[PASS] Basic authentication header generated.");

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
    `Basic ${expectedCredentials}`,
  );

  console.log("[PASS] Existing request headers preserved.");

  // 3. Unicode credentials use UTF-8 encoding.
  const unicodeResult = strategy.apply(
    {},
    {
      authType: "BASIC",
      credentials: {
        username: "josé",
        password: "pässword",
      },
    },
  );

  assert.ok(unicodeResult.headers instanceof AxiosHeaders);

  const expectedUnicodeCredentials = Buffer.from(
    "josé:pässword",
    "utf8",
  ).toString("base64");

  assert.equal(
    unicodeResult.headers.get("Authorization"),
    `Basic ${expectedUnicodeCredentials}`,
  );

  console.log("[PASS] Unicode credentials encoded correctly.");

  // 4. Missing username is rejected.
  assert.throws(
    () =>
      strategy.apply(
        {},
        {
          authType: "BASIC",
          credentials: {
            username: "",
            password: "test-password",
          },
        },
      ),
    /Basic authentication username is missing/,
  );

  console.log("[PASS] Missing username rejected.");

  // 5. Missing password is rejected.
  assert.throws(
    () =>
      strategy.apply(
        {},
        {
          authType: "BASIC",
          credentials: {
            username: "test-user",
            password: "",
          },
        },
      ),
    /Basic authentication password is missing/,
  );

  console.log("[PASS] Missing password rejected.");

  // 6. Existing Authorization header is replaced.
  const replacedResult = strategy.apply(
    {
      headers: {
        Authorization: "Bearer old-token",
      },
    },
    context,
  );

  assert.ok(replacedResult.headers instanceof AxiosHeaders);

  assert.equal(
    replacedResult.headers.get("Authorization"),
    `Basic ${expectedCredentials}`,
  );

  console.log("[PASS] Existing Authorization header replaced.");

  console.log("--------------------------------------");
  console.log("PASSED: 6");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main();
