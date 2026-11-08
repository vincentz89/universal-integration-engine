import "dotenv/config";
import assert from "node:assert/strict";

import {
  createDefaultAuthenticationRegistry,
} from "../../../src/infra/connectors/auth/create-auth-registry.js";

import type {
  OAuth2ProviderConfigResolver,
} from "../../../src/infra/connectors/auth/oauth2-provider-config.js";

const resolverCalls: string[] = [];

const providerResolver: OAuth2ProviderConfigResolver = {
  async resolve(input) {
    resolverCalls.push(input.systemName);

    return {
      tokenEndpointConfig: {
        tokenUrl: "https://auth.example.com/oauth2/token",
        clientAuthentication: "CLIENT_SECRET_BASIC",
      },
      allowedTokenHosts: ["auth.example.com"],
    };
  },
};

async function main(): Promise<void> {
  const registry = createDefaultAuthenticationRegistry({
    oauth2ProviderConfigResolver: providerResolver,
  });

  // Verify all supported authentication strategies are registered.
  const expectedTypes = [
    "NONE",
    "API_KEY",
    "BASIC",
    "BEARER",
    "OAUTH2",
  ];

  for (const authType of expectedTypes) {
    assert.equal(registry.has(authType as never), true);
  }

  console.log("[PASS] All five authentication strategies registered.");

  // Verify registered types.
  assert.deepEqual(
    registry.getRegisteredTypes().sort(),
    [...expectedTypes].sort(),
  );

  console.log("[PASS] Registered authentication types are correct.");

  // Verify each strategy can be retrieved.
  for (const authType of expectedTypes) {
    const strategy = registry.get(authType as never);

    assert.equal(strategy.authType, authType);
  }

  console.log("[PASS] All registered strategies are retrievable.");

  // Verify duplicate registration is rejected.
  assert.throws(
    () => registry.register(registry.get("NONE")),
    /already registered/,
  );

  console.log("[PASS] Duplicate registration rejected.");

  // Verify OAuth2 is registered without resolving provider configuration
  // during registry construction.
  assert.equal(resolverCalls.length, 0);

  console.log("[PASS] OAuth2 provider resolution is deferred.");

  console.log("--------------------------------------");
  console.log("PASSED: 5");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});