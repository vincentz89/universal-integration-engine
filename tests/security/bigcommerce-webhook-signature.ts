import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  verifyBigCommerceSignature,
} from "../../src/infra/webhooks/bigcommerce/signature-verifier.js";

const secret = "test-webhook-secret";
const webhookId = "test-webhook-001";
const rawBody = Buffer.from(
  JSON.stringify({
    scope: "store/order/created",
    store_id: "12345",
    data: { id: 1001 },
  }),
);

function createSignature(
  body: Buffer,
  timestamp: string,
  signingSecret = secret,
): string {
  const signedContent =
    `${webhookId}.${timestamp}.${body.toString("utf8")}`;

  return crypto
    .createHmac("sha256", Buffer.from(signingSecret, "utf8"))
    .update(signedContent, "utf8")
    .digest("base64");
}

async function main(): Promise<void> {
  let passed = 0;

  function test(name: string, callback: () => void): void {
    callback();
    passed++;
    console.log(`[PASS] ${name}`);
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createSignature(rawBody, timestamp);

  console.log("======================================");
  console.log("BIGCOMMERCE WEBHOOK SIGNATURE TEST");
  console.log("======================================");

  test("Valid signature is accepted", () => {
    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        secret,
        webhookId,
        timestamp,
        `v1,${signature}`,
      ),
      true,
    );
  });

  test("Tampered payload is rejected", () => {
    const modifiedBody = Buffer.from(
      JSON.stringify({ scope: "store/order/updated" }),
    );

    assert.equal(
      verifyBigCommerceSignature(
        modifiedBody,
        secret,
        webhookId,
        timestamp,
        `v1,${signature}`,
      ),
      false,
    );
  });

  test("Incorrect secret is rejected", () => {
    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        "incorrect-secret",
        webhookId,
        timestamp,
        `v1,${signature}`,
      ),
      false,
    );
  });

  test("Invalid signature is rejected", () => {
    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        secret,
        webhookId,
        timestamp,
        "v1,invalid-signature",
      ),
      false,
    );
  });

  test("Unsupported signature version is rejected", () => {
    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        secret,
        webhookId,
        timestamp,
        `v2,${signature}`,
      ),
      false,
    );
  });

  test("Expired timestamp is rejected", () => {
    const expiredTimestamp = String(
      Math.floor(Date.now() / 1000) - 301,
    );

    const expiredSignature = createSignature(
      rawBody,
      expiredTimestamp,
    );

    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        secret,
        webhookId,
        expiredTimestamp,
        `v1,${expiredSignature}`,
      ),
      false,
    );
  });

  test("Future timestamp outside tolerance is rejected", () => {
    const futureTimestamp = String(
      Math.floor(Date.now() / 1000) + 301,
    );

    const futureSignature = createSignature(
      rawBody,
      futureTimestamp,
    );

    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        secret,
        webhookId,
        futureTimestamp,
        `v1,${futureSignature}`,
      ),
      false,
    );
  });

  test("Malformed timestamp is rejected", () => {
    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        secret,
        webhookId,
        "invalid",
        `v1,${signature}`,
      ),
      false,
    );
  });

  test("Valid signature is accepted among multiple versions", () => {
    assert.equal(
      verifyBigCommerceSignature(
        rawBody,
        secret,
        webhookId,
        timestamp,
        `v2,invalid v1,${signature}`,
      ),
      true,
    );
  });

  console.log("--------------------------------------");
  console.log(`PASSED: ${passed}`);
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
  console.log("======================================");
}

main().catch((error: unknown) => {
  console.error("[FAIL] Signature verification test:", error);
  process.exitCode = 1;
});