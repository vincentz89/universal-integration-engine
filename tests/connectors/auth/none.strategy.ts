import assert from "node:assert/strict";
import { AxiosHeaders } from "axios";

import { NoneAuthenticationStrategy } from
  "../../../src/infra/connectors/auth/strategies/none.strategy.js";

import type {
  AuthenticationContext,
} from "../../../src/infra/connectors/auth/auth.types.js";

function main(): void {
  const strategy = new NoneAuthenticationStrategy();

  const context: AuthenticationContext<"NONE"> = {
    authType: "NONE",
    credentials: {},
  };

  const originalConfig = {
    baseURL: "https://api.example.com",
    headers: {
      Accept: "application/json",
    },
  };

  const result = strategy.apply(originalConfig, context);

  assert.equal(strategy.authType, "NONE");
  assert.equal(result.baseURL, originalConfig.baseURL);
  assert.ok(result.headers instanceof AxiosHeaders);
  assert.equal(result.headers.get("Accept"), "application/json");
  assert.equal(result.headers.get("Authorization"), undefined);
  assert.equal(result.headers.get("Proxy-Authorization"), undefined);



  console.log("[PASS] NONE authentication preserves request configuration.");
  console.log("[PASS] NONE authentication adds no credentials.");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main();