
import assert from "node:assert/strict";

import {
  LEGACY_BIGCOMMERCE_WEBHOOK_SCOPE,
  getWebhookIdempotencyScope,
  getIntegrationWebhookIdempotencyScope,
  getWebhookSystemNameFromScope,
  getWebhookIntegrationIdFromScope,
} from "../../src/core/webhooks/idempotency-scope.js";

function test(name: string, callback: () => void): void {
  callback();
  console.info(`[PASS] ${name}`);
}

// Legacy compatibility
test("Preserves legacy BigCommerce scope", () => {
  assert.equal(
    getWebhookIdempotencyScope("BIGCOMMERCE"),
    LEGACY_BIGCOMMERCE_WEBHOOK_SCOPE,
  );
});

test("Preserves legacy provider-level scope", () => {
  assert.equal(
    getWebhookIdempotencyScope("SHOPIFY"),
    "WEBHOOK:SHOPIFY",
  );
});

// Account-specific identity
test("Creates account-specific BigCommerce scope", () => {
  assert.equal(
    getIntegrationWebhookIdempotencyScope(
      "BIGCOMMERCE",
      "account_001",
    ),
    "WEBHOOK:BIGCOMMERCE:INTEGRATION:account_001",
  );
});

test("Different integration accounts have different scopes", () => {
  const first = getIntegrationWebhookIdempotencyScope(
    "BIGCOMMERCE",
    "account_001",
  );

  const second = getIntegrationWebhookIdempotencyScope(
    "BIGCOMMERCE",
    "account_002",
  );

  assert.notEqual(first, second);
});

test("Different providers have different scopes", () => {
  const first = getIntegrationWebhookIdempotencyScope(
    "BIGCOMMERCE",
    "account_001",
  );

  const second = getIntegrationWebhookIdempotencyScope(
    "SHOPIFY",
    "account_001",
  );

  assert.notEqual(first, second);
});

// Scope parsing
test("Resolves legacy BigCommerce provider", () => {
  assert.equal(
    getWebhookSystemNameFromScope(
      LEGACY_BIGCOMMERCE_WEBHOOK_SCOPE,
    ),
    "BIGCOMMERCE",
  );
});

test("Resolves account-specific provider", () => {
  assert.equal(
    getWebhookSystemNameFromScope(
      "WEBHOOK:BIGCOMMERCE:INTEGRATION:account_001",
    ),
    "BIGCOMMERCE",
  );
});

test("Extracts integration ID from account-specific scope", () => {
  assert.equal(
    getWebhookIntegrationIdFromScope(
      "WEBHOOK:BIGCOMMERCE:INTEGRATION:account_001",
    ),
    "account_001",
  );
});

test("Returns null integration ID for legacy scopes", () => {
  assert.equal(
    getWebhookIntegrationIdFromScope(
      LEGACY_BIGCOMMERCE_WEBHOOK_SCOPE,
    ),
    null,
  );

  assert.equal(
    getWebhookIntegrationIdFromScope("WEBHOOK:SHOPIFY"),
    null,
  );
});

// Invalid input
test("Rejects invalid provider names", () => {
  assert.throws(() =>
    getIntegrationWebhookIdempotencyScope(
      "bigcommerce",
      "account_001",
    ),
  );
});

test("Rejects invalid integration IDs", () => {
  assert.throws(() =>
    getIntegrationWebhookIdempotencyScope(
      "BIGCOMMERCE",
      "invalid:account",
    ),
  );
});

test("Rejects malformed account-specific scopes", () => {
  assert.equal(
    getWebhookSystemNameFromScope(
      "WEBHOOK:BIGCOMMERCE:INTEGRATION:",
    ),
    null,
  );

  assert.equal(
    getWebhookSystemNameFromScope(
      "WEBHOOK:BIGCOMMERCE:INTEGRATION:bad:id",
    ),
    null,
  );
});

// Additional scope parsing edge cases
test("Rejects duplicated integration markers", () => {
  const malformedScope =
    "WEBHOOK:BIGCOMMERCE:INTEGRATION:account_001:INTEGRATION:account_002";

  assert.equal(
    getWebhookSystemNameFromScope(malformedScope),
    null,
  );

  assert.equal(
    getWebhookIntegrationIdFromScope(malformedScope),
    null,
  );
});

test("Rejects invalid provider when extracting integration ID", () => {
  assert.equal(
    getWebhookIntegrationIdFromScope(
      "WEBHOOK:bigcommerce:INTEGRATION:account_001",
    ),
    null,
  );
});

test("Rejects malformed integration ID when extracting scope identity", () => {
  assert.equal(
    getWebhookIntegrationIdFromScope(
      "WEBHOOK:BIGCOMMERCE:INTEGRATION:invalid:account",
    ),
    null,
  );
});

console.info("\nWebhook idempotency scope tests passed.");
